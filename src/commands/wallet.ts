/**
 * Wallet command handlers for the CAC Admin Bot.
 * Provides user wallet functionality including balance checking, deposits,
 * withdrawals, transfers, and transaction history.
 *
 * @module commands/wallet
 */

import type { Context, Telegraf } from "telegraf";
import { bold, fmt } from "telegraf/format";
import {
	handleAdjustBalance,
	handleBalance,
	handleCheckDeposit,
	handleContributeTreasury,
	handleFundTreasury,
	handleReconcile,
	handleSend,
	handleTransactions,
	handleTreasuryBalance,
	handleWalletStats,
	handleWithdraw,
	handleWithdrawTreasury,
} from "../handlers/wallet";
import { adminOrHigher, ownerOnly } from "../middleware/index";
import { financialLockCheck } from "../middleware/lockCheck";

export function buildWalletHelpText(userId: string) {
	return fmt`${bold("Wallet Commands")}

${bold("Basic Commands:")}
/balance (or /bal) - Check your internal wallet balance
/deposit - Get deposit instructions with your required memo
/verifydeposit <txhash> - Verify and credit a deposit by hash
/withdraw <amount> <address> - Withdraw to an external wallet
/send <amount> <recipient> (or /transfer) - Send to @username, user ID, or juno1... address
/transactions [@user|userId] (or /history) - View your recent transactions; owners can target another user
/checkdeposit <txhash> (or /checktx) - Check whether a deposit was already processed
/unclaimeddeposits - View deposits that arrived with a missing or invalid memo

${bold("Treasury Commands:")}
/fundtreasury <amount> - Move funds from your balance into the game treasury
/fundtreasury deposit - Get external deposit instructions for the game treasury
/treasurybalance (or /gamebalance) - Check the game treasury balance (admin+)
/contributetreasury <amount> - Contribute to the treasury from your balance (admin+)
/withdrawtreasury <amount> - Withdraw treasury funds back to your balance (owner only)

${bold("Owner Diagnostics (owner only):")}
/walletstats - View system wallet statistics (owner only)
/reconcile - Check internal ledger vs on-chain balance (owner only)
/adjustbalance <amount> <debit|credit> [reason] - Correct ledger discrepancies (owner only)

${bold("Important:")}
- Always include your user ID (${userId}) as memo when depositing
- Withdrawals are locked to prevent double-spending
- Internal transfers are instant and free
- External transfers incur network fees`;
}

/**
 * Registers all wallet-related commands with the bot.
 *
 * Commands registered:
 * - /balance (alias: /bal) - Check internal ledger balance
 * - /deposit - Get deposit instructions
 * - /withdraw - Withdraw to external wallet (with locking)
 * - /send (alias: /transfer) - Send to user or external wallet (with locking)
 * - /transactions (alias: /history) - View transaction history
 * - /walletstats - System statistics (owner only)
 * - /reconcile - Check ledger vs on-chain balance (owner only)
 * - /checkdeposit - Check specific deposit by transaction hash
 * - /wallethelp - Display wallet command help
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerWalletCommands } from './commands/wallet';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerWalletCommands(bot);
 * ```
 */
export function registerWalletCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /balance (alias: /bal)
	 * Check user's internal ledger balance.
	 *
	 * Permission: Any user
	 * Syntax: /balance
	 */
	bot.command("balance", handleBalance);
	bot.command("bal", handleBalance); // Alias

	/**
	 * Command: /withdraw
	 * Withdraw funds to an external Juno address (with financial locking).
	 *
	 * Permission: Any user
	 * Syntax: /withdraw <amount> <address>
	 */
	bot.command("withdraw", financialLockCheck, handleWithdraw);

	/**
	 * Command: /send (alias: /transfer)
	 * Send funds to another user or external wallet (with locking for external transfers).
	 *
	 * Permission: Any user
	 * Syntax: /send <amount> <recipient>
	 * - recipient can be @username, userId, or juno1... address
	 */
	bot.command("send", financialLockCheck, handleSend);
	bot.command("transfer", financialLockCheck, handleSend); // Alias

	/**
	 * Command: /transactions (alias: /history)
	 * View transaction history.
	 *
	 * Permission: Any user (own transactions only)
	 *             Owners (can specify userId to view any user's transactions)
	 * Syntax: /transactions
	 *         /transactions <userId> (owners only)
	 */
	bot.command("transactions", handleTransactions);
	bot.command("history", handleTransactions); // Alias

	/**
	 * Command: /walletstats
	 * View system wallet statistics and ledger reconciliation (owner only).
	 *
	 * Permission: Owner only
	 * Syntax: /walletstats
	 */
	bot.command("walletstats", ownerOnly, handleWalletStats);

	/**
	 * Command: /reconcile
	 * Check internal ledger balance against on-chain balance (owner only).
	 * Shows mismatch details and provides correction commands.
	 *
	 * Permission: Owner only
	 * Syntax: /reconcile
	 */
	bot.command("reconcile", ownerOnly, handleReconcile);

	/**
	 * Command: /adjustbalance
	 * Manually adjust the internal ledger to correct discrepancies.
	 * Uses SYSTEM_RESERVE account for audit trail.
	 *
	 * Permission: Owner only
	 * Syntax: /adjustbalance <amount> <debit|credit> [reason]
	 */
	bot.command("adjustbalance", ownerOnly, handleAdjustBalance);

	/**
	 * Command: /checkdeposit (alias: /checktx)
	 * Check status of a specific deposit by transaction hash.
	 *
	 * Permission: Any user
	 * Syntax: /checkdeposit <txhash>
	 *         /checktx <txhash>
	 */
	bot.command("checkdeposit", handleCheckDeposit);
	bot.command("checktx", handleCheckDeposit); // Alias

	/**
	 * Command: /wallethelp
	 * Display comprehensive wallet command help.
	 *
	 * Permission: Any user
	 * Syntax: /wallethelp
	 */
	bot.command("wallethelp", async (ctx) => {
		const userId = ctx.from?.id ? ctx.from.id.toString() : "unknown";
		await ctx.reply(buildWalletHelpText(userId));
	});

	/**
	 * Command: /treasurybalance (alias: /gamebalance)
	 * Check game treasury balance.
	 *
	 * Permission: Admin or higher
	 * Syntax: /treasurybalance
	 */
	bot.command("treasurybalance", adminOrHigher, handleTreasuryBalance);
	bot.command("gamebalance", adminOrHigher, handleTreasuryBalance);

	/**
	 * Command: /fundtreasury
	 * Fund the game treasury (transfer from own balance or get deposit instructions).
	 *
	 * Permission: All users
	 * Syntax: /fundtreasury <amount> | /fundtreasury deposit
	 */
	bot.command("fundtreasury", handleFundTreasury);

	/**
	 * Command: /contributetreasury
	 * Contribute to game treasury from your own balance.
	 *
	 * Permission: Admin or higher
	 * Syntax: /contributetreasury <amount>
	 */
	bot.command("contributetreasury", adminOrHigher, handleContributeTreasury);

	/**
	 * Command: /withdrawtreasury
	 * Withdraw from game treasury to your balance.
	 *
	 * Permission: Owner only
	 * Syntax: /withdrawtreasury <amount>
	 */
	bot.command("withdrawtreasury", ownerOnly, handleWithdrawTreasury);
}
