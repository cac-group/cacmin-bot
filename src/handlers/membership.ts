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
import { execute } from "../database";
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
 */
export function registerMembershipHandlers(bot: Telegraf<Context>): void {
	bot.on("message", async (ctx, next) => {
		const msg = ctx.message;
		if (!msg || !("new_chat_members" in msg) || !msg.new_chat_members) {
			return next();
		}
		for (const member of msg.new_chat_members) {
			if (member.is_bot) continue;
			ensureUserExists(member.id, member.username || `user_${member.id}`);
			recordJoin(member.id, ctx.chat?.id, msg.date, "new_chat_members");
			await applyMemberTag(ctx.telegram, ctx.chat?.id, member.id);
		}
		return next();
	});

	bot.on("chat_member", async (ctx, next) => {
		const update = ctx.chatMember;
		if (
			update &&
			update.chat.type !== "private" &&
			isJoinTransition(
				update.old_chat_member.status,
				update.new_chat_member.status,
			)
		) {
			const user = update.new_chat_member.user;
			if (!user.is_bot) {
				ensureUserExists(user.id, user.username || `user_${user.id}`);
				recordJoin(
					user.id,
					update.chat.id,
					update.date,
					`chat_member:${update.old_chat_member.status}->${update.new_chat_member.status}`,
				);
				await applyMemberTag(ctx.telegram, update.chat.id, user.id);
			}
		}
		return next();
	});

	logger.info("Membership join tracking registered");
}
