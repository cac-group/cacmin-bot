/**
 * Wallet and ledger management handlers for the CAC Admin Bot.
 * Provides a complete internal ledger system with JUNO token management,
 * including deposits, withdrawals, internal transfers, and administrative functions.
 *
 * Features:
 * - Internal ledger tracking with user balances
 * - Deposit monitoring with unique memos
 * - Withdrawals to external Juno addresses
 * - Internal transfers between users
 * - Transaction history tracking
 * - Admin giveaway functionality
 * - Balance reconciliation and system statistics
 *
 * @module handlers/wallet
 */

import type { Context } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { config } from "../config";
import { UnifiedWalletService } from "../services/unifiedWalletService";
import { logger, StructuredLogger } from "../utils/logger";
import { checkIsElevated } from "../utils/roles";

/**
 * Handles the /balance command.
 * Displays the user's current internal ledger balance in JUNO tokens.
 *
 * Permission: All users (can only view their own balance)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /balance
 */
export async function handleBalance(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const balance = await UnifiedWalletService.getBalance(userId);
		const username = ctx.from.username
			? `@${ctx.from.username}`
			: `User ${userId}`;

		await ctx.reply(
			fmt`${bold(`Balance for ${username}`)}

Current balance: ${code(`${balance.toFixed(6)} JUNO`)}`,
		);

		StructuredLogger.logUserAction("Balance queried", {
			userId,
			username: ctx.from.username,
			operation: "check_balance",
			amount: balance.toFixed(6),
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "check_balance",
		});
		await ctx.reply("Failed to fetch balance");
	}
}

/**
 * Handles the /deposit command.
 * Displays deposit instructions with a unique address and memo for the user.
 * Deposits are automatically credited when the transaction is confirmed on-chain.
 *
 * Permission: All users
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /deposit
 */
export async function handleDeposit(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const depositInfo = UnifiedWalletService.getDepositInstructions(userId);

		// Send warning sticker first
		const CACGIFS_SATELLITE_STICKER =
			"CAACAgIAAxkBAAICIGkIxVYID2ee6Z3t3fzMKGyrzCLlAAJmNgACfvIoSL_cdmEGklS0NgQ";
		try {
			await ctx.replyWithSticker(CACGIFS_SATELLITE_STICKER);
		} catch (stickerError) {
			logger.warn("Failed to send warning sticker", {
				userId,
				error: stickerError,
			});
			// Continue even if sticker fails
		}

		// Send experimental warning
		await ctx.reply(
			fmt`${bold("EXPERIMENTAL SOFTWARE WARNING")}

This bot is ${bold("highly experimental")} and under active development.

${bold("DO NOT deposit funds you are not prepared to immediately lose.")}

By depositing, you acknowledge:
- This software may contain bugs
- Funds may be irretrievably lost
- No guarantees or warranties are provided
- You use this service entirely at your own risk

If you understand and accept these risks, proceed with deposit instructions below.`,
		);

		await ctx.reply(
			fmt`${bold("Deposit Instructions")}

To deposit JUNO to your account:

1. Send JUNO to this address:
${code(depositInfo.address)}

2. ${bold("IMPORTANT")}: Include this memo:
${code(depositInfo.memo)}

${bold("Your memo is unique to you and will never change")}
${bold("Deposits without the correct memo cannot be credited")}

Your deposit will be credited automatically once confirmed on-chain.`,
		);

		StructuredLogger.logUserAction("Deposit instructions requested", {
			userId,
			username: ctx.from.username,
			operation: "request_deposit",
			depositAddress: depositInfo.address,
			depositMemo: depositInfo.memo,
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "request_deposit",
		});
		await ctx.reply("Failed to generate deposit info");
	}
}

/**
 * Handles the /withdraw command.
 * Processes a withdrawal from the user's internal balance to an external Juno address.
 * Validates balance sufficiency and address format before processing.
 *
 * Permission: All users (can only withdraw from their own balance)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /withdraw <amount> <juno_address>
 * Example: /withdraw 10 juno1abc123xyz...
 */
