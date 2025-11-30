/**
 * Giveaway command handlers for the CAC Admin Bot.
 * Provides open giveaway system where users can claim slots.
 *
 * @module commands/giveaway
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, get, query } from "../database";
import { ownerOnly } from "../middleware/index";
import { LedgerService } from "../services/ledgerService";
import {
	getGiveawayEscrowId,
	SYSTEM_USER_IDS,
	UnifiedWalletService,
} from "../services/unifiedWalletService";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { hasRole } from "../utils/roles";

interface Giveaway {
	id: number;
	created_by: number;
	funded_by: number;
	total_amount: number;
	amount_per_slot: number;
	total_slots: number;
	claimed_slots: number;
	chat_id: number;
	message_id: number | null;
	status: "active" | "completed" | "cancelled";
	created_at: number;
	completed_at: number | null;
}

/**
 * Registers all giveaway-related commands with the bot.
 *
 * Commands registered:
 * - /balance - Check bot wallet balance (admin only)
 * - /giveaway - Send tokens to a user (admin only)
 * - /treasury - View treasury and ledger status (admin only)
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerGiveawayCommands } from './commands/giveaway';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerGiveawayCommands(bot);
 * ```
 */
export function registerGiveawayCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /botbalance
	 * Check the bot's on-chain wallet balance.
	 *
	 * Permission: Owner only
	 * Syntax: /botbalance
	 *
	 * @example
	 * User: /botbalance
	 * Bot: Bot Wallet Balance
	 *      Address: `juno1...`
	 *      Balance: *123.456789 JUNO*
	 */
	bot.command("botbalance", ownerOnly, async (ctx) => {
		try {
			const balance = await UnifiedWalletService.getBotBalance();

			if (!balance) {
				return ctx.reply(" Unable to fetch wallet balance.");
			}

			await ctx.reply(
				` *Bot Wallet Balance*\n\n` +
					`Address: \`${config.botTreasuryAddress}\`\n` +
					`Balance: *${balance.toFixed(6)} JUNO*`,
				{ parse_mode: "Markdown" },
			);
		} catch (error) {
			logger.error("Error fetching balance", error);
			await ctx.reply(" Error fetching wallet balance.");
		}
	});

	/**
	 * Command: /giveaway
	 * Create an open giveaway that users can claim by clicking a button.
	 *
	 * Permission: All users (funded from own balance)
	 *             Owners/Admins can also fund from treasury
	 * Syntax: /giveaway <amount>
	 *
	 * Creates an open giveaway where the total amount is split into slots.
	 * Users click the "Claim" button to receive their share.
	 * Each user can only claim once per giveaway.
	 */
	bot.command("giveaway", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text.split(" ").slice(1);

		if (!args || args.length < 1) {
			return ctx.reply(
				"*Open Giveaway*\n\n" +
					"Usage: `/giveaway <total_amount>`\n\n" +
					"Example: `/giveaway 100`\n" +
					"Creates a 100 JUNO giveaway. You'll then choose how many slots (10, 25, 50, or 100) to split it into.\n\n" +
					"*How it works:*\n" +
					"1. Enter total amount to give away\n" +
					"2. Select number of slots (e.g., 10 slots = 10 JUNO each)\n" +
					"3. Funds are held in escrow\n" +
					"4. Users click Claim button (one per user)\n" +
					"5. Cancel anytime with `/cancelgiveaway` to reclaim unclaimed funds\n\n" +
					"Funds come from your wallet balance.\n" +
					"Admins/owners can also fund from treasury.",
				{ parse_mode: "Markdown" },
			);
		}

		const totalAmount = parseFloat(args[0]);

		if (Number.isNaN(totalAmount) || totalAmount <= 0) {
			return ctx.reply("Invalid amount. Must be a positive number.");
		}

		try {
			AmountPrecision.validateAmount(totalAmount);
		} catch {
			return ctx.reply("Invalid amount precision. Max 6 decimal places.");
		}

		// Check user's balance
		const userBalance = await LedgerService.getUserBalance(userId);
		const isOwnerOrAdmin = hasRole(userId, "owner") || hasRole(userId, "admin");

		// Get treasury balance for owners/admins
		let treasuryBalance = 0;
		if (isOwnerOrAdmin) {
			treasuryBalance = await LedgerService.getUserBalance(
				SYSTEM_USER_IDS.BOT_TREASURY,
			);
		}

		// Check if user can afford it from their balance
		const canAffordFromBalance = userBalance >= totalAmount;
		const canAffordFromTreasury =
			isOwnerOrAdmin && treasuryBalance >= totalAmount;

		if (!canAffordFromBalance && !canAffordFromTreasury) {
			let msg = `Insufficient balance.\nYour balance: ${userBalance.toFixed(6)} JUNO`;
			if (isOwnerOrAdmin) {
				msg += `\nTreasury balance: ${treasuryBalance.toFixed(6)} JUNO`;
			}
			return ctx.reply(msg);
		}

		// Build slot selection keyboard
		const slotOptions = [10, 25, 50, 100];
		const slotInfo = slotOptions
			.map((s) => `- ${s} slots = ${(totalAmount / s).toFixed(6)} JUNO each`)
			.join("\n");

		// For owners/admins who can afford from both sources, show funding choice
		if (isOwnerOrAdmin && canAffordFromBalance && canAffordFromTreasury) {
			await ctx.reply(
				`*Create Giveaway: ${totalAmount} JUNO*\n\n` +
					"Select funding source:\n" +
					`Your balance: ${userBalance.toFixed(6)} JUNO\n` +
					`Treasury: ${treasuryBalance.toFixed(6)} JUNO`,
				{
					parse_mode: "Markdown",
					reply_markup: {
						inline_keyboard: [
							[
								{
									text: "Fund from My Balance",
									callback_data: `giveaway_fund_${totalAmount}_self`,
								},
							],
							[
								{
									text: "Fund from Treasury",
									callback_data: `giveaway_fund_${totalAmount}_treasury`,
								},
							],
							[{ text: "Cancel", callback_data: "cancel" }],
						],
					},
				},
			);
		} else if (
			isOwnerOrAdmin &&
			canAffordFromTreasury &&
			!canAffordFromBalance
		) {
			// Admin can only use treasury
			await ctx.reply(
				`*Create Giveaway: ${totalAmount} JUNO*\n\n` +
					`Funding from Treasury (${treasuryBalance.toFixed(6)} JUNO)\n\n` +
					`Select number of slots:\n${slotInfo}`,
				{
					parse_mode: "Markdown",
					reply_markup: {
						inline_keyboard: [
							[
								{
									text: "10 slots",
									callback_data: `giveaway_create_${totalAmount}_10_treasury`,
								},
								{
									text: "25 slots",
									callback_data: `giveaway_create_${totalAmount}_25_treasury`,
								},
							],
							[
								{
									text: "50 slots",
									callback_data: `giveaway_create_${totalAmount}_50_treasury`,
								},
								{
									text: "100 slots",
									callback_data: `giveaway_create_${totalAmount}_100_treasury`,
								},
							],
							[{ text: "Cancel", callback_data: "cancel" }],
						],
					},
				},
			);
		} else {
			// Regular user or admin using own balance
			await ctx.reply(
				`*Create Giveaway: ${totalAmount} JUNO*\n\n` +
					`Funding from your balance (${userBalance.toFixed(6)} JUNO)\n\n` +
					`Select number of slots:\n${slotInfo}`,
				{
					parse_mode: "Markdown",
					reply_markup: {
						inline_keyboard: [
							[
								{
									text: "10 slots",
									callback_data: `giveaway_create_${totalAmount}_10_self`,
								},
								{
									text: "25 slots",
									callback_data: `giveaway_create_${totalAmount}_25_self`,
								},
							],
							[
								{
									text: "50 slots",
									callback_data: `giveaway_create_${totalAmount}_50_self`,
								},
								{
									text: "100 slots",
									callback_data: `giveaway_create_${totalAmount}_100_self`,
								},
							],
							[{ text: "Cancel", callback_data: "cancel" }],
						],
					},
				},
			);
		}
	});

	/**
	 * Command: /cancelgiveaway
	 * Cancel an active giveaway (unclaimed funds returned to funder)
	 *
	 * Permission: Owner, or the user who created the giveaway
	 * Syntax: /cancelgiveaway <giveaway_id>
	 */
	bot.command("cancelgiveaway", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text.split(" ").slice(1);
		const isOwner = hasRole(userId, "owner");

		if (!args || args.length < 1) {
			// Show active giveaways (owner sees all, users see their own)
			const activeGiveaways = isOwner
				? query<Giveaway>(
						"SELECT * FROM giveaways WHERE status = 'active' ORDER BY created_at DESC LIMIT 10",
					)
				: query<Giveaway>(
						"SELECT * FROM giveaways WHERE status = 'active' AND created_by = ? ORDER BY created_at DESC LIMIT 10",
						[userId],
					);

			if (activeGiveaways.length === 0) {
				return ctx.reply("No active giveaways.");
			}

			const list = activeGiveaways
				.map(
					(g) =>
						`ID ${g.id}: ${g.total_amount} JUNO (${g.claimed_slots}/${g.total_slots} claimed)`,
				)
				.join("\n");

			return ctx.reply(
				`*Active Giveaways*\n\n${list}\n\nUsage: \`/cancelgiveaway <id>\``,
				{ parse_mode: "Markdown" },
			);
		}

		const giveawayId = parseInt(args[0], 10);
		if (Number.isNaN(giveawayId)) {
			return ctx.reply("Invalid giveaway ID.");
		}

		const giveaway = get<Giveaway>(
			"SELECT * FROM giveaways WHERE id = ? AND status = 'active'",
			[giveawayId],
		);

		if (!giveaway) {
			return ctx.reply("Giveaway not found or already completed/cancelled.");
		}

		// Check permission: must be owner or the creator
		if (!isOwner && giveaway.created_by !== userId) {
			return ctx.reply("You can only cancel your own giveaways.");
		}

		const unclaimed = giveaway.total_slots - giveaway.claimed_slots;
		const unclaimedAmount = unclaimed * giveaway.amount_per_slot;

		// Refund unclaimed amount FROM giveaway's escrow back TO the funder
		if (unclaimedAmount > 0) {
			const escrowId = getGiveawayEscrowId(giveawayId);
			const refundResult = await LedgerService.transferBetweenUsers(
				escrowId,
				giveaway.funded_by,
				unclaimedAmount,
				`Refund from cancelled giveaway #${giveawayId}`,
			);

			if (!refundResult.success) {
				logger.error("Failed to refund giveaway funds", {
					giveawayId,
					escrowId,
					fundedBy: giveaway.funded_by,
					unclaimedAmount,
				});
				return ctx.reply(
					"Error refunding giveaway funds. Please contact admin.",
				);
			}
		}

		// Mark as cancelled
		execute(
			"UPDATE giveaways SET status = 'cancelled', completed_at = ? WHERE id = ?",
			[Math.floor(Date.now() / 1000), giveawayId],
		);

		const refundTarget =
			giveaway.funded_by === SYSTEM_USER_IDS.BOT_TREASURY
				? "Treasury"
				: `User ${giveaway.funded_by}`;

		StructuredLogger.logUserAction("Giveaway cancelled", {
			userId,
			operation: "cancel_giveaway",
			giveawayId,
			unclaimedSlots: unclaimed,
			unclaimedAmount,
			refundedTo: giveaway.funded_by,
		});

		await ctx.reply(
			`Giveaway #${giveawayId} cancelled.\n` +
				`${unclaimed} unclaimed slots (${unclaimedAmount.toFixed(6)} JUNO) refunded to ${refundTarget}.`,
		);
	});

	/**
	 * Command: /treasury
	 * View comprehensive treasury and internal ledger status.
	 *
	 * Permission: Admin or higher
	 * Syntax: /treasury
	 *
	 * Displays:
	 * - On-chain treasury wallet address and balance
	 * - Internal ledger statistics (user balances, fines, bail collected)
	 * - Explanation of dual system (treasury vs ledger)
	 *
	 * @example
	 * User: /treasury
	 * Bot: Treasury & Ledger Status
	 *
	 *      On-Chain Treasury Wallet:
	 *      Address: `juno1...`
	 *      Balance: *1000.000000 JUNO*
	 *      Purpose: Receives bail/fine payments via on-chain transfers
	 *
	 *      Internal Ledger System:
	 *      Total User Balances: `500.000000 JUNO`
	 *      Fines Collected: `50.000000 JUNO`
	 *      Bail Collected: `100.000000 JUNO`
	 */
	bot.command("treasury", ownerOnly, async (ctx) => {
		try {
			// On-chain treasury balance
			const treasuryBalance = await UnifiedWalletService.getBotBalance();
			const treasuryAddress = config.botTreasuryAddress;

			// Internal ledger statistics
			const { query } = await import("../database");
			type CollectedTotal = { total: number | null };

			const finesResult = query<CollectedTotal>(
				"SELECT SUM(amount) as total FROM transactions WHERE transaction_type = ? AND status = ?",
				["fine", "completed"],
			);
			const totalFines = finesResult[0]?.total || 0;

			const bailResult = query<CollectedTotal>(
				"SELECT SUM(amount) as total FROM transactions WHERE transaction_type = ? AND status = ?",
				["bail", "completed"],
			);
			const totalBail = bailResult[0]?.total || 0;

			// Get internal ledger total (all user balances)
			const internalBalances = query<{ total: number | null }>(
				"SELECT SUM(balance) as total FROM user_balances",
			);
			const totalUserBalances = internalBalances[0]?.total || 0;

			await ctx.reply(
				`Treasury & Ledger Status\n\n` +
					`On-Chain Treasury Wallet:\n` +
					`Address: ${treasuryAddress}\n` +
					`Balance: ${treasuryBalance?.toFixed(6) || "0"} JUNO\n` +
					`Purpose: Receives bail/fine payments via on-chain transfers\n\n` +
					`Internal Ledger System:\n` +
					`Total User Balances: ${totalUserBalances.toFixed(6)} JUNO\n` +
					`Fines Collected: ${totalFines.toFixed(6)} JUNO - deducted from users\n` +
					`Bail Collected: ${totalBail.toFixed(6)} JUNO - deducted from users\n\n` +
					`Note: Treasury and ledger are separate systems.\n` +
					`• Treasury: On-chain wallet for direct payments\n` +
					`• Ledger: Internal accounting for user balances\n\n` +
					`Use /giveaway to distribute funds\n` +
					`Use /walletstats for detailed reconciliation`,
			);
		} catch (error) {
			logger.error("Error fetching treasury info", error);
			await ctx.reply(" Error fetching treasury information.");
		}
	});
}
