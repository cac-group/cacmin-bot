/**
 * Wallet testing command handlers for the CAC Admin Bot.
 * Provides owner-only commands for comprehensive wallet system testing,
 * including balance checks, transfers, deposits, withdrawals, and full flow tests.
 *
 * @module commands/walletTest
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { ownerOnly } from "../middleware";
import { LedgerService } from "../services/ledgerService";
import {
	SYSTEM_USER_IDS,
	UnifiedWalletService,
} from "../services/unifiedWalletService";
import { logger } from "../utils/logger";

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
 */
export const registerWalletTestCommands = (bot: Telegraf<Context>) => {
	/**
	 * Command: /testbalance
	 * Test balance checking for user and bot treasury.
	 */
	bot.command("testbalance", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const balance = await UnifiedWalletService.getBalance(userId);
			const botBalance = await UnifiedWalletService.getBotBalance();

			await ctx.reply(
				fmt`${bold("Balance Test")}

Your balance: ${code(`${balance.toFixed(6)} JUNO`)}
Bot treasury: ${code(`${botBalance.toFixed(6)} JUNO`)}`,
			);
		} catch (error) {
			logger.error("Balance test failed", { userId, error });
			await ctx.reply("Balance test failed");
		}
	});

	/**
	 * Command: /testdeposit
	 * Test deposit instruction generation.
	 */
	bot.command("testdeposit", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const instructions = UnifiedWalletService.getDepositInstructions(userId);

			await ctx.reply(
				fmt`${bold("Deposit Test Instructions")}

Address:
${code(instructions.address)}

Memo: ${code(instructions.memo)}

${instructions.instructions}`,
			);
		} catch (error) {
			logger.error("Deposit test failed", { userId, error });
			await ctx.reply("Deposit test failed");
		}
	});

	/**
	 * Command: /testtransfer
	 * Test internal transfer between users.
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
					fmt`${bold("Transfer Test Successful")}

Sent ${code(`${amount.toFixed(6)} JUNO`)} to user ${toUserId}
Your new balance: ${code(`${result.fromBalance?.toFixed(6) || "0"} JUNO`)}
Recipient balance: ${code(`${result.toBalance?.toFixed(6) || "0"} JUNO`)}`,
				);
			} else {
				await ctx.reply(`Transfer failed: ${result.error || "Unknown error"}`);
			}
		} catch (error) {
			logger.error("Transfer test failed", { userId, toUserId, amount, error });
			await ctx.reply("Transfer test failed");
		}
	});

	/**
	 * Command: /testfine
	 * Test fine payment from user balance.
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
					fmt`${bold("Fine Test Successful")}

Paid ${code(`${amount.toFixed(6)} JUNO`)} fine
Your new balance: ${code(`${result.newBalance?.toFixed(6) || "0"} JUNO`)}
Bot treasury balance: ${code(`${botBalance.toFixed(6)} JUNO`)}`,
				);
			} else {
				await ctx.reply(
					`Fine payment failed: ${result.error || "Unknown error"}`,
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
			const balance = await UnifiedWalletService.getBalance(userId);

			if (balance < amount) {
				await ctx.reply(
					fmt`${bold("Withdrawal Test Failed")}

Insufficient balance
Requested: ${code(`${amount.toFixed(6)} JUNO`)}
Available: ${code(`${balance.toFixed(6)} JUNO`)}`,
				);
			} else {
				await ctx.reply(
					fmt`${bold("Withdrawal Test (DRY RUN)")}

Would withdraw ${code(`${amount.toFixed(6)} JUNO`)}
To: ${code(address)}
Current balance: ${code(`${balance.toFixed(6)} JUNO`)}
Balance after: ${code(`${(balance - amount).toFixed(6)} JUNO`)}

This was a dry run - no actual withdrawal`,
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
					fmt`${bold("Transaction Verified")}

Hash: ${code(txHash)}
Amount: ${code(`${result.amount?.toFixed(6) || "0"} JUNO`)}
From: ${code(result.from || "")}
To: ${code(result.to || "")}
Memo: ${result.memo || "None"}`,
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
	 */
	bot.command("testwalletstats", ownerOnly, async (ctx) => {
		try {
			const stats = await UnifiedWalletService.getStats();
			const diffText = !stats.reconciled
				? `Difference: ${Math.abs(stats.onChainBalance - stats.internalTotal).toFixed(6)} JUNO`
				: "";

			await ctx.reply(
				fmt`${bold("Wallet Statistics")}

${bold("System Wallet")}
Address: ${code(stats.walletAddress)}
On-chain balance: ${code(`${stats.onChainBalance.toFixed(6)} JUNO`)}

${bold("Internal Ledger")}
Total user balances: ${code(`${stats.internalTotal.toFixed(6)} JUNO`)}
Bot treasury: ${code(`${stats.botBalance.toFixed(6)} JUNO`)}
Unclaimed deposits: ${code(`${stats.unclaimedBalance.toFixed(6)} JUNO`)}

${bold("Status")}
Active users: ${stats.activeUsers}
Pending deposits: ${stats.pendingDeposits}
Reconciled: ${stats.reconciled ? "Yes" : "No"}
${diffText}`,
			);
		} catch (error) {
			logger.error("Wallet stats test failed", { error });
			await ctx.reply("Wallet stats test failed");
		}
	});

	/**
	 * Command: /testsimulatedeposit
	 * Simulate a deposit without blockchain transaction (for testing).
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
			const result = await LedgerService.processDeposit(
				targetUserId,
				amount,
				`TEST_${Date.now()}`,
				"simulated_address",
				"Test deposit simulation",
			);

			if (result.success) {
				await ctx.reply(
					fmt`${bold("Deposit Simulation Successful")}

User ${targetUserId} credited with ${code(`${amount.toFixed(6)} JUNO`)}
New balance: ${code(`${result.newBalance.toFixed(6)} JUNO`)}

This is a simulated deposit for testing`,
				);
			} else {
				await ctx.reply(
					`Deposit simulation failed: ${result.error || "Unknown error"}`,
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
	 */
	bot.command("testhistory", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const transactions = await LedgerService.getUserTransactions(userId, 5);

			if (transactions.length === 0) {
				return ctx.reply("No transaction history found");
			}

			const txLines: string[] = [];
			for (const tx of transactions) {
				const type = tx.transactionType;
				const amount = tx.amount;
				txLines.push(`${type.toUpperCase()}: ${amount.toFixed(6)} JUNO`);
				if (tx.description) {
					txLines.push(`   ${tx.description}`);
				}
				if (tx.txHash) {
					txLines.push(`   Hash: ${tx.txHash.substring(0, 10)}...`);
				}
				txLines.push("");
			}

			await ctx.reply(
				fmt`${bold("Recent Transactions")}

${txLines.join("\n")}`,
			);
		} catch (error) {
			logger.error("History test failed", { userId, error });
			await ctx.reply("History test failed");
		}
	});

	/**
	 * Command: /testfullflow
	 * Run a comprehensive full system flow test including deposit, fine, and transfer.
	 */
	bot.command("testfullflow", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		await ctx.reply("Starting full wallet flow test...");

		try {
			// 1. Check initial balance
			const initialBalance = await UnifiedWalletService.getBalance(userId);
			await ctx.reply(`1. Initial balance: ${initialBalance.toFixed(6)} JUNO`);

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
				`2. Deposit: +${depositAmount} JUNO (balance: ${depositResult.newBalance.toFixed(6)})`,
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
				`3. Fine paid: -${fineAmount} JUNO (balance: ${fineResult.newBalance?.toFixed(6) || "0"})`,
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
				`4. Transfer to bot: -${transferAmount} JUNO (balance: ${transferResult.fromBalance?.toFixed(6) || "0"})`,
			);

			// 5. Check final balances
			const finalUserBalance = await UnifiedWalletService.getBalance(userId);
			const botBalance = await UnifiedWalletService.getBotBalance();
			const expectedBalance =
				initialBalance + depositAmount - fineAmount - transferAmount;

			await ctx.reply(
				fmt`${bold("Full Flow Test Complete")}

Initial balance: ${code(`${initialBalance.toFixed(6)} JUNO`)}
Deposited: ${code(`+${depositAmount} JUNO`)}
Fine paid: ${code(`-${fineAmount} JUNO`)}
Transferred: ${code(`-${transferAmount} JUNO`)}

Expected: ${code(`${expectedBalance.toFixed(6)} JUNO`)}
Actual: ${code(`${finalUserBalance.toFixed(6)} JUNO`)}

Bot treasury: ${code(`${botBalance.toFixed(6)} JUNO`)}`,
			);
		} catch (error) {
			logger.error("Full flow test failed", { userId, error });
			await ctx.reply(
				`Full flow test failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	});

	logger.info("Wallet test commands registered");
};