export async function handleWithdraw(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Invalid format")}

Usage: ${code("/withdraw <amount> <juno_address>")}
Example: ${code("/withdraw 10 juno1xxxxx...")}`,
			);
			return;
		}

		const amount = parseFloat(args[0]);
		const address = args[1];

		if (Number.isNaN(amount) || amount <= 0) {
			await ctx.reply(" Invalid amount. Please enter a positive number.");
			return;
		}

		if (!address.startsWith("juno1")) {
			await ctx.reply(
				' Invalid Juno address. Address must start with "juno1".',
			);
			return;
		}

		// Check balance first
		const balance = await UnifiedWalletService.getBalance(userId);
		if (balance < amount) {
			await ctx.reply(
				fmt`${bold("Insufficient balance")}

Requested: ${code(`${amount} JUNO`)}
Available: ${code(`${balance.toFixed(6)} JUNO`)}`,
			);
			return;
		}

		// Process withdrawal
		await ctx.reply(" Processing withdrawal...");

		const result = await UnifiedWalletService.processWithdrawal(
			userId,
			address,
			amount,
		);

		if (result.success) {
			StructuredLogger.logTransaction("Withdrawal successful", {
				userId,
				username: ctx.from.username,
				operation: "withdrawal",
				amount: amount.toString(),
				txHash: result.txHash,
				toAddress: address,
			});

			await ctx.reply(
				result.txHash
					? fmt`${bold("Withdrawal Successful")}

Amount: ${code(`${amount} JUNO`)}
To: ${code(address)}
New Balance: ${code(`${result.newBalance?.toFixed(6) || "0"} JUNO`)}

Transaction: ${code(result.txHash)}`
					: fmt`${bold("Withdrawal Successful")}

Amount: ${code(`${amount} JUNO`)}
To: ${code(address)}
New Balance: ${code(`${result.newBalance?.toFixed(6) || "0"} JUNO`)}`,
			);
		} else {
			StructuredLogger.logError(`Withdrawal failed: ${result.error}`, {
				userId,
				operation: "withdrawal",
				amount: amount.toString(),
				toAddress: address,
			});

			await ctx.reply(
				fmt`${bold("Withdrawal Failed")}

Error: ${result.error || "Unknown error"}
Balance: ${code(`${result.newBalance?.toFixed(6) || "0"} JUNO`)}`,
			);
		}
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "withdrawal",
			amount: undefined,
		});
		await ctx.reply("Withdrawal failed");
	}
}

/**
 * Handles the /send command.
 * Sends JUNO tokens to another user (internal transfer) or to an external address.
 * Supports three recipient formats: @username, user ID, or juno1... address.
 *
 * Permission: All users (can only send from their own balance)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /send <amount> <recipient>
 * Example: /send 5 @alice (internal transfer)
 * Example: /send 10 123456789 (internal transfer by ID)
 * Example: /send 2.5 juno1abc... (external transfer)
 */
export async function handleSend(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Invalid format")}

Usage: ${code("/send <amount> <recipient>")}
Recipient can be:
- @username (internal transfer)
- User ID (internal transfer)
- juno1xxx... (external transfer)

Examples:
${code("/send 5 @alice")}
${code("/send 10 123456789")}
${code("/send 2.5 juno1xxxxx...")}`,
			);
			return;
		}

		const amount = parseFloat(args[0]);
		const recipient = args[1];

		if (Number.isNaN(amount) || amount <= 0) {
			await ctx.reply(" Invalid amount. Please enter a positive number.");
			return;
		}

		// Check sender's balance
		const balance = await UnifiedWalletService.getBalance(userId);
		if (balance < amount) {
			await ctx.reply(
				fmt`${bold("Insufficient balance")}

Requested: ${code(`${amount} JUNO`)}
Available: ${code(`${balance.toFixed(6)} JUNO`)}`,
			);
			return;
		}

		// Determine recipient type and process
		if (recipient.startsWith("juno1")) {
			// External transfer
			await ctx.reply(" Processing external transfer...");

			const result = await UnifiedWalletService.processWithdrawal(
				userId,
				recipient,
				amount,
			);

			if (result.success) {
				StructuredLogger.logTransaction("External transfer successful", {
					userId,
					username: ctx.from.username,
					operation: "external_transfer",
					amount: amount.toString(),
					txHash: result.txHash,
					toAddress: recipient,
				});

				await ctx.reply(
					fmt`${bold("External Transfer Successful")}

Amount: ${code(`${amount} JUNO`)}
To: ${code(recipient)}
New Balance: ${code(`${result.newBalance?.toFixed(6) || "0"} JUNO`)}${result.txHash ? `\n\nTransaction: ${code(result.txHash)}` : ""}`,
				);
			} else {
				StructuredLogger.logError(`External transfer failed: ${result.error}`, {
					userId,
					operation: "external_transfer",
					amount: amount.toString(),
					recipient,
				});

				await ctx.reply(
					fmt`${bold("Transfer Failed")}

Error: ${result.error || "Unknown error"}`,
				);
			}
		} else if (recipient.startsWith("@")) {
			// Internal transfer by username
			await ctx.reply(" Processing internal transfer...");

			const result = await UnifiedWalletService.sendToUsername(
				userId,
				recipient,
				amount,
				undefined,
				ctx, // Pass context for username resolution
			);

			if (result.success) {
				StructuredLogger.logTransaction(
					"Internal transfer by username successful",
					{
						userId,
						username: ctx.from.username,
						operation: "internal_transfer",
						amount: amount.toString(),
						recipient: result.recipient,
					},
				);

				await ctx.reply(
					fmt`${bold("Transfer Successful")}

Amount: ${code(`${amount} JUNO`)}
To: @${result.recipient || "unknown"}
Your New Balance: ${code(`${result.fromBalance?.toFixed(6) || "0"} JUNO`)}`,
				);
			} else {
				StructuredLogger.logError(`Internal transfer failed: ${result.error}`, {
					userId,
					operation: "internal_transfer",
					amount: amount.toString(),
					recipient,
				});

				await ctx.reply(
					fmt`${bold("Transfer Failed")}

Error: ${result.error || "Unknown error"}`,
				);
			}
		} else if (/^\d+$/.test(recipient)) {
			// Internal transfer by userId
			const recipientId = parseInt(recipient, 10);

			if (recipientId === userId) {
				await ctx.reply(" You cannot send tokens to yourself.");
				return;
			}

			await ctx.reply(" Processing internal transfer...");

			const result = await UnifiedWalletService.transferToUser(
				userId,
				recipientId,
				amount,
			);

			if (result.success) {
				StructuredLogger.logTransaction(
					"Internal transfer by user ID successful",
					{
						userId,
						username: ctx.from.username,
						operation: "internal_transfer",
						amount: amount.toString(),
						recipientId: recipientId.toString(),
					},
				);

				await ctx.reply(
					fmt`${bold("Transfer Successful")}

Amount: ${code(`${amount} JUNO`)}
To: User ${recipientId}
Your New Balance: ${code(`${result.fromBalance?.toFixed(6) || "0"} JUNO`)}`,
				);
			} else {
				StructuredLogger.logError(`Internal transfer failed: ${result.error}`, {
					userId,
					operation: "internal_transfer",
					amount: amount.toString(),
					recipientId: recipientId.toString(),
				});

				await ctx.reply(
					fmt`${bold("Transfer Failed")}

Error: ${result.error || "Unknown error"}`,
				);
			}
		} else {
			await ctx.reply(
				"Invalid recipient format. Use @username, user ID, or juno1xxx... address.",
			);
		}
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "send_tokens",
		});
		await ctx.reply("Transfer failed");
	}
}

