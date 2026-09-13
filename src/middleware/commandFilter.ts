/**
 * @module middleware/commandFilter
 * @description Middleware for filtering bot commands in group chats to prevent command conflicts.
 * Ensures that commands in group environments are explicitly directed at this bot using @mention syntax.
 */

import type { Context, MiddlewareFn } from "telegraf";
import { logger } from "../utils/logger";

const BOT_USERNAME = "banBabyBot";

/**
 * Middleware that filters commands to only respond when explicitly mentioned in group chats.
 * In private chats, all commands are processed. In group/supergroup chats, only commands
 * with @banBabyBot suffix are processed. This prevents conflicts with other bots that may
 * use the same command names (e.g., Rose bot).
 *
 * @param ctx - Telegraf context object containing message and chat information
 * @param next - Next middleware function to call if command should be processed
 * @returns Promise that resolves when middleware completes
 *
 * @example
 * // In group chat - will be processed
 * /mute@banBabyBot @user 60
 *
 * @example
 * // In group chat - will be ignored
 * /mute @user 60
 *
 * @example
 * // In private chat - will be processed
 * /help
 */
export const commandFilterMiddleware: MiddlewareFn<Context> = async (
	ctx,
	next,
) => {
	// Check if this is a command message
	const messageText =
		ctx.message && "text" in ctx.message ? ctx.message.text : null;

	if (!messageText?.startsWith("/")) {
		return next();
	}

	// Extract command (e.g., "/mute" or "/mute@banBabyBot")
	const commandMatch = messageText.match(/^\/([a-zA-Z0-9_]+)(@[a-zA-Z0-9_]+)?/);

	if (!commandMatch) {
		return next();
	}

	const [, commandName, botMention] = commandMatch;

	// Check if we're in a group/supergroup chat
	const chatType = ctx.chat?.type;
	const isGroupChat = chatType === "group" || chatType === "supergroup";

	// In group chats, only respond to commands with @banBabyBot suffix
	if (isGroupChat) {
		const isMentioned = botMention === `@${BOT_USERNAME}`;

		if (!isMentioned) {
			// Command is not for this bot, ignore it
			logger.debug("Ignoring command without bot mention in group", {
				command: commandName,
				chatId: ctx.chat?.id,
				chatType,
			});
			return; // Don't call next(), stop processing
		}
	}

	// In private chats or if properly mentioned in groups, continue
	return next();
};
