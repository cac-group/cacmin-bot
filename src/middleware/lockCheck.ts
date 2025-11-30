/**
 * @module middleware/lockCheck
 * @description Transaction locking middleware to prevent concurrent financial operations.
 * Provides mechanisms to lock users during sensitive operations like withdrawals and transfers,
 * preventing race conditions and double-spending scenarios.
 */

import type { Context } from "telegraf";
import { bold, fmt } from "telegraf/format";
import { TransactionLockService } from "../services/transactionLock";
import { logger } from "../utils/logger";

/**
 * Middleware that checks if a user has an active transaction lock.
 * Prevents users from executing any commands while a financial transaction (withdrawal, transfer)
 * is in progress. Displays a message with remaining lock time if user attempts to execute a command.
 *
 * @param ctx - Telegraf context object containing user information
 * @param next - Next middleware function to call if user is not locked
 * @returns Promise that resolves when lock check is complete
 *
 * @example
 * // Apply globally to prevent any commands during transactions
 * bot.use(lockCheckMiddleware);
 *
 * @example
 * // User with active lock will see:
 * // "Transaction in Progress
 * //  You have a withdrawal transaction in progress.
 * //  Please wait 45 seconds for it to complete."
 */
export async function lockCheckMiddleware(
	ctx: Context,
	next: () => Promise<void>,
): Promise<void> {
	try {
		const userId = ctx.from?.id;

		if (!userId) {
			return next();
		}

		// Check if user is locked
		const lock = await TransactionLockService.getActiveLock(userId);

		if (lock) {
			const now = Math.floor(Date.now() / 1000);
			const age = now - lock.lockedAt;

			// Determine timeout based on lock type
			const timeoutMap: Record<string, number> = {
				withdrawal: 120,
				deposit: 300,
				transfer: 30,
			};
			const timeout = timeoutMap[lock.lockType] || 60;
			const remainingSeconds = Math.max(0, timeout - age);

			await ctx.reply(
				fmt`${bold("Transaction in Progress")}

You have a ${lock.lockType} transaction in progress.
Please wait ${remainingSeconds} seconds for it to complete.

If this persists, contact an admin.`,
			);

			logger.info("User command blocked due to active lock", {
				userId,
				lockType: lock.lockType,
				remainingSeconds,
			});

			// Don't continue to next middleware
			return;
		}

		// User not locked, continue
		return next();
	} catch (error) {
		logger.error("Error in lock check middleware", { error });
		// On error, allow command to proceed rather than blocking
		return next();
	}
}

/**
 * Middleware that checks for transaction locks only on financial commands.
 * More lenient than lockCheckMiddleware - only blocks concurrent financial operations
 * (withdraw, send, transfer, pay, bail, paybail) but allows other commands to proceed.
 * This prevents double-spending while maintaining bot responsiveness for non-financial commands.
 *
 * @param ctx - Telegraf context object containing message and user information
 * @param next - Next middleware function to call if user is not locked or command is non-financial
 * @returns Promise that resolves when lock check is complete
 *
 * @example
 * // Apply to command handlers that may trigger financial operations
 * bot.use(financialLockCheck);
 * bot.command('withdraw', async (ctx) => {
 *   // Lock check prevents concurrent withdrawals
 * });
 *
 * @example
 * // Non-financial commands proceed even with active lock
 * // /balance, /help, etc. work normally during a withdrawal
 */
export async function financialLockCheck(
	ctx: Context,
	next: () => Promise<void>,
): Promise<void> {
	try {
		const userId = ctx.from?.id;

		if (!userId) {
			return next();
		}

		const command = (ctx.message as any)?.text?.split(" ")[0];
		const financialCommands = [
			"/withdraw",
			"/send",
			"/transfer",
			"/pay",
			"/bail",
			"/paybail",
		];

		// Only check lock for financial commands
		if (command && financialCommands.includes(command)) {
			const isLocked = await TransactionLockService.hasLock(userId);

			if (isLocked) {
				await ctx.reply(
					fmt`You have another transaction in progress. Please wait for it to complete before initiating a new one.`,
				);
				return;
			}
		}

		return next();
	} catch (error) {
		logger.error("Error in financial lock check", { error });
		return next();
	}
}