/**
 * Handles the /transactions command.
 * Displays the user's recent transaction history (last 10 transactions).
 * Shows deposits, withdrawals, transfers, fines, and giveaways.
 *
 * Permission: All users (can view their own transactions)
 *             Owners only (can view any user's transactions by specifying userId)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /transactions (view your own transactions)
 * Usage: /transactions <userId> (owners only - view specific user's transactions)
 */
export async function handleTransactions(ctx: Context): Promise<void> {
	try {
		const requesterId = ctx.from?.id;
		if (!requesterId) return;

		// Parse arguments
		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		// Check if requester is owner
		const isOwner = config.ownerIds.includes(requesterId);

		// Determine which user's transactions to fetch
		let targetUserId = requesterId;
		if (args.length > 0) {
			const specifiedUserId = parseInt(args[0], 10);

			if (!isOwner) {
				await ctx.reply(
					"Only owners can view other users' transaction history.",
				);
				return;
			}

			if (Number.isNaN(specifiedUserId)) {
				await ctx.reply("Invalid user ID. Please provide a numeric user ID.");
				return;
			}

			targetUserId = specifiedUserId;
		}

		const transactions = await UnifiedWalletService.getTxHistory(
			targetUserId,
			10,
		);

		if (transactions.length === 0) {
			const userDisplay =
				targetUserId === requesterId ? "You have" : `User ${targetUserId} has`;
			await ctx.reply(`${userDisplay} no transaction history yet.`);
			return;
		}

		const header =
			targetUserId === requesterId
				? bold("Recent Transactions")
				: bold(`Transaction History for User ${targetUserId}`);

		const txLines = transactions.map((tx) => {
			const date = new Date((tx.created_at || 0) * 1000).toLocaleString();
			const type = tx.transaction_type.toUpperCase();
			const amount = tx.amount.toFixed(6);

			let description = "";
			switch (tx.transaction_type) {
				case "deposit":
					description = `+${amount} JUNO (Deposit)`;
					break;
				case "withdrawal":
					description = `-${amount} JUNO (Withdrawal)`;
					break;
				case "transfer":
					if (tx.from_user_id === targetUserId) {
						description = `-${amount} JUNO (Sent)`;
					} else {
						description = `+${amount} JUNO (Received)`;
					}
					break;
				case "fine":
					description = `-${amount} JUNO (Fine)`;
					break;
				case "bail":
					description = `-${amount} JUNO (Bail)`;
					break;
				case "giveaway":
					description = `+${amount} JUNO (Giveaway)`;
					break;
				default:
					description = `${amount} JUNO (${type})`;
			}

			let txInfo = `[${date}]\nType: ${type}\nAmount: ${description}`;

			if (tx.status && tx.status !== "completed") {
				txInfo += `\nStatus: ${tx.status.toUpperCase()}`;
			}

			if (tx.tx_hash) {
				txInfo += `\nTX Hash: ${code(tx.tx_hash)}`;
			}

			if (tx.external_address) {
				txInfo += `\nAddress: ${code(tx.external_address)}`;
			}

			if (tx.description) {
				txInfo += `\nNote: ${tx.description}`;
			}

			return txInfo;
		});

		await ctx.reply(fmt`${header}

${txLines.join("\n\n")}`);

		StructuredLogger.logUserAction("Transaction history queried", {
			userId: requesterId,
			username: ctx.from.username,
			operation: "view_transactions",
			targetUserId: targetUserId,
			transactionCount: transactions.length.toString(),
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "view_transactions",
		});
		await ctx.reply("Failed to fetch history");
	}
}

