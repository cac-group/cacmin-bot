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
import { execute, query } from "../database";
import type { JailEvent, User } from "../types";
import { StructuredLogger } from "../utils/logger";
import { PriceService } from "./priceService";

/** Canonical bail amount for jails without an explicitly configured amount. */
export const DEFAULT_JAIL_BAIL_AMOUNT = 69.42;

export interface JailUserRequest {
	userId: number;
	durationMinutes: number;
	adminId?: number;
	bailAmount?: number;
	paidByUserId?: number;
	paymentTx?: string;
	metadata?: Record<string, any>;
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

		return { mutedUntil, bailAmount };
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
				bailAmount,
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
		);
	}

	/**
	 * Gets the bail amount recorded for a user's current jail.
	 *
	 * @param userId - Telegram user ID
	 * @returns The recorded bail amount, or the canonical default
	 */
	static getCurrentBailAmount(userId: number): number {
		const event = query<{ bailAmount: number }>(
			`SELECT bail_amount AS bailAmount
			 FROM jail_events
			 WHERE user_id = ? AND event_type = 'jailed'
			 ORDER BY timestamp DESC, id DESC LIMIT 1`,
			[userId],
		)[0];
		return event ? event.bailAmount : DEFAULT_JAIL_BAIL_AMOUNT;
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
		);
	}

	/**
	 * Calculates bail amount based on jail duration using USD-based pricing.
	 * Converts USD to JUNO using rolling average price from CoinGecko.
	 *
	 * @param durationMinutes - Duration of jail in minutes
	 * @returns Promise resolving to bail amount in JUNO tokens
	 *
	 * @example
	 * ```typescript
	 * const bail = await JailService.calculateBailAmount(60); // ~1.0 JUNO for 1 hour at $0.10/min
	 * ```
	 */
	static async calculateBailAmount(durationMinutes: number): Promise<number> {
		return PriceService.calculateBailAmount(durationMinutes);
	}

	/**
	 * Synchronous fallback for bail calculation (uses cached/default values).
	 * Use this only when async is not possible.
	 *
	 * @param durationMinutes - Duration of jail in minutes
	 * @returns Bail amount in JUNO tokens
	 */
	static calculateBailAmountSync(durationMinutes: number): number {
		const perMinuteUsd = PriceService.getFineConfigUsd("jail_per_minute");
		const minimumUsd = PriceService.getFineConfigUsd("jail_minimum");
		const totalUsd = Math.max(minimumUsd, durationMinutes * perMinuteUsd);

		// Use a default price if we can't get the rolling average synchronously
		// This will be updated on next async call
		const defaultPrice = 0.1; // $0.10 per JUNO as fallback
		return Math.round((totalUsd / defaultPrice) * 100) / 100;
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

					// Try to restore permissions in the configured group chat
					if (config.groupChatId) {
						try {
							await JailService.bot.telegram.restrictChatMember(
								config.groupChatId,
								user.id,
								{
									permissions: {
										can_send_messages: true,
										can_send_audios: true,
										can_send_documents: true,
										can_send_photos: true,
										can_send_videos: true,
										can_send_video_notes: true,
										can_send_voice_notes: true,
										can_send_polls: true,
										can_send_other_messages: true,
										can_add_web_page_previews: true,
										can_change_info: false,
										can_invite_users: true,
										can_pin_messages: false,
										can_manage_topics: false,
									},
								},
							);

							StructuredLogger.logSecurityEvent("User auto-unjailed", {
								userId: user.id,
								operation: "auto_unjailed",
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
}
