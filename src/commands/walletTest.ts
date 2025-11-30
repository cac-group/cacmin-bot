/**
 * Wallet testing command handlers for the CAC Admin Bot.
 * Provides owner-only commands for comprehensive wallet system testing,
 * including balance checks, transfers, deposits, withdrawals, and full flow tests.
 *
 * @module commands/walletTest
 */

import type { Context, Telegraf } from "telegraf";
import { ownerOnly } from "../middleware";
import { LedgerService } from "../services/ledgerService";
import {
	SYSTEM_USER_IDS,
	UnifiedWalletService,
} from "../services/unifiedWalletService";
import { logger } from "../utils/logger";
import { escapeMarkdownV2 } from "../utils/markdown";

/**
 * Registers all wallet test commands with the bot.
 *
 * All commands are owner-only for security purposes.
 *
 * Commands registered:
 * - /testbalance - Test balance checking
 * - /testdeposit - Test deposit instructions
 * - /testtransfer - Test internal transfer
 * - /testfine - Test fine payment
 * - /testwithdraw - Test withdrawal (dry run)
 * - /testverify - Test transaction verification
 * - /testwalletstats - Test wallet statistics
 * - /testsimulatedeposit - Simulate a deposit
 * - /testhistory - Test transaction history
 * - /testfullflow - Run full system flow test
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerWalletTestCommands } from './commands/walletTest';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerWalletTestCommands(bot);
 * ```
 */
