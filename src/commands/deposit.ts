/**
 * Deposit command handlers for the CAC Admin Bot.
 * Provides commands for deposit instructions, verification, and unclaimed deposit management.
 *
 * @module commands/deposit
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt, italic } from "telegraf/format";
import { config } from "../config";
import { execute, get, query } from "../database";
import { DepositInstructionService } from "../services/depositInstructions";
import { LedgerService } from "../services/ledgerService";
import { RPCTransactionVerification } from "../services/rpcTransactionVerification";
import {
	SYSTEM_USER_IDS,
	UnifiedWalletService,
} from "../services/unifiedWalletService";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

interface ProcessedDeposit {
	tx_hash: string;
	user_id: number;
	amount: number;
	from_address: string;
	memo: string | null;
	height: number;
	processed: number;
	processed_at: number | null;
	error: string | null;
	created_at: number;
}

/**
 * Registers all deposit-related commands with the bot.
 *
 * Commands registered:
 * - /deposit - Get deposit instructions with memo
 * - /verifydeposit - Verify a deposit by transaction hash
 * - /unclaimeddeposits - View unclaimed deposits (missing or invalid memo)
 * - /claimdeposit - Assign an unclaimed deposit to a user (admin only)
 * - /processdeposit - Manually process a pending deposit (admin only)
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerDepositCommands } from './commands/deposit';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerDepositCommands(bot);
 * ```
 */
