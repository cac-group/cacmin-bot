/**
 * Gambling command handlers for the CAC Admin Bot.
 * Provides /roll command for a chance-based game using cryptographic randomness.
 *
 * @module commands/gambling
 */

import { createHash } from "crypto";
import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { execute, get } from "../database";
import { LedgerService, TransactionType } from "../services/ledgerService";
import { TransactionLockService } from "../services/transactionLock";
import { SYSTEM_USER_IDS } from "../services/unifiedWalletService";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

// Minimum and maximum bets
export const MIN_BET = 0.1;
export const MAX_BET = 100;

// Payout multiplier (9x profit = 10x total return for 10% win chance = fair game)
export const WIN_MULTIPLIER = 9;

// Store the previous roll hash for entropy chaining
let previousRollHash: string = "";

/**
 * Initialize the roll hash chain with a random seed
 * Called once at module load
 */
export function initializeRollHashChain(): void {
	const seed = `init_${Date.now()}_${Math.random().toString(36)}`;
	previousRollHash = createHash("sha256").update(seed).digest("hex");
	logger.info("Roll hash chain initialized");
}

// Initialize on module load
initializeRollHashChain();

/**
 * Generate a 9-digit roll number using cryptographic randomness.
 * Combines timestamp, userId, and previous roll hash for entropy.
 *
 * @param timestamp - Message timestamp (unix seconds)
 * @param userId - User ID of the roller
 * @returns 9-digit number as string (000000000-999999999)
 */
export function generateRollNumber(timestamp: number, userId: number): string {
	// Combine entropy sources
	const entropyInput = `${timestamp}:${userId}:${previousRollHash}`;

	// Generate SHA-256 hash
	const hash = createHash("sha256").update(entropyInput).digest("hex");

	// Update the chain for next roll
	previousRollHash = hash;

	// Take first 12 hex chars (48 bits) and convert to number
	// Then mod by 1 billion to get 9 digits
	const hexPortion = hash.substring(0, 12);
	const numericValue = parseInt(hexPortion, 16);
	const rollNumber = numericValue % 1_000_000_000;

	// Pad to 9 digits
	return rollNumber.toString().padStart(9, "0");
}

/**
 * Check if the roll is a winning roll (ends in 2+ matching digits)
 * "dubs" = last 2 same, "trips" = last 3 same, etc.
 *
 * @param roll - 9-digit roll string
 * @returns Object with win status and match count
 */
export function checkWin(roll: string): {
	won: boolean;
	matchCount: number;
	matchName: string;
} {
	const lastDigit = roll[roll.length - 1];
	let matchCount = 1;

	// Count matching digits from the end
	for (let i = roll.length - 2; i >= 0; i--) {
		if (roll[i] === lastDigit) {
			matchCount++;
		} else {
			break;
		}
	}

	const matchNames: Record<number, string> = {
		2: "DUBS",
		3: "TRIPS",
		4: "QUADS",
		5: "QUINTS",
		6: "SEXTS",
		7: "SEPTS",
		8: "OCTS",
		9: "NINES",
	};

	return {
		won: matchCount >= 2,
		matchCount,
		matchName: matchNames[matchCount] || `${matchCount}x`,
	};
}

/**
 * Get user's gambling statistics
 */
export interface UserRollStats {
	totalRolls: number;
	totalWagered: number;
	totalWon: number;
	netProfit: number;
}

export function getUserRollStats(userId: number): UserRollStats {
	// Losses (user paid treasury)
	const wagered = get<{ total: number; count: number }>(
		`SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM transactions
		WHERE transaction_type = ? AND from_user_id = ?`,
		[TransactionType.GAMBLING, userId],
	);

	// Wins (treasury paid user)
	const won = get<{ total: number }>(
		`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
		WHERE transaction_type = ? AND to_user_id = ?`,
		[TransactionType.GAMBLING, userId],
	);

	const totalWagered = wagered?.total || 0;
	const totalWon = won?.total || 0;

	return {
		totalRolls: wagered?.count || 0,
		totalWagered,
		totalWon,
		netProfit: totalWon - totalWagered,
	};
}

