/**
 * Reaction-based spam detection handler for the CAC Admin Bot.
 * Monitors chat reactions and jails users detected as spam bots via two methods:
 * 1. Bio pattern matching - immediate jail if bio matches known spam patterns
 * 2. Velocity detection - jail if a new user reacts to many messages rapidly
 *
 * Enforcement is always a temporary jail (mute); the bot never bans or kicks.
 *
 * Only new users (fewer than NEW_USER_MESSAGE_LIMIT lifetime group messages)
 * are checked; established and elevated users are exempt.
 *
 * @module handlers/reactionSpam
 */

import type { Context, Telegraf } from "telegraf";
import type { Chat, User } from "telegraf/types";
import { config } from "../config";
import { get } from "../database";
import { JailService } from "../services/jailService";
import { ensureUserExists } from "../services/userService";
import { dedupeResponse } from "../utils/autoDelete";
import { logger, StructuredLogger } from "../utils/logger";
import { checkIsElevated } from "../utils/roles";
import { getDbSpamReacts } from "./spamReacts";

/** Lifetime group messages after which a user is exempt from spam checks */
const NEW_USER_MESSAGE_LIMIT = 5;

/**
 * Fallback exemption: account age (seconds) after which a member is treated as
 * established even with few indexed messages. Covers long-time lurkers who
 * have no group-message history to count.
 */
const NEW_USER_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

/** Max reactions allowed within the time window before triggering a velocity jail */
const VELOCITY_REACTION_LIMIT = 3;

/** Time window in milliseconds for velocity tracking (60 seconds) */
const VELOCITY_WINDOW_MS = 60_000;

/** How often to prune stale entries from the velocity tracker (5 minutes) */
const VELOCITY_CLEANUP_INTERVAL_MS = 300_000;

/** How often to prune the established-user exemption cache (20 minutes) */
const ESTABLISHED_CACHE_CLEANUP_INTERVAL_MS = 1_200_000;

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
	/bonus\s*\d+\s*\$/i, // "BONUS 1000$" scam channel spam
	/elon\s*musk/i, // Elon Musk crypto scam channels
];

/**
 * Fun jail messages for reaction spammers.
 * One is randomly selected when jailing.
 */
const JAIL_MESSAGES = [
	"{name} has been jailed for spamming reactions.",
	"{name} tried to corrupt the chat. The horny police have intervened.",
	"{name} is cooling off in horny jail for reaction spam.",
];

/** Permissions removed from a jailed reaction spammer (all sending disabled). */
const JAIL_PERMISSIONS = {
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
};

/**
 * In-memory tracker for reaction velocity per user per chat.
 * Key format: `${userId}:${chatId}` -> array of timestamps
 */
const reactionTracker = new Map<string, number[]>();

/**
 * Set of users already actioned this session to avoid duplicate jails.
 * Key format: `${userId}:${chatId}`
 */
const handledUsers = new Set<string>();

/**
 * In-memory cache of users exempt from spam checks (message count reached the
 * new-user limit). Key: userId -> last time the exemption was confirmed (ms
 * epoch). Message counts only grow, so entries are pruned on a 20-minute
 * interval to keep the set bounded; re-checking a pruned user is one cheap
 * indexed lookup.
 */
const establishedUsers = new Map<number, number>();

/** Profile info returned from Telegram's getChat for spam evaluation */
interface UserProfile {
	bio?: string;
	personalChatTitle?: string;
}

/**
 * Checks if any profile text matches spam patterns (built-in or DB-managed).
 *
 * @param profile - The user's profile info (bio and/or personal chat title)
 * @returns Object with matched field and pattern info, or null if no match
 */
function detectSpamProfile(
	profile: UserProfile,
): { field: string; patternSource: string } | null {
	const fields: [string, string | undefined][] = [
		["bio", profile.bio],
		["personal_chat", profile.personalChatTitle],
	];

	// Check built-in patterns (always match both fields)
	for (const [field, value] of fields) {
		if (value && SPAM_BIO_PATTERNS.some((pattern) => pattern.test(value))) {
			return { field, patternSource: "builtin" };
		}
	}

	// Check DB-managed patterns with field targeting
	const dbPatterns = getDbSpamReacts();
	for (const dbPattern of dbPatterns) {
		const fieldsToCheck: [string, string | undefined][] = [];
		if (dbPattern.matchField === "bio" || dbPattern.matchField === "both") {
			fieldsToCheck.push(["bio", profile.bio]);
		}
		if (dbPattern.matchField === "channel" || dbPattern.matchField === "both") {
			fieldsToCheck.push(["personal_chat", profile.personalChatTitle]);
		}

		for (const [field, value] of fieldsToCheck) {
			if (value) {
				try {
					dbPattern.compiled.regex.lastIndex = 0;
					if (dbPattern.compiled.regex.test(value)) {
						return {
							field,
							patternSource: `db#${dbPattern.id}:${dbPattern.raw}`,
						};
					}
				} catch {
					// Skip broken patterns
				}
			}
		}
	}

	return null;
}

