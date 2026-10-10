/**
 * Jail (mute) management service module.
 * Handles jailing/muting users temporarily, tracking jail events,
 * calculating bail amounts, and auto-releasing expired jails.
 *
 * Responsibilities:
 * - Logging jail events (jailed, unjailed, auto-unjailed, bail paid)
 * - Managing active jails and jail history
 * - Calculating bail amounts based on duration
 * - Cleaning up expired jails and restoring permissions
 *
 * @module services/jailService
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, query, transaction } from "../database";
import type { JailEvent, User } from "../types";
import { generateJailingId, normalizeJailingId } from "../utils/jailingId";
import { StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { CHAT_RESTORE_PERMISSIONS } from "../utils/telegramPermissions";
import {
	hasStoredBinding,
	muteMember,
	releaseMember,
	releaseMute,
} from "./chatMuteService";
import {
	cancelOpenCooldown,
	clearOnBuyout,
	REJOIN_COOLDOWN_REASON,
} from "./rejoinCooldownService";

/** Canonical bail amount for jails without an explicitly configured amount. */
export const DEFAULT_JAIL_BAIL_AMOUNT = config.defaultJailBailAmount;

/** `jail_events.bail_amount` is stored as integer micro-units; expose JUNO. */
const toJunoJailEvent = (event: JailEvent): JailEvent => ({
	...event,
	bailAmount: AmountPrecision.fromDbMicro(event.bailAmount),
});

export interface JailUserRequest {
	userId: number;
	durationMinutes: number;
	adminId?: number;
	bailAmount?: number;
	paidByUserId?: number;
	paymentTx?: string;
	metadata?: Record<string, any>;
}

/** A canonical jailing row (`jailings`), amounts in JUNO. */
export interface Jailing {
	id: number;
	jailingId: string;
	userId: number;
	bailAmount: number;
	paid: boolean;
	mutedUntil: number;
}

interface JailingRow {
	id: number;
	jailingId: string;
	userId: number;
	bailAmount: number;
	paid: number;
	mutedUntil: number;
}

/**
 * Service class for managing user jails (temporary mutes).
 * Integrates with Telegram Bot API to enforce and lift restrictions.
 */
export class JailService {
	private static bot: Telegraf<Context>;

	/**
	 * Initializes the jail service with the Telegraf bot instance.
	 * Must be called during bot startup before using other methods.
	 *
	 * @param bot - Telegraf bot instance for Telegram API access
	 */
	static initialize(bot: Telegraf<Context>): void {
		JailService.bot = bot;
	}

