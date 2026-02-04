/**
 * Reaction-based spam detection handler for the CAC Admin Bot.
 * Monitors chat reactions and automatically bans users with suspicious bios
 * (typically adult content spam bots that react to messages to get attention).
 *
 * @module handlers/reactionSpam
 */

import type { Context, Telegraf } from "telegraf";
import type { Chat, User } from "telegraf/types";
import { logger, StructuredLogger } from "../utils/logger";
import { isAdmin, isOwner } from "../utils/roles";

/**
 * Patterns that indicate a spam bot bio.
 * These are common patterns found in adult content spam bots.
 */
const SPAM_BIO_PATTERNS = [
	/18\+/i, // "18+" age indicator
	/secret\s*place/i, // "Secret Place" channel promotion
	/hi,?\s*baby/i, // Spam greeting pattern
	/create\s*(a\s*)?similar\s*video/i, // Video creation spam
	/onlyfans/i, // OnlyFans promotion
	/subscribe.*channel/i, // Channel subscription spam
	/adult\s*content/i, // Explicit adult content
	/private\s*video/i, // Private video spam
	/hot\s*(girl|video|content)/i, // Hot content spam
	/click.*link.*bio/i, // Link in bio spam
	/free\s*nudes/i, // Explicit spam
	/dating\s*site/i, // Dating spam
	/meet\s*single/i, // Dating spam
	/sexy?\s*(girl|video|photo)/i, // Explicit content spam
	/\uD83D\uDD1E/, // 18+ emoji
];

/**
 * Fun ban messages for spam bots.
 * One is randomly selected when banning.
 */
const BAN_MESSAGES = [
	"Be gone thot!",
	"{name} is banished, our members' virginity remains untarnished.",
	"{name} tried to corrupt the chat. The horny police have intervened.",
	"Begone, spam demon! {name} has been yeeted into the void.",
	"{name} was sent to the shadow realm for being too spicy.",
];

/**
 * Checks if a bio matches any spam patterns.
 *
 * @param bio - The user's bio text
 * @returns True if the bio matches spam patterns
 */
function isSpamBio(bio: string | undefined): boolean {
	if (!bio) return false;

	return SPAM_BIO_PATTERNS.some((pattern) => pattern.test(bio));
}

/**
 * Gets a random ban message, replacing {name} with the user's name.
 *
 * @param user - The user being banned
 * @returns Formatted ban message
 */
function getBanMessage(user: User): string {
	const name = user.first_name + (user.last_name ? ` ${user.last_name}` : "");
	const template =
		BAN_MESSAGES[Math.floor(Math.random() * BAN_MESSAGES.length)];
	return template.replace("{name}", name);
}

/**
 * Fetches a user's bio by getting their private chat info.
 *
 * @param telegram - Telegram API instance
 * @param userId - User ID to fetch bio for
 * @returns The user's bio or undefined if unavailable
 */
async function getUserBio(
	telegram: Telegraf<Context>["telegram"],
	userId: number,
): Promise<string | undefined> {
	try {
		const chat = (await telegram.getChat(userId)) as Chat.PrivateGetChat;
		return chat.bio;
	} catch (error) {
		// User may have privacy settings that prevent fetching chat info
		logger.debug("Could not fetch user bio", { userId, error });
		return undefined;
	}
}

/**
 * Registers the reaction spam detection handler with the bot.
 * Monitors all reactions in the chat and checks reacting users' bios for spam patterns.
 *
 * Features:
 * - Logs all reactions to the chat log
 * - Checks user bios for spam patterns when they react
 * - Automatically bans users with spam bios
 * - Sends a fun ban message to the chat
 * - Admins and owners are exempt from checks
 *
 * Requirements:
 * - Bot must be an administrator in the chat
 * - Bot must have "message_reaction" in allowed_updates (set in bot.launch())
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * ```typescript
 * const bot = new Telegraf(token);
 * registerReactionSpamHandler(bot);
 * ```
 */
export function registerReactionSpamHandler(bot: Telegraf<Context>): void {
	bot.on("message_reaction", async (ctx) => {
		const reaction = ctx.messageReaction;
		if (!reaction) return;

		const user = reaction.user;
		const chat = reaction.chat;

		// Only process reactions from identified users in groups
		if (!user || chat.type === "private") return;

		// Log the reaction event
		const reactionEmojis = reaction.new_reaction
			.map((r) => {
				if (r.type === "emoji") return r.emoji;
				if (r.type === "custom_emoji") return `[custom:${r.custom_emoji_id}]`;
				return "[unknown]";
			})
			.join(", ");

		logger.info("[REACTION]", {
			userId: user.id,
			username: user.username,
			firstName: user.first_name,
			lastName: user.last_name,
			chatId: chat.id,
			chatTitle: "title" in chat ? chat.title : undefined,
			messageId: reaction.message_id,
			reactions: reactionEmojis,
			oldReactions: reaction.old_reaction.length,
			newReactions: reaction.new_reaction.length,
		});

		// Skip checks for owners and admins
		if (isOwner(user.id) || isAdmin(user.id)) {
			logger.debug("Skipping spam check for admin/owner", { userId: user.id });
			return;
		}

		// Only check users who are adding reactions (not removing)
		if (reaction.new_reaction.length === 0) {
			return;
		}

		// Fetch and check user's bio
		try {
			const bio = await getUserBio(ctx.telegram, user.id);

			if (bio) {
				logger.info("[USER_BIO]", {
					userId: user.id,
					username: user.username,
					bio: bio.substring(0, 200), // Truncate for logging
				});
			}

			if (isSpamBio(bio)) {
				StructuredLogger.logSecurityEvent("Spam bot detected via reaction", {
					userId: user.id,
					username: user.username,
					bio: bio?.substring(0, 200),
					chatId: chat.id,
					operation: "reaction_spam_detection",
				});

				// Ban the user
				try {
					await ctx.telegram.banChatMember(chat.id, user.id);

					const banMessage = getBanMessage(user);
					await ctx.telegram.sendMessage(chat.id, banMessage);

					StructuredLogger.logSecurityEvent("Spam bot banned", {
						userId: user.id,
						username: user.username,
						chatId: chat.id,
						operation: "auto_ban",
						reason: "spam_bio_detected",
					});

					logger.info("[AUTO_BAN]", {
						userId: user.id,
						username: user.username,
						firstName: user.first_name,
						chatId: chat.id,
						reason: "spam_bio_detected",
						bio: bio?.substring(0, 100),
					});
				} catch (banError) {
					logger.error("Failed to ban spam bot", {
						userId: user.id,
						chatId: chat.id,
						error: banError,
					});
				}
			}
		} catch (error) {
			logger.error("Error checking user for spam", {
				userId: user.id,
				chatId: chat.id,
				error,
			});
		}
	});

	logger.info("Reaction spam detection handler registered");
}
