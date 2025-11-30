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
	handleReconcile,
	handleSend,
	handleTransactions,
	handleWalletStats,
	handleWithdraw,
} from "../handlers/wallet";
import { ownerOnly } from "../middleware/index";
import { financialLockCheck } from "../middleware/lockCheck";

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
	 * Syntax: /checkdeposit <tx_hash>
	 *         /checktx <tx_hash>
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
		await ctx.reply(
			fmt`${bold("Wallet Commands")}

${bold("Basic Commands:")}
/balance - Check your balance
/deposit - Get deposit instructions
/withdraw <amount> <address> - Withdraw to external wallet
/send <amount> <recipient> - Send to user or wallet
/transactions - View transaction history
/checkdeposit <tx_hash> - Check a specific deposit

${bold("Send Recipients:")}
- @username - Send to another user
- User ID - Send to user by ID
- juno1... - Send to external wallet

${bold("Owner Commands:")}
/walletstats - System statistics
/giveaway <@user|id> <amount> - Send giveaway to user
/reconcile - Check internal ledger vs on-chain balance
/adjustbalance <amt> <debit|credit> - Fix ledger discrepancies

${bold("Important:")}
- Always include your user ID (${userId}) as memo when depositing
- Withdrawals are locked to prevent double-spending
- Internal transfers are instant and free
- External transfers incur network fees`,
		);
	});
}
