/**
 * Duel game service module.
 * Manages 2-player wagered duels with optional consequences for losers.
 * Uses the same cryptographic RNG as the roll game.
 *
 * @module services/duelService
 */

import type { Context, Telegraf } from "telegraf";
import { execute, get, query } from "../database";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { JailService } from "./jailService";
import { LedgerService, TransactionType } from "./ledgerService";
import { TransactionLockService } from "./transactionLock";
import { addUserRestriction } from "./userService";

// Duel timeout in seconds (5 minutes)
export const DUEL_TIMEOUT_SECONDS = 300;

// Minimum and maximum wager amounts
export const MIN_WAGER = 0.1;
export const MAX_WAGER = 50;

// Consequence types that can be applied to losers
export type DuelConsequence =
	| "none" // No additional penalty
	| "jail" // Loser gets jailed
	| "muted" // Loser gets muted (no messages)
	| "no_stickers" // Loser can't send stickers
	| "no_media" // Loser can't send any media
	| "no_gifs" // Loser can't send GIFs
	| "no_forwarding"; // Loser can't forward messages

// Default durations for consequences (in minutes)
export const DEFAULT_CONSEQUENCE_DURATIONS: Record<DuelConsequence, number> = {
	none: 0,
	jail: 60, // 1 hour
	muted: 30, // 30 minutes
	no_stickers: 60, // 1 hour
	no_media: 60, // 1 hour
	no_gifs: 60, // 1 hour
	no_forwarding: 60, // 1 hour
};

export interface Duel {
	id: number;
	challengerId: number;
	opponentId: number;
	wagerAmount: number;
	loserConsequence: DuelConsequence;
	consequenceDuration?: number;
	consequenceAction?: string;
	status:
		| "pending"
		| "accepted"
		| "rejected"
		| "cancelled"
		| "expired"
		| "completed";
	winnerId?: number;
	loserId?: number;
	rollChallenger?: string;
	rollOpponent?: string;
	rollIdChallenger?: number;
	rollIdOpponent?: number;
	chatId: number;
	messageId?: number;
	createdAt: number;
	expiresAt: number;
	resolvedAt?: number;
}

// DB row format (snake_case)
interface DuelRow {
	id: number;
	challenger_id: number;
	opponent_id: number;
	wager_amount: number;
	loser_consequence: string;
	consequence_duration?: number;
	consequence_action?: string;
	status: string;
	winner_id?: number;
	loser_id?: number;
	roll_challenger?: string;
	roll_opponent?: string;
	roll_id_challenger?: number;
	roll_id_opponent?: number;
	chat_id: number;
	message_id?: number;
	created_at: number;
	expires_at: number;
	resolved_at?: number;
}

/**
 * Convert DB row to Duel interface
 */
function rowToDuel(row: DuelRow): Duel {
	return {
		id: row.id,
		challengerId: row.challenger_id,
		opponentId: row.opponent_id,
		wagerAmount: row.wager_amount,
		loserConsequence: row.loser_consequence as DuelConsequence,
		consequenceDuration: row.consequence_duration,
		consequenceAction: row.consequence_action,
		status: row.status as Duel["status"],
		winnerId: row.winner_id,
		loserId: row.loser_id,
		rollChallenger: row.roll_challenger,
		rollOpponent: row.roll_opponent,
		rollIdChallenger: row.roll_id_challenger,
		rollIdOpponent: row.roll_id_opponent,
		chatId: row.chat_id,
		messageId: row.message_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		resolvedAt: row.resolved_at,
	};
}

export class DuelService {
	private static bot: Telegraf<Context>;

	/**
	 * Initialize the duel service with bot instance
	 */
	static initialize(bot: Telegraf<Context>): void {
		DuelService.bot = bot;
	}

	/**
	 * Check if a user has a pending outgoing duel
	 */
	static hasOutgoingDuel(userId: number): boolean {
		const row = get<{ count: number }>(
			`SELECT COUNT(*) as count FROM duels
			WHERE challenger_id = ? AND status = 'pending'`,
			[userId],
		);
		return (row?.count || 0) > 0;
	}