	/**
	 * Creates a jail using the canonical jail definition.
	 *
	 * @param request - Jail target, duration, optional explicit bail, and audit data
	 * @returns The expiry timestamp and recorded bail amount
	 */
	static jailUser(request: JailUserRequest): {
		jailingId: string;
		mutedUntil: number;
		bailAmount: number;
	} {
		const now = Math.floor(Date.now() / 1000);
		const mutedUntil = now + request.durationMinutes * 60;
		const bailAmount = request.bailAmount ?? DEFAULT_JAIL_BAIL_AMOUNT;

		execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
			mutedUntil,
			now,
			request.userId,
		]);

		const jailingId = JailService.insertJailing({
			userId: request.userId,
			bailAmount,
			mutedUntil,
			adminId: request.adminId,
			reason: request.metadata?.reason,
			createdAt: now,
		});

		// A cooldown's payable jailing must not coexist with a real jail: its
		// memo could otherwise be paid to lift the jail via releaseMember.
		cancelOpenCooldown(request.userId, now);

		JailService.logJailEvent(
			request.userId,
			"jailed",
			request.adminId,
			request.durationMinutes,
			bailAmount,
			request.paidByUserId,
			request.paymentTx,
			request.metadata,
		);

		return { jailingId, mutedUntil, bailAmount };
	}

	/** Insert a jailing row with a fresh unique id, retrying on the (rare) collision. */
	private static insertJailing(input: {
		userId: number;
		bailAmount: number;
		mutedUntil: number;
		adminId?: number;
		reason?: string;
		createdAt: number;
	}): string {
		for (let attempt = 0; ; attempt++) {
			const jailingId = generateJailingId();
			try {
				execute(
					`INSERT INTO jailings (jailing_id, user_id, bail_amount, muted_until, admin_id, reason, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						jailingId,
						input.userId,
						AmountPrecision.toDbMicro(input.bailAmount),
						input.mutedUntil,
						input.adminId || null,
						input.reason || null,
						input.createdAt,
					],
				);
				return jailingId;
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

	/** Map a raw `jailings` row to the public shape (JUNO amount, boolean paid). */
	private static toJailing(row: JailingRow | undefined): Jailing | null {
		return row
			? {
					...row,
					paid: Boolean(row.paid),
					bailAmount: AmountPrecision.fromDbMicro(row.bailAmount),
				}
			: null;
	}

	/** The user's current unpaid jailing, if any. */
	static getActiveJailing(userId: number): Jailing | null {
		const now = Math.floor(Date.now() / 1000);
		return JailService.toJailing(
			query<JailingRow>(
				`SELECT id, jailing_id AS jailingId, user_id AS userId,
				        bail_amount AS bailAmount, paid, muted_until AS mutedUntil
				 FROM jailings WHERE user_id = ? AND paid = 0 AND muted_until > ?
				 ORDER BY id DESC LIMIT 1`,
				[userId, now],
			)[0],
		);
	}

	/** Look up an open, unexpired jailing by its user-facing (case-insensitive) id. */
	static getJailingByPublicId(jailingId: string): Jailing | null {
		const now = Math.floor(Date.now() / 1000);
		return JailService.toJailing(
			query<JailingRow>(
				`SELECT id, jailing_id AS jailingId, user_id AS userId,
				        bail_amount AS bailAmount, paid, muted_until AS mutedUntil
				 FROM jailings WHERE jailing_id = ? AND paid = 0 AND muted_until > ? LIMIT 1`,
				[normalizeJailingId(jailingId), now],
			)[0],
		);
	}

	/**
	 * Logs a jail-related event to the database for audit trail.
	 *
	 * @param userId - Telegram user ID being jailed/unjailed
	 * @param eventType - Type of event (jailed, unjailed, auto_unjailed, bail_paid)
	 * @param adminId - Optional admin user ID who performed the action
	 * @param durationMinutes - Optional duration of jail in minutes
	 * @param bailAmount - Bail amount in JUNO (default canonical amount for jailing)
	 * @param paidByUserId - Optional user ID who paid bail
	 * @param paymentTx - Optional blockchain transaction hash
	 * @param metadata - Optional additional metadata
	 *
	 * @example
	 * ```typescript
	 * // Log user jailed for 60 minutes with bail option
	 * JailService.logJailEvent(123456, 'jailed', 789012, 60, 10.0);
	 * ```
	 */
	static logJailEvent(
		userId: number,
		eventType: "jailed" | "unjailed" | "auto_unjailed" | "bail_paid",
		adminId?: number,
		durationMinutes?: number,
		bailAmount: number = eventType === "jailed" ? DEFAULT_JAIL_BAIL_AMOUNT : 0,
		paidByUserId?: number,
		paymentTx?: string,
		metadata?: Record<string, any>,
	): void {
		execute(
			`INSERT INTO jail_events (user_id, event_type, admin_id, duration_minutes, bail_amount, paid_by_user_id, payment_tx, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				userId,
				eventType,
				adminId || null,
				durationMinutes || null,
				AmountPrecision.toDbMicro(bailAmount),
				paidByUserId || null,
				paymentTx || null,
				metadata ? JSON.stringify(metadata) : null,
			],
		);

		StructuredLogger.logSecurityEvent(`User ${eventType}`, {
			userId,
			operation: eventType,
			amount: bailAmount.toString(),
		});
	}

	/**
	 * Retrieves all currently active jails with remaining time.
	 *
	 * @returns Array of jailed users with calculated time remaining
	 *
	 * @example
	 * ```typescript
	 * const jails = JailService.getActiveJails();
	 * jails.forEach(jail => {
	 *   console.log(`User ${jail.id} has ${jail.timeRemaining}s remaining`);
	 * });
	 * ```
	 */
	static getActiveJails(): Array<User & { timeRemaining: number }> {
		const now = Math.floor(Date.now() / 1000);
		const jailedUsers = query<User>(
			"SELECT * FROM users WHERE muted_until IS NOT NULL AND muted_until > ?",
			[now],
		);

		return jailedUsers.map((user) => ({
			...user,
			timeRemaining: (user.muted_until ?? now) - now,
		}));
	}

	/**
	 * Retrieves jail event history for a specific user.
	 *
	 * @param userId - Telegram user ID
	 * @param limit - Maximum number of events to return (default 10)
	 * @returns Array of jail events ordered by most recent first
	 */
	static getUserJailEvents(userId: number, limit: number = 10): JailEvent[] {
		return query<JailEvent>(
			`SELECT
				id,
				user_id AS userId,
				event_type AS eventType,
				admin_id AS adminId,
				duration_minutes AS durationMinutes,
				bail_amount AS bailAmount,
				paid_by_user_id AS paidByUserId,
				payment_tx AS paymentTx,
				timestamp,
				metadata
			FROM jail_events
			WHERE user_id = ?
			ORDER BY timestamp DESC
			LIMIT ?`,
			[userId, limit],
		).map(toJunoJailEvent);
	}

	/**
	 * Gets the bail amount recorded for a user's current jail.
	 *
	 * @param userId - Telegram user ID
	 * @returns The recorded bail amount, or the canonical default
	 */
	static getCurrentBailAmount(userId: number): number {
		const active = JailService.getActiveJailing(userId);
		if (active) return active.bailAmount;

		// Legacy fallback for jails predating the `jailings` table.
		const event = query<{ bailAmount: number }>(
			`SELECT bail_amount AS bailAmount
			 FROM jail_events
			 WHERE user_id = ? AND event_type = 'jailed'
			 ORDER BY timestamp DESC, id DESC LIMIT 1`,
			[userId],
		)[0];
		return event
			? AmountPrecision.fromDbMicro(event.bailAmount)
			: DEFAULT_JAIL_BAIL_AMOUNT;
	}

	/**
	 * Mark a jailing paid and release its user atomically. The unique payment-tx
	 * index rejects reuse of a hash.
	 *
	 * @param jailingId - The user-facing jailing id (from the tx memo)
	 * @param paidByUserId - Telegram user who submitted the payment
	 * @param paymentTx - Verified transaction hash
	 * @returns Whether it was recorded, whether a duplicate tx caused failure, and the user
	 */
	static payJailing(
		jailingId: string,
		paidByUserId: number | undefined,
		paymentTx: string,
	): {
		success: boolean;
		duplicate: boolean;
		userId?: number;
		notFound?: boolean;
		alreadyPaid?: boolean;
	} {
		const normalized = normalizeJailingId(jailingId);
		try {
			let userId: number | undefined;
			let outcome = "not_found";
			transaction(() => {
				const row = query<{
					id: number;
					userId: number;
					bailAmount: number;
					paid: number;
					mutedUntil: number;
					reason: string | null;
				}>(
					`SELECT id, user_id AS userId, bail_amount AS bailAmount, paid,
					        muted_until AS mutedUntil, reason
					 FROM jailings WHERE jailing_id = ?`,
					[normalized],
				)[0];
				if (!row) return;
				userId = row.userId;
				if (row.paid) {
					outcome = "already_paid";
					return;
				}

				const now = Math.floor(Date.now() / 1000);
				if (row.mutedUntil <= now) return; // expired: no longer payable

				execute(
					`UPDATE jailings SET paid = 1, payment_tx = ?, paid_by_user_id = ?, paid_at = ?
					 WHERE id = ?`,
					[paymentTx, paidByUserId ?? null, now, row.id],
				);
				JailService.logJailEvent(
					row.userId,
					"bail_paid",
					undefined,
					undefined,
					AmountPrecision.fromDbMicro(row.bailAmount),
					paidByUserId,
					paymentTx,
				);
				execute(
					"UPDATE users SET muted_until = NULL, updated_at = ? WHERE id = ?",
					[now, row.userId],
				);
				// A bought-out cooldown must not survive as accrued debt.
				if (row.reason === REJOIN_COOLDOWN_REASON) {
					clearOnBuyout(row.userId);
				}
				outcome = "paid";
			});

			if (outcome !== "paid") {
				return {
					success: false,
					duplicate: false,
					userId,
					notFound: outcome === "not_found",
					alreadyPaid: outcome === "already_paid",
				};
			}
			return { success: true, duplicate: false, userId };
		} catch (error) {
			const duplicate =
				error instanceof Error &&
				error.message.includes("UNIQUE constraint failed") &&
				(error.message.includes("payment_tx") ||
					error.message.includes("idx_jailings_payment_tx"));
			return { success: false, duplicate };
		}
	}

	/** Release a jailed user's Telegram restriction (used by the deposit listener). */
	static async releaseJailingTelegram(userId: number): Promise<void> {
		if (!config.groupChatId || !JailService.bot) return;
		try {
			await releaseMember({
				telegram: JailService.bot.telegram,
				chatId: config.groupChatId,
				userId,
			});
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId,
				operation: "release_jailing_telegram",
			});
		}
	}

	/**
	 * Check whether a transaction hash has already paid bail for any user.
	 *
	 * @param paymentTx - Blockchain transaction hash
	 * @returns True when the hash is already recorded as a bail payment
	 */
	static isBailPaymentUsed(paymentTx: string): boolean {
		return Boolean(
			query<{ id: number }>(
				"SELECT id FROM jailings WHERE payment_tx = ? LIMIT 1",
				[paymentTx],
			)[0] ||
				query<{ id: number }>(
					"SELECT id FROM jail_events WHERE event_type = 'bail_paid' AND payment_tx = ? LIMIT 1",
					[paymentTx],
				)[0],
		);
	}

	/**
	 * Retrieves all jail events across all users for statistics.
	 *
	 * @param limit - Maximum number of events to return (default 100)
	 * @returns Array of jail events ordered by most recent first
	 */
	static getAllJailEvents(limit: number = 100): JailEvent[] {
		return query<JailEvent>(
			`SELECT
				id,
				user_id AS userId,
				event_type AS eventType,
				admin_id AS adminId,
				duration_minutes AS durationMinutes,
				bail_amount AS bailAmount,
				paid_by_user_id AS paidByUserId,
				payment_tx AS paymentTx,
				timestamp,
				metadata
			FROM jail_events
			ORDER BY timestamp DESC
			LIMIT ?`,
			[limit],
		).map(toJunoJailEvent);
	}

	/**
	 * Cleans up expired jails and automatically restores user permissions.
	 * Should be called periodically (e.g., via setInterval or cron job).
	 *
	 * Process:
	 * 1. Find all users whose jail time has expired
	 * 2. Clear muted_until field in database
	 * 3. Restore Telegram chat permissions
	 * 4. Log auto-unjail event
	 * 5. Notify user via DM
	 *
	 * @throws Will log errors but continue processing other users if individual operations fail
	 *
	 * @example
	 * ```typescript
	 * // Run every minute
	 * setInterval(() => JailService.cleanExpiredJails(), 60000);
	 * ```
	 */
	static async cleanExpiredJails(): Promise<void> {
		try {
			const now = Math.floor(Date.now() / 1000);

			// Find users whose jail time has expired
			const expiredJails = query<User>(
				"SELECT * FROM users WHERE muted_until IS NOT NULL AND muted_until <= ?",
				[now],
			);

			if (expiredJails.length === 0) {
				return;
			}

			StructuredLogger.logUserAction("Cleaning expired jails", {
				operation: "clean_expired_jails",
				amount: expiredJails.length.toString(),
			});

			for (const user of expiredJails) {
				try {
					// Clear the muted_until field
					execute(
						"UPDATE users SET muted_until = NULL, updated_at = ? WHERE id = ?",
						[now, user.id],
					);

					// Restore the permissions captured when the jail was applied.
					// releaseMute leaves the restriction if another mute kind is
					// still active; a missing binding leaves Telegram's own
					// until_date to lift it.
					if (config.groupChatId) {
						try {
							const released = await releaseMute(
								{
									telegram: JailService.bot.telegram,
									chatId: config.groupChatId,
									userId: user.id,
								},
								"jail",
							);
							// A jail applied before this service stored no binding;
							// fall back to standard member rights once.
							if (!released && !hasStoredBinding(user.id)) {
								await JailService.bot.telegram.restrictChatMember(
									config.groupChatId,
									user.id,
									{ permissions: CHAT_RESTORE_PERMISSIONS },
								);
							}

							StructuredLogger.logSecurityEvent("User auto-unjailed", {
								userId: user.id,
								operation: "auto_unjailed",
								restored: released,
							});

							// Log the auto-unjail event
							JailService.logJailEvent(user.id, "auto_unjailed");

							// Notify the user their jail time is up
							try {
								await JailService.bot.telegram.sendMessage(
									user.id,
									" Your jail time has expired. You can now send messages in the group again.",
								);
							} catch (_dmError) {
								// User might have blocked the bot, that's okay
								StructuredLogger.logDebug(
									"Could not notify user of jail expiry",
									{
										userId: user.id,
									},
								);
							}
						} catch (error) {
							StructuredLogger.logError(error as Error, {
								userId: user.id,
								operation: "restore_permissions",
							});
							// Continue with other users even if one fails
						}
					}
				} catch (error) {
					StructuredLogger.logError(error as Error, {
						userId: user.id,
						operation: "process_expired_jail",
					});
				}
			}
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				operation: "clean_expired_jails",
			});
		}
	}

	/**
	 * Apply a Telegram chat restriction matching an existing jail. The database
	 * `muted_until` must already be set (via `jailUser`); this captures the
	 * member's current permissions so `cleanExpiredJails` can restore exactly
	 * what they had, and clamps the deadline past Telegram's permanent threshold.
	 *
	 * @param userId - Telegram user ID to mute
	 * @param chatId - Chat to mute in
	 * @param mutedUntil - Jail expiry (unix seconds)
	 * @param kind - Mute source (defaults to a plain jail)
	 */
	static async applyTelegramMute(
		userId: number,
		chatId: number,
		mutedUntil: number,
		kind: "jail" | "reaction_spam" | "identity_block" | "flood" = "jail",
	): Promise<void> {
		await muteMember(
			{ telegram: JailService.bot.telegram, chatId, userId },
			kind,
			mutedUntil,
		);
	}
}