export const registerWalletTestCommands = (bot: Telegraf<Context>) => {
	/**
	 * Command: /testbalance
	 * Test balance checking for user and bot treasury.
	 *
	 * Permission: Owner only
	 * Syntax: /testbalance
	 *
	 * @example
	 * User: /testbalance
	 * Bot: Balance Test
	 *
	 *      Your balance: `100.000000 JUNO`
	 *      Bot treasury: `500.000000 JUNO`
	 */
	bot.command("testbalance", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const balance = await UnifiedWalletService.getBalance(userId);
			const botBalance = await UnifiedWalletService.getBotBalance();

			await ctx.reply(
				`*Balance Test*\n\n` +
					`Your balance: \`${escapeMarkdownV2(balance.toFixed(6))} JUNO\`\n` +
					`Bot treasury: \`${escapeMarkdownV2(botBalance.toFixed(6))} JUNO\``,
				{ parse_mode: "MarkdownV2" },
			);
		} catch (error) {
			logger.error("Balance test failed", { userId, error });
			await ctx.reply("Balance test failed");
		}
	});

	/**
	 * Command: /testdeposit
	 * Test deposit instruction generation.
	 *
	 * Permission: Owner only
	 * Syntax: /testdeposit
	 */
	bot.command("testdeposit", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const instructions = UnifiedWalletService.getDepositInstructions(userId);

			await ctx.reply(
				`*Deposit Test Instructions*\n\n` +
					`Address:\n\`${escapeMarkdownV2(instructions.address)}\`\n\n` +
					`Memo: \`${escapeMarkdownV2(instructions.memo)}\`\n\n` +
					`${escapeMarkdownV2(instructions.instructions)}`,
				{ parse_mode: "MarkdownV2" },
			);
		} catch (error) {
			logger.error("Deposit test failed", { userId, error });
			await ctx.reply("Deposit test failed");
		}
	});

	/**
	 * Command: /testtransfer
	 * Test internal transfer between users.
	 *
	 * Permission: Owner only
	 * Syntax: /testtransfer <toUserId> <amount>
	 */
	bot.command("testtransfer", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];
		if (args.length < 2) {
			return ctx.reply("Usage: /testtransfer <toUserId> <amount>");
		}

		const toUserId = parseInt(args[0], 10);
		const amount = parseFloat(args[1]);

		if (Number.isNaN(toUserId) || Number.isNaN(amount) || amount <= 0) {
			return ctx.reply("Invalid parameters");
		}

		try {
			const result = await UnifiedWalletService.transferToUser(
				userId,
				toUserId,
				amount,
				"Test transfer",
			);

			if (result.success) {
				await ctx.reply(
					`*Transfer Test Successful*\n\n` +
						`Sent \`${escapeMarkdownV2(amount.toFixed(6))} JUNO\` to user ${escapeMarkdownV2(toUserId.toString())}\n` +
						`Your new balance: \`${escapeMarkdownV2(result.fromBalance?.toFixed(6) || "0")} JUNO\`\n` +
						`Recipient balance: \`${escapeMarkdownV2(result.toBalance?.toFixed(6) || "0")} JUNO\``,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				await ctx.reply(
					`Transfer failed: ${escapeMarkdownV2(result.error || "Unknown error")}`,
				);
			}
		} catch (error) {
			logger.error("Transfer test failed", { userId, toUserId, amount, error });
			await ctx.reply("Transfer test failed");
		}
	});

	/**
	 * Command: /testfine
	 * Test fine payment from user balance.
	 *
	 * Permission: Owner only
	 * Syntax: /testfine [amount]
	 */
	bot.command("testfine", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];
		const amount = parseFloat(args[0] || "1");

		if (Number.isNaN(amount) || amount <= 0) {
			return ctx.reply("Usage: /testfine [amount]");
		}

		try {
			const result = await UnifiedWalletService.payFine(
				userId,
				amount,
				"Test fine payment",
			);

			if (result.success) {
				const botBalance = await UnifiedWalletService.getBotBalance();

				await ctx.reply(
					`*Fine Test Successful*\n\n` +
						`Paid \`${escapeMarkdownV2(amount.toFixed(6))} JUNO\` fine\n` +
						`Your new balance: \`${escapeMarkdownV2(result.newBalance?.toFixed(6) || "0")} JUNO\`\n` +
						`Bot treasury balance: \`${escapeMarkdownV2(botBalance.toFixed(6))} JUNO\``,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				await ctx.reply(
					`Fine payment failed: ${escapeMarkdownV2(result.error || "Unknown error")}`,
				);
			}
		} catch (error) {
			logger.error("Fine test failed", { userId, amount, error });
			await ctx.reply("Fine test failed");
		}
	});

	/**
	 * Command: /testwithdraw
	 * Test withdrawal validation (dry run - no actual blockchain transaction).
	 *
	 * Permission: Owner only
	 * Syntax: /testwithdraw <address> <amount>
	 */
	bot.command("testwithdraw", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];
		if (args.length < 2) {
			return ctx.reply("Usage: /testwithdraw <address> <amount>");
		}

		const address = args[0];
		const amount = parseFloat(args[1]);

		if (!address.startsWith("juno1") || Number.isNaN(amount) || amount <= 0) {
			return ctx.reply("Invalid parameters. Address must start with juno1");
		}

		try {
			// Just validate, don't actually withdraw
			const balance = await UnifiedWalletService.getBalance(userId);

			if (balance < amount) {
				await ctx.reply(
					`*Withdrawal Test Failed*\n\n` +
						`Insufficient balance\n` +
						`Requested: \`${escapeMarkdownV2(amount.toFixed(6))} JUNO\`\n` +
						`Available: \`${escapeMarkdownV2(balance.toFixed(6))} JUNO\``,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				await ctx.reply(
					`*Withdrawal Test \\(DRY RUN\\)*\n\n` +
						`Would withdraw \`${escapeMarkdownV2(amount.toFixed(6))} JUNO\`\n` +
						`To: \`${escapeMarkdownV2(address)}\`\n` +
						`Current balance: \`${escapeMarkdownV2(balance.toFixed(6))} JUNO\`\n` +
						`Balance after: \`${escapeMarkdownV2((balance - amount).toFixed(6))} JUNO\`\n\n` +
						`This was a dry run \\- no actual withdrawal`,
					{ parse_mode: "MarkdownV2" },
				);
			}
		} catch (error) {
			logger.error("Withdrawal test failed", {
				userId,
				address,
				amount,
				error,
			});
			await ctx.reply("Withdrawal test failed");
		}
	});

	/**
	 * Command: /testverify
	 * Test on-chain transaction verification.
	 *
	 * Permission: Owner only
	 * Syntax: /testverify <txHash>
	 */
	bot.command("testverify", ownerOnly, async (ctx) => {
		const args = ctx.message?.text?.split(" ").slice(1) || [];
		if (args.length < 1) {
			return ctx.reply("Usage: /testverify <txHash>");
		}

		const txHash = args[0];

		try {
			const result = await UnifiedWalletService.verifyTransaction(txHash);

			if (result.verified) {
				await ctx.reply(
					`*Transaction Verified*\n\n` +
						`Hash: \`${escapeMarkdownV2(txHash)}\`\n` +
						`Amount: \`${escapeMarkdownV2(result.amount?.toFixed(6) || "0")} JUNO\`\n` +
						`From: \`${escapeMarkdownV2(result.from || "")}\`\n` +
						`To: \`${escapeMarkdownV2(result.to || "")}\`\n` +
						`Memo: ${escapeMarkdownV2(result.memo || "None")}`,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				await ctx.reply("Transaction not found or invalid");
			}
		} catch (error) {
			logger.error("Verification test failed", { txHash, error });
			await ctx.reply("Verification test failed");
		}
	});

	/**
	 * Command: /testwalletstats
	 * Test wallet statistics and reconciliation.
	 *
	 * Permission: Owner only
	 * Syntax: /testwalletstats
	 */
	bot.command("testwalletstats", ownerOnly, async (ctx) => {
		try {
			const stats = await UnifiedWalletService.getStats();

			await ctx.reply(
				`*Wallet Statistics*\n\n` +
					`*System Wallet*\n` +
					`Address: \`${escapeMarkdownV2(stats.walletAddress)}\`\n` +
					`On\\-chain balance: \`${escapeMarkdownV2(stats.onChainBalance.toFixed(6))} JUNO\`\n\n` +
					`*Internal Ledger*\n` +
					`Total user balances: \`${escapeMarkdownV2(stats.internalTotal.toFixed(6))} JUNO\`\n` +
					`Bot treasury: \`${escapeMarkdownV2(stats.botBalance.toFixed(6))} JUNO\`\n` +
					`Unclaimed deposits: \`${escapeMarkdownV2(stats.unclaimedBalance.toFixed(6))} JUNO\`\n\n` +
					`*Status*\n` +
					`Active users: ${escapeMarkdownV2(stats.activeUsers.toString())}\n` +
					`Pending deposits: ${escapeMarkdownV2(stats.pendingDeposits.toString())}\n` +
					`Reconciled: ${stats.reconciled ? "Yes" : "No"}\n` +
					`${!stats.reconciled ? `Difference: ${escapeMarkdownV2(Math.abs(stats.onChainBalance - stats.internalTotal).toFixed(6))} JUNO` : ""}`,
				{ parse_mode: "MarkdownV2" },
			);
		} catch (error) {
			logger.error("Wallet stats test failed", { error });
			await ctx.reply("Wallet stats test failed");
		}
	});

	/**
	 * Command: /testsimulatedeposit
	 * Simulate a deposit without blockchain transaction (for testing).
	 *
	 * Permission: Owner only
	 * Syntax: /testsimulatedeposit [userId] [amount]
	 */
	bot.command("testsimulatedeposit", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text?.split(" ").slice(1) || [];
		const targetUserId = args[0] ? parseInt(args[0], 10) : userId;
		const amount = parseFloat(args[1] || "10");

		if (Number.isNaN(targetUserId) || Number.isNaN(amount) || amount <= 0) {
			return ctx.reply("Usage: /testsimulatedeposit [userId] [amount]");
		}

		try {
			// Simulate a deposit by directly crediting the user
			const result = await LedgerService.processDeposit(
				targetUserId,
				amount,
				`TEST_${Date.now()}`,
				"simulated_address",
				"Test deposit simulation",
			);

			if (result.success) {
				await ctx.reply(
					`*Deposit Simulation Successful*\n\n` +
						`User ${escapeMarkdownV2(targetUserId.toString())} credited with \`${escapeMarkdownV2(amount.toFixed(6))} JUNO\`\n` +
						`New balance: \`${escapeMarkdownV2(result.newBalance.toFixed(6))} JUNO\`\n\n` +
						`This is a simulated deposit for testing`,
					{ parse_mode: "MarkdownV2" },
				);
			} else {
				await ctx.reply(
					`Deposit simulation failed: ${escapeMarkdownV2(result.error || "Unknown error")}`,
				);
			}
		} catch (error) {
			logger.error("Deposit simulation failed", {
				targetUserId,
				amount,
				error,
			});
			await ctx.reply("Deposit simulation failed");
		}
	});

	/**
	 * Command: /testhistory
	 * Test transaction history retrieval.
	 *
	 * Permission: Owner only
	 * Syntax: /testhistory
	 */
	bot.command("testhistory", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const transactions = await LedgerService.getUserTransactions(userId, 5);

			if (transactions.length === 0) {
				return ctx.reply("No transaction history found");
			}

			let message = "*Recent Transactions*\n\n";

			for (const tx of transactions) {
				const type = tx.transactionType;
				const amount = tx.amount;
				const isCredit = tx.toUserId === userId;

				message += `${isCredit ? "" : ""} ${escapeMarkdownV2(type.toUpperCase())}: \`${escapeMarkdownV2(amount.toFixed(6))} JUNO\`\n`;

				if (tx.description) {
					message += `   ${escapeMarkdownV2(tx.description)}\n`;
				}

				if (tx.txHash) {
					message += `   Hash: \`${escapeMarkdownV2(tx.txHash.substring(0, 10))}\\.\\.\\.\`\n`;
				}

				message += "\n";
			}

			await ctx.reply(message, { parse_mode: "MarkdownV2" });
		} catch (error) {
			logger.error("History test failed", { userId, error });
			await ctx.reply("History test failed");
		}
	});

	/**
	 * Command: /testfullflow
	 * Run a comprehensive full system flow test including deposit, fine, and transfer.
	 *
	 * Permission: Owner only
	 * Syntax: /testfullflow
	 *
	 * Tests the following sequence:
	 * 1. Check initial balance
	 * 2. Simulate a deposit
	 * 3. Pay a fine
	 * 4. Transfer to bot
	 * 5. Verify final balances
	 */
	bot.command("testfullflow", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		await ctx.reply("Starting full wallet flow test...");

		try {
			// 1. Check initial balance
			const initialBalance = await UnifiedWalletService.getBalance(userId);
			await ctx.reply(
				`1 Initial balance: ${escapeMarkdownV2(initialBalance.toFixed(6))} JUNO`,
			);

			// 2. Simulate a deposit
			const depositAmount = 100;
			const depositResult = await LedgerService.processDeposit(
				userId,
				depositAmount,
				`FULLTEST_${Date.now()}`,
				"test_address",
				"Full flow test deposit",
			);

			if (!depositResult.success) {
				throw new Error(`Deposit failed: ${depositResult.error}`);
			}

			await ctx.reply(
				`2 Deposit: +${escapeMarkdownV2(depositAmount.toString())} JUNO (balance: ${escapeMarkdownV2(depositResult.newBalance.toFixed(6))})`,
			);

			// 3. Pay a fine
			const fineAmount = 10;
			const fineResult = await UnifiedWalletService.payFine(
				userId,
				fineAmount,
				"Test fine",
			);

			if (!fineResult.success) {
				throw new Error(`Fine payment failed: ${fineResult.error}`);
			}

			await ctx.reply(
				`3 Fine paid: -${escapeMarkdownV2(fineAmount.toString())} JUNO (balance: ${escapeMarkdownV2(fineResult.newBalance?.toFixed(6) || "0")})`,
			);

			// 4. Transfer to bot
			const transferAmount = 5;
			const transferResult = await UnifiedWalletService.transferToUser(
				userId,
				SYSTEM_USER_IDS.BOT_TREASURY,
				transferAmount,
				"Test transfer to bot",
			);

			if (!transferResult.success) {
				throw new Error(`Transfer failed: ${transferResult.error}`);
			}

			await ctx.reply(
				`4 Transfer to bot: -${escapeMarkdownV2(transferAmount.toString())} JUNO (balance: ${escapeMarkdownV2(transferResult.fromBalance?.toFixed(6) || "0")})`,
			);

			// 5. Check final balances
			const finalUserBalance = await UnifiedWalletService.getBalance(userId);
			const botBalance = await UnifiedWalletService.getBotBalance();

			await ctx.reply(
				`*Full Flow Test Complete*\n\n` +
					`Initial balance: \`${escapeMarkdownV2(initialBalance.toFixed(6))} JUNO\`\n` +
					`Deposited: \`${escapeMarkdownV2(`+${depositAmount}`)} JUNO\`\n` +
					`Fine paid: \`${escapeMarkdownV2(`-${fineAmount}`)} JUNO\`\n` +
					`Transferred: \`${escapeMarkdownV2(`-${transferAmount}`)} JUNO\`\n\n` +
					`Expected: \`${escapeMarkdownV2((initialBalance + depositAmount - fineAmount - transferAmount).toFixed(6))} JUNO\`\n` +
					`Actual: \`${escapeMarkdownV2(finalUserBalance.toFixed(6))} JUNO\`\n\n` +
					`Bot treasury: \`${escapeMarkdownV2(botBalance.toFixed(6))} JUNO\``,
				{ parse_mode: "MarkdownV2" },
			);
		} catch (error) {
			logger.error("Full flow test failed", { userId, error });
			await ctx.reply(
				`Full flow test failed: ${escapeMarkdownV2(error instanceof Error ? error.message : "Unknown error")}`,
			);
		}
	});

	logger.info("Wallet test commands registered");
};
