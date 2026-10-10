/**
 * Leave/rejoin cooldown.
 *
 * A member who leaves and rejoins is muted for one cooldown interval
 * (`config.rejoinCooldownSeconds`). While the user is away the mute is paused —
 * the seconds still owed are frozen and one more interval is added on the next
 * rejoin, so evading a mute by leaving only extends it.
 *
 * State split:
 * - `user_rejoin_cooldowns` keeps the paused remainder and the `pending` flag
 *   that remembers a leave is waiting to be re-enforced.
 * - The live Telegram restriction is written through `muteMember(..., "cooldown")`
 *   into `user_rate_limit_mutes`, so the existing message filter and mute
 *   cleanup enforce and release it with no extra wiring.
 *
 * Buy-out: each active cooldown opens (or extends) a `jailings` row in the same
 * shape as a jail, carrying {@link REJOIN_COOLDOWN_REASON}. That makes the
 * existing bail pipeline — `/paybail`, `/verifybail`, and the deposit listener —
 * verify and release it unchanged; `JailService.payJailing` calls
 * {@link clearOnBuyout} so the accrued cooldown does not survive the payment.
 *
 * Only the `chat_member` update path calls this: it is the single source of
 * join/leave transitions, which avoids double-counting a join that arrives both
 * as a message and a chat_member update.
 *
 * @module services/rejoinCooldownService
 */

import type { Telegram } from "telegraf";
import { config } from "../config";
import { execute, get } from "../database";
import { generateJailingId } from "../utils/jailingId";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { muteMember, releaseMute } from "./chatMuteService";

/** `jailings.reason` value marking a payable rejoin cooldown. */
export const REJOIN_COOLDOWN_REASON = "rejoin_cooldown";

interface CooldownRow {
	pending: number;
	remaining_seconds: number;
}

/** Current time in whole unix seconds. */
function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** Owners, admins, and whitelisted users are never cooled down. */
function isExempt(userId: number): boolean {
	const user = get<{ role: string | null; whitelist: number | null }>(
		"SELECT role, whitelist FROM users WHERE id = ?",
		[userId],
	);
	return (
		Boolean(user?.whitelist) || user?.role === "owner" || user?.role === "admin"
	);
}

/**
 * Open or extend the user's single unpaid cooldown jailing, so `/paybail` and
 * the deposit listener can price and release it through the normal bail flow.
 */
