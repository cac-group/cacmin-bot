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
import {
	getTokens,
	JUNO_DENOM,
	networkForDenom,
	resolveToken,
	tokenByDenom,
} from "../tokens";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { normalizeTxHash } from "../utils/txHash";
import { resolveUserId } from "../utils/userResolver";

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
 * Look up a deposit on-chain and credit it, idempotently. Used by /claimdeposit
 * (any user) and /processdeposit (admin) so the two cannot diverge.
 *
 * Designated deposits (valid user id in the memo) go to the memo user. A
 * non-designated deposit already held in the UNCLAIMED ledger account can be
 * allocated by passing `targetUserId` (admin path only).
 */
async function creditDepositFromChain(
	txHash: string,
	actorId: number,
	operation: string,
	targetUserId?: number,
	denom: string = JUNO_DENOM,
): Promise<DepositCreditResult> {
	const txResult = await RPCTransactionVerification.fetchTokenTransaction(
		txHash,
		denom,
	);
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

	const memoUserId = tx.memo ? Number.parseInt(tx.memo, 10) : Number.NaN;
	const memoUser = Number.isNaN(memoUserId) ? undefined : memoUserId;

	const depositAddress = UnifiedWalletService.getDepositInstructions(
		memoUser ?? SYSTEM_USER_IDS.UNCLAIMED,
		denom,
	).address;
	const transfer = tx.transfers?.find(
		(t) => t.recipient === depositAddress && (t.denom ?? JUNO_DENOM) === denom,
	);
	if (!transfer) {
		return {
			success: false,
			error: `No transfer to the deposit address (${depositAddress || "unset"}) was found.`,
		};
	}

	const existing = get<ProcessedDeposit>(
		"SELECT * FROM processed_deposits WHERE tx_hash = ?",
		[txHash],
	);

	// Non-designated deposit held in the unclaimed ledger account: allocate it
	// to the requested user (the public path never passes a target).
	if (existing && existing.user_id === SYSTEM_USER_IDS.UNCLAIMED) {
		const recipient = targetUserId ?? memoUser;
		if (!recipient) {
			return {
				success: false,
				error:
					"This deposit has no designated user. Provide a target user id to allocate it.",
				amount: existing.amount,
			};
		}
		const moved = await LedgerService.transferBetweenUsers(
			SYSTEM_USER_IDS.UNCLAIMED,
			recipient,
			existing.amount,
			`Allocated unclaimed deposit ${txHash}`,
			denom,
		);
		if (!moved.success) {
			return {
				success: false,
				error: moved.error || "Failed to allocate deposit",
			};
		}
		execute("UPDATE processed_deposits SET user_id = ? WHERE tx_hash = ?", [
			recipient,
			txHash,
		]);
		StructuredLogger.logUserAction("Unclaimed deposit allocated", {
			userId: actorId,
			operation,
			targetUserId: recipient,
			txHash,
			amount: existing.amount.toString(),
		});
		return {
			success: true,
			amount: existing.amount,
			creditedUserId: recipient,
			sender: transfer.sender,
			memo: tx.memo,
		};
	}

	if (existing?.processed) {
		return {
			success: false,
			error: `This deposit has already been credited to user ${existing.user_id}.`,
			amount: existing.amount,
			creditedUserId: existing.user_id,
		};
	}

	const creditedUserId = targetUserId ?? memoUser;
	if (!creditedUserId) {
		return {
			success: false,
			error: tx.memo
				? `The memo "${tx.memo}" is not a valid user id. Provide a target user id to allocate it.`
				: "This deposit has no memo. Provide a target user id to allocate it.",
		};
	}

	const result = await LedgerService.processDeposit(
		creditedUserId,
		transfer.amount,
		txHash,
		transfer.sender,
		`Manual deposit processing (${operation})`,
		denom,
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
       tx_hash, user_id, amount, denom, network, from_address, memo, height, processed, processed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(tx_hash) DO UPDATE SET
       user_id = excluded.user_id, amount = excluded.amount,
       denom = excluded.denom, network = excluded.network,
       from_address = excluded.from_address, memo = excluded.memo,
       processed = 1, processed_at = excluded.processed_at, error = NULL`,
		[
			txHash,
			creditedUserId,
			transfer.amount,
			denom,
			networkForDenom(denom),
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
 * - /processdeposit - Admin recovery/allocating of any deposit: memo user by default, or a target user for unclaimed deposits
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

		const token = resolveToken(
			(ctx.message as any)?.text?.split(" ").slice(1)[0],
		);
		if (!token) {
			return ctx.reply(
				fmt`${bold("Unknown token")}\n\nUsage: ${code("/deposit [juno|cac]")}`,
			);
		}

		try {
			if (
				token.chain === "osmosis" &&
				!UnifiedWalletService.getDepositAddress(token.denom)
			) {
				await ctx.reply(
					`${token.symbol} deposits are not configured yet. Ask an admin to set the Osmosis wallet.`,
				);
				return;
			}
			const instructions = UnifiedWalletService.getDepositInstructions(
				userId,
				token.denom,
			);
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
				fmt`${bold("Usage")}: /verifydeposit <txhash> [juno|cac]`,
			);
		}

		const txHash = normalizeTxHash(args[0]);
		const token = resolveToken(args[1]);
		if (!token) {
			return ctx.reply(
				fmt`${bold("Unknown token")}\n\nUsage: ${code("/verifydeposit <txhash> [juno|cac]")}`,
			);
		}
		const denom = token.denom;

		if (!UnifiedWalletService.getDepositAddress(denom)) {
			await ctx.reply(`${token.symbol} deposits are not configured yet.`);
			return;
		}

		await ctx.reply(" Verifying transaction...");

		try {
			// Get wallet address
			const walletAddress = UnifiedWalletService.getDepositInstructions(
				userId,
				denom,
			).address;

			// Verify the deposit
			const verification = await RPCTransactionVerification.verifyDeposit(
				txHash,
				walletAddress,
				userId,
				denom,
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
					fmt`${bold("Already Processed")}\n\nThis deposit has already been credited.\nAmount: ${code(`${AmountPrecision.format(verifiedAmount)} ${token.symbol}`)}\nFrom: ${code(verifiedSender)}`,
				);
			}

			// Process the deposit
			const result = await LedgerService.processDeposit(
				userId,
				verifiedAmount,
				txHash,
				verifiedSender,
				`Manual deposit verification from ${verifiedSender}`,
				denom,
			);

			if (result.success) {
				// Mark deposit as processed in database
				if (!existing) {
					// Insert new record if it doesn't exist
					execute(
						`INSERT INTO processed_deposits (
              tx_hash, user_id, amount, denom, network, from_address, memo, height, processed, processed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
						[
							txHash,
							userId,
							verifiedAmount,
							denom,
							networkForDenom(denom),
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
						token.symbol,
					),
				);
			} else {
				// Mark deposit as failed in database
				if (!existing) {
					execute(
						`INSERT INTO processed_deposits (
              tx_hash, user_id, amount, denom, network, from_address, memo, height, processed, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
						[
							txHash,
							userId,
							verifiedAmount,
							denom,
							networkForDenom(denom),
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
			// Get unclaimed balances for every supported token.
			const unclaimedBalances = await Promise.all(
				getTokens().map(async (token) => ({
					token,
					amount: await LedgerService.getUserBalance(
						SYSTEM_USER_IDS.UNCLAIMED,
						token.denom,
					),
				})),
			);
			const nonZero = unclaimedBalances.filter((entry) => entry.amount !== 0);
			if (nonZero.length === 0) {
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
				...nonZero.map(
					(entry) =>
						`${entry.token.symbol}: ${code(
							`${AmountPrecision.format(entry.amount)} ${entry.token.symbol}`,
						)}\n`,
				),
				"\n",
			];

			if (unclaimed.length > 0) {
				messageParts.push(bold("Recent deposits without valid memo:"), "\n");
				for (const deposit of unclaimed) {
					const symbol =
						tokenByDenom(deposit.denom ?? JUNO_DENOM)?.symbol ?? "JUNO";
					messageParts.push(
						`• ${code(`${deposit.tx_hash.substring(0, 10)}...`)}\n`,
						`  Amount: ${AmountPrecision.format(deposit.amount)} ${symbol}\n`,
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
				fmt`${bold("Usage")}: /claimdeposit <txhash> [juno|cac]`,
			);
		}

		const txHash = normalizeTxHash(args[0]);
		const token = resolveToken(args[1]);
		if (!token) {
			return ctx.reply(
				fmt`${bold("Unknown token")}\n\nUsage: ${code("/claimdeposit <txhash> [juno|cac]")}`,
			);
		}
		await ctx.reply(" Looking up transaction...");

		try {
			const result = await creditDepositFromChain(
				txHash,
				userId,
				"claim_deposit",
				undefined,
				token.denom,
			);

			if (!result.success) {
				return ctx.reply(
					fmt`${bold("Deposit Claim Failed")}\n\n${result.error ?? "Unknown error"}`,
				);
			}

			await ctx.reply(
				fmt`${bold("Deposit Claimed")}\n\nAmount: ${code(`${AmountPrecision.format(result.amount ?? 0)} ${token.symbol}`)}\nCredited to: ${code(String(result.creditedUserId))}\nTransaction: ${code(`${txHash.substring(0, 10)}...`)}`,
			);
		} catch (error) {
			logger.error("Failed to claim deposit", { userId, txHash, error });
			await ctx.reply("Failed to claim deposit");
		}
	});

	/**
	 * Command: /processdeposit
	 * Admin manual path for any deposit: recovers a missed on-chain deposit or
	 * allocates a non-designated (unclaimed) one to a specified user.
	 *
	 * Permission: Admin or owner
	 * Syntax: /processdeposit <txhash> [userId|@username]
	 *
	 * If the memo designates a user, that user is credited and no target is
	 * needed. For an unclaimed deposit, pass the target user to allocate it.
	 *
	 * @example
	 * User: /processdeposit ABC123...
	 * User: /processdeposit ABC123... 123456
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
				fmt`Usage: /processdeposit <txhash> [userId|@username] [juno|cac]`,
			);
		}

		const txHash = normalizeTxHash(args[0]);
		// The token may appear before or after the optional target user:
		// /processdeposit <hash> cac and /processdeposit <hash> <user> cac both work.
		const firstToken = args[1] ? resolveToken(args[1]) : undefined;
		const token = firstToken ?? resolveToken(args[2]);
		if (!token) {
			return ctx.reply(
				fmt`${bold("Unknown token")}\n\nUsage: ${code("/processdeposit <txhash> [userId|@username] [juno|cac]")}`,
			);
		}
		let targetUserId: number | undefined;
		if (args[1] && !firstToken) {
			targetUserId = resolveUserId(args[1]) ?? undefined;
			if (!targetUserId) {
				return ctx.reply(
					"Target user not found. Use a numeric id or @username of a known user.",
				);
			}
		}

		await ctx.reply("Processing deposit...");

		try {
			const result = await creditDepositFromChain(
				txHash,
				adminId,
				"process_deposit",
				targetUserId,
				token.denom,
			);

			if (!result.success) {
				return ctx.reply(
					fmt`${bold("Deposit Processing Failed")}\n\n${result.error ?? "Unknown error"}`,
				);
			}

			await ctx.reply(
				fmt`${bold("Deposit Processed")}\n\nAmount: ${code(`${AmountPrecision.format(result.amount ?? 0)} ${token.symbol}`)}\nFrom: ${code(result.sender || "unknown")}\nCredited to user: ${code(String(result.creditedUserId))}\nTransaction: ${code(`${txHash.substring(0, 16)}...`)}`,
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
