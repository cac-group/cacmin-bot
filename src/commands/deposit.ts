/**
 * Deposit command handlers for the CAC Admin Bot.
 * Provides commands for deposit instructions, verification, and unclaimed deposit management.
 *
 * @module commands/deposit
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt, italic } from "telegraf/format";
import { execute, get, query } from "../database";
import { adminOrHigher } from "../middleware";
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

interface DepositCreditResult {
	success: boolean;
	amount?: number;
	creditedUserId?: number;
	sender?: string;
	memo?: string;
	error?: string;
}

/**
 * Look up a deposit on-chain and credit the user id in its memo, idempotently.
 * Used by /claimdeposit (any user) and /processdeposit (admin) so they cannot
 * diverge.
 */
async function creditDepositFromChain(
	txHash: string,
	actorId: number,
	operation: string,
): Promise<DepositCreditResult> {
	const txResult = await RPCTransactionVerification.fetchTransaction(txHash);
	if (!txResult.success || !txResult.data) {
		return {
			success: false,
			error: txResult.error || "Transaction not found",
		};
	}

	const tx = txResult.data;
	if (tx.status !== 0) {
		return {
			success: false,
			error: `Transaction failed on-chain (code ${tx.status})`,
		};
	}

	const creditedUserId = tx.memo ? Number.parseInt(tx.memo, 10) : Number.NaN;
	if (!creditedUserId || Number.isNaN(creditedUserId)) {
		return {
			success: false,
			error: tx.memo
				? `The memo "${tx.memo}" is not a valid user id.`
				: "The transaction has no memo, so there is no user to credit.",
		};
	}

	const depositAddress =
		UnifiedWalletService.getDepositInstructions(creditedUserId).address;
	const transfer = tx.transfers?.find((t) => t.recipient === depositAddress);
	if (!transfer) {
		return {
			success: false,
			error: `No transfer to the deposit address (${depositAddress || "unset"}) was found.`,
		};
	}

	const existing = get<{ processed: number }>(
		"SELECT processed FROM processed_deposits WHERE tx_hash = ?",
		[txHash],
	);
	if (existing?.processed) {
		return {
			success: false,
			error: "This deposit has already been credited.",
			amount: transfer.amount,
			creditedUserId,
		};
	}

	const result = await LedgerService.processDeposit(
		creditedUserId,
		transfer.amount,
		txHash,
		transfer.sender,
		`Manual deposit processing (${operation})`,
	);
	if (!result.success) {
		return {
			success: false,
			error: result.error || "Failed to credit deposit",
		};
	}

	const now = Math.floor(Date.now() / 1000);
	execute(
		`INSERT INTO processed_deposits (
       tx_hash, user_id, amount, from_address, memo, height, processed, processed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(tx_hash) DO UPDATE SET
       user_id = excluded.user_id, amount = excluded.amount,
       from_address = excluded.from_address, memo = excluded.memo,
       processed = 1, processed_at = excluded.processed_at, error = NULL`,
		[
			txHash,
			creditedUserId,
			transfer.amount,
			transfer.sender,
			tx.memo || null,
			tx.height || 0,
			now,
			now,
		],
	);

	StructuredLogger.logUserAction("Deposit credited from chain", {
		userId: actorId,
		operation,
		targetUserId: creditedUserId,
		txHash,
		amount: transfer.amount.toString(),
	});

	return {
		success: true,
		amount: transfer.amount,
		creditedUserId,
		sender: transfer.sender,
		memo: tx.memo,
	};
}

/**
 * Registers all deposit-related commands with the bot.
 *
 * Commands registered:
 * - /deposit - Get deposit instructions with memo
 * - /verifydeposit - Verify a deposit by transaction hash
 * - /unclaimeddeposits - View unclaimed deposits (missing or invalid memo)
 * - /claimdeposit - Verify a missed deposit by hash and credit the memo user id (any user)
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
	 * Syntax: /verifydeposit <txhash>
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
				fmt`${bold("Usage")}: /verifydeposit <txhash>\n\nProvide the transaction hash of your deposit to verify and credit it.`,
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
	 * Look up a deposit transaction and credit the user id in its memo.
	 *
	 * Permission: Any user
	 * Syntax: /claimdeposit <txhash>
	 *
	 * @example
	 * User: /claimdeposit ABC123...
	 * Bot: Deposit Claimed
	 *
	 *      Amount: `25.000000 JUNO`
	 *      Credited to: `123456`
	 *      Transaction: `ABC123...`
	 */
	bot.command("claimdeposit", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];

		if (args.length < 1) {
			return ctx.reply(
				fmt`${bold("Usage")}: /claimdeposit <txhash>\n\nIf a deposit was missed, send its transaction hash and the bot will verify it on-chain and credit the user id in the memo.`,
			);
		}

		const txHash = args[0].trim();
		await ctx.reply(" Looking up transaction...");

		try {
			const result = await creditDepositFromChain(
				txHash,
				userId,
				"claim_deposit",
			);

			if (!result.success) {
				return ctx.reply(
					fmt`${bold("Deposit Claim Failed")}\n\n${result.error ?? "Unknown error"}`,
				);
			}

			await ctx.reply(
				fmt`${bold("Deposit Claimed")}\n\nAmount: ${code(`${AmountPrecision.format(result.amount ?? 0)} JUNO`)}\nCredited to: ${code(String(result.creditedUserId))}\nTransaction: ${code(`${txHash.substring(0, 10)}...`)}`,
			);
		} catch (error) {
			logger.error("Failed to claim deposit", { userId, txHash, error });
			await ctx.reply("Failed to claim deposit");
		}
	});

	/**
	 * Command: /processdeposit
	 * Manually process a deposit transaction and credit the user id in its memo.
	 *
	 * Permission: Admin or owner
	 * Syntax: /processdeposit <txhash>
	 *
	 * @example
	 * User: /processdeposit ABC123...
	 * Bot: Deposit Processed
	 *      Amount: 1.000000 JUNO
	 *      Credited to user: 1705203106
	 */
	bot.command("processdeposit", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];

		if (args.length < 1) {
			return ctx.reply(
				fmt`Usage: /processdeposit <txhash>\n\nManually process a deposit. The transaction must have a valid user id in its memo.`,
			);
		}

		const txHash = args[0].trim();
		await ctx.reply("Processing deposit...");

		try {
			const result = await creditDepositFromChain(
				txHash,
				adminId,
				"process_deposit",
			);

			if (!result.success) {
				return ctx.reply(
					fmt`${bold("Deposit Processing Failed")}\n\n${result.error ?? "Unknown error"}`,
				);
			}

			await ctx.reply(
				fmt`${bold("Deposit Processed")}\n\nAmount: ${code(`${AmountPrecision.format(result.amount ?? 0)} JUNO`)}\nFrom: ${code(result.sender || "unknown")}\nCredited to user: ${code(String(result.creditedUserId))}\nTransaction: ${code(`${txHash.substring(0, 16)}...`)}`,
			);
		} catch (error) {
			logger.error("Failed to process deposit", { adminId, txHash, error });
			await ctx.reply(
				"Failed to process deposit. Please check logs for details.",
			);
		}
	});

	logger.info("Deposit commands registered");
};
