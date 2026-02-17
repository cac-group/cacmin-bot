/**
 * Reaction-based spam detection handler for the CAC Admin Bot.
 * Monitors chat reactions and kicks users detected as spam bots via two methods:
 * 1. Bio pattern matching - immediate kick if bio matches known spam patterns
 * 2. Velocity detection - kick if a low-message user reacts to many messages rapidly
 *
 * @module handlers/reactionSpam
 */

import type { Context, Telegraf } from "telegraf";
import type { Chat, User } from "telegraf/types";
import { get } from "../database";
import { logger, StructuredLogger } from "../utils/logger";
import { isAdmin, isOwner } from "../utils/roles";

/** Minimum messages a user must have sent before being exempt from spam checks */
const MIN_MESSAGES_FOR_EXEMPTION = 10;

/** Max reactions allowed within the time window before triggering a velocity kick */
const VELOCITY_REACTION_LIMIT = 3;

/** Time window in milliseconds for velocity tracking (60 seconds) */
const VELOCITY_WINDOW_MS = 60_000;

/** How often to prune stale entries from the velocity tracker (5 minutes) */
const VELOCITY_CLEANUP_INTERVAL_MS = 300_000;

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
 * Fun kick messages for spam bots.
 * One is randomly selected when kicking.
 */
const KICK_MESSAGES = [
	"Be gone thot!",
	"{name} is banished, our members' virginity remains untarnished.",
	"{name} tried to corrupt the chat. The horny police have intervened.",
];

/**
 * In-memory tracker for reaction velocity per user per chat.
 * Key format: `${userId}:${chatId}` -> array of timestamps
 */
const reactionTracker = new Map<string, number[]>();

/**
 * Set of users already kicked this session to avoid duplicate kick attempts.
 * Key format: `${userId}:${chatId}`
 */
const kickedUsers = new Set<string>();

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
 * Gets a random kick message, replacing {name} with the user's name.
 *
 * @param user - The user being kicked
 * @returns Formatted kick message
 */