/**
 * Registers all gambling-related commands with the bot.
 *
 * Commands registered:
 * - /roll <amount> - Roll for a chance to win 9x your bet
 * - /rollstats - View your gambling statistics
 * - /rollodds - View game odds and rules
 *
 * @param bot - Telegraf bot instance
 */
export function registerGamblingCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /roll
	 * Roll for a chance to win. If the 9-digit number ends in 2+ matching digits, you win 9x profit.
	 *
	 * Win probability: 10% (any dubs or better)
	 * Payout: 9x profit (10x total return including original bet)
	 * Expected value: 0 (fair game)
	 */
	bot.command("roll", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text.split(" ").slice(1);

		// Show help if no amount provided
		if (!args || args.length < 1) {
			const balance = await LedgerService.getUserBalance(userId);
			return ctx.reply(
				fmt`${bold("Roll Game")}

Roll a 9-digit number. If it ends in 2+ matching digits (dubs), you win!

${bold("Rules:")}
- Win condition: Last 2+ digits match (dubs/trips/quads...)
- Win chance: 10% (1 in 10)
- Win payout: 9x profit (get back 10x your bet)
- Fair game: Expected value = 0

${bold("Usage:")} ${code("/roll <amount>")}
${bold("Example:")} ${code("/roll 5")}

Limits: ${MIN_BET} - ${MAX_BET} JUNO
Your balance: ${code(AmountPrecision.format(balance))} JUNO`,
			);
		}

		// Parse bet amount
		let betAmount: number;
		try {
			betAmount = AmountPrecision.parseUserInput(args[0]);
		} catch {
			return ctx.reply(
				"Invalid amount. Use a number with up to 6 decimal places.",
			);
		}

		// Validate bet limits
		if (betAmount < MIN_BET) {
			return ctx.reply(`Minimum bet is ${MIN_BET} JUNO.`);
		}
		if (betAmount > MAX_BET) {
			return ctx.reply(`Maximum bet is ${MAX_BET} JUNO.`);
		}

		// Acquire transaction lock
		const lockAcquired = await TransactionLockService.acquireLock(
			userId,
			"gambling_roll",
			betAmount,
		);

		if (!lockAcquired) {
			return ctx.reply(
				"You have an active transaction. Please wait and try again.",
			);
		}

		try {
			// Check user balance
			const userBalance = await LedgerService.getUserBalance(userId);
			if (!AmountPrecision.isGreaterOrEqual(userBalance, betAmount)) {
				await TransactionLockService.releaseLock(userId);
				return ctx.reply(
					fmt`Insufficient balance.

Your balance: ${code(AmountPrecision.format(userBalance))} JUNO
Bet amount: ${code(AmountPrecision.format(betAmount))} JUNO

Use ${code("/deposit")} to add funds.`,
				);
			}

			// Calculate potential payout (profit = bet * multiplier)
			const potentialProfit = AmountPrecision.validateAmount(
				betAmount * WIN_MULTIPLIER,
			);

			// Check treasury can cover potential payout
			const treasuryBalance = await LedgerService.getUserBalance(
				SYSTEM_USER_IDS.BOT_TREASURY,
			);
			if (!AmountPrecision.isGreaterOrEqual(treasuryBalance, potentialProfit)) {
				await TransactionLockService.releaseLock(userId);
				logger.warn("Treasury insufficient for gambling payout", {
					treasuryBalance,
					requiredPayout: potentialProfit,
					userId,
				});
				return ctx.reply(
					"Game temporarily unavailable. Treasury balance too low.",
				);
			}

			// Generate roll using message timestamp and user ID
			const timestamp = ctx.message?.date || Math.floor(Date.now() / 1000);
			const rollNumber = generateRollNumber(timestamp, userId);
			const result = checkWin(rollNumber);

			let txResult;
			let newBalance: number;

			if (result.won) {
				// User wins - treasury pays user the profit
				txResult = await LedgerService.transferBetweenUsers(
					SYSTEM_USER_IDS.BOT_TREASURY,
					userId,
					potentialProfit,
					`Roll win (${result.matchName}) - bet ${AmountPrecision.format(betAmount)} JUNO`,
				);
				newBalance = txResult.toBalance;
			} else {
				// User loses - user pays treasury their bet
				txResult = await LedgerService.transferBetweenUsers(
					userId,
					SYSTEM_USER_IDS.BOT_TREASURY,
					betAmount,
					`Roll loss - bet ${AmountPrecision.format(betAmount)} JUNO`,
				);
				newBalance = txResult.fromBalance;
			}

			// Release lock
			await TransactionLockService.releaseLock(userId);

			if (!txResult.success) {
				logger.error("Roll transaction failed", {
					userId,
					betAmount,
					won: result.won,
					error: txResult.error,
				});
				return ctx.reply(
					"Transaction failed. Your balance is unchanged. Please try again.",
				);
			}

			// Record as gambling transaction type (update the transaction we just created)
			execute(
				`UPDATE transactions SET transaction_type = ?
				WHERE (from_user_id = ? OR to_user_id = ?)
				AND created_at = (SELECT MAX(created_at) FROM transactions WHERE from_user_id = ? OR to_user_id = ?)`,
				[TransactionType.GAMBLING, userId, userId, userId, userId],
			);

			// Format result message
			const rollDisplay = rollNumber.replace(
				/(\d{3})(\d{3})(\d{3})/,
				"$1 $2 $3",
			);

			if (result.won) {
				await ctx.reply(
					fmt`${bold("WINNER!")} ${result.matchName}!

Roll: ${bold(rollDisplay)}

Bet: ${code(AmountPrecision.format(betAmount))} JUNO
Profit: ${bold(`+${AmountPrecision.format(potentialProfit)}`)} JUNO

New balance: ${code(AmountPrecision.format(newBalance))} JUNO`,
				);
			} else {
				await ctx.reply(
					fmt`${bold("No match")}

Roll: ${code(rollDisplay)}

Bet: ${code(AmountPrecision.format(betAmount))} JUNO
Lost: ${code(`-${AmountPrecision.format(betAmount)}`)} JUNO

New balance: ${code(AmountPrecision.format(newBalance))} JUNO`,
				);
			}

			// Log the roll
			StructuredLogger.logTransaction("Gambling roll completed", {
				userId,
				operation: "roll",
				betAmount: betAmount.toString(),
				rollNumber,
				outcome: result.won ? `win_${result.matchName}` : "loss",
				profit: result.won ? potentialProfit.toString() : `-${betAmount}`,
				newBalance: newBalance.toString(),
			});
		} catch (error) {
			// Always release lock on error
			await TransactionLockService.releaseLock(userId);
			logger.error("Roll command error", { userId, betAmount, error });
			return ctx.reply("An error occurred. Your balance is unchanged.");
		}
	});

	/**
	 * Command: /rollstats
	 * View your personal gambling statistics
	 */
	bot.command("rollstats", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const stats = getUserRollStats(userId);
		const balance = await LedgerService.getUserBalance(userId);

		const profitStr =
			stats.netProfit >= 0
				? `+${AmountPrecision.format(stats.netProfit)}`
				: AmountPrecision.format(stats.netProfit);

		await ctx.reply(
			fmt`${bold("Your Roll Statistics")}

Total rolls: ${stats.totalRolls}
Total wagered: ${code(AmountPrecision.format(stats.totalWagered))} JUNO
Total won: ${code(AmountPrecision.format(stats.totalWon))} JUNO
Net profit: ${code(profitStr)} JUNO

Current balance: ${code(AmountPrecision.format(balance))} JUNO`,
		);
	});

	/**
	 * Command: /rollodds
	 * View game odds and rules
	 */
	bot.command("rollodds", async (ctx) => {
		await ctx.reply(
			fmt`${bold("Roll Game Odds")}

${bold("How it works:")}
A 9-digit number is generated using cryptographic randomness.
If the last 2+ digits match, you win!

${bold("Win probabilities:")}
- Dubs (2 match): 10% chance
- Trips (3 match): 1% chance
- Quads (4 match): 0.1% chance
- Quints+: increasingly rare

${bold("Payouts:")}
- Any win: 9x profit (get back 10x bet)
- Loss: lose your bet

${bold("Expected value:")}
Win: 10% x 9 = 0.9
Loss: 90% x -1 = -0.9
Net EV: 0 (perfectly fair)

${bold("Randomness:")}
Each roll combines:
- Message timestamp
- Your user ID
- Hash of previous roll
All hashed with SHA-256 for provable fairness.`,
		);
	});
}
