/**
 * @module utils/adminNotify
 * @description Notification system for admins and users.
 * Provides centralized mechanism for critical events, errors, and user error messages.
 * User errors are sent via DM with fallback to brief group reply.
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { logger } from "./logger";
import { escapeMarkdownV2 } from "./markdown";

let botInstance: Telegraf | null = null;

/**
 * Sets the bot instance for sending admin notifications.
 * Must be called during bot initialization before notifyAdmin can be used.
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * const bot = new Telegraf(BOT_TOKEN);
 * setBotInstance(bot);  // Now notifyAdmin() can send messages
 */
export function setBotInstance(bot: Telegraf): void {
	botInstance = bot;
}

/**
 * Sends a notification message to the configured admin chat.
 * Messages are formatted with a warning emoji and Markdown formatting.
 * Gracefully handles missing bot instance or admin chat ID configuration.
 *
 * @param message - The notification message to send to admins
 * @returns Promise that resolves when notification is sent or fails gracefully
 *
 * @example
 * await notifyAdmin('Critical: Withdrawal system offline');
 *
 * @example
 * await notifyAdmin(
 *   'User @suspicious (123456) attempted to bypass transaction lock'
 * );
 *
 * @example
 * // Notification appears in admin chat as:
 * // " Admin Alert
 * //
 * //  Critical: Withdrawal system offline"
 */
export async function notifyAdmin(message: string): Promise<void> {
	if (!botInstance) {
		logger.warn("Bot instance not set, cannot send admin notification");
		return;
	}

	if (!config.adminChatId) {
		logger.warn("Admin chat ID not configured, cannot send notification");
		return;
	}

	try {
		await botInstance.telegram.sendMessage(
			config.adminChatId,
			`⚠️ *Admin Alert*\n\n${escapeMarkdownV2(message)}`,
			{ parse_mode: "MarkdownV2" },
		);
	} catch (error) {
		logger.error("Failed to send admin notification", { error, message });
	}
}

/**
 * Sends an error message to a user via DM, with fallback to a brief group reply.
 * Detailed errors go to DM, group gets a hyperlink to the bot DM.
 *
 * @param ctx - Telegraf context
 * @param detailedMessage - Full error message for DM
 * @param briefMessage - Optional short message for group fallback
 * @returns Promise that resolves when message is sent
 *
 * @example
 * await sendUserError(ctx, 'Insufficient balance. You have 5 JUNO but tried to send 10.');
 * // DM: Full error message
 * // Group: Hyperlink to DM
 */
export async function sendUserError(
	ctx: Context,
	detailedMessage: string,
	briefMessage = "An error occurred.",
): Promise<void> {
	const userId = ctx.from?.id;
	if (!userId) {
		await ctx.reply(briefMessage);
		return;
	}

	// Hyperlink message for group - links directly to bot DM
	const dmLink =
		'<a href="https://t.me/banbabybot">Check DM for full error details</a>';

	try {
		// Try to DM the detailed error
		await ctx.telegram.sendMessage(
			userId,
			`${detailedMessage}\n\nIf this persists, forward this message to @BasementNodes`,
		);
		// Only reply in group if this is a group chat
		if (ctx.chat && ctx.chat.type !== "private") {
			await ctx.reply(dmLink, {
				parse_mode: "HTML",
				// biome-ignore lint/style/useNamingConvention: Telegram API
				link_preview_options: { is_disabled: true },
			});
		}
	} catch {
		// DM failed (user hasn't started bot or blocked it), reply in group
		await ctx.reply(briefMessage);
		logger.debug("Could not DM user, replied in group", { userId });
	}
}

/**
 * Sends a transaction/wallet error to user via DM with standard formatting.
 *
 * @param ctx - Telegraf context
 * @param operation - What the user was trying to do (e.g., "withdrawal", "transfer")
 * @param error - The error message or Error object
 * @returns Promise that resolves when message is sent
 */
export async function sendWalletError(
	ctx: Context,
	operation: string,
	error: string | Error,
): Promise<void> {
	const errorMsg = error instanceof Error ? error.message : error;
	const detailed = `${operation} failed: ${errorMsg}`;
	await sendUserError(ctx, detailed, `${operation} failed. Check your DMs.`);
}
