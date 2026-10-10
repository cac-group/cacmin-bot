/**
 * Group membership tracking.
 *
 * Records the first time a member is observed joining a group so the bot can
 * reason about account age. Historically there is no join data (Telegram's Bot
 * API does not expose join dates), so this starts recording from deployment
 * forward; earlier members fall back to their first-seen `users.created_at`.
 *
 * Writes are strictly insert-only (`INSERT OR IGNORE`, `user_id` primary key):
 * the earliest join wins and nothing is ever updated or deleted.
 *
 * @module handlers/membership
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, get } from "../database";
import {
	recordMemberLeave,
	recordMemberRejoin,
} from "../services/rejoinCooldownService";
import { ensureUserExists } from "../services/userService";
import { logger } from "../utils/logger";

/**
 * True when a chat-member status transition represents a join (from outside
 * the group into a participating status).
 */
export function isJoinTransition(previous: string, next: string): boolean {
	const joined =
		next === "member" || next === "administrator" || next === "creator";
	return joined && (previous === "left" || previous === "kicked");
}

/**
 * True when a chat-member status transition represents a leave (out of the
 * group from any participating status, including a restricted/muted one).
 */
export function isLeaveTransition(previous: string, next: string): boolean {
	const left = next === "left" || next === "kicked";
	return left && previous !== "left" && previous !== "kicked";
}

/** Insert-only join record; the first observation for a user wins. */
function recordJoin(
	userId: number,
	chatId: number | undefined,
	joinedAt: number,
	source: string,
): void {
	try {
		execute(
			`INSERT OR IGNORE INTO user_memberships (user_id, chat_id, joined_at, source)
			 VALUES (?, ?, ?, ?)`,
			[userId, chatId ?? null, joinedAt, source],
		);
	} catch (error) {
		logger.error("Failed to record user join", { userId, chatId, error });
	}
}

/**
 * Append a join/leave transition to the event log consumed as statistics by
 * telegram-chat-explorer / the CAC museum mini-app. The same transition can
 * arrive as both a service message and a `chat_member` update, so a duplicate
 * of the same type within 10 seconds is collapsed.
 */
export function recordMembershipEvent(
	userId: number,
	chatId: number | undefined,
	eventType: "join" | "leave",
	source: string,
	occurredAt: number,
): void {
	try {
		const last = get<{ event_type: string; occurred_at: number }>(
			"SELECT event_type, occurred_at FROM user_membership_events WHERE user_id = ? ORDER BY id DESC LIMIT 1",
			[userId],
		);
		if (
			last &&
			last.event_type === eventType &&
			Math.abs(occurredAt - last.occurred_at) <= 10
		) {
			return;
		}
		execute(
			`INSERT INTO user_membership_events (user_id, chat_id, event_type, source, occurred_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[userId, chatId ?? null, eventType, source, occurredAt],
		);
	} catch (error) {
		logger.error("Failed to record membership event", {
			userId,
			chatId,
			eventType,
			error,
		});
	}
}

/**
 * Applies the configured member tag for a user on join, if any. Telegram's
 * `setChatMemberTag` is newer than telegraf's bundled method map, so the call
 * goes through the untyped `callApi` escape hatch. Failures are logged and
 * swallowed: the bot needs the `can_manage_tags` admin right, and a missing
 * right must not break join tracking.
 */
export async function applyMemberTag(
	telegram: Context["telegram"],
	chatId: number | undefined,
	userId: number,
): Promise<void> {
	const tag = config.memberTags.get(userId);
	if (!tag || chatId === undefined) return;
	try {
		const api = telegram as unknown as {
			callApi(
				method: string,
				payload: Record<string, unknown>,
			): Promise<unknown>;
		};
		await api.callApi("setChatMemberTag", {
			chat_id: chatId,
			user_id: userId,
			tag,
		});
		logger.info("Applied member tag on join", { userId, chatId, tag });
	} catch (error) {
		logger.warn("Failed to apply member tag on join", {
			userId,
			chatId,
			tag,
			error,
		});
	}
}

/**
 * Registers join-tracking listeners for group joins. Existing members who
 * predate this are handled by the reaction handler's first-seen fallback.
 *
 * Both delivery paths are handled because Telegram sends a join/leave as a
 * service message (`new_chat_members` / `left_chat_member`) and, for admins, as
 * a `chat_member` update — and either can be missing. The event log collapses
 * the duplicate, `recordMemberRejoin`/`recordMemberLeave` are idempotent on the
 * `pending` flag, and the member tag is applied once on the service message.
 */
export function registerMembershipHandlers(bot: Telegraf<Context>): void {
	bot.on("message", async (ctx, next) => {
		const msg = ctx.message;
		if (!msg) return next();

		if ("new_chat_members" in msg && msg.new_chat_members) {
			for (const member of msg.new_chat_members) {
				if (member.is_bot) continue;
				ensureUserExists(member.id, member.username || `user_${member.id}`);
				recordJoin(member.id, ctx.chat?.id, msg.date, "new_chat_members");
				recordMembershipEvent(
					member.id,
					ctx.chat?.id,
					"join",
					"new_chat_members",
					msg.date,
				);
				await applyMemberTag(ctx.telegram, ctx.chat?.id, member.id);
				await recordMemberRejoin(
					ctx.telegram,
					ctx.chat?.id,
					member.id,
					msg.date,
				);
			}
			return next();
		}

		if ("left_chat_member" in msg && msg.left_chat_member) {
			const member = msg.left_chat_member;
			if (!member.is_bot) {
				ensureUserExists(member.id, member.username || `user_${member.id}`);
				recordMembershipEvent(
					member.id,
					ctx.chat?.id,
					"leave",
					"left_chat_member",
					msg.date,
				);
				recordMemberLeave(member.id, msg.date);
			}
			return next();
		}

		return next();
	});

	bot.on("chat_member", async (ctx, next) => {
		const update = ctx.chatMember;
		if (!update || update.chat.type === "private") {
			return next();
		}
		const previous = update.old_chat_member.status;
		const nextStatus = update.new_chat_member.status;
		const source = `chat_member:${previous}->${nextStatus}`;

		if (isJoinTransition(previous, nextStatus)) {
			const user = update.new_chat_member.user;
			if (!user.is_bot) {
				ensureUserExists(user.id, user.username || `user_${user.id}`);
				recordJoin(user.id, update.chat.id, update.date, source);
				recordMembershipEvent(
					user.id,
					update.chat.id,
					"join",
					source,
					update.date,
				);
				await recordMemberRejoin(
					ctx.telegram,
					update.chat.id,
					user.id,
					update.date,
				);
			}
		} else if (isLeaveTransition(previous, nextStatus)) {
			const user = update.new_chat_member.user;
			if (!user.is_bot) {
				ensureUserExists(user.id, user.username || `user_${user.id}`);
				recordMembershipEvent(
					user.id,
					update.chat.id,
					"leave",
					source,
					update.date,
				);
				recordMemberLeave(user.id, update.date);
			}
		}
		return next();
	});

	logger.info("Membership join tracking registered");
}
