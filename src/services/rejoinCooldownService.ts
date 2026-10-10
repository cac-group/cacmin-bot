/**
 * Leave/rejoin cooldown.
 *
 * A member who leaves and rejoins is muted for one cooldown interval
 * (`config.rejoinCooldownSeconds`). While the user is away the mute is paused —
 * the seconds still owed are frozen and one more interval is added on the next
 * rejoin, so evading a mute by leaving only extends it.
 *
 * The rejoin is detected from the **join** itself: a join for a user we already
 * know is necessarily a rejoin, so we never depend on receiving a leave update
 * (Telegram does not deliver those reliably). `recordMemberLeave` is best-effort
 * and only freezes the remainder earlier; if it is missed, the still-running
 * mute supplies the remainder at the next rejoin.
 *
 * State split:
 * - `user_rejoin_cooldowns` keeps the paused remainder and `last_join_at` (which
 *   collapses the same join delivered as both a service message and a
 *   `chat_member` update).
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

/** A join delivered twice within this window is the same join. */
const JOIN_DEDUPE_SECONDS = 5;

interface CooldownRow {
	remaining_seconds: number;
	last_join_at: number;
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

/** Remaining seconds left on an active cooldown mute, or 0. */
function activeCooldownRemaining(userId: number, now: number): number {
	const active = get<{ muted_until: number }>(
		"SELECT muted_until FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
	return active && active.muted_until > now ? active.muted_until - now : 0;
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

/** Record that a join has been processed (dedupe marker, and clears owed time). */
function markJoinSeen(
	userId: number,
	now: number,
	remainingSeconds: number,
): void {
	execute(
		`INSERT INTO user_rejoin_cooldowns (user_id, remaining_seconds, last_join_at, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		 remaining_seconds=excluded.remaining_seconds,
		 last_join_at=excluded.last_join_at,
		 updated_at=excluded.updated_at`,
		[userId, remainingSeconds, now, now],
	);
}

/** Store the frozen remainder without disturbing the join dedupe marker. */
function markLeavePaused(
	userId: number,
	now: number,
	remainingSeconds: number,
): void {
	execute(
		`INSERT INTO user_rejoin_cooldowns (user_id, remaining_seconds, last_join_at, updated_at)
		 VALUES (?, ?, 0, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		 remaining_seconds=excluded.remaining_seconds,
		 updated_at=excluded.updated_at`,
		[userId, remainingSeconds, now],
	);
}

/**
 * Best-effort pause: freeze whatever cooldown time is still owed and drop the
 * live mute so it does not keep ticking while the user is away. If Telegram
 * never delivers the leave, the next rejoin falls back to the still-running
 * mute's remaining time.
 */
export function recordMemberLeave(userId: number, now = nowSeconds()): void {
	if (!(config.rejoinCooldownSeconds > 0)) return;
	if (isExempt(userId)) return;

	const remaining = activeCooldownRemaining(userId, now);
	execute(
		"DELETE FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
	markLeavePaused(userId, now, remaining);
	logger.info("Rejoin cooldown paused", {
		tag: "moderation",
		subtag: "cooldown_paused",
		userId,
		remainingSeconds: remaining,
	});
}

/**
 * Apply or extend the cooldown mute when a member joins. `isRejoin` is false
 * only for a first-ever join (a user we did not already know); any other join is
 * a rejoin and adds one interval to whatever is still owed.
 */
export async function recordMemberRejoin(
	telegram: Telegram,
	chatId: number,
	userId: number,
	now = nowSeconds(),
	isRejoin = true,
): Promise<void> {
	if (!(config.rejoinCooldownSeconds > 0)) return;
	if (isExempt(userId)) return;

	const row = get<CooldownRow>(
		"SELECT remaining_seconds, last_join_at FROM user_rejoin_cooldowns WHERE user_id = ?",
		[userId],
	);
	// The same join can arrive as a service message and a chat_member update.
	if (row && Math.abs(now - row.last_join_at) <= JOIN_DEDUPE_SECONDS) return;

	if (!isRejoin) {
		markJoinSeen(userId, now, row?.remaining_seconds ?? 0);
		return;
	}

	if (hasConflictingMute(userId, now)) {
		markJoinSeen(userId, now, 0);
		logger.info("Rejoin cooldown skipped; another mute is active", {
			tag: "moderation",
			subtag: "cooldown_skipped",
			userId,
		});
		return;
	}

	// Paused remainder (leave seen) or the still-running mute's remainder.
	const owed =
		Math.max(
			row?.remaining_seconds ?? 0,
			activeCooldownRemaining(userId, now),
		) + config.rejoinCooldownSeconds;
	const until = now + owed;
	// Mute first so a failed Telegram call cannot leave a payable jailing with
	// no enforced restriction. The join is only marked seen after both succeed.
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
		markJoinSeen(userId, now, 0);
		logger.info("Rejoin cooldown abandoned; another mute started", {
			tag: "moderation",
			subtag: "cooldown_abandoned",
			userId,
		});
		return;
	}

	upsertCooldownJailing(userId, until);
	markJoinSeen(userId, now, 0);
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