function upsertCooldownJailing(userId: number, mutedUntil: number): void {
	const existing = get<{ id: number }>(
		`SELECT id FROM jailings
		 WHERE user_id = ? AND reason = ? AND paid = 0
		 ORDER BY id DESC LIMIT 1`,
		[userId, REJOIN_COOLDOWN_REASON],
	);
	if (existing) {
		execute("UPDATE jailings SET muted_until = ? WHERE id = ?", [
			mutedUntil,
			existing.id,
		]);
		return;
	}
	const bailMicro = AmountPrecision.toDbMicro(config.defaultJailBailAmount);
	for (let attempt = 0; ; attempt++) {
		try {
			execute(
				`INSERT INTO jailings (jailing_id, user_id, bail_amount, muted_until, reason)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					generateJailingId(),
					userId,
					bailMicro,
					mutedUntil,
					REJOIN_COOLDOWN_REASON,
				],
			);
			return;
		} catch (error) {
			const collision =
				error instanceof Error &&
				error.message.includes("UNIQUE constraint failed") &&
				error.message.includes("jailing_id");
			if (collision && attempt < 4) continue;
			throw error;
		}
	}
}

/**
 * Whether the user is already muted by something other than the cooldown — an
 * active jail/rate-limit mute or an open non-cooldown jailing. Applying a
 * cooldown on top would open a second, cheaper payable jailing that
 * `releaseMember` could use to lift the real one, so we skip it.
 */
function hasConflictingMute(userId: number, now: number): boolean {
	if (
		get<{ user_id: number }>(
			`SELECT user_id FROM user_rate_limit_mutes
			 WHERE user_id = ? AND kind <> 'cooldown' AND muted_until > ? LIMIT 1`,
			[userId, now],
		)
	) {
		return true;
	}
	return Boolean(
		get<{ id: number }>(
			`SELECT id FROM jailings
			 WHERE user_id = ? AND paid = 0 AND muted_until > ?
			   AND (reason IS NULL OR reason <> ?) LIMIT 1`,
			[userId, now, REJOIN_COOLDOWN_REASON],
		),
	);
}

/**
 * Record that a member left. Freezes whatever cooldown time is still owed and
 * marks them pending so the next rejoin re-applies (and extends) the mute.
 * Idempotent: a duplicate leave signal is ignored.
 */
export function recordMemberLeave(userId: number, now = nowSeconds()): void {
	if (!(config.rejoinCooldownSeconds > 0)) return;
	if (isExempt(userId)) return;

	const existing = get<Pick<CooldownRow, "pending">>(
		"SELECT pending FROM user_rejoin_cooldowns WHERE user_id = ?",
		[userId],
	);
	if (existing?.pending) return; // already away

	const active = get<{ muted_until: number }>(
		"SELECT muted_until FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
	const remaining =
		active && active.muted_until > now ? active.muted_until - now : 0;

	// Drop the live mute row: the user is gone, so there is nothing to restore,
	// and the frozen remainder supersedes it.
	execute(
		"DELETE FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
	execute(
		`INSERT INTO user_rejoin_cooldowns (user_id, pending, remaining_seconds, updated_at)
		 VALUES (?, 1, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		 pending=1, remaining_seconds=excluded.remaining_seconds, updated_at=excluded.updated_at`,
		[userId, remaining, now],
	);
	logger.info("Rejoin cooldown paused", {
		tag: "moderation",
		subtag: "cooldown_paused",
		userId,
		remainingSeconds: remaining,
	});
}

/**
 * Apply or extend the cooldown mute when a pending member rejoins. The owed
 * time is the frozen remainder plus one cooldown interval.
 */
export async function recordMemberRejoin(
	telegram: Telegram,
	chatId: number,
	userId: number,
	now = nowSeconds(),
): Promise<void> {
	if (!(config.rejoinCooldownSeconds > 0)) return;

	const row = get<CooldownRow>(
		"SELECT pending, remaining_seconds FROM user_rejoin_cooldowns WHERE user_id = ?",
		[userId],
	);
	if (!row?.pending) return; // first-ever join, or already handled

	if (isExempt(userId)) {
		execute("DELETE FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]);
		return;
	}

	if (hasConflictingMute(userId, now)) {
		execute(
			"UPDATE user_rejoin_cooldowns SET pending = 0, remaining_seconds = 0, updated_at = ? WHERE user_id = ?",
			[now, userId],
		);
		logger.info("Rejoin cooldown skipped; another mute is active", {
			tag: "moderation",
			subtag: "cooldown_skipped",
			userId,
		});
		return;
	}

	const owed = row.remaining_seconds + config.rejoinCooldownSeconds;
	const until = now + owed;
	// Mute first so a failed Telegram call cannot leave a payable jailing with
	// no enforced restriction. `pending` is only cleared after both succeed.
	await muteMember({ telegram, chatId, userId }, "cooldown", until);

	// A jail can start during the await above (admin or auto-jail). Re-check
	// before opening the payable jailing so two open jailings never coexist; if
	// one landed, abandon this cooldown rather than leave a cheaper memo that
	// `releaseMember` could use to lift the jail.
	if (hasConflictingMute(userId, now)) {
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ? AND kind = 'cooldown'",
			[userId],
		);
		await releaseMute({ telegram, chatId, userId }, "cooldown").catch(() => {});
		execute("DELETE FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]);
		logger.info("Rejoin cooldown abandoned; another mute started", {
			tag: "moderation",
			subtag: "cooldown_abandoned",
			userId,
		});
		return;
	}

	upsertCooldownJailing(userId, until);
	execute(
		"UPDATE user_rejoin_cooldowns SET pending = 0, remaining_seconds = 0, updated_at = ? WHERE user_id = ?",
		[now, userId],
	);
	logger.warn("Rejoin cooldown mute applied", {
		tag: "moderation",
		subtag: "cooldown_muted",
		userId,
		chatId,
		until,
		owedSeconds: owed,
	});
}

/** Drop a user's accrued cooldown once they have bought it out. */
export function clearOnBuyout(userId: number): void {
	execute("DELETE FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]);
}

/**
 * Cancel an open cooldown when a real jail starts. Without this, a user could
 * hold a cooldown jailing and, after being jailed, pay that (identical flat)
 * memo — `releaseMember` clears every mute kind, lifting the jail. Marking the
 * cooldown jailing paid removes it from the payable set.
 */
export function cancelOpenCooldown(userId: number, now = nowSeconds()): void {
	execute(
		`UPDATE jailings SET paid = 1, paid_at = ?
		 WHERE user_id = ? AND reason = ? AND paid = 0`,
		[now, userId, REJOIN_COOLDOWN_REASON],
	);
	execute("DELETE FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]);
	execute(
		"DELETE FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
}

/** The user's active cooldown deadline, if any (used by `/mystatus`). */
export function getActiveCooldown(
	userId: number,
	now = nowSeconds(),
): { mutedUntil: number } | null {
	const row = get<{ muted_until: number }>(
		"SELECT muted_until FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
	return row && row.muted_until > now ? { mutedUntil: row.muted_until } : null;
}
