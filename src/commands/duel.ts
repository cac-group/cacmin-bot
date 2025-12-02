/**
 * Duel game command handlers for the CAC Admin Bot.
 * Provides 2-player wagered duels with optional consequences for losers.
 *
 * @module commands/duel
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import {
	DEFAULT_CONSEQUENCE_DURATIONS,
	type DuelConsequence,
	DuelService,
	MAX_WAGER,
	MIN_WAGER,
} from "../services/duelService";
import { LedgerService } from "../services/ledgerService";
import { ensureUserExists } from "../services/userService";
import { StructuredLogger } from "../utils/logger";
import {
	cleanupMenuByMessage,
	createMenuSession,
	getActiveMenuSession,
	validateMenuInteraction,
} from "../utils/menuSession";
import { AmountPrecision } from "../utils/precision";
import { formatUserIdDisplay, resolveUserId } from "../utils/userResolver";
import { generateRollNumber } from "./gambling";

// Consequence display names
const CONSEQUENCE_NAMES: Record<DuelConsequence, string> = {
	none: "No Penalty",
	jail: "Jail",
	muted: "Muted",
	no_stickers: "No Stickers",
	no_media: "No Media",
	no_gifs: "No GIFs",
	no_forwarding: "No Forwarding",
};

/**
 * Create the consequence selection keyboard
 */
function consequenceKeyboard(wager: number, opponentId: number) {
	return {
		inline_keyboard: [
			[
				{
					text: "No Penalty",
					callback_data: `duel_cons_none_${wager}_${opponentId}`,
				},
				{
					text: "Jail (1hr)",
					callback_data: `duel_cons_jail_${wager}_${opponentId}`,
				},
			],
			[
				{
					text: "Muted (30m)",
					callback_data: `duel_cons_muted_${wager}_${opponentId}`,
				},
				{
					text: "No Stickers (1hr)",
					callback_data: `duel_cons_no_stickers_${wager}_${opponentId}`,
				},
			],
			[
				{
					text: "No Media (1hr)",
					callback_data: `duel_cons_no_media_${wager}_${opponentId}`,
				},
				{
					text: "No GIFs (1hr)",
					callback_data: `duel_cons_no_gifs_${wager}_${opponentId}`,
				},
			],
			[{ text: "Cancel", callback_data: "cancel" }],
		],
	};
}

/**
 * Create the duel challenge keyboard shown to opponent
 */
function duelChallengeKeyboard(duelId: number) {
	return {
		inline_keyboard: [
			[
				{ text: "Accept", callback_data: `duel_accept_${duelId}` },
				{ text: "Reject", callback_data: `duel_reject_${duelId}` },
			],
		],
	};
}

/**
 * Create the duel cancel keyboard for challenger
 */
function duelCancelKeyboard(duelId: number) {
	return {
		inline_keyboard: [
			[{ text: "Cancel Challenge", callback_data: `duel_cancel_${duelId}` }],
		],
	};
}

/**
 * Registers all duel-related commands and callback handlers with the bot.
 *
 * Commands registered:
 * - /duel <@user> <amount> - Challenge another user to a duel
 * - /duelstats - View your duel statistics
 * - /duelcancel - Cancel your pending duel challenge
 *
 * @param bot - Telegraf bot instance
 */