/**
 * Gets a random jail message, replacing {name} with the user's name.
 * If the user has a username, the name is rendered as an HTML link to their profile.
 *
 * @param user - The user being jailed
 * @returns Formatted jail message with HTML link
 */
function getJailMessage(user: User): string {
	const displayName =
		user.first_name + (user.last_name ? ` ${user.last_name}` : "");
	const nameHtml = user.username
		? `<a href="https://t.me/${user.username}">${escapeHtml(displayName)}</a>`
		: escapeHtml(displayName);
	const template =
		JAIL_MESSAGES[Math.floor(Math.random() * JAIL_MESSAGES.length)];
	return template.replace("{name}", nameHtml);
}

/**
 * Escapes HTML special characters in a string.
 *
 * @param text - The text to escape
 * @returns HTML-safe text
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Sends a jail announcement message, replacing a recent response for the user.
 *
 * @param telegram - Telegram API instance
 * @param chatId - Chat to send the message in
 * @param message - HTML-formatted message text
 * @param replyToMessageId - Message ID to reply to
 */
async function sendJailAnnouncement(
	telegram: Telegraf<Context>["telegram"],
	chatId: number,
	userId: number,
	message: string,
	replyToMessageId: number,
): Promise<void> {
	// Send new announcement
	const sent = await telegram.sendMessage(chatId, message, {
		parse_mode: "HTML",
		reply_parameters: { message_id: replyToMessageId },
		link_preview_options: { is_disabled: true },
	});

	await dedupeResponse(
		telegram,
		chatId,
		userId,
		"spam-jail-announcement",
		sent.message_id,
	);
}

/**
 * Fetches a user's profile info (bio and personal chat title) via getChat.
 * The personal_chat field is a newer Telegram API addition not yet in @telegraf/types.
 *
 * @param telegram - Telegram API instance
 * @param userId - User ID to fetch profile for
 * @returns Profile info with bio and personal chat title
 */