/**
 * Handles the /walletstats command.
 * Displays comprehensive system wallet statistics including balances,
 * ledger statistics, and reconciliation status.
 *
 * Permission: Elevated users only (admin/owner)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /walletstats
 */
export async function handleWalletStats(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;

		// Check if user is elevated
		if (!userId || !checkIsElevated(userId)) {
			await ctx.reply(" This command requires elevated permissions.");
			return;
		}

		await ctx.reply(" Fetching wallet statistics...");

		const systemBalances = await UnifiedWalletService.getSystemBalances();
		const ledgerStats = await UnifiedWalletService.getLedgerStats();
		const reconciliation = await UnifiedWalletService.reconcileBalances();

		await ctx.reply(
			fmt`${bold("Wallet System Statistics")}

${bold("System Wallets:")}
Treasury: ${code(`${systemBalances.treasury.toFixed(6)} JUNO`)}
Reserve: ${code(`${systemBalances.reserve.toFixed(6)} JUNO`)}
Unclaimed: ${code(`${systemBalances.unclaimed.toFixed(6)} JUNO`)}

${bold("Ledger Statistics:")}
Total Users: ${ledgerStats.totalUsers}
Active Users: ${ledgerStats.activeUsers}
Total Balance (Internal): ${code(`${ledgerStats.totalBalance.toFixed(6)} JUNO`)}
24h Deposits: ${ledgerStats.recentDeposits}
24h Withdrawals: ${ledgerStats.recentWithdrawals}

${bold("Reconciliation:")}
Internal Total: ${code(`${reconciliation.internalTotal.toFixed(6)} JUNO`)}
On-chain Total: ${code(`${reconciliation.onChainTotal.toFixed(6)} JUNO`)}
Difference: ${code(`${reconciliation.difference.toFixed(6)} JUNO`)}
Status: ${reconciliation.matched ? "Balanced" : "Mismatch"}`,
		);

		StructuredLogger.logUserAction("Wallet statistics viewed", {
			userId,
			operation: "view_wallet_stats",
			treasuryBalance: systemBalances.treasury.toFixed(6),
			reserveBalance: systemBalances.reserve.toFixed(6),
			unclaimedBalance: systemBalances.unclaimed.toFixed(6),
			internalTotal: ledgerStats.totalBalance.toFixed(6),
			reconciled: reconciliation.matched.toString(),
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "view_wallet_stats",
		});
		await ctx.reply("Failed to fetch stats");
	}
}

