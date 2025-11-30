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
import { config } from "../config";
import { UnifiedWalletService } from "../services/unifiedWalletService";
import { logger, StructuredLogger } from "../utils/logger";
import { escapeMarkdownV2 } from "../utils/markdown";
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
			`*Balance for ${escapeMarkdownV2(username)}*\n\n` +
				`Current balance: \`${escapeMarkdownV2(balance.toFixed(6))} JUNO\``,
			{ parse_mode: "MarkdownV2" },
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
			`*EXPERIMENTAL SOFTWARE WARNING*\n\n` +
				`This bot is *highly experimental* and under active development\\.\n\n` +
				`*DO NOT deposit funds you are not prepared to immediately lose\\.*\n\n` +
				`By depositing, you acknowledge:\n` +
				`\\- This software may contain bugs\n` +
				`\\- Funds may be irretrievably lost\n` +
				`\\- No guarantees or warranties are provided\n` +
				`\\- You use this service entirely at your own risk\n\n` +
				`If you understand and accept these risks, proceed with deposit instructions below\\.`,
			{ parse_mode: "MarkdownV2" },
		);

		await ctx.reply(
			`*Deposit Instructions*\n\n` +
				`To deposit JUNO to your account:\n\n` +
				`1\\. Send JUNO to this address:\n` +
				`\`${depositInfo.address}\`\n\n` +
				`2\\. *IMPORTANT*: Include this memo:\n` +
				`\`${depositInfo.memo}\`\n\n` +
				`*Your memo is unique to you and will never change*\n` +
				`*Deposits without the correct memo cannot be credited*\n\n` +
				`Your deposit will be credited automatically once confirmed on\\-chain\\.`,
			{ parse_mode: "MarkdownV2" },
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
				"*Invalid format*\n\n" +
					"Usage: `/withdraw \\<amount\\> \\<juno_address\\>`\n" +
					"Example: `/withdraw 10 juno1xxxxx\\.\\.\\.`",
				{ parse_mode: "MarkdownV2" },
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
				`*Insufficient balance*\n\n` +
					`Requested: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
					`Available: \`${escapeMarkdownV2(balance.toFixed(6))} JUNO\``,
				{ parse_mode: "MarkdownV2" },
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
				`*Withdrawal Successful*\n\n` +
					`Amount: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
					`To: \`${address}\`\n` +
					`New Balance: \`${escapeMarkdownV2(result.newBalance?.toFixed(6) || "0")} JUNO\`\n` +
					(result.txHash ? `\nTransaction: \`${result.txHash}\`` : ""),
				{ parse_mode: "MarkdownV2" },
			);
		} else {
			StructuredLogger.logError(`Withdrawal failed: ${result.error}`, {
				userId,
				operation: "withdrawal",
				amount: amount.toString(),
				toAddress: address,
			});

			await ctx.reply(
				`*Withdrawal Failed*\n\n` +
					`Error: ${escapeMarkdownV2(result.error || "Unknown error")}\n` +
					`Balance: \`${escapeMarkdownV2(result.newBalance?.toFixed(6) || "0")} JUNO\``,
				{ parse_mode: "MarkdownV2" },
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
				"*Invalid format*\n\n" +
					"Usage: `/send \\<amount\\> \\<recipient\\>`\n" +
					"Recipient can be:\n" +
					"\\- @username \\(internal transfer\\)\n" +
					"\\- User ID \\(internal transfer\\)\n" +
					"\\- juno1xxx\\.\\.\\. \\(external transfer\\)\n\n" +
					"Examples:\n" +
					"`/send 5 @alice`\n" +
					"`/send 10 123456789`\n" +
					"`/send 2.5 juno1xxxxx...`",
				{ parse_mode: "MarkdownV2" },
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
				`*Insufficient balance*\n\n` +
					`Requested: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
					`Available: \`${escapeMarkdownV2(balance.toFixed(6))} JUNO\``,
				{ parse_mode: "MarkdownV2" },
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
					`*External Transfer Successful*\n\n` +
						`Amount: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
						`To: \`${recipient}\`\n` +
						`New Balance: \`${escapeMarkdownV2(result.newBalance?.toFixed(6) || "0")} JUNO\`\n` +
						(result.txHash ? `\nTransaction: \`${result.txHash}\`` : ""),
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				StructuredLogger.logError(`External transfer failed: ${result.error}`, {
					userId,
					operation: "external_transfer",
					amount: amount.toString(),
					recipient,
				});

				await ctx.reply(
					`*Transfer Failed*\n\nError: ${escapeMarkdownV2(result.error || "Unknown error")}`,
					{
						parse_mode: "MarkdownV2",
					},
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
					`*Transfer Successful*\n\n` +
						`Amount: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
						`To: @${escapeMarkdownV2(result.recipient || "unknown")}\n` +
						`Your New Balance: \`${escapeMarkdownV2(result.fromBalance?.toFixed(6) || "0")} JUNO\``,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				StructuredLogger.logError(`Internal transfer failed: ${result.error}`, {
					userId,
					operation: "internal_transfer",
					amount: amount.toString(),
					recipient,
				});

				await ctx.reply(
					`*Transfer Failed*\n\nError: ${escapeMarkdownV2(result.error || "Unknown error")}`,
					{
						parse_mode: "MarkdownV2",
					},
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
					`*Transfer Successful*\n\n` +
						`Amount: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
						`To: User ${recipientId}\n` +
						`Your New Balance: \`${escapeMarkdownV2(result.fromBalance?.toFixed(6) || "0")} JUNO\``,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				StructuredLogger.logError(`Internal transfer failed: ${result.error}`, {
					userId,
					operation: "internal_transfer",
					amount: amount.toString(),
					recipientId: recipientId.toString(),
				});

				await ctx.reply(
					`*Transfer Failed*\n\nError: ${escapeMarkdownV2(result.error || "Unknown error")}`,
					{
						parse_mode: "MarkdownV2",
					},
				);
			}
		} else {
			await ctx.reply(
				"Invalid recipient format\\. Use @username, user ID, or juno1xxx\\.\\.\\. address\\.",
				{ parse_mode: "MarkdownV2" },
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

		let message =
			targetUserId === requesterId
				? "*Recent Transactions*\n\n"
				: `*Transaction History for User ${targetUserId}*\n\n`;

		for (const tx of transactions) {
			const date = escapeMarkdownV2(
				new Date((tx.created_at || 0) * 1000).toLocaleString(),
			);
			const type = tx.transaction_type.toUpperCase();
			const amount = escapeMarkdownV2(tx.amount.toFixed(6));

			let description = "";
			switch (tx.transaction_type) {
				case "deposit":
					description = `\\+${amount} JUNO \\(Deposit\\)`;
					break;
				case "withdrawal":
					description = `\\-${amount} JUNO \\(Withdrawal\\)`;
					break;
				case "transfer":
					if (tx.from_user_id === targetUserId) {
						description = `\\-${amount} JUNO \\(Sent\\)`;
					} else {
						description = `\\+${amount} JUNO \\(Received\\)`;
					}
					break;
				case "fine":
					description = `\\-${amount} JUNO \\(Fine\\)`;
					break;
				case "bail":
					description = `\\-${amount} JUNO \\(Bail\\)`;
					break;
				case "giveaway":
					description = `\\+${amount} JUNO \\(Giveaway\\)`;
					break;
				default:
					description = `${amount} JUNO \\(${escapeMarkdownV2(type)}\\)`;
			}

			message += `\\[${date}\\]\n`;
			message += `Type: ${escapeMarkdownV2(type)}\n`;
			message += `Amount: ${description}\n`;

			if (tx.status && tx.status !== "completed") {
				message += `Status: ${escapeMarkdownV2(tx.status.toUpperCase())}\n`;
			}

			if (tx.tx_hash) {
				message += `TX Hash: \`${tx.tx_hash}\`\n`;
			}

			if (tx.external_address) {
				message += `Address: \`${tx.external_address}\`\n`;
			}

			if (tx.description) {
				message += `Note: ${escapeMarkdownV2(tx.description)}\n`;
			}

			message += "\n";
		}

		await ctx.reply(message, { parse_mode: "MarkdownV2" });

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

		let message = "*Wallet System Statistics*\n\n";

		message += "*System Wallets:*\n";
		message += `Treasury: \`${escapeMarkdownV2(systemBalances.treasury.toFixed(6))} JUNO\`\n`;
		message += `Reserve: \`${escapeMarkdownV2(systemBalances.reserve.toFixed(6))} JUNO\`\n`;
		message += `Unclaimed: \`${escapeMarkdownV2(systemBalances.unclaimed.toFixed(6))} JUNO\`\n\n`;

		message += "*Ledger Statistics:*\n";
		message += `Total Users: ${ledgerStats.totalUsers}\n`;
		message += `Active Users: ${ledgerStats.activeUsers}\n`;
		message += `Total Balance \\(Internal\\): \`${escapeMarkdownV2(ledgerStats.totalBalance.toFixed(6))} JUNO\`\n`;
		message += `24h Deposits: ${ledgerStats.recentDeposits}\n`;
		message += `24h Withdrawals: ${ledgerStats.recentWithdrawals}\n\n`;

		message += "*Reconciliation:*\n";
		message += `Internal Total: \`${escapeMarkdownV2(reconciliation.internalTotal.toFixed(6))} JUNO\`\n`;
		message += `On\\-chain Total: \`${escapeMarkdownV2(reconciliation.onChainTotal.toFixed(6))} JUNO\`\n`;
		message += `Difference: \`${escapeMarkdownV2(reconciliation.difference.toFixed(6))} JUNO\`\n`;
		message += `Status: ${reconciliation.matched ? "Balanced" : "Mismatch"}\n`;

		await ctx.reply(message, { parse_mode: "MarkdownV2" });

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
				"*Invalid format*\n\n" +
					"Usage: `/giveaway \\<amount\\> \\<@user1\\> \\<@user2\\> \\.\\.\\.`\n" +
					"Example: `/giveaway 5 @alice @bob @charlie`",
				{ parse_mode: "MarkdownV2" },
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
			`*Giveaway Complete*\n\n` +
				`Amount per user: \`${escapeMarkdownV2(amount)} JUNO\`\n` +
				`Successful: ${result.succeeded.length}\n` +
				`Failed: ${result.failed.length}\n` +
				`Total distributed: \`${escapeMarkdownV2(result.totalDistributed.toFixed(6))} JUNO\``,
			{ parse_mode: "MarkdownV2" },
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
				"*Invalid format*\n\n" +
					"Usage: `/checkdeposit \\<tx_hash\\>`\n" +
					"Example: `/checkdeposit ABCD1234\\.\\.\\.`",
				{ parse_mode: "MarkdownV2" },
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
				`*Transaction Already Processed*\n\n` +
					`From: \`${result.from}\`\n` +
					`Amount: \`${escapeMarkdownV2(result.amount || 0)} JUNO\`\n` +
					(recipientUserId ? `User ID: ${recipientUserId}\n` : "") +
					(result.memo ? `Memo: ${escapeMarkdownV2(result.memo)}\n` : "") +
					`Processed: Yes`,
				{ parse_mode: "MarkdownV2" },
			);
		} else {
			await ctx.reply(
				`*Transaction Found*\n\n` +
					`From: \`${result.from}\`\n` +
					`Amount: \`${escapeMarkdownV2(result.amount || 0)} JUNO\`\n` +
					(recipientUserId
						? `Recipient User ID: ${recipientUserId}\n`
						: "No valid user ID in memo\n") +
					(result.memo
						? `Memo: ${escapeMarkdownV2(result.memo)}\n`
						: "No memo\n") +
					`Status: Pending processing`,
				{ parse_mode: "MarkdownV2" },
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

		let message =
			`*Balance Reconciliation Results*\n\n` +
			`Internal Ledger Total: \`${escapeMarkdownV2(result.internalTotal.toFixed(6))} JUNO\`\n` +
			`On\\-Chain Balance: \`${escapeMarkdownV2(result.onChainTotal.toFixed(6))} JUNO\`\n` +
			`Difference: \`${escapeMarkdownV2(result.difference.toFixed(6))} JUNO\`\n\n` +
			`Status: ${result.matched ? "Balanced" : "MISMATCH"}\n`;

		if (!result.matched) {
			const direction =
				result.internalTotal > result.onChainTotal ? "debit" : "credit";
			const correctionAmount = escapeMarkdownV2(result.difference.toFixed(6));

			message +=
				`\n*Correction Required:*\n` +
				`The internal ledger is ${direction === "debit" ? "higher" : "lower"} than on\\-chain\\.\n\n`;

			if (direction === "debit") {
				message +=
					`*Likely Causes:*\n` +
					`\\- Gas fees from withdrawals not deducted\n` +
					`\\- Failed withdrawal refunds over\\-credited\n` +
					`\\- Manual on\\-chain transfers from wallet\n\n` +
					`*To Fix:*\n` +
					`/adjustbalance ${correctionAmount} debit\n` +
					`This debits ${correctionAmount} JUNO from reserve\\.`;
			} else {
				message +=
					`*Likely Causes:*\n` +
					`\\- Deposits not credited to ledger\n` +
					`\\- Manual deposits to the wallet\n\n` +
					`*To Fix:*\n` +
					`/adjustbalance ${correctionAmount} credit\n` +
					`This credits ${correctionAmount} JUNO to reserve\\.`;
			}
		}

		await ctx.reply(message, { parse_mode: "MarkdownV2" });

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
				`*Adjust Balance \\- Manual Ledger Correction*\n\n` +
					`Usage: \`/adjustbalance \\<amount\\> \\<debit|credit\\> \\[reason\\]\`\n\n` +
					`*Examples:*\n` +
					`\`/adjustbalance 1.009 debit Gas fees\` \\- Reduce internal total\n` +
					`\`/adjustbalance 0.5 credit Missed deposit\` \\- Increase internal total\n\n` +
					`*How it works:*\n` +
					`\\- \`debit\`: Removes amount from SYSTEM\\_RESERVE \\(reduces internal total\\)\n` +
					`\\- \`credit\`: Adds amount to SYSTEM\\_RESERVE \\(increases internal total\\)\n\n` +
					`*When to use:*\n` +
					`\\- After \`/reconcile\` shows a mismatch\n` +
					`\\- To account for gas fees, missed deposits, or manual transfers\n\n` +
					`Run \`/reconcile\` first to see the current discrepancy\\.`,
				{ parse_mode: "MarkdownV2" },
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
			`*Ledger Adjustment Complete*\n\n` +
				`*Operation:* ${escapeMarkdownV2(direction.toUpperCase())} ${escapeMarkdownV2(amount.toFixed(6))} JUNO\n` +
				`*Reason:* ${escapeMarkdownV2(reason)}\n` +
				`*SYSTEM\\_RESERVE Balance:* ${escapeMarkdownV2(result.newBalance.toFixed(6))} JUNO\n\n` +
				`*Before:*\n` +
				`Internal: ${escapeMarkdownV2(beforeState.internalTotal.toFixed(6))} JUNO\n` +
				`On\\-chain: ${escapeMarkdownV2(beforeState.onChainTotal.toFixed(6))} JUNO\n` +
				`Difference: ${escapeMarkdownV2(beforeState.difference.toFixed(6))} JUNO\n\n` +
				`*After:*\n` +
				`Internal: ${escapeMarkdownV2(afterState.internalTotal.toFixed(6))} JUNO\n` +
				`On\\-chain: ${escapeMarkdownV2(afterState.onChainTotal.toFixed(6))} JUNO\n` +
				`Difference: ${escapeMarkdownV2(afterState.difference.toFixed(6))} JUNO\n\n` +
				`Status: ${afterState.matched ? "BALANCED" : "Still mismatched"}`,
			{ parse_mode: "MarkdownV2" },
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