export function registerDuelCommands(bot: Telegraf<Context>): void {
	// Initialize the duel service with bot instance
	DuelService.initialize(bot);

	/**
	 * Command: /duel
	 * Challenge another user to a wagered duel
	 */
	bot.command("duel", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text.split(" ").slice(1);

		// Show help if no arguments
		if (!args || args.length < 2) {
			const balance = await LedgerService.getUserBalance(userId);
			return ctx.reply(
				fmt`${bold("Duel Game")}

Challenge another user to a 1v1 roll-off. Highest roll wins!

${bold("Rules:")}
- Both players wager the same amount
- Each player rolls a 9-digit number
- Highest roll wins the pot
- Ties go to the challenger

${bold("Consequences (optional):")}
The loser can face additional penalties:
- Jail, mute, or restrictions
- Duration varies by penalty type

${bold("Usage:")} ${code("/duel @username <amount>")}
${bold("Example:")} ${code("/duel @alice 5")}

Limits: ${MIN_WAGER} - ${MAX_WAGER} JUNO
Your balance: ${code(AmountPrecision.format(balance))} JUNO`,
			);
		}

		const [targetArg, amountArg] = args;

		// Parse wager amount
		let wagerAmount: number;
		try {
			wagerAmount = AmountPrecision.parseUserInput(amountArg);
		} catch {
			return ctx.reply(
				"Invalid amount. Use a number with up to 6 decimal places.",
			);
		}

		// Validate wager limits
		if (wagerAmount < MIN_WAGER) {
			return ctx.reply(`Minimum wager is ${MIN_WAGER} JUNO.`);
		}
		if (wagerAmount > MAX_WAGER) {
			return ctx.reply(`Maximum wager is ${MAX_WAGER} JUNO.`);
		}

		// Resolve opponent
		const opponentId = resolveUserId(targetArg);
		if (!opponentId) {
			return ctx.reply(
				"User not found. Make sure the user has interacted with the bot before.",
			);
		}

		// Check self-duel
		if (opponentId === userId) {
			return ctx.reply("You cannot duel yourself!");
		}

		// Check if challenger already has an outgoing duel
		if (DuelService.hasOutgoingDuel(userId)) {
			return ctx.reply(
				fmt`You already have a pending duel challenge.

Use ${code("/duelcancel")} to cancel it first, or wait for it to expire.`,
			);
		}

		// Check if opponent already has an incoming duel
		if (DuelService.hasIncomingDuel(opponentId)) {
			return ctx.reply(
				`That user already has a pending duel challenge. Try again later.`,
			);
		}

		// Check challenger balance
		const challengerBalance = await LedgerService.getUserBalance(userId);
		if (!AmountPrecision.isGreaterOrEqual(challengerBalance, wagerAmount)) {
			return ctx.reply(
				fmt`Sorry, you're too poor for that.

Please remain at your location, the authorities are on their way.

Your balance: ${code(AmountPrecision.format(challengerBalance))} JUNO
Wager: ${code(AmountPrecision.format(wagerAmount))} JUNO`,
			);
		}

		// Check opponent balance
		const opponentBalance = await LedgerService.getUserBalance(opponentId);
		if (!AmountPrecision.isGreaterOrEqual(opponentBalance, wagerAmount)) {
			return ctx.reply(
				`That user doesn't have enough balance to accept a ${AmountPrecision.format(wagerAmount)} JUNO wager.`,
			);
		}

		// Check if there's already an active duel menu in this chat
		const chatId = ctx.chat?.id;
		if (chatId) {
			const existingMenu = getActiveMenuSession(chatId, "duel_setup");
			if (existingMenu) {
				return ctx.reply(
					"Another duel is being set up. Please wait for it to complete or expire (30s).",
				);
			}
		}

		// Show consequence selection menu
		const menuMsg = await ctx.reply(
			fmt`${bold("Select Loser Consequence")}

Challenging ${bold(formatUserIdDisplay(opponentId))}
Wager: ${bold(AmountPrecision.format(wagerAmount))} JUNO

What penalty should the loser face?

(This menu expires in 30 seconds)`,
			{
				reply_markup: consequenceKeyboard(wagerAmount, opponentId),
			},
		);

		// Create menu session to track ownership
		if (chatId) {
			createMenuSession(userId, chatId, menuMsg.message_id, "duel_setup");
		}
	});

	/**
	 * Command: /duelstats
	 * View your duel statistics
	 */
	bot.command("duelstats", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const stats = DuelService.getUserDuelStats(userId);
		const balance = await LedgerService.getUserBalance(userId);

		const winRate =
			stats.totalDuels > 0
				? ((stats.wins / stats.totalDuels) * 100).toFixed(1)
				: "0.0";
		const profitStr =
			stats.netProfit >= 0
				? `+${AmountPrecision.format(stats.netProfit)}`
				: AmountPrecision.format(stats.netProfit);

		// Get recent duels
		const recentDuels = DuelService.getRecentDuels(userId, 3);
		let recentText = "";
		if (recentDuels.length > 0) {
			recentText = "\n\nRecent duels:\n";
			for (const duel of recentDuels) {
				const won = duel.winnerId === userId;
				const opponent =
					duel.challengerId === userId ? duel.opponentId : duel.challengerId;
				const result = won ? "W" : "L";
				const amount = won
					? `+${AmountPrecision.format(duel.wagerAmount)}`
					: `-${AmountPrecision.format(duel.wagerAmount)}`;
				recentText += `[${result}] vs ${formatUserIdDisplay(opponent)}: ${amount} JUNO\n`;
			}
		}

		await ctx.reply(
			fmt`${bold("Your Duel Statistics")}

Total duels: ${stats.totalDuels}
Wins: ${stats.wins}
Losses: ${stats.losses}
Win rate: ${winRate}%

Total wagered: ${code(AmountPrecision.format(stats.totalWagered))} JUNO
Total won: ${code(AmountPrecision.format(stats.totalWon))} JUNO
Net profit: ${code(profitStr)} JUNO

Current balance: ${code(AmountPrecision.format(balance))} JUNO${recentText}`,
		);
	});

	/**
	 * Command: /duelcancel
	 * Cancel your pending duel challenge
	 */
	bot.command("duelcancel", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const duel = DuelService.getOutgoingDuel(userId);
		if (!duel) {
			return ctx.reply("You don't have any pending duel challenges.");
		}

		const result = DuelService.cancelDuel(duel.id, userId);
		if (!result.success) {
			return ctx.reply(result.error || "Failed to cancel duel.");
		}

		// Try to update the original message
		if (duel.messageId && duel.chatId) {
			try {
				await ctx.telegram.editMessageText(
					duel.chatId,
					duel.messageId,
					undefined,
					fmt`${bold("Duel Cancelled")}

The duel challenge has been cancelled by the challenger.`,
				);
			} catch {
				// Message may have been deleted or too old
			}
		}

		await ctx.reply("Your duel challenge has been cancelled.");
	});

	// Register callback handlers for duel interactions
	registerDuelCallbacks(bot);
}

