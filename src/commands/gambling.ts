/**
 * Gambling command handlers for the CAC Admin Bot.
 * Provides /roll command for a chance-based game using cryptographic randomness.
 *
 * @module commands/gambling
 */

import { createHash, randomBytes } from "crypto";
import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { execute, get } from "../database";
import { LedgerService, TransactionType } from "../services/ledgerService";
import { TransactionLockService } from "../services/transactionLock";
import { SYSTEM_USER_IDS } from "../services/unifiedWalletService";
import { sendUserError } from "../utils/adminNotify";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

// Minimum and maximum bets
export const MIN_BET = 0.1;
export const MAX_BET = 100;

// Payout multiplier (9x profit = 10x total return for 10% win chance = fair game)
export const WIN_MULTIPLIER = 9;

// System state keys for database persistence
const STATE_HASH_CHAIN = "roll_hash_chain";
const STATE_ROLL_COUNTER = "roll_counter";
const STATE_SERVER_SEED = "roll_server_seed";
const STATE_SERVER_SEED_HASH = "roll_server_seed_hash";

interface RollState {
	hashChain: string;
	rollCounter: number;
	serverSeed: string;
	serverSeedHash: string;
}

// In-memory cache of current state (loaded from DB at startup)
let rollState: RollState | null = null;

// Track last roll messages per user for cleanup (chatId -> userId -> {userMsgId, botMsgId})
interface RollMessagePair {
	userMsgId: number;
	botMsgId: number;
}
const lastRollMessages = new Map<number, Map<number, RollMessagePair>>();

/**
 * Get a system state value from the database
 */
function getSystemState(key: string): string | undefined {
	const row = get<{ value: string }>(
		"SELECT value FROM system_state WHERE key = ?",
		[key],
	);
	return row?.value;
}

/**
 * Set a system state value in the database
 */
function setSystemState(key: string, value: string): void {
	execute(
		`INSERT INTO system_state (key, value, updated_at)
		 VALUES (?, ?, strftime('%s', 'now'))
		 ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = strftime('%s', 'now')`,
		[key, value, value],
	);
}

/**
 * Generate a new server seed using crypto.randomBytes (256 bits)
 * Returns both the seed and its commitment hash (for commit-reveal)
 */
function generateServerSeed(): { seed: string; hash: string } {
	const seed = randomBytes(32).toString("hex");
	const hash = createHash("sha256").update(seed).digest("hex");
	return { seed, hash };
}

/**
 * Initialize or restore the RNG state from database
 * Called once at bot startup via initializeRollSystem()
 */
function loadOrInitializeState(): RollState {
	let hashChain = getSystemState(STATE_HASH_CHAIN);
	let rollCounter = parseInt(getSystemState(STATE_ROLL_COUNTER) || "0", 10);
	let serverSeed = getSystemState(STATE_SERVER_SEED);
	let serverSeedHash = getSystemState(STATE_SERVER_SEED_HASH);

	// Initialize hash chain if not present (first run or corrupted)
	if (!hashChain) {
		const initEntropy = randomBytes(32).toString("hex");
		hashChain = createHash("sha256").update(initEntropy).digest("hex");
		setSystemState(STATE_HASH_CHAIN, hashChain);
		logger.info("Roll hash chain initialized with cryptographic entropy");
	} else {
		logger.info("Roll hash chain restored from database");
	}

	// Initialize roll counter if not present
	if (Number.isNaN(rollCounter)) {
		rollCounter = 0;
		setSystemState(STATE_ROLL_COUNTER, "0");
	}

	// Initialize server seed if not present
	if (!serverSeed || !serverSeedHash) {
		const newSeed = generateServerSeed();
		serverSeed = newSeed.seed;
		serverSeedHash = newSeed.hash;
		setSystemState(STATE_SERVER_SEED, serverSeed);
		setSystemState(STATE_SERVER_SEED_HASH, serverSeedHash);
		logger.info("Roll server seed initialized for commit-reveal");
	}

	return { hashChain, rollCounter, serverSeed, serverSeedHash };
}

/**
 * Initialize the roll system - must be called at bot startup
 * Loads state from database or initializes fresh state with crypto.randomBytes
 */
export async function initializeRollSystem(): Promise<void> {
	rollState = loadOrInitializeState();
	logger.info("Roll system initialized", {
		rollCounter: rollState.rollCounter,
		serverSeedHash: `${rollState.serverSeedHash.substring(0, 16)}...`,
	});
}

/**
 * Get the current server seed commitment hash (for /rollodds display)
 */
export function getServerSeedCommitment(): string {
	if (!rollState) {
		throw new Error("Roll system not initialized");
	}
	return rollState.serverSeedHash;
}

/**
 * Rotate the server seed (call periodically, e.g., hourly)
 * Returns the OLD seed for verification, sets up new seed
 */
