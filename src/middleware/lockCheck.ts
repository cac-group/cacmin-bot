/**
 * @module middleware/lockCheck
 * @description Transaction locking middleware to prevent concurrent financial operations.
 * Provides mechanisms to lock users during sensitive operations like withdrawals and transfers,
 * preventing race conditions and double-spending scenarios.
 */

import type { Context } from "telegraf";
import { fmt } from "telegraf/format";
import { TransactionLockService } from "../services/transactionLock";
import { logger } from "../utils/logger";

/**
 * Middleware that checks for transaction locks only on financial commands.
 * Only blocks concurrent financial operations
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