async function getUserProfile(
	telegram: Telegraf<Context>["telegram"],
	userId: number,
): Promise<UserProfile> {
	try {
		const chat = (await telegram.getChat(userId)) as Chat.PrivateGetChat & {
			personal_chat?: { title?: string };
		};
		return {
			bio: chat.bio,
			personalChatTitle: chat.personal_chat?.title,
		};
	} catch (error) {
		logger.info("[REACTION_PROFILE_FETCH_FAILED]", {
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
		return {};
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
 * Jails a reaction spammer for a bounded period (mute, never ban or kick).
 *
 * @param telegram - Telegram API instance
 * @param chatId - Chat to jail in
 * @param user - User to jail
 */
async function jailSpammer(
	telegram: Telegraf<Context>["telegram"],
	chatId: number,
	user: User,
): Promise<void> {
	const minutes = config.reactionSpamJailMinutes;
	ensureUserExists(user.id, user.username || `user_${user.id}`);
	const { mutedUntil } = JailService.jailUser({
		userId: user.id,
		durationMinutes: minutes,
		metadata: { reason: "reaction_spam" },
	});
	await telegram.restrictChatMember(chatId, user.id, {
		permissions: JAIL_PERMISSIONS,
		until_date: mutedUntil,
	});
}

/**
 * Returns true if the user is still considered "new" and subject to spam
 * checks. A user is exempt (not new) when either:
 * - they have sent at least NEW_USER_MESSAGE_LIMIT lifetime group messages, or
 * - their tracked account is at least NEW_USER_MAX_AGE_SECONDS old.
 *
 * The age fallback only applies when `created_at` is known, so a user the bot
 * has never recorded is still treated as new. Exemptions are cached in-memory
 * so the DB is only hit once per user per cache window.
 *
 * @param userId - The user ID to check
 * @returns True if the user is still new
 */
function isNewUser(userId: number): boolean {
	if (establishedUsers.has(userId)) return false;

	const row = get<{ message_count: number; created_at: number }>(
		"SELECT message_count, created_at FROM users WHERE id = ?",
		[userId],
	);
	const membership = get<{ joined_at: number }>(
		"SELECT joined_at FROM user_memberships WHERE user_id = ?",
		[userId],
	);
	const messageCount = row?.message_count ?? 0;
	// Prefer the recorded group-join time; fall back to first-seen for members
	// who predate join tracking.
	const ageBase = membership?.joined_at ?? row?.created_at ?? 0;
	const ageSeconds = ageBase > 0 ? Date.now() / 1000 - ageBase : 0;

	if (
		messageCount >= NEW_USER_MESSAGE_LIMIT ||
		ageSeconds >= NEW_USER_MAX_AGE_SECONDS
	) {
		establishedUsers.set(userId, Date.now());
		return false;
	}
	return true;
}

/**
 * Removes stale entries from the new-user exemption cache.
 * Re-checking a pruned user is one indexed lookup, so pruning keeps the set
 * bounded without leaving established users re-evaluated too aggressively.
 */
function pruneEstablishedCache(): void {
	const cutoff = Date.now() - ESTABLISHED_CACHE_CLEANUP_INTERVAL_MS;
	for (const [userId, lastChecked] of establishedUsers) {
		if (lastChecked < cutoff) establishedUsers.delete(userId);
	}
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

	// Also clear handled users set periodically so it doesn't grow forever
	// (safe because Telegram won't deliver reactions from users no longer in chat)
	handledUsers.clear();
}

/**
 * Registers the reaction spam detection handler with the bot.
 * Monitors all reactions in the chat and detects spam bots via bio matching
 * and reaction velocity tracking.
 *
 * Detection methods:
 * 1. Bio check: If a new user's bio matches spam patterns, jail immediately
 * 2. Velocity check: If a new user reacts to 3+ messages within 60 seconds,
 *    jail for reaction spam
 *
 * Features:
 * - Logs all reactions for audit trail
 * - Jails (never bans or kicks); the mute expires and cleanup restores access
 * - Sends a fun jail message to the chat
 * - Elevated users and established members (5+ messages) are exempt
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

	// Periodic cleanup of the established-user exemption cache
	setInterval(pruneEstablishedCache, ESTABLISHED_CACHE_CLEANUP_INTERVAL_MS);

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

		// Skip checks for elevated users (owner, admin, elevated)
		if (checkIsElevated(user.id)) {
			logger.debug("Skipping spam check for elevated user", {
				userId: user.id,
			});
			return;
		}

		// Only check users who are adding reactions (not removing)
		if (reaction.new_reaction.length === 0) {
			return;
		}

		// Skip if already actioned this session
		const userChatKey = `${user.id}:${chat.id}`;
		if (handledUsers.has(userChatKey)) {
			return;
		}

		// Skip checks for established users (message count reached the limit)
		if (!isNewUser(user.id)) {
			logger.debug("Skipping spam check for established user", {
				userId: user.id,
			});
			return;
		}

		logger.info("[REACTION_CHECK]", {
			userId: user.id,
			username: user.username,
		});

		// --- Detection method 1: Profile pattern matching (bio + personal chat) ---
		try {
			const profile = await getUserProfile(ctx.telegram, user.id);

			logger.info("[REACTION_PROFILE]", {
				userId: user.id,
				username: user.username,
				bio: profile.bio?.substring(0, 200) ?? null,
				personalChat: profile.personalChatTitle ?? null,
			});

			const spamMatch = detectSpamProfile(profile);
			if (spamMatch) {
				const matchedValue =
					spamMatch.field === "bio" ? profile.bio : profile.personalChatTitle;

				StructuredLogger.logSecurityEvent("Spam bot detected via profile", {
					userId: user.id,
					username: user.username,
					matchedField: spamMatch.field,
					matchedValue: matchedValue?.substring(0, 200),
					patternSource: spamMatch.patternSource,
					chatId: chat.id,
					operation: "reaction_spam_profile",
				});

				try {
					await jailSpammer(ctx.telegram, chat.id, user);
					handledUsers.add(userChatKey);
					reactionTracker.delete(userChatKey);

					const jailMessage = getJailMessage(user);
					await sendJailAnnouncement(
						ctx.telegram,
						chat.id,
						user.id,
						jailMessage,
						reaction.message_id,
					);

					logger.info("[AUTO_JAIL]", {
						userId: user.id,
						username: user.username,
						firstName: user.first_name,
						chatId: chat.id,
						reason: `spam_${spamMatch.field}`,
						patternSource: spamMatch.patternSource,
						matchedValue: matchedValue?.substring(0, 100),
					});
				} catch (jailError) {
					logger.error("Failed to jail spammer (profile)", {
						userId: user.id,
						chatId: chat.id,
						error: jailError,
					});
				}
				return; // Already handled
			}
		} catch (error) {
			logger.error("Error checking user profile for spam", {
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
					operation: "reaction_spam_velocity",
				},
			);

			try {
				await jailSpammer(ctx.telegram, chat.id, user);
				handledUsers.add(userChatKey);
				reactionTracker.delete(userChatKey);

				const jailMessage = getJailMessage(user);
				await sendJailAnnouncement(
					ctx.telegram,
					chat.id,
					user.id,
					jailMessage,
					reaction.message_id,
				);

				logger.info("[AUTO_JAIL]", {
					userId: user.id,
					username: user.username,
					firstName: user.first_name,
					chatId: chat.id,
					reason: "reaction_velocity",
				});
			} catch (jailError) {
				logger.error("Failed to jail spammer (velocity)", {
					userId: user.id,
					chatId: chat.id,
					error: jailError,
				});
			}
		}
	});

	logger.info("Reaction spam detection handler registered");
}