function getKickMessage(user: User): string {
	const name = user.first_name + (user.last_name ? ` ${user.last_name}` : "");
	const template =
		KICK_MESSAGES[Math.floor(Math.random() * KICK_MESSAGES.length)];
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
		logger.info("[REACTION_BIO_FETCH_FAILED]", {
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Records a reaction event and checks if the user has exceeded the velocity limit.
 *
 * @param userId - The user who reacted
 * @param chatId - The chat where the reaction occurred
 * @returns True if the user exceeded the velocity limit
 */
function checkReactionVelocity(userId: number, chatId: number): boolean {
	const key = `${userId}:${chatId}`;
	const now = Date.now();
	const cutoff = now - VELOCITY_WINDOW_MS;

	// Get existing timestamps and prune old ones
	const timestamps = (reactionTracker.get(key) ?? []).filter((t) => t > cutoff);

	// Add current reaction
	timestamps.push(now);
	reactionTracker.set(key, timestamps);

	return timestamps.length >= VELOCITY_REACTION_LIMIT;
}

/**
 * Kicks a user from a chat (ban + immediate unban so they can rejoin).
 *
 * @param telegram - Telegram API instance
 * @param chatId - Chat to kick from
 * @param userId - User to kick
 */
async function kickUser(
	telegram: Telegraf<Context>["telegram"],
	chatId: number,
	userId: number,
): Promise<void> {
	await telegram.banChatMember(chatId, userId);
	await telegram.unbanChatMember(chatId, userId);
}

/**
 * Removes stale entries from the velocity tracker.
 */
function pruneReactionTracker(): void {
	const now = Date.now();
	const cutoff = now - VELOCITY_WINDOW_MS;

	for (const [key, timestamps] of reactionTracker) {
		const fresh = timestamps.filter((t) => t > cutoff);
		if (fresh.length === 0) {
			reactionTracker.delete(key);
		} else {
			reactionTracker.set(key, fresh);
		}
	}

	// Also clear kicked users set periodically so it doesn't grow forever
	// (safe because Telegram won't deliver reactions from users no longer in chat)
	kickedUsers.clear();
}

/**
 * Registers the reaction spam detection handler with the bot.
 * Monitors all reactions in the chat and detects spam bots via bio matching
 * and reaction velocity tracking.
 *
 * Detection methods:
 * 1. Bio check: If a reacting user's bio matches spam patterns, kick immediately
 * 2. Velocity check: If a user with few messages reacts to 3+ messages within
 *    60 seconds, kick for reaction spam
 *
 * Features:
 * - Logs all reactions for audit trail
 * - Kicks (not bans) so false positives can rejoin
 * - Sends a fun kick message to the chat
 * - Admins, owners, and established members are exempt
 * - Detailed logging for debugging detection failures
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
	// Periodic cleanup of stale velocity tracking data
	setInterval(pruneReactionTracker, VELOCITY_CLEANUP_INTERVAL_MS);

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
			chatId: chat.id,
			chatTitle: "title" in chat ? chat.title : undefined,
			messageId: reaction.message_id,
			reactions: reactionEmojis,
			oldReactions: reaction.old_reaction.length,
			newReactions: reaction.new_reaction.length,
		});

		// Skip checks for owners and admins
		if (isOwner(user.id) || isAdmin(user.id)) {
			logger.debug("Skipping spam check for admin/owner", {
				userId: user.id,
			});
			return;
		}

		// Only check users who are adding reactions (not removing)
		if (reaction.new_reaction.length === 0) {
			return;
		}

		// Skip if already kicked this session
		const userChatKey = `${user.id}:${chat.id}`;
		if (kickedUsers.has(userChatKey)) {
			return;
		}

		// Check message history
		const countRow = get<{ message_count: number }>(
			"SELECT message_count FROM user_message_counts WHERE user_id = ? AND chat_id = ?",
			[user.id, chat.id],
		);
		const messageCount = countRow?.message_count ?? 0;

		if (messageCount >= MIN_MESSAGES_FOR_EXEMPTION) {
			logger.debug("Skipping spam check for established user", {
				userId: user.id,
				messageCount,
			});
			return;
		}

		logger.info("[REACTION_CHECK]", {
			userId: user.id,
			username: user.username,
			messageCount,
		});

		// --- Detection method 1: Bio pattern matching ---
		try {
			const bio = await getUserBio(ctx.telegram, user.id);

			if (bio) {
				logger.info("[REACTION_BIO]", {
					userId: user.id,
					username: user.username,
					bio: bio.substring(0, 200),
				});
			} else {
				logger.info("[REACTION_NO_BIO]", {
					userId: user.id,
					username: user.username,
				});
			}

			if (isSpamBio(bio)) {
				StructuredLogger.logSecurityEvent("Spam bot detected via bio pattern", {
					userId: user.id,
					username: user.username,
					bio: bio?.substring(0, 200),
					chatId: chat.id,
					operation: "reaction_spam_bio",
				});

				try {
					await kickUser(ctx.telegram, chat.id, user.id);
					kickedUsers.add(userChatKey);
					reactionTracker.delete(userChatKey);

					const kickMessage = getKickMessage(user);
					await ctx.telegram.sendMessage(chat.id, kickMessage, {
						reply_parameters: { message_id: reaction.message_id },
					});

					logger.info("[AUTO_KICK]", {
						userId: user.id,
						username: user.username,
						firstName: user.first_name,
						chatId: chat.id,
						reason: "spam_bio",
						bio: bio?.substring(0, 100),
					});
				} catch (kickError) {
					logger.error("Failed to kick spam bot (bio)", {
						userId: user.id,
						chatId: chat.id,
						error: kickError,
					});
				}
				return; // Already handled
			}
		} catch (error) {
			logger.error("Error checking user bio for spam", {
				userId: user.id,
				chatId: chat.id,
				error,
			});
		}

		// --- Detection method 2: Reaction velocity ---
		const exceeded = checkReactionVelocity(user.id, chat.id);

		if (exceeded) {
			StructuredLogger.logSecurityEvent(
				"Spam bot detected via reaction velocity",
				{
					userId: user.id,
					username: user.username,
					chatId: chat.id,
					messageCount,
					operation: "reaction_spam_velocity",
				},
			);

			try {
				await kickUser(ctx.telegram, chat.id, user.id);
				kickedUsers.add(userChatKey);
				reactionTracker.delete(userChatKey);

				const kickMessage = getKickMessage(user);
				await ctx.telegram.sendMessage(chat.id, kickMessage, {
					reply_parameters: { message_id: reaction.message_id },
				});

				logger.info("[AUTO_KICK]", {
					userId: user.id,
					username: user.username,
					firstName: user.first_name,
					chatId: chat.id,
					reason: "reaction_velocity",
					messageCount,
				});
			} catch (kickError) {
				logger.error("Failed to kick spam bot (velocity)", {
					userId: user.id,
					chatId: chat.id,
					error: kickError,
				});
			}
		}
	});

	logger.info("Reaction spam detection handler registered");
}