export const registerDepositCommands = (bot: Telegraf<Context>) => {
	/**
	 * Command: /deposit
	 * Get deposit instructions with unique user memo.
	 *
	 * Permission: Any user
	 * Syntax: /deposit
	 *
	 * @example
	 * User: /deposit
	 * Bot: Deposit Instructions
	 *
	 *      Send JUNO to:
	 *      `juno1...`
	 *
	 *      IMPORTANT: Include this memo:
	 *      `123456`
	 *
	 *      Without the correct memo, your deposit cannot be automatically credited.
	 */
	bot.command("deposit", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const instructions = UnifiedWalletService.getDepositInstructions(userId);
			await ctx.reply(
				fmt`${instructions.markdown}\n\n${italic("Experimental software - deposit at your own risk")}`,
			);
		} catch (error) {
			logger.error("Failed to send deposit response", { userId, error });
			await ctx.reply("Failed to process deposit command");
		}
	});

	/**
	 * Command: /verifydeposit
	 * Verify and credit a deposit by providing the transaction hash.
	 *
	 * Permission: Any user
	 * Syntax: /verifydeposit <transaction_hash>
	 *
	 * @example
	 * User: /verifydeposit ABC123DEF456...
	 * Bot: Deposit Confirmed!
	 *
	 *      Amount: 100.000000 JUNO
	 *      From: juno1abc...
	 *      Transaction: ABC123DEF456...
	 *
	 *      New balance: 100.000000 JUNO
	 */
	bot.command("verifydeposit", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];

		if (args.length < 1) {
			return ctx.reply(
				fmt`${bold("Usage")}: /verifydeposit <transaction_hash>\n\nProvide the transaction hash of your deposit to verify and credit it.`,
			);
		}

		const txHash = args[0].trim();

		await ctx.reply(" Verifying transaction...");

		try {
			// Get wallet address
			const walletAddress =
				UnifiedWalletService.getDepositInstructions(userId).address;

			// Verify the deposit
			const verification = await RPCTransactionVerification.verifyDeposit(
				txHash,
				walletAddress,
				userId,
			);

			if (!verification.valid) {
				const memoInfo =
					verification.memo !== undefined
						? `Memo found: ${code(verification.memo || "none")}\nExpected: ${code(userId.toString())}\n\n`
						: "";

				return ctx.reply(
					fmt`${bold("Deposit Verification Failed")}\n\n${verification.error || "Unknown error"}\n\n${memoInfo}Please ensure:\n• Transaction is confirmed on-chain\n• Funds were sent to: ${code(walletAddress)}\n• Memo was exactly: ${code(userId.toString())}`,
				);
			}

			// Extract verified values (guaranteed to exist after valid check)
			const verifiedAmount = verification.amount ?? 0;
			const verifiedSender = verification.sender ?? "";

			// Check if already processed
			const existing = get<ProcessedDeposit>(
				"SELECT * FROM processed_deposits WHERE tx_hash = ?",
				[txHash],
			);

			if (existing?.processed) {
				return ctx.reply(
					fmt`${bold("Already Processed")}\n\nThis deposit has already been credited.\nAmount: ${code(`${AmountPrecision.format(verifiedAmount)} JUNO`)}\nFrom: ${code(verifiedSender)}`,
				);
			}

			// Process the deposit
			const result = await LedgerService.processDeposit(
				userId,
				verifiedAmount,
				txHash,
				verifiedSender,
				`Manual deposit verification from ${verifiedSender}`,
			);

			if (result.success) {
				// Mark deposit as processed in database
				if (!existing) {
					// Insert new record if it doesn't exist
					execute(
						`INSERT INTO processed_deposits (
              tx_hash, user_id, amount, from_address, memo, height, processed, processed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
						[
							txHash,
							userId,
							verifiedAmount,
							verifiedSender,
							verification.memo || null,
							0, // height unknown for manual verification
							Math.floor(Date.now() / 1000),
							Math.floor(Date.now() / 1000),
						],
					);
				} else {
					// Update existing record
					execute(
						"UPDATE processed_deposits SET processed = 1, processed_at = ?, user_id = ?, error = NULL WHERE tx_hash = ?",
						[Math.floor(Date.now() / 1000), userId, txHash],
					);
				}

				StructuredLogger.logTransaction("Deposit verified and credited", {
					userId,
					txHash,
					amount: verifiedAmount.toString(),
					operation: "deposit_verification",
				});

				await ctx.reply(
					DepositInstructionService.formatDepositConfirmation(
						userId,
						verifiedAmount,
						txHash,
						result.newBalance,
					),
				);
			} else {
				// Mark deposit as failed in database
				if (!existing) {
					execute(
						`INSERT INTO processed_deposits (
              tx_hash, user_id, amount, from_address, memo, height, processed, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
						[
							txHash,
							userId,
							verifiedAmount,
							verifiedSender,
							verification.memo || null,
							0,
							result.error || "Unknown error",
							Math.floor(Date.now() / 1000),
						],
					);
				} else {
					execute("UPDATE processed_deposits SET error = ? WHERE tx_hash = ?", [
						result.error || "Unknown error",
						txHash,
					]);
				}

				await ctx.reply(
					fmt`${bold("Failed to credit deposit")}\n\n${result.error || "Unknown error"}\n\nPlease contact an admin for assistance.`,
				);
			}
		} catch (error) {
			logger.error("Deposit verification failed", { userId, txHash, error });
			await ctx.reply(
				"Failed to verify deposit. Please try again or contact an admin.",
			);
		}
	});

	/**
	 * Command: /unclaimeddeposits
	 * View deposits that could not be automatically credited due to missing or invalid memos.
	 *
	 * Permission: Any user
	 * Syntax: /unclaimeddeposits
	 *
	 * @example
	 * User: /unclaimeddeposits
	 * Bot: Unclaimed Deposits
	 *
	 *      Total: `50.000000 JUNO`
	 *
	 *      Recent deposits without valid memo:
	 *      • `ABC123...`
	 *        Amount: 25.000000 JUNO
	 *        Memo: "wrong_id"
	 */
	bot.command("unclaimeddeposits", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			// Get unclaimed balance
			const unclaimedBalance = await LedgerService.getUserBalance(
				SYSTEM_USER_IDS.UNCLAIMED,
			);

			if (unclaimedBalance === 0) {
				return ctx.reply("No unclaimed deposits");
			}

			// Get recent unclaimed deposits
			const unclaimed = query<any>(
				`SELECT * FROM processed_deposits
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
				[SYSTEM_USER_IDS.UNCLAIMED],
			);

			const messageParts = [
				bold("Unclaimed Deposits"),
				"\n\n",
				`Total: ${code(`${AmountPrecision.format(unclaimedBalance)} JUNO`)}`,
				"\n\n",
			];

			if (unclaimed.length > 0) {
				messageParts.push(bold("Recent deposits without valid memo:"), "\n");
				for (const deposit of unclaimed) {
					messageParts.push(
						`• ${code(`${deposit.tx_hash.substring(0, 10)}...`)}\n`,
						`  Amount: ${AmountPrecision.format(deposit.amount)} JUNO\n`,
						`  Memo: "${deposit.memo || "none"}"\n\n`,
					);
				}
			}

			messageParts.push(DepositInstructionService.getUnclaimedInstructions());

			await ctx.reply(fmt(messageParts));
		} catch (error) {
			logger.error("Failed to get unclaimed deposits", { userId, error });
			await ctx.reply(" Failed to retrieve unclaimed deposits");
		}
	});

	/**
	 * Command: /claimdeposit
	 * Manually assign an unclaimed deposit to a user (admin only).
	 *
	 * Permission: Admin or owner
	 * Syntax: /claimdeposit <transaction_hash> <user_id>
	 *
	 * @example
	 * User: /claimdeposit ABC123... 123456
	 * Bot: Deposit Claimed
	 *
	 *      Amount: `25.000000 JUNO`
	 *      Assigned to user: `123456`
	 *      Transaction: `ABC123...`
	 */
	bot.command("claimdeposit", async (ctx) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		// Check if owner (from config) or admin (from database)
		const isOwner = config.ownerIds.includes(adminId);
		const admin = get<any>("SELECT role FROM users WHERE id = ?", [adminId]);

		if (
			!isOwner &&
			(!admin || (admin.role !== "owner" && admin.role !== "admin"))
		) {
			return ctx.reply("This command requires admin permissions");
		}

		const args = ctx.message?.text?.split(" ").slice(1) || [];

		if (args.length < 2) {
			return ctx.reply(
				fmt`${bold("Usage")}: /claimdeposit <transaction_hash> <user_id>\n\nAssign an unclaimed deposit to a user.`,
			);
		}

		const txHash = args[0].trim();
		const targetUserId = parseInt(args[1], 10);

		if (Number.isNaN(targetUserId)) {
			return ctx.reply("Invalid user ID");
		}

		try {
			const result = await UnifiedWalletService.claimUnclaimedDeposit(
				txHash,
				targetUserId,
			);

			if (result.success) {
				StructuredLogger.logUserAction("Unclaimed deposit assigned by admin", {
					userId: adminId,
					operation: "claim_deposit",
					targetUserId: targetUserId,
					txHash,
					amount: result.amount?.toString(),
				});

				await ctx.reply(
					fmt`${bold("Deposit Claimed")}\n\nAmount: ${code(`${AmountPrecision.format(result.amount ?? 0)} JUNO`)}\nAssigned to user: ${code(targetUserId.toString())}\nTransaction: ${code(`${txHash.substring(0, 10)}...`)}`,
				);
			} else {
				await ctx.reply(
					fmt`${bold("Failed to claim deposit")}\n\n${result.error || "Unknown error"}`,
				);
			}
		} catch (error) {
			logger.error("Failed to claim deposit", {
				adminId,
				txHash,
				targetUserId,
				error,
			});
			await ctx.reply("Failed to claim deposit");
		}
	});

	/**
	 * Command: /processdeposit
	 * Manually process a pending deposit transaction (admin only).
	 *
	 * Permission: Admin or owner
	 * Syntax: /processdeposit <transaction_hash>
	 *
	 * @example
	 * User: /processdeposit ABC123...
	 * Bot: Processing deposit...
	 *      Deposit Processed
	 *      Amount: 1.000000 JUNO
	 *      Credited to user: 1705203106
	 */
	bot.command("processdeposit", async (ctx) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		// Check if owner (from config) or admin (from database)
		const isOwner = config.ownerIds.includes(adminId);
		const admin = get<any>("SELECT role FROM users WHERE id = ?", [adminId]);

		if (
			!isOwner &&
			(!admin || (admin.role !== "owner" && admin.role !== "admin"))
		) {
			return ctx.reply("This command requires admin permissions");
		}

		const args = ctx.message?.text?.split(" ").slice(1) || [];

		if (args.length < 1) {
			return ctx.reply(
				fmt`Usage: /processdeposit <transaction_hash>\n\nManually process a pending deposit. The deposit must have a valid user ID in the memo.`,
			);
		}

		const txHash = args[0].trim().toUpperCase();

		await ctx.reply("Processing deposit...");

		try {
			// Fetch transaction from RPC
			const txResult =
				await RPCTransactionVerification.fetchTransaction(txHash);

			if (!txResult.success || !txResult.data) {
				return ctx.reply(
					fmt`Failed to fetch transaction\n\n${txResult.error || "Transaction not found"}`,
				);
			}

			const tx = txResult.data;

			// Check transaction status
			if (tx.status !== 0) {
				return ctx.reply(
					fmt`Transaction failed on-chain\n\nStatus code: ${tx.status.toString()}`,
				);
			}

			// Extract deposit information from transfers
			if (!tx.transfers || tx.transfers.length === 0) {
				return ctx.reply("No transfers found in transaction");
			}

			// Find transfer to bot treasury
			const deposit = tx.transfers.find(
				(t) => t.recipient === config.botTreasuryAddress,
			);

			if (!deposit) {
				return ctx.reply(
					fmt`No transfer to bot treasury found\n\nExpected recipient: ${config.botTreasuryAddress || ""}`,
				);
			}

			// Extract user ID from memo
			const userId = tx.memo ? parseInt(tx.memo, 10) : null;

			if (!userId || Number.isNaN(userId)) {
				return ctx.reply(
					fmt`No valid user ID found in memo\n\nMemo: ${tx.memo || "none"}\n\nUse /claimdeposit to manually assign this deposit to a user.`,
				);
			}

			// Check if already processed
			const existing = get<any>(
				"SELECT * FROM processed_deposits WHERE tx_hash = ?",
				[txHash],
			);

			if (existing?.processed) {
				return ctx.reply(
					fmt`Deposit Already Processed\n\nAmount: ${AmountPrecision.format(deposit.amount)} JUNO\nUser: ${userId.toString()}\nThis deposit has already been credited.`,
				);
			}

			// Process the deposit
			const result = await LedgerService.processDeposit(
				userId,
				deposit.amount,
				txHash,
				deposit.sender,
				`Manual deposit processing by admin ${adminId}`,
			);

			if (result.success) {
				// Mark deposit as processed in database
				if (!existing) {
					// Insert new record if it doesn't exist
					execute(
						`INSERT INTO processed_deposits (
              tx_hash, user_id, amount, from_address, memo, height, processed, processed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
						[
							txHash,
							userId,
							deposit.amount,
							deposit.sender,
							tx.memo || null,
							tx.height || 0,
							Math.floor(Date.now() / 1000),
							Math.floor(Date.now() / 1000),
						],
					);
				} else {
					// Update existing record
					execute(
						"UPDATE processed_deposits SET processed = 1, processed_at = ?, user_id = ?, error = NULL WHERE tx_hash = ?",
						[Math.floor(Date.now() / 1000), userId, txHash],
					);
				}

				StructuredLogger.logUserAction("Deposit manually processed by admin", {
					userId: adminId,
					operation: "process_deposit",
					targetUserId: userId,
					txHash,
					amount: deposit.amount.toString(),
				});

				await ctx.reply(
					fmt`Deposit Processed\n\nAmount: ${AmountPrecision.format(deposit.amount)} JUNO\nFrom: ${deposit.sender}\nCredited to user: ${userId.toString()}\nNew balance: ${AmountPrecision.format(result.newBalance)} JUNO\nTransaction: ${txHash.substring(0, 16)}...`,
				);
			} else {
				// Mark deposit as failed in database
				if (!existing) {
					execute(
						`INSERT INTO processed_deposits (
              tx_hash, user_id, amount, from_address, memo, height, processed, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
						[
							txHash,
							userId,
							deposit.amount,
							deposit.sender,
							tx.memo || null,
							tx.height || 0,
							result.error || "Unknown error",
							Math.floor(Date.now() / 1000),
						],
					);
				} else {
					execute("UPDATE processed_deposits SET error = ? WHERE tx_hash = ?", [
						result.error || "Unknown error",
						txHash,
					]);
				}

				await ctx.reply(
					fmt`Failed to process deposit\n\n${result.error || "Unknown error"}`,
				);
			}
		} catch (error) {
			logger.error("Failed to process deposit", { adminId, txHash, error });
			await ctx.reply(
				"Failed to process deposit. Please check logs for details.",
			);
		}
	});

	logger.info("Deposit commands registered");
};