	/**
	 * Check if a user has a pending incoming duel
	 */
	static hasIncomingDuel(userId: number): boolean {
		const row = get<{ count: number }>(
			`SELECT COUNT(*) as count FROM duels
			WHERE opponent_id = ? AND status = 'pending'`,
			[userId],
		);
		return (row?.count || 0) > 0;
	}

	/**
	 * Get a user's pending outgoing duel
	 */
	static getOutgoingDuel(userId: number): Duel | undefined {
		const row = get<DuelRow>(
			`SELECT * FROM duels WHERE challenger_id = ? AND status = 'pending'`,
			[userId],
		);
		return row ? rowToDuel(row) : undefined;
	}

	/**
	 * Get a user's pending incoming duel
	 */
	static getIncomingDuel(userId: number): Duel | undefined {
		const row = get<DuelRow>(
			`SELECT * FROM duels WHERE opponent_id = ? AND status = 'pending'`,
			[userId],
		);
		return row ? rowToDuel(row) : undefined;
	}

	/**
	 * Get a duel by ID
	 */
	static getDuel(duelId: number): Duel | undefined {
		const row = get<DuelRow>(`SELECT * FROM duels WHERE id = ?`, [duelId]);
		return row ? rowToDuel(row) : undefined;
	}

	/**
	 * Create a new duel challenge
	 */
	static async createDuel(
		challengerId: number,
		opponentId: number,
		wagerAmount: number,
		chatId: number,
		consequence: DuelConsequence = "none",
		consequenceDuration?: number,
	): Promise<{ success: boolean; duel?: Duel; error?: string }> {
		// Validate challenger doesn't already have an outgoing duel
		if (DuelService.hasOutgoingDuel(challengerId)) {
			return {
				success: false,
				error: "You already have a pending duel challenge",
			};
		}

		// Validate opponent doesn't already have an incoming duel
		if (DuelService.hasIncomingDuel(opponentId)) {
			return {
				success: false,
				error: "That user already has a pending duel challenge",
			};
		}

		// Cannot duel yourself
		if (challengerId === opponentId) {
			return { success: false, error: "You cannot duel yourself" };
		}

		// Validate wager amount
		if (wagerAmount < MIN_WAGER) {
			return { success: false, error: `Minimum wager is ${MIN_WAGER} JUNO` };
		}
		if (wagerAmount > MAX_WAGER) {
			return { success: false, error: `Maximum wager is ${MAX_WAGER} JUNO` };
		}

		// Check challenger balance
		const challengerBalance = await LedgerService.getUserBalance(challengerId);
		if (!AmountPrecision.isGreaterOrEqual(challengerBalance, wagerAmount)) {
			return { success: false, error: "Insufficient balance to create duel" };
		}

		// Use default duration if not specified
		const duration =
			consequenceDuration || DEFAULT_CONSEQUENCE_DURATIONS[consequence];
		const expiresAt = Math.floor(Date.now() / 1000) + DUEL_TIMEOUT_SECONDS;

		const result = execute(
			`INSERT INTO duels (
				challenger_id, opponent_id, wager_amount, loser_consequence,
				consequence_duration, chat_id, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				challengerId,
				opponentId,
				wagerAmount,
				consequence,
				duration,
				chatId,
				expiresAt,
			],
		);

		const duelId = result.lastInsertRowid as number;
		const duel = DuelService.getDuel(duelId);

		StructuredLogger.logTransaction("Duel created", {
			userId: challengerId,
			operation: "duel_create",
			duelId: duelId.toString(),
			opponentId: opponentId.toString(),
			wagerAmount: wagerAmount.toString(),
			consequence,
		});

		return { success: true, duel };
	}

	/**
	 * Update the message ID for a duel (after posting the challenge)
	 */
	static updateMessageId(duelId: number, messageId: number): void {
		execute(`UPDATE duels SET message_id = ? WHERE id = ?`, [
			messageId,
			duelId,
		]);
	}

	/**
	 * Cancel a pending duel (by challenger)
	 */
	static cancelDuel(
		duelId: number,
		userId: number,
	): { success: boolean; error?: string } {
		const duel = DuelService.getDuel(duelId);
		if (!duel) {
			return { success: false, error: "Duel not found" };
		}
		if (duel.challengerId !== userId) {
			return {
				success: false,
				error: "Only the challenger can cancel the duel",
			};
		}
		if (duel.status !== "pending") {
			return { success: false, error: "This duel is no longer pending" };
		}

		execute(
			`UPDATE duels SET status = 'cancelled', resolved_at = ? WHERE id = ?`,
			[Math.floor(Date.now() / 1000), duelId],
		);

		StructuredLogger.logTransaction("Duel cancelled", {
			userId,
			operation: "duel_cancel",
			duelId: duelId.toString(),
		});

		return { success: true };
	}

	/**
	 * Reject a pending duel (by opponent)
	 */
	static rejectDuel(
		duelId: number,
		userId: number,
	): { success: boolean; error?: string } {
		const duel = DuelService.getDuel(duelId);
		if (!duel) {
			return { success: false, error: "Duel not found" };
		}
		if (duel.opponentId !== userId) {
			return {
				success: false,
				error: "Only the challenged user can reject this duel",
			};
		}
		if (duel.status !== "pending") {
			return { success: false, error: "This duel is no longer pending" };
		}

		execute(
			`UPDATE duels SET status = 'rejected', resolved_at = ? WHERE id = ?`,
			[Math.floor(Date.now() / 1000), duelId],
		);

		StructuredLogger.logTransaction("Duel rejected", {
			userId,
			operation: "duel_reject",
			duelId: duelId.toString(),
		});

		return { success: true };
	}

	/**
	 * Accept and execute a duel
	 * Returns the result including winner/loser and their rolls
	 */
	static async acceptAndExecuteDuel(
		duelId: number,
		userId: number,
		generateRollFn: (
			timestamp: number,
			userId: number,
			messageId: number,
		) => {
			rollNumber: string;
			rollId: number;
			verificationHash: string;
		},
	): Promise<{
		success: boolean;
		error?: string;
		duel?: Duel;
		challengerRoll?: string;
		opponentRoll?: string;
	}> {
		const duel = DuelService.getDuel(duelId);
		if (!duel) {
			return { success: false, error: "Duel not found" };
		}
		if (duel.opponentId !== userId) {
			return {
				success: false,
				error: "Only the challenged user can accept this duel",
			};
		}
		if (duel.status !== "pending") {
			return { success: false, error: "This duel is no longer pending" };
		}

		// Check opponent balance
		const opponentBalance = await LedgerService.getUserBalance(userId);
		if (!AmountPrecision.isGreaterOrEqual(opponentBalance, duel.wagerAmount)) {
			return { success: false, error: "Insufficient balance to accept duel" };
		}

		// Re-check challenger balance
		const challengerBalance = await LedgerService.getUserBalance(
			duel.challengerId,
		);
		if (
			!AmountPrecision.isGreaterOrEqual(challengerBalance, duel.wagerAmount)
		) {
			// Cancel the duel since challenger no longer has funds
			execute(
				`UPDATE duels SET status = 'cancelled', resolved_at = ? WHERE id = ?`,
				[Math.floor(Date.now() / 1000), duelId],
			);
			return {
				success: false,
				error: "Challenger no longer has sufficient funds - duel cancelled",
			};
		}

		// Acquire locks for both users
		const challengerLock = await TransactionLockService.acquireLock(
			duel.challengerId,
			"duel",
			duel.wagerAmount,
		);
		if (!challengerLock) {
			return { success: false, error: "Challenger has a pending transaction" };
		}

		const opponentLock = await TransactionLockService.acquireLock(
			userId,
			"duel",
			duel.wagerAmount,
		);
		if (!opponentLock) {
			await TransactionLockService.releaseLock(duel.challengerId);
			return { success: false, error: "You have a pending transaction" };
		}

		try {
			// Generate rolls for both users
			const now = Math.floor(Date.now() / 1000);
			const challengerResult = generateRollFn(
				now,
				duel.challengerId,
				duel.messageId || 0,
			);
			const opponentResult = generateRollFn(now, userId, duel.messageId || 0);

			// Determine winner (higher number wins, tie goes to challenger as defender advantage)
			const challengerNum = parseInt(challengerResult.rollNumber, 10);
			const opponentNum = parseInt(opponentResult.rollNumber, 10);

			let winnerId: number;
			let loserId: number;

			if (challengerNum >= opponentNum) {
				winnerId = duel.challengerId;
				loserId = userId;
			} else {
				winnerId = userId;
				loserId = duel.challengerId;
			}

			// Transfer wager from loser to winner
			const txResult = await LedgerService.transferBetweenUsers(
				loserId,
				winnerId,
				duel.wagerAmount,
				`Duel #${duel.id} - ${loserId === duel.challengerId ? "challenger" : "opponent"} lost`,
			);

			if (!txResult.success) {
				throw new Error(txResult.error || "Transfer failed");
			}

			// Update transaction type to gambling
			execute(
				`UPDATE transactions SET transaction_type = ?
				WHERE (from_user_id = ? OR to_user_id = ?)
				AND created_at = (SELECT MAX(created_at) FROM transactions WHERE from_user_id = ? OR to_user_id = ?)`,
				[TransactionType.GAMBLING, loserId, winnerId, loserId, winnerId],
			);

			// Update duel record
			execute(
				`UPDATE duels SET
					status = 'completed',
					winner_id = ?,
					loser_id = ?,
					roll_challenger = ?,
					roll_opponent = ?,
					roll_id_challenger = ?,
					roll_id_opponent = ?,
					resolved_at = ?
				WHERE id = ?`,
				[
					winnerId,
					loserId,
					challengerResult.rollNumber,
					opponentResult.rollNumber,
					challengerResult.rollId,
					opponentResult.rollId,
					now,
					duelId,
				],
			);

			// Apply consequence to loser if any
			if (duel.loserConsequence !== "none") {
				await DuelService.applyConsequence(
					loserId,
					duel.loserConsequence,
					duel.consequenceDuration ||
						DEFAULT_CONSEQUENCE_DURATIONS[duel.loserConsequence],
					duel.chatId,
				);
			}

			// Release locks
			await TransactionLockService.releaseLock(duel.challengerId);
			await TransactionLockService.releaseLock(userId);

			StructuredLogger.logTransaction("Duel completed", {
				userId: winnerId,
				operation: "duel_complete",
				duelId: duelId.toString(),
				winnerId: winnerId.toString(),
				loserId: loserId.toString(),
				wagerAmount: duel.wagerAmount.toString(),
				consequence: duel.loserConsequence,
			});

			const updatedDuel = DuelService.getDuel(duelId);
			return {
				success: true,
				duel: updatedDuel,
				challengerRoll: challengerResult.rollNumber,
				opponentRoll: opponentResult.rollNumber,
			};
		} catch (error) {
			// Release locks on error
			await TransactionLockService.releaseLock(duel.challengerId);
			await TransactionLockService.releaseLock(userId);

			logger.error("Duel execution failed", {
				duelId,
				error: error instanceof Error ? error.message : String(error),
			});

			return { success: false, error: "Duel execution failed" };
		}
	}

	/**
	 * Apply a consequence restriction to the loser
	 */
	private static async applyConsequence(
		userId: number,
		consequence: DuelConsequence,
		durationMinutes: number,
		chatId: number,
	): Promise<void> {
		const untilTimestamp = Math.floor(Date.now() / 1000) + durationMinutes * 60;

		if (consequence === "jail") {
			// Use the jail system
			execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
				untilTimestamp,
				Math.floor(Date.now() / 1000),
				userId,
			]);

			JailService.logJailEvent(
				userId,
				"jailed",
				undefined,
				durationMinutes,
				0,
				undefined,
				undefined,
				{
					reason: "duel_loss",
				},
			);

			// Actually restrict in Telegram
			try {
				await DuelService.bot.telegram.restrictChatMember(chatId, userId, {
					permissions: {
						can_send_messages: false,
						can_send_audios: false,
						can_send_documents: false,
						can_send_photos: false,
						can_send_videos: false,
						can_send_video_notes: false,
						can_send_voice_notes: false,
						can_send_polls: false,
						can_send_other_messages: false,
						can_add_web_page_previews: false,
						can_change_info: false,
						can_invite_users: false,
						can_pin_messages: false,
						can_manage_topics: false,
					},
					until_date: untilTimestamp,
				});
			} catch (error) {
				logger.error("Failed to apply Telegram restriction for duel jail", {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else if (consequence === "muted") {
			// Apply mute via restriction
			addUserRestriction(userId, "muted", undefined, undefined, untilTimestamp);

			// Telegram restriction
			try {
				await DuelService.bot.telegram.restrictChatMember(chatId, userId, {
					permissions: {
						can_send_messages: false,
						can_send_audios: false,
						can_send_documents: false,
						can_send_photos: false,
						can_send_videos: false,
						can_send_video_notes: false,
						can_send_voice_notes: false,
						can_send_polls: false,
						can_send_other_messages: false,
						can_add_web_page_previews: false,
						can_change_info: false,
						can_invite_users: false,
						can_pin_messages: false,
						can_manage_topics: false,
					},
					until_date: untilTimestamp,
				});
			} catch (error) {
				logger.error("Failed to apply Telegram restriction for duel mute", {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else {
			// Other restrictions (stickers, media, etc.) - use the restriction service
			addUserRestriction(
				userId,
				consequence,
				undefined,
				undefined,
				untilTimestamp,
			);
		}

		logger.info("Duel consequence applied", {
			userId,
			consequence,
			durationMinutes,
			expiresAt: untilTimestamp,
		});
	}

	/**
	 * Clean up expired duels (mark them as expired)
	 */
	static async cleanExpiredDuels(): Promise<number> {
		const now = Math.floor(Date.now() / 1000);

		const result = execute(
			`UPDATE duels SET status = 'expired', resolved_at = ?
			WHERE status = 'pending' AND expires_at <= ?`,
			[now, now],
		);

		if (result.changes > 0) {
			logger.info("Expired duels cleaned up", { count: result.changes });
		}

		return result.changes;
	}

	/**
	 * Get duel statistics for a user
	 */
	static getUserDuelStats(userId: number): {
		totalDuels: number;
		wins: number;
		losses: number;
		totalWagered: number;
		totalWon: number;
		netProfit: number;
	} {
		const stats = get<{
			total: number;
			wins: number;
			losses: number;
		}>(
			`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) as wins,
				SUM(CASE WHEN loser_id = ? THEN 1 ELSE 0 END) as losses
			FROM duels
			WHERE status = 'completed'
			AND (challenger_id = ? OR opponent_id = ?)`,
			[userId, userId, userId, userId],
		);

		const wagered = get<{ total: number }>(
			`SELECT COALESCE(SUM(wager_amount), 0) as total FROM duels
			WHERE status = 'completed'
			AND (challenger_id = ? OR opponent_id = ?)`,
			[userId, userId],
		);

		const won = get<{ total: number }>(
			`SELECT COALESCE(SUM(wager_amount), 0) as total FROM duels
			WHERE status = 'completed' AND winner_id = ?`,
			[userId],
		);

		const lost = get<{ total: number }>(
			`SELECT COALESCE(SUM(wager_amount), 0) as total FROM duels
			WHERE status = 'completed' AND loser_id = ?`,
			[userId],
		);

		return {
			totalDuels: stats?.total || 0,
			wins: stats?.wins || 0,
			losses: stats?.losses || 0,
			totalWagered: wagered?.total || 0,
			totalWon: won?.total || 0,
			netProfit: (won?.total || 0) - (lost?.total || 0),
		};
	}

	/**
	 * Get recent duels for a user
	 */
	static getRecentDuels(userId: number, limit: number = 5): Duel[] {
		const rows = query<DuelRow>(
			`SELECT * FROM duels
			WHERE (challenger_id = ? OR opponent_id = ?)
			AND status = 'completed'
			ORDER BY resolved_at DESC
			LIMIT ?`,
			[userId, userId, limit],
		);

		return rows.map(rowToDuel);
	}
}
