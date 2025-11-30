/**
 * @module utils/adminNotify
 * @description Admin notification system for sending alerts to administrators.
 * Provides centralized notification mechanism for critical events, errors, and system alerts.
 * Requires bot instance initialization and admin chat ID configuration.
 */

import type { Telegraf } from "telegraf";
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