/**
 * Register callback query handlers for duel interactions
 */
function registerDuelCallbacks(bot: Telegraf<Context>): void {
	// Handle consequence selection
	bot.action(/^duel_cons_(.+)_(.+)_(.+)$/, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		// Validate menu ownership and expiry
		const validationError = await validateMenuInteraction(ctx, "duel_setup");
		if (validationError) {
			await ctx.answerCbQuery(validationError);
			return;
		}

		const match = ctx.match;
		const consequence = match[1] as DuelConsequence;
		const wagerAmount = parseFloat(match[2]);
		const opponentId = parseInt(match[3], 10);

		if (Number.isNaN(wagerAmount) || Number.isNaN(opponentId)) {
			await ctx.answerCbQuery("Invalid duel data.");
			return;
		}

		const chatId = ctx.chat?.id;
		const messageId = ctx.callbackQuery?.message?.message_id;
		if (!chatId) {
			await ctx.answerCbQuery("Cannot create duel outside of a chat.");
			return;
		}

		// Clean up the menu session since we're proceeding
		if (messageId) {
			cleanupMenuByMessage(chatId, messageId);
		}

		// Ensure both users exist
		const challengerUsername = ctx.from?.username || `user_${userId}`;
		ensureUserExists(userId, challengerUsername);

		// Create the duel
		const result = await DuelService.createDuel(
			userId,
			opponentId,
			wagerAmount,
			chatId,
			consequence,
		);

		if (!result.success || !result.duel) {
			await ctx.editMessageText(result.error || "Failed to create duel.");
			return;
		}

		const duel = result.duel;
		const consequenceName = CONSEQUENCE_NAMES[consequence];
		const duration = DEFAULT_CONSEQUENCE_DURATIONS[consequence];
		const durationText = duration > 0 ? `${duration} minutes` : "";

		// Edit the original message to confirm
		await ctx.editMessageText(
			fmt`${bold("Duel Challenge Sent!")}

Waiting for ${bold(formatUserIdDisplay(opponentId))} to respond...

The challenge will expire in 5 minutes.`,
			{
				reply_markup: duelCancelKeyboard(duel.id),
			},
		);

		// Send the challenge to the opponent
		const challengeMsg = await ctx.reply(
			fmt`${bold("Duel Challenge!")}

${bold(formatUserIdDisplay(userId))} challenges ${bold(formatUserIdDisplay(opponentId))} to a duel!

${bold("Wager:")} ${code(AmountPrecision.format(wagerAmount))} JUNO each
${bold("Loser Penalty:")} ${consequenceName}${durationText ? ` (${durationText})` : ""}

Both players roll a 9-digit number.
${bold("Highest roll wins!")}
(Ties go to challenger)

This challenge expires in 5 minutes.`,
			{
				reply_markup: duelChallengeKeyboard(duel.id),
			},
		);

		// Update the duel with the message ID
		DuelService.updateMessageId(duel.id, challengeMsg.message_id);

		StructuredLogger.logUserAction("Duel challenge sent", {
			userId,
			operation: "duel_challenge",
			duelId: duel.id.toString(),
			opponentId: opponentId.toString(),
			wagerAmount: wagerAmount.toString(),
			consequence,
		});

		await ctx.answerCbQuery("Duel challenge sent!");
	});

	// Handle duel accept
	bot.action(/^duel_accept_(\d+)$/, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const duelId = parseInt(ctx.match[1], 10);

		// Execute the duel
		const result = await DuelService.acceptAndExecuteDuel(
			duelId,
			userId,
			generateRollNumber,
		);

		if (!result.success || !result.duel) {
			await ctx.answerCbQuery(result.error || "Failed to execute duel.");

			// If there was an error, try to update the message
			try {
				await ctx.editMessageText(
					fmt`${bold("Duel Failed")}

${result.error || "An error occurred."}`,
				);
			} catch {
				// Message may have been deleted
			}
			return;
		}

		const duel = result.duel;
		const challengerWon = duel.winnerId === duel.challengerId;

		// Format the result message
		const consequenceName = CONSEQUENCE_NAMES[duel.loserConsequence];
		const duration = duel.consequenceDuration || 0;
		const durationText = duration > 0 ? ` for ${duration} minutes` : "";

		let consequenceText = "";
		if (duel.loserConsequence !== "none") {
			consequenceText = `\n\n${bold("Penalty Applied:")} ${consequenceName}${durationText}`;
		}

		await ctx.editMessageText(
			fmt`${bold("Duel Complete!")}

${bold(formatUserIdDisplay(duel.challengerId))} rolled: ${code(result.challengerRoll || "???")}
${bold(formatUserIdDisplay(duel.opponentId))} rolled: ${code(result.opponentRoll || "???")}

${bold("Winner:")} ${formatUserIdDisplay(duel.winnerId || 0)}
${bold("Prize:")} ${code(AmountPrecision.format(duel.wagerAmount))} JUNO${consequenceText}`,
		);

		// Notify the challenger if they weren't the one who clicked
		if (duel.challengerId !== userId) {
			try {
				await ctx.telegram.sendMessage(
					duel.challengerId,
					fmt`Your duel against ${formatUserIdDisplay(duel.opponentId)} is complete!

You ${challengerWon ? "won" : "lost"} ${AmountPrecision.format(duel.wagerAmount)} JUNO.`,
				);
			} catch {
				// User may have blocked the bot
			}
		}

		await ctx.answerCbQuery(
			duel.winnerId === userId ? "You won!" : "You lost...",
		);
	});

	// Handle duel reject
	bot.action(/^duel_reject_(\d+)$/, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const duelId = parseInt(ctx.match[1], 10);

		const result = DuelService.rejectDuel(duelId, userId);
		if (!result.success) {
			await ctx.answerCbQuery(result.error || "Failed to reject duel.");
			return;
		}

		const duel = DuelService.getDuel(duelId);

		await ctx.editMessageText(
			fmt`${bold("Duel Rejected")}

${bold(formatUserIdDisplay(userId))} declined the duel challenge.

No funds were exchanged.`,
		);

		// Notify the challenger
		if (duel) {
			try {
				await ctx.telegram.sendMessage(
					duel.challengerId,
					fmt`Your duel challenge was rejected by ${formatUserIdDisplay(userId)}.`,
				);
			} catch {
				// User may have blocked the bot
			}
		}

		await ctx.answerCbQuery("Duel rejected.");
	});

	// Handle duel cancel (by challenger)
	bot.action(/^duel_cancel_(\d+)$/, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const duelId = parseInt(ctx.match[1], 10);

		const result = DuelService.cancelDuel(duelId, userId);
		if (!result.success) {
			await ctx.answerCbQuery(result.error || "Failed to cancel duel.");
			return;
		}

		const duel = DuelService.getDuel(duelId);

		await ctx.editMessageText(
			fmt`${bold("Duel Cancelled")}

The duel challenge has been cancelled by the challenger.`,
		);

		// Try to update the challenge message too
		if (duel?.messageId && duel?.chatId) {
			try {
				await ctx.telegram.editMessageText(
					duel.chatId,
					duel.messageId,
					undefined,
					fmt`${bold("Duel Cancelled")}

This challenge was cancelled by ${formatUserIdDisplay(userId)}.`,
				);
			} catch {
				// Message may have been deleted or too old
			}
		}

		await ctx.answerCbQuery("Duel cancelled.");
	});
}
