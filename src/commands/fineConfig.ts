/**
 * Fine configuration command handlers for the CAC Admin Bot.
 * Provides owner-only commands for managing USD-based fine amounts,
 * viewing price information, and custom jail assignments.
 *
 * @module commands/fineConfig
 */

import type { Context, Telegraf } from "telegraf";
import { execute } from "../database";
import { ownerOnly } from "../middleware/index";
import { JailService } from "../services/jailService";
import { PriceService } from "../services/priceService";
import { logger, StructuredLogger } from "../utils/logger";
import { escapeMarkdownV2 } from "../utils/markdown";
import { isImmuneToModeration } from "../utils/roles";
import { formatUserIdDisplay, resolveUserId } from "../utils/userResolver";

/**
 * Registers all fine configuration commands with the bot.
 *
 * Commands registered:
 * - /setfine - Set fine amount in USD for a fine type (owner only)
 * - /listfines - List all fine configurations (owner only)
 * - /junoprice - View current and average JUNO price (owner only)
 * - /customjail - Jail a user with custom fine and reason (owner only)
 *
 * @param bot - Telegraf bot instance
 */
export function registerFineConfigCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /setfine
	 * Set fine amount in USD for a specific fine type.
	 *
	 * Permission: Owner only
	 * Syntax: /setfine <type> <amount_usd> [description]
	 *
	 * Fine types:
	 * - sticker: Restricted sticker violations
	 * - url: URL posting violations
	 * - regex: Regex pattern match violations
	 * - blacklist: Blacklist violations
	 * - jail_per_minute: Per-minute jail rate
	 * - jail_minimum: Minimum jail fine
	 * - auto_jail: Auto-jail fine amount
	 *
	 * @example
	 * User: /setfine sticker 0.05 Reduced sticker fine
	 * Bot: Fine for 'sticker' set to $0.05 USD
	 */
	bot.command("setfine", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		if (!ownerId) return;

		const args = ctx.message?.text.split(" ").slice(1) || [];
		if (args.length < 2) {
			return ctx.reply(
				"*Usage:* `/setfine <type> <amount_usd> [description]`\n\n" +
					"*Fine types:*\n" +
					"• `sticker` \\- Restricted sticker violations\n" +
					"• `url` \\- URL posting violations\n" +
					"• `regex` \\- Regex pattern violations\n" +
					"• `blacklist` \\- Blacklist violations\n" +
					"• `jail_per_minute` \\- Per\\-minute jail rate\n" +
					"• `jail_minimum` \\- Minimum jail fine\n" +
					"• `auto_jail` \\- Auto\\-jail fine amount\n\n" +
					"*Example:* `/setfine sticker 0\\.05 Reduced fine`",
				{ parse_mode: "MarkdownV2" },
			);
		}

		const fineType = args[0].toLowerCase();
		const amountUsd = parseFloat(args[1]);
		const description = args.slice(2).join(" ") || `${fineType} fine`;

		const validTypes = [
			"sticker",
			"url",
			"regex",
			"blacklist",
			"jail_per_minute",
			"jail_minimum",
			"auto_jail",
		];
		if (!validTypes.includes(fineType)) {
			return ctx.reply(
				`❌ Invalid fine type\\. Valid types: ${escapeMarkdownV2(validTypes.join(", "))}`,
				{ parse_mode: "MarkdownV2" },
			);
		}

		if (Number.isNaN(amountUsd) || amountUsd < 0) {
			return ctx.reply(
				"❌ Invalid amount\\. Please enter a positive number\\.",
				{
					parse_mode: "MarkdownV2",
				},
			);
		}

		PriceService.setFineConfigUsd(fineType, amountUsd, description, ownerId);

		// Show equivalent JUNO amount
		const junoAmount = await PriceService.usdToJuno(amountUsd);

		await ctx.reply(
			`✅ Fine for '${escapeMarkdownV2(fineType)}' set to $${escapeMarkdownV2(amountUsd.toFixed(2))} USD\n` +
				`Current equivalent: ${escapeMarkdownV2(junoAmount.toFixed(2))} JUNO`,
			{ parse_mode: "MarkdownV2" },
		);

		logger.info("Fine config updated", { ownerId, fineType, amountUsd });
	});

	/**
	 * Command: /listfines
	 * List all configured fine amounts with USD and JUNO equivalents.
	 *
	 * Permission: Owner only
	 * Syntax: /listfines
	 */
	bot.command("listfines", ownerOnly, async (ctx) => {
		const configs = PriceService.getAllFineConfigs();
		const priceInfo = await PriceService.getPriceInfo();

		let message = "*Fine Configuration*\n\n";
		message += `JUNO Price: $${escapeMarkdownV2(priceInfo.average.toFixed(4))} \\(24h avg\\)\n\n`;

		// Show all fine types with their values
		const allTypes = [
			"sticker",
			"url",
			"regex",
			"blacklist",
			"jail_per_minute",
			"jail_minimum",
			"auto_jail",
		];

		for (const fineType of allTypes) {
			const usdAmount = PriceService.getFineConfigUsd(fineType);
			const junoAmount = await PriceService.usdToJuno(usdAmount);
			const config = configs.find((c) => c.fine_type === fineType);

			message += `*${escapeMarkdownV2(fineType)}*\n`;
			message += `  $${escapeMarkdownV2(usdAmount.toFixed(2))} USD ≈ ${escapeMarkdownV2(junoAmount.toFixed(2))} JUNO\n`;
			if (config?.description) {
				message += `  _${escapeMarkdownV2(config.description)}_\n`;
			}
			message += "\n";
		}

		await ctx.reply(message, { parse_mode: "MarkdownV2" });
	});

	/**
	 * Command: /junoprice
	 * View current and rolling average JUNO price.
	 *
	 * Permission: Owner only
	 * Syntax: /junoprice
	 */
	bot.command("junoprice", ownerOnly, async (ctx) => {
		const priceInfo = await PriceService.getPriceInfo();

		const lastUpdateTime = priceInfo.lastUpdate
			? new Date(priceInfo.lastUpdate).toLocaleString()
			: "Never";

		const message =
			"*JUNO Price Information*\n\n" +
			`Current: $${escapeMarkdownV2(priceInfo.current?.toFixed(4) || "N/A")}\n` +
			`24h Average: $${escapeMarkdownV2(priceInfo.average.toFixed(4))}\n\n` +
			`Last Updated: ${escapeMarkdownV2(lastUpdateTime)}\n\n` +
			"_Prices from CoinGecko API_";

		await ctx.reply(message, { parse_mode: "MarkdownV2" });
	});

	/**
	 * Command: /customjail
	 * Jail a user with a custom fine amount and reason.
	 * This allows owners to assign arbitrary fines for any reason.
	 *
	 * Permission: Owner only
	 * Syntax: /customjail <@username|userId> <minutes> <juno_amount> <reason>
	 *
	 * @example
	 * User: /customjail @alice 120 5.0 Repeated spamming despite warnings
	 * Bot: User @alice has been jailed for 120 minutes.
	 *      Custom fine: 5.00 JUNO
	 *      Reason: Repeated spamming despite warnings
	 */
	bot.command("customjail", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		if (!ownerId) return;

		const args = ctx.message?.text.split(" ").slice(1) || [];
		if (args.length < 4) {
			return ctx.reply(
				"*Usage:* `/customjail <@username|userId> <minutes> <juno_amount> <reason>`\n\n" +
					"*Example:*\n" +
					"`/customjail @alice 120 5\\.0 Repeated spamming`\n\n" +
					"This jails the user for the specified time with a custom fine amount\\.",
				{ parse_mode: "MarkdownV2" },
			);
		}

		const userIdentifier = args[0];
		const minutes = parseInt(args[1], 10);
		const junoAmount = parseFloat(args[2]);
		const reason = args.slice(3).join(" ");

		// Resolve username or userId to numeric ID
		const userId = resolveUserId(userIdentifier);
		if (!userId) {
			return ctx.reply(
				"❌ User not found\\. Please use a valid @username or userId\\.",
				{ parse_mode: "MarkdownV2" },
			);
		}

		// Check if target user is immune to moderation
		if (isImmuneToModeration(userId)) {
			const userDisplay = formatUserIdDisplay(userId);
			return ctx.reply(
				`❌ Cannot jail ${escapeMarkdownV2(userDisplay)} \\- admins and owners are immune to moderation actions\\.`,
				{ parse_mode: "MarkdownV2" },
			);
		}

		if (Number.isNaN(minutes) || minutes < 1) {
			return ctx.reply(
				"❌ Invalid duration\\. Minutes must be a positive number\\.",
				{
					parse_mode: "MarkdownV2",
				},
			);
		}

		if (Number.isNaN(junoAmount) || junoAmount < 0) {
			return ctx.reply(
				"❌ Invalid fine amount\\. Please enter a non\\-negative number\\.",
				{ parse_mode: "MarkdownV2" },
			);
		}

		const mutedUntil = Math.floor(Date.now() / 1000) + minutes * 60;

		// Update database
		execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
			mutedUntil,
			Math.floor(Date.now() / 1000),
			userId,
		]);

		// Log the jail event with custom metadata
		JailService.logJailEvent(
			userId,
			"jailed",
			ownerId,
			minutes,
			junoAmount,
			undefined,
			undefined,
			{ reason, customFine: true },
		);

		// Actually restrict the user in Telegram (if in a group)
		if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
			try {
				await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
					permissions: {
						can_send_messages: false,
						can_send_audios: false,
						can_send_documents: false,
						can_send_photos: false,
						can_send_videos: false,
						can_send_video_notes: false,
						can_send_voice_notes: false,
						can_send_polls: false,
						can_send_other_messages: false,
						can_add_web_page_previews: false,
						can_change_info: false,
						can_invite_users: false,
						can_pin_messages: false,
						can_manage_topics: false,
					},
					until_date: mutedUntil,
				});
			} catch (error) {
				logger.error("Failed to restrict user in Telegram", {
					userId,
					chatId: ctx.chat.id,
					error,
				});
				await ctx.reply(
					`⚠️ Database updated but failed to restrict user in Telegram\\.\n` +
						`Error: ${escapeMarkdownV2(error instanceof Error ? error.message : "Unknown error")}`,
					{ parse_mode: "MarkdownV2" },
				);
			}
		}

		const userDisplay = formatUserIdDisplay(userId);
		await ctx.reply(
			`✅ User ${escapeMarkdownV2(userDisplay)} has been jailed for ${escapeMarkdownV2(minutes.toString())} minutes\\.\n` +
				`Custom fine: ${escapeMarkdownV2(junoAmount.toFixed(2))} JUNO\n` +
				`Reason: ${escapeMarkdownV2(reason)}\n\n` +
				`They can pay bail using /paybail or check their status with /mystatus`,
			{ parse_mode: "MarkdownV2" },
		);

		StructuredLogger.logSecurityEvent("Custom jail applied", {
			userId: ownerId,
			operation: "custom_jail",
			targetUserId: userId,
			duration: minutes,
			amount: junoAmount.toString(),
			reason,
		});

		logger.info("User custom jailed", {
			ownerId,
			userId,
			minutes,
			junoAmount,
			reason,
		});
	});

	/**
	 * Command: /initfines
	 * Initialize default fine configurations in the database.
	 * Only needs to be run once after setup.
	 *
	 * Permission: Owner only
	 * Syntax: /initfines
	 */
	bot.command("initfines", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		if (!ownerId) return;

		const defaults: Array<{ type: string; amount: number; desc: string }> = [
			{ type: "sticker", amount: 0.1, desc: "Restricted sticker violation" },
			{ type: "url", amount: 0.2, desc: "URL posting violation" },
			{ type: "regex", amount: 0.15, desc: "Regex pattern violation" },
			{ type: "blacklist", amount: 0.5, desc: "Blacklist violation" },
			{ type: "jail_per_minute", amount: 0.01, desc: "Per-minute jail rate" },
			{ type: "jail_minimum", amount: 0.1, desc: "Minimum jail fine" },
			{ type: "auto_jail", amount: 1.0, desc: "Auto-jail fine" },
		];

		for (const def of defaults) {
			// Only set if not already configured
			const existing = PriceService.getAllFineConfigs().find(
				(c) => c.fine_type === def.type,
			);
			if (!existing) {
				PriceService.setFineConfigUsd(def.type, def.amount, def.desc, ownerId);
			}
		}

		await ctx.reply(
			"✅ Default fine configurations initialized\\.\n" +
				"Use /listfines to view current settings\\.\n" +
				"Use /setfine to adjust amounts\\.",
			{ parse_mode: "MarkdownV2" },
		);

		logger.info("Fine configs initialized", { ownerId });
	});
}