/**
 * Handles the /giveaway command.
 * Distributes a specified amount of JUNO to multiple users from the treasury.
 * Only elevated users can perform giveaways.
 *
 * Permission: Elevated users only (admin/owner)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /giveaway <amount> <@user1> <@user2> ...
 * Example: /giveaway 5 @alice @bob @charlie
 */
export async function handleGiveaway(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;

		// Check if user is elevated
		if (!userId || !checkIsElevated(userId)) {
			await ctx.reply(" This command requires elevated permissions.");
			return;
		}

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Invalid format")}

Usage: ${code("/giveaway <amount> <@user1> <@user2> ...")}
Example: ${code("/giveaway 5 @alice @bob @charlie")}`,
			);
			return;
		}

		const amount = parseFloat(args[0]);
		if (Number.isNaN(amount) || amount <= 0) {
			await ctx.reply(" Invalid amount. Please enter a positive number.");
			return;
		}

		const recipients = args.slice(1);
		const userIds: number[] = [];

		// Resolve usernames to userIds
		for (const recipient of recipients) {
			if (recipient.startsWith("@")) {
				const user = await UnifiedWalletService.findUserByUsername(recipient);
				if (user) {
					userIds.push(user.id);
				} else {
					await ctx.reply(` User ${recipient} not found, skipping...`);
				}
			} else if (/^\d+$/.test(recipient)) {
				userIds.push(parseInt(recipient, 10));
			}
		}

		if (userIds.length === 0) {
			await ctx.reply(" No valid recipients found.");
			return;
		}

		await ctx.reply(
			` Distributing ${amount} JUNO to ${userIds.length} users...`,
		);

		const result = await UnifiedWalletService.distributeGiveaway(
			userIds,
			amount,
			`Giveaway from admin`,
		);

		await ctx.reply(
			fmt`${bold("Giveaway Complete")}

Amount per user: ${code(`${amount} JUNO`)}
Successful: ${result.succeeded.length}
Failed: ${result.failed.length}
Total distributed: ${code(`${result.totalDistributed.toFixed(6)} JUNO`)}`,
		);

		StructuredLogger.logTransaction("Giveaway distributed", {
			userId,
			username: ctx.from.username,
			operation: "giveaway",
			amount: amount.toString(),
			recipients: userIds.length.toString(),
			totalDistributed: result.totalDistributed.toFixed(6),
			succeeded: result.succeeded.length.toString(),
			failed: result.failed.length.toString(),
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "giveaway",
		});
		await ctx.reply("Giveaway failed");
	}
}

/**
 * Handles the /checkdeposit command.
 * Manually checks and credits a specific deposit transaction by hash.
 * Useful for troubleshooting missed deposits or verifying transactions.
 *
 * Permission: All users (can check any transaction)
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /checkdeposit <tx_hash>
 * Example: /checkdeposit ABCD1234567890...
 */
export async function handleCheckDeposit(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 1) {
			await ctx.reply(
				fmt`${bold("Invalid format")}

Usage: ${code("/checkdeposit <tx_hash>")}
Example: ${code("/checkdeposit ABCD1234...")}`,
			);
			return;
		}

		const txHash = args[0];

		await ctx.reply(" Checking transaction...");

		// Use UnifiedWalletService to verify transaction
		const result = await UnifiedWalletService.verifyTransaction(txHash);

		if (!result.verified) {
			await ctx.reply(" Transaction not found on-chain or invalid.");
			return;
		}

		// Check if transaction was already processed
		const { get } = await import("../database");
		const processedDeposit = get<any>(
			"SELECT * FROM processed_deposits WHERE tx_hash = ?",
			[txHash],
		);

		const recipientUserId = result.memo ? parseInt(result.memo, 10) : null;

		if (processedDeposit) {
			await ctx.reply(
				fmt`${bold("Transaction Already Processed")}

From: ${code(result.from || "unknown")}
Amount: ${code(`${result.amount || 0} JUNO`)}${recipientUserId ? `\nUser ID: ${recipientUserId}` : ""}${result.memo ? `\nMemo: ${result.memo}` : ""}
Processed: Yes`,
			);
		} else {
			await ctx.reply(
				fmt`${bold("Transaction Found")}

From: ${code(result.from || "unknown")}
Amount: ${code(`${result.amount || 0} JUNO`)}
${recipientUserId ? `Recipient User ID: ${recipientUserId}` : "No valid user ID in memo"}${result.memo ? `\nMemo: ${result.memo}` : "\nNo memo"}
Status: Pending processing`,
			);
		}

		StructuredLogger.logTransaction("Manual deposit check", {
			userId,
			txHash,
			operation: "check_deposit",
			amount: result.amount?.toString(),
			processed: !!processedDeposit,
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "check_deposit",
			txHash: undefined,
		});
		await ctx.reply("Failed to check deposit");
	}
}

/**
 * Handles the /reconcile command.
 * Manually triggers a balance reconciliation check between the internal ledger
 * and on-chain wallet balances. Alerts if there's a mismatch and provides guidance.
 *
 * Permission: Owner only
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /reconcile
 */
export async function handleReconcile(ctx: Context): Promise<void> {
	try {
		await ctx.reply("Running balance reconciliation...");

		const { LedgerService } = await import("../services/ledgerService");
		const result = await LedgerService.reconcileAndAlert();

		if (!result.matched) {
			const direction =
				result.internalTotal > result.onChainTotal ? "debit" : "credit";
			const correctionAmount = result.difference.toFixed(6);

			const causes =
				direction === "debit"
					? `- Gas fees from withdrawals not deducted
- Failed withdrawal refunds over-credited
- Manual on-chain transfers from wallet`
					: `- Deposits not credited to ledger
- Manual deposits to the wallet`;

			await ctx.reply(
				fmt`${bold("Balance Reconciliation Results")}

Internal Ledger Total: ${code(`${result.internalTotal.toFixed(6)} JUNO`)}
On-Chain Balance: ${code(`${result.onChainTotal.toFixed(6)} JUNO`)}
Difference: ${code(`${result.difference.toFixed(6)} JUNO`)}

Status: MISMATCH

${bold("Correction Required:")}
The internal ledger is ${direction === "debit" ? "higher" : "lower"} than on-chain.

${bold("Likely Causes:")}
${causes}

${bold("To Fix:")}
/adjustbalance ${correctionAmount} ${direction}
This ${direction === "debit" ? "debits" : "credits"} ${correctionAmount} JUNO ${direction === "debit" ? "from" : "to"} reserve.`,
			);
		} else {
			await ctx.reply(
				fmt`${bold("Balance Reconciliation Results")}

Internal Ledger Total: ${code(`${result.internalTotal.toFixed(6)} JUNO`)}
On-Chain Balance: ${code(`${result.onChainTotal.toFixed(6)} JUNO`)}
Difference: ${code(`${result.difference.toFixed(6)} JUNO`)}

Status: Balanced`,
			);
		}

		StructuredLogger.logUserAction("Balance reconciliation triggered", {
			userId: ctx.from?.id,
			operation: "reconcile_balances",
			internalTotal: result.internalTotal.toFixed(6),
			onChainTotal: result.onChainTotal.toFixed(6),
			difference: result.difference.toFixed(6),
			matched: result.matched.toString(),
		});

		if (!result.matched) {
			StructuredLogger.logSecurityEvent("Balance mismatch detected", {
				userId: ctx.from?.id,
				operation: "reconcile_balances",
				internalTotal: result.internalTotal.toFixed(6),
				onChainTotal: result.onChainTotal.toFixed(6),
				difference: result.difference.toFixed(6),
			});
		}
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "reconcile_balances",
		});
		await ctx.reply("Failed to run reconciliation.");
	}
}

/**
 * Handles the /adjustbalance command.
 * Allows owners to manually adjust the ledger to match on-chain reality.
 * Uses SYSTEM_RESERVE account for corrections to maintain audit trail.
 *
 * Permission: Owner only
 *
 * @param ctx - Telegraf context
 *
 * @example
 * Usage: /adjustbalance <amount> <debit|credit> [reason]
 * Example: /adjustbalance 1.009172 debit Gas fees from withdrawals
 */
export async function handleAdjustBalance(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Adjust Balance - Manual Ledger Correction")}

Usage: ${code("/adjustbalance <amount> <debit|credit> [reason]")}

${bold("Examples:")}
${code("/adjustbalance 1.009 debit Gas fees")} - Reduce internal total
${code("/adjustbalance 0.5 credit Missed deposit")} - Increase internal total

${bold("How it works:")}
- ${code("debit")}: Removes amount from SYSTEM_RESERVE (reduces internal total)
- ${code("credit")}: Adds amount to SYSTEM_RESERVE (increases internal total)

${bold("When to use:")}
- After ${code("/reconcile")} shows a mismatch
- To account for gas fees, missed deposits, or manual transfers

Run ${code("/reconcile")} first to see the current discrepancy.`,
			);
			return;
		}

		const amount = parseFloat(args[0]);
		const direction = args[1].toLowerCase();
		const reason = args.slice(2).join(" ") || "Manual ledger adjustment";

		if (Number.isNaN(amount) || amount <= 0) {
			await ctx.reply("Invalid amount. Please enter a positive number.");
			return;
		}

		if (direction !== "debit" && direction !== "credit") {
			await ctx.reply(
				"Invalid direction. Use 'debit' to reduce internal total or 'credit' to increase it.",
			);
			return;
		}

		// Get current reconciliation state
		const { LedgerService } = await import("../services/ledgerService");
		const beforeState = await LedgerService.reconcileBalances();

		// Import SYSTEM_USER_IDS
		const { SYSTEM_USER_IDS } = await import(
			"../services/unifiedWalletService"
		);

		// Ensure SYSTEM_RESERVE has a balance entry
		await LedgerService.ensureUserBalance(SYSTEM_USER_IDS.SYSTEM_RESERVE);

		let result: { success: boolean; newBalance: number };

		if (direction === "debit") {
			// Debit from SYSTEM_RESERVE (will go negative, representing owed amount)
			result = await LedgerService.processAdjustment(
				SYSTEM_USER_IDS.SYSTEM_RESERVE,
				-amount,
				`[DEBIT] ${reason} (Reconciliation adjustment by user ${userId})`,
			);
		} else {
			// Credit to SYSTEM_RESERVE
			result = await LedgerService.processAdjustment(
				SYSTEM_USER_IDS.SYSTEM_RESERVE,
				amount,
				`[CREDIT] ${reason} (Reconciliation adjustment by user ${userId})`,
			);
		}

		if (!result.success) {
			await ctx.reply("Failed to process adjustment. Check logs for details.");
			return;
		}

		// Get new reconciliation state
		const afterState = await LedgerService.reconcileBalances();

		await ctx.reply(
			fmt`${bold("Ledger Adjustment Complete")}

${bold("Operation:")} ${direction.toUpperCase()} ${amount.toFixed(6)} JUNO
${bold("Reason:")} ${reason}
${bold("SYSTEM_RESERVE Balance:")} ${result.newBalance.toFixed(6)} JUNO

${bold("Before:")}
Internal: ${beforeState.internalTotal.toFixed(6)} JUNO
On-chain: ${beforeState.onChainTotal.toFixed(6)} JUNO
Difference: ${beforeState.difference.toFixed(6)} JUNO

${bold("After:")}
Internal: ${afterState.internalTotal.toFixed(6)} JUNO
On-chain: ${afterState.onChainTotal.toFixed(6)} JUNO
Difference: ${afterState.difference.toFixed(6)} JUNO

Status: ${afterState.matched ? "BALANCED" : "Still mismatched"}`,
		);

		StructuredLogger.logTransaction("Manual ledger adjustment", {
			userId,
			operation: "adjust_balance",
			direction,
			amount: amount.toFixed(6),
			reason,
			beforeDifference: beforeState.difference.toFixed(6),
			afterDifference: afterState.difference.toFixed(6),
			reserveBalance: result.newBalance.toFixed(6),
		});

		StructuredLogger.logSecurityEvent("Manual ledger adjustment performed", {
			userId,
			operation: "adjust_balance",
			direction,
			amount: amount.toFixed(6),
			reason,
		});
	} catch (error) {
		StructuredLogger.logError(error as Error, {
			userId: ctx.from?.id,
			operation: "adjust_balance",
		});
		await ctx.reply("Failed to adjust balance.");
	}
}
