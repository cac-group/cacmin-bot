/**
 * @module middleware/messageFilter
 * @description Message filtering middleware for enforcing user restrictions and mutes.
 * Monitors incoming messages in group chats and applies restrictions like mutes, sticker blocks,
 * URL blocks, and regex pattern filters. Whitelisted users, owners, and admins are exempt from filtering.
 */

import type { Context, MiddlewareFn } from "telegraf";
import { execute, get } from "../database";
import { ChatIndexerService } from "../services/chatIndexerService";
import { RestrictionService } from "../services/restrictionService";
import { ensureUserExists } from "../services/userService";
import type { User } from "../types";
import { logger } from "../utils/logger";

/** Max message count to track per user per chat (used for spam detection heuristics) */
const MESSAGE_COUNT_CAP = 10;

/**
 * Middleware that filters messages based on user restrictions and mute status.
 * Runs on every message to enforce restrictions like:
 * - Mutes (jails) - deletes all messages from muted users in group chats
 * - Sticker restrictions - blocks specific stickers or sticker packs
 * - URL restrictions - blocks links to specific domains
 * - Regex pattern restrictions - blocks messages matching patterns
 *
 * Important: Only applies in group/supergroup chats. Private DMs are never filtered.
 * Whitelisted users, owners, and admins bypass all filtering.
 *
 * @param ctx - Telegraf context object containing message and user information
 * @param next - Next middleware function to call if message passes all checks
 * @returns Promise that resolves when filtering is complete
 *
 * @example
 * // Apply early in middleware chain to filter messages
 * bot.use(messageFilterMiddleware);
 *
 * @example
 * // Muted user's messages are automatically deleted in groups
 * // /jail @user 60  <- Mutes user for 60 minutes
 * // User's messages deleted until mute expires
 */
export const messageFilterMiddleware: MiddlewareFn<Context> = async (
	ctx,
	next,
) => {
	// Skip if no message or user
	if (!ctx.message || !ctx.from) {
		return next();
	}

	try {
		// Ensure user exists (synchronous operation)
		ensureUserExists(ctx.from.id, ctx.from.username || "unknown");

		// Get user from database
		const user = get<User>("SELECT * FROM users WHERE id = ?", [ctx.from.id]);

		// Skip ALL filtering for whitelisted users, owners, and admins
		if (user?.whitelist || user?.role === "owner" || user?.role === "admin") {
			// Index message for chat explorer (fire-and-forget)
			const isGroup =
				ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
			if (isGroup) {
				ChatIndexerService.indexMessage(ctx).catch(() => {});
			}
			return next();
		}

		// Check if user is muted - ONLY apply in group chats, not DMs
		const isGroupChat =
			ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
		if (
			isGroupChat &&
			user?.muted_until &&
			user.muted_until > Date.now() / 1000
		) {
			try {
				await ctx.deleteMessage();
				logger.info("Deleted message from jailed user", {
					userId: ctx.from.id,
					mutedUntil: user.muted_until,
				});
			} catch (error) {
				logger.error(
					"Failed to delete message - bot may lack admin permissions",
					{
						userId: ctx.from.id,
						chatId: ctx.chat?.id,
						error,
					},
				);
			}
			return; // Don't continue regardless of deletion success
		}

		// Check message against restrictions (only in group chats)
		if (isGroupChat) {
			const violated = await RestrictionService.checkMessage(
				ctx,
				ctx.message,
				user,
			);

			if (violated) {
				// Message was deleted and violation recorded
				return; // Don't continue to next middleware
			}
		}

		// Increment message count for spam detection (capped at MESSAGE_COUNT_CAP)
		if (isGroupChat) {
			execute(
				`INSERT INTO user_message_counts (user_id, chat_id, message_count)
				VALUES (?, ?, 1)
				ON CONFLICT(user_id, chat_id) DO UPDATE
				SET message_count = MIN(message_count + 1, ?)
				WHERE message_count < ?`,
				[ctx.from.id, ctx.chat.id, MESSAGE_COUNT_CAP, MESSAGE_COUNT_CAP],
			);

			// Index message for chat explorer (fire-and-forget)
			ChatIndexerService.indexMessage(ctx).catch(() => {});
		}

		return next();
	} catch (error) {
		logger.error("Error in message filter middleware", error);
		return next(); // Continue on error to avoid blocking
	}
};