export function rotateServerSeed(): {
	oldSeed: string;
	oldHash: string;
	newHash: string;
} {
	if (!rollState) {
		throw new Error("Roll system not initialized");
	}

	const oldSeed = rollState.serverSeed;
	const oldHash = rollState.serverSeedHash;

	const newSeed = generateServerSeed();
	rollState.serverSeed = newSeed.seed;
	rollState.serverSeedHash = newSeed.hash;

	setSystemState(STATE_SERVER_SEED, newSeed.seed);
	setSystemState(STATE_SERVER_SEED_HASH, newSeed.hash);

	logger.info("Server seed rotated", {
		oldSeedHash: `${oldHash.substring(0, 16)}...`,
		newSeedHash: `${newSeed.hash.substring(0, 16)}...`,
	});

	return { oldSeed, oldHash, newHash: newSeed.hash };
}

/**
 * Generate a 9-digit roll number using cryptographic randomness.
 *
 * Entropy sources (none fully user-controllable):
 * - timestamp: Telegram message timestamp (user chooses when, but seconds precision)
 * - serverNanos: High-resolution server time (nanoseconds, unpredictable)
 * - userId: Fixed per user
 * - messageId: Telegram message ID (sequential with unpredictable gaps)
 * - rollCounter: Global monotonic counter (prevents replay)
 * - hashChain: Previous roll's hash (depends on all prior rolls)
 * - serverSeed: Cryptographic server secret (commit-reveal)
 *
 * @param timestamp - Message timestamp (unix seconds)
 * @param userId - User ID of the roller
 * @param messageId - Telegram message ID
 * @returns Object with roll number, rollId, and verification data
 */
export function generateRollNumber(
	timestamp: number,
	userId: number,
	messageId: number,
): { rollNumber: string; rollId: number; verificationHash: string } {
	if (!rollState) {
		throw new Error(
			"Roll system not initialized - call initializeRollSystem() first",
		);
	}

	// Capture server nanosecond timestamp (unpredictable)
	const serverNanos = process.hrtime.bigint().toString();

	// Increment roll counter
	rollState.rollCounter++;
	const rollId = rollState.rollCounter;

	// Combine all entropy sources
	const entropyInput = [
		timestamp,
		serverNanos,
		userId,
		messageId,
		rollId,
		rollState.hashChain,
		rollState.serverSeed,
	].join(":");

	// Generate SHA-256 hash
	const hash = createHash("sha256").update(entropyInput).digest("hex");

	// Update hash chain for next roll
	rollState.hashChain = hash;

	// Persist updated state to database
	setSystemState(STATE_HASH_CHAIN, hash);
	setSystemState(STATE_ROLL_COUNTER, rollId.toString());

	// Take first 12 hex chars (48 bits) and convert to number
	// Then mod by 1 billion to get 9 digits
	const hexPortion = hash.substring(0, 12);
	const numericValue = parseInt(hexPortion, 16);
	const rollNumber = (numericValue % 1_000_000_000).toString().padStart(9, "0");

	// Create verification hash (hash of public inputs for user verification)
	const verificationHash = createHash("sha256")
		.update(`${timestamp}:${userId}:${messageId}:${rollId}`)
		.digest("hex")
		.substring(0, 16);

	return { rollNumber, rollId, verificationHash };
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
	winMessage: string;
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

	const winMessages: Record<number, string> = {
		2: "Sick dubs!!",
		3: "Trip city bruh",
		4: "QUADS!!!",
		5: "QUINTS?! Insane!",
		6: "SEXTS!!! Legendary!",
		7: "SEPTS!!! Impossible!",
		8: "OCTS!!! Godlike!",
		9: "NINES!!! You broke reality!",
	};

	return {
		won: matchCount >= 2,
		matchCount,
		matchName: matchNames[matchCount] || `${matchCount}x`,
		winMessage: winMessages[matchCount] || "Winner!",
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
			// Get lock details to provide better feedback
			const existingLock = await TransactionLockService.getActiveLock(userId);
			const lockAge = existingLock
				? Math.floor(Date.now() / 1000) - existingLock.lockedAt
				: 0;
			const lockType = existingLock?.lockType || "unknown";

			await sendUserError(
				ctx,
				`You have an active ${lockType} transaction (${lockAge}s old). Please wait for it to complete before rolling again.`,
			);
			return;
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

			// Calculate potential payout (profit = bet * multiplier) using safe integer math
			const potentialProfit = AmountPrecision.multiply(
				betAmount,
				WIN_MULTIPLIER,
			);

			// Check treasury can cover potential payout
			const treasuryBalance = await LedgerService.getUserBalance(
				SYSTEM_USER_IDS.BOT_TREASURY,
			);
			if (!AmountPrecision.isGreaterOrEqual(treasuryBalance, potentialProfit)) {
				await TransactionLockService.releaseLock(userId);
				// Calculate a suggested bet (treasury / multiplier, rounded down to nice number)
				const maxBet = AmountPrecision.sanitize(
					treasuryBalance / WIN_MULTIPLIER,
				);
				// Suggest a "nice" amount less than max (e.g., 80% rounded to 1 decimal)
				const suggestedBet = Math.floor(maxBet * 0.8 * 10) / 10;
				logger.warn("Treasury insufficient for gambling payout", {
					treasuryBalance,
					requiredPayout: potentialProfit,
					userId,
					suggestedBet,
				});
				return ctx.reply(
					fmt`Treasury balance too low for that bet. Try ${code(`/roll ${suggestedBet}`)}`,
				);
			}

			// Generate roll using enhanced entropy sources
			const timestamp = ctx.message?.date || Math.floor(Date.now() / 1000);
			const messageId = ctx.message?.message_id || 0;
			const { rollNumber, rollId, verificationHash } = generateRollNumber(
				timestamp,
				userId,
				messageId,
			);
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

			// Delete previous roll messages (user command + bot response) for this user
			const chatId = ctx.chat?.id;
			const userMsgId = ctx.message?.message_id;
			if (chatId) {
				const chatMessages = lastRollMessages.get(chatId);
				const prevPair = chatMessages?.get(userId);
				if (prevPair) {
					// Delete both messages in parallel, ignore errors (may be deleted/too old)
					await Promise.all([
						ctx.telegram
							.deleteMessage(chatId, prevPair.userMsgId)
							.catch(() => {}),
						ctx.telegram
							.deleteMessage(chatId, prevPair.botMsgId)
							.catch(() => {}),
					]);
				}
			}

			// Format and send result message
			let sentMessage;
			if (result.won) {
				sentMessage = await ctx.reply(
					fmt`${bold(result.winMessage)}

Roll #${rollId}: ${bold(rollNumber)}

Bet: ${code(AmountPrecision.format(betAmount))} JUNO
Profit: ${bold(`+${AmountPrecision.format(potentialProfit)}`)} JUNO

New balance: ${code(AmountPrecision.format(newBalance))} JUNO
Verify: ${code(verificationHash)}`,
				);
			} else {
				sentMessage = await ctx.reply(
					fmt`${bold("watch tomorrow")}

Roll #${rollId}: ${code(rollNumber)}

Bet: ${code(AmountPrecision.format(betAmount))} JUNO
Lost: ${code(`-${AmountPrecision.format(betAmount)}`)} JUNO

New balance: ${code(AmountPrecision.format(newBalance))} JUNO
Verify: ${code(verificationHash)}`,
				);
			}

			// Track both messages for future cleanup
			if (chatId && sentMessage && userMsgId) {
				if (!lastRollMessages.has(chatId)) {
					lastRollMessages.set(chatId, new Map());
				}
				lastRollMessages.get(chatId)?.set(userId, {
					userMsgId,
					botMsgId: sentMessage.message_id,
				});
			}

			// Log the roll
			StructuredLogger.logTransaction("Gambling roll completed", {
				userId,
				operation: "roll",
				betAmount: betAmount.toString(),
				rollNumber,
				rollId: rollId.toString(),
				verificationHash,
				outcome: result.won ? `win_${result.matchName}` : "loss",
				profit: result.won ? potentialProfit.toString() : `-${betAmount}`,
				newBalance: newBalance.toString(),
			});
		} catch (error) {
			// Always release lock on error
			await TransactionLockService.releaseLock(userId);
			const errMsg = error instanceof Error ? error.message : String(error);
			const errStack = error instanceof Error ? error.stack : undefined;
			logger.error("Roll command error", {
				userId,
				betAmount,
				error: errMsg,
				stack: errStack,
			});

			// Determine user-friendly error message
			let userMessage = "An error occurred. Your balance is unchanged.";
			if (errMsg.includes("Roll system not initialized")) {
				userMessage =
					"Roll system is restarting. Please try again in a moment.";
			} else if (
				errMsg.includes("SQLITE_BUSY") ||
				errMsg.includes("database is locked")
			) {
				userMessage = "Database is busy. Please try again in a few seconds.";
			}

			await sendUserError(ctx, userMessage);
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
		let seedCommitment = "Not initialized";
		try {
			seedCommitment = getServerSeedCommitment();
		} catch {
			// Roll system not yet initialized
		}

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

${bold("Provable Fairness:")}
Each roll combines these entropy sources:
- Message timestamp
- Server nanoseconds (unpredictable)
- Your user ID
- Message ID
- Global roll counter
- Hash chain (depends on all prior rolls)
- Server seed (committed in advance)

Current seed commitment:
${code(seedCommitment.substring(0, 32))}...

Server seeds rotate hourly. Previous seeds are
revealed so you can verify past rolls were fair.`,
		);
	});
}
