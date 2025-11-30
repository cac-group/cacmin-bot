import type { Context } from "telegraf";
import type { Message } from "telegraf/typings/core/types/typegram";
import { execute, query } from "../database";
import type { GlobalAction, User, UserRestriction } from "../types";
import { logger } from "../utils/logger";
import { createPatternObject, testPatternSafely } from "../utils/safeRegex";
import { JailService } from "./jailService";
import { createViolation } from "./violationService";

/**
 * Restriction check handler type
 */
type RestrictionCheckFn = (
	message: any,
	restrictedAction?: string,
) => boolean | Promise<boolean>;

/**
 * Map of restriction types to their check functions.
 * Each function returns true if the message violates the restriction.
 */
const restrictionChecks: Record<string, RestrictionCheckFn> = {
	no_stickers: (msg, action) => {
		if (!msg.sticker) return false;
		if (!action) return true; // Block all stickers
		return msg.sticker.set_name === action;
	},
	no_urls: (msg, action) => {
		if (!msg.text && !msg.caption) return false;
		const text = msg.text || msg.caption || "";
		const urlRegex =
			/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/gi;
		const urls = text.match(urlRegex);
		if (!urls) return false;
		if (!action) return true; // Block all URLs
		return urls.some((url: string) => url.includes(action));
	},
	no_media: (msg) => !!(msg.photo || msg.video || msg.document || msg.audio),
	no_photos: (msg) => !!msg.photo,
	no_videos: (msg) => !!msg.video,
	no_documents: (msg) => !!msg.document,
	no_gifs: (msg) => !!msg.animation,
	no_voice: (msg) => !!(msg.voice || msg.video_note),
	no_forwarding: (msg) => !!(msg.forward_from || msg.forward_from_chat),
	muted: () => true, // All messages blocked if muted
};

export class RestrictionService {
	/**
	 * Check if a message violates any restrictions
	 */
	static async checkMessage(
		ctx: Context,
		message: Message,
		user?: User,
	): Promise<boolean> {
		if (!ctx.from) return false;

		const userId = ctx.from.id;
		const now = Math.floor(Date.now() / 1000);

		// Get user restrictions - ALWAYS apply these
		const userRestrictions = query<UserRestriction>(
			"SELECT * FROM user_restrictions WHERE user_id = ? AND (restricted_until IS NULL OR restricted_until > ?)",
			[userId, now],
		);

		// Get global restrictions - only apply if user is NOT elevated
		let globalRestrictions: GlobalAction[] = [];
		const isElevated = user?.role === "elevated";

		if (!isElevated) {
			globalRestrictions = query<GlobalAction>(
				"SELECT * FROM global_restrictions WHERE restricted_until IS NULL OR restricted_until > ?",
				[now],
			);
		}

		// Check each restriction type
		for (const restriction of [...userRestrictions, ...globalRestrictions]) {
			const violated = await RestrictionService.checkRestriction(
				ctx,
				message,
				restriction,
			);
			if (violated) {
				await RestrictionService.handleViolation(ctx, restriction);
				return true;
			}
		}

		return false;
	}

	/**
	 * Check specific restriction using handler map
	 */
	private static async checkRestriction(
		_ctx: Context,
		message: any,
		restriction: UserRestriction | GlobalAction,
	): Promise<boolean> {
		// Handle regex_block separately (async with timeout protection)
		if (restriction.restriction === "regex_block") {
			return RestrictionService.checkRegex(
				message,
				restriction.restrictedAction,
			);
		}

		// Use handler map for all other restriction types
		const checker = restrictionChecks[restriction.restriction];
		if (checker) {
			return checker(message, restriction.restrictedAction);
		}

		return false;
	}

	/**
	 * Check if message text matches a regex pattern restriction.
	 * Uses safe regex with timeout protection to prevent ReDoS attacks.
	 */
	private static async checkRegex(
		message: any,
		pattern?: string,
	): Promise<boolean> {
		if (!pattern || (!message.text && !message.caption)) return false;

		const text = message.text || message.caption || "";
		const compiledPattern = createPatternObject(pattern);
		if (!compiledPattern) {
			logger.error("Failed to compile regex pattern", { pattern });
			return false;
		}

		try {
			return await testPatternSafely(compiledPattern.regex, text, 100);
		} catch (error) {
			logger.error("Regex matching error", { pattern, error });
			return false;
		}
	}

	/**
	 * Handle restriction violation with severity-based penalties
	 */
	private static async handleViolation(
		ctx: Context,
		restriction: UserRestriction | GlobalAction,
	): Promise<void> {
		if (!ctx.from) return;

		try {
			const userId = ctx.from.id;
			const userRestriction = restriction as UserRestriction;

			// Delete the message
			await ctx.deleteMessage();

			// Create violation record
			const msg = ctx.message as any;
			await createViolation(
				userId,
				restriction.restriction,
				msg?.text || "[non-text message]",
			);

			// Check for spam (recent violations)
			const recentViolations = await RestrictionService.getRecentViolations(
				userId,
				restriction.restriction,
				60, // Last 60 minutes
			);

			logger.info("Restriction violation handled", {
				userId,
				restriction: restriction.restriction,
				recentViolations: recentViolations.length,
				severity: userRestriction.severity || "delete",
			});

			// Check if auto-jail threshold reached
			const threshold = userRestriction.violationThreshold || 5;
			if (recentViolations.length >= threshold) {
				await RestrictionService.applyAutoJail(ctx, userRestriction);
				return;
			}

			// Apply severity-based penalty
			const severity = userRestriction.severity || "delete";

			switch (severity) {
				case "jail":
					// Immediate jail on any violation
					await RestrictionService.applyImmediateJail(ctx, userRestriction);
					break;

				case "mute":
					// Temporary mute (30 minutes)
					await RestrictionService.applyTemporaryMute(ctx, userId);
					break;
				default:
					// Just delete + warn (already done above)
					await ctx.reply(
						`Your message was deleted for violating restriction: ${restriction.restriction}\n\n` +
							`Violations in last hour: ${recentViolations.length}/${threshold}\n` +
							`${recentViolations.length >= threshold - 1 ? "WARNING: One more violation will result in automatic 2-day jail with a 10 JUNO fine!\n" : ""}` +
							`\nUse /violations to check your status.\n` +
							`If you get jailed, use /paybail to pay your fine and get unjailed immediately.`,
					);
					break;
			}
		} catch (error) {
			logger.error("Failed to handle violation", error);
		}
	}

	/**
	 * Get recent violations for a user and restriction type
	 */
	private static async getRecentViolations(
		userId: number,
		restriction: string,
		minutesAgo: number,
	): Promise<any[]> {
		const sinceTimestamp = Math.floor(Date.now() / 1000) - minutesAgo * 60;

		return query(
			`SELECT * FROM violations
       WHERE user_id = ?
       AND restriction = ?
       AND timestamp > ?
       ORDER BY timestamp DESC`,
			[userId, restriction, sinceTimestamp],
		);
	}

	/**
	 * Apply automatic jail for spam violations
	 */
	private static async applyAutoJail(
		ctx: Context,
		restriction: UserRestriction,
	): Promise<void> {
		if (!ctx.from) return;

		const userId = ctx.from.id;
		const duration = restriction.autoJailDuration || 2880; // Default 2 days
		const fine = restriction.autoJailFine || 10.0; // Default 10 JUNO

		try {
			const mutedUntil = Math.floor(Date.now() / 1000) + duration * 60;

			// Update database
			execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
				mutedUntil,
				Math.floor(Date.now() / 1000),
				userId,
			]);

			// Log the jail event
			JailService.logJailEvent(
				userId,
				"jailed",
				undefined,
				duration,
				fine,
				undefined,
				undefined,
				{
					reason: "auto_spam_detection",
					restriction: restriction.restriction,
				},
			);

			// Actually restrict the user in Telegram (if in a group)
			if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
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
			}

			// Notify user with payment guidance
			await ctx.reply(
				`*AUTOMATIC JAIL - Spam Detection*\n\n` +
					`You have been automatically jailed for ${duration} minutes (${Math.round(duration / 1440)} days) due to repeated violations of: ${restriction.restriction}\n\n` +
					`**Fine Amount:** ${fine} JUNO\n\n` +
					`**To get unjailed immediately:**\n` +
					`1. Check your balance: \`/balance\`\n` +
					`2. Deposit JUNO if needed: \`/deposit\`\n` +
					`3. Pay your bail: \`/paybail\`\n\n` +
					`Otherwise, you will be automatically released after ${Math.round(duration / 1440)} days.\n\n` +
					`View your violations: \`/violations\``,
				{ parse_mode: "Markdown" },
			);

			logger.warn("Auto-jail applied for spam", {
				userId,
				restriction: restriction.restriction,
				duration,
				fine,
			});
		} catch (error) {
			logger.error("Failed to apply auto-jail", { userId, error });
		}
	}

	/**
	 * Apply immediate jail for high-severity restrictions
	 */
	private static async applyImmediateJail(
		ctx: Context,
		restriction: UserRestriction,
	): Promise<void> {
		if (!ctx.from) return;

		const userId = ctx.from.id;
		const duration = 60; // 1 hour for immediate jail
		const fine = 5.0; // 5 JUNO fine

		try {
			const mutedUntil = Math.floor(Date.now() / 1000) + duration * 60;

			// Update database
			execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
				mutedUntil,
				Math.floor(Date.now() / 1000),
				userId,
			]);

			// Log the jail event
			JailService.logJailEvent(
				userId,
				"jailed",
				undefined,
				duration,
				fine,
				undefined,
				undefined,
				{
					reason: "restriction_violation",
					restriction: restriction.restriction,
				},
			);

			// Actually restrict the user in Telegram (if in a group)
			if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
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
			}

			await ctx.reply(
				`*JAILED - Restriction Violation*\n\n` +
					`You have been jailed for ${duration} minutes for violating: ${restriction.restriction}\n\n` +
					`**Fine: ${fine} JUNO**\n\n` +
					`**To get unjailed immediately:**\n` +
					`1. Check your balance: \`/balance\`\n` +
					`2. Deposit JUNO if needed: \`/deposit\`\n` +
					`3. Pay your bail: \`/paybail\`\n\n` +
					`View your violations: \`/violations\``,
				{ parse_mode: "Markdown" },
			);

			logger.info("Immediate jail applied", {
				userId,
				restriction: restriction.restriction,
			});
		} catch (error) {
			logger.error("Failed to apply immediate jail", { userId, error });
		}
	}

	/**
	 * Apply temporary mute for medium-severity restrictions
	 * Uses Telegram's restrictChatMember API to actually mute the user
	 */
	private static async applyTemporaryMute(
		ctx: Context,
		userId: number,
	): Promise<void> {
		const duration = 30; // 30 minutes

		try {
			const mutedUntil = Math.floor(Date.now() / 1000) + duration * 60;

			// Actually mute the user in Telegram (remove send message permissions)
			if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
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
			}

			// Update user's muted_until timestamp in database
			execute("UPDATE users SET muted_until = ? WHERE id = ?", [
				mutedUntil,
				userId,
			]);

			await ctx.reply(
				`*MUTED - Restriction Violation*\n\n` +
					`You have been temporarily muted for ${duration} minutes.\n\n` +
					`You will not be able to send messages until the mute expires.\n\n` +
					`**Warning:** Continued violations will result in automatic jail with a fine that can only be removed by paying in JUNO.\n\n` +
					`View your violations: \`/violations\``,
				{ parse_mode: "Markdown" },
			);

			logger.info("Temporary mute applied", { userId, duration });
		} catch (error) {
			logger.error("Failed to apply temporary mute", { userId, error });
		}
	}

	/**
	 * Clean expired restrictions
	 */
	static cleanExpiredRestrictions(): void {
		const now = Math.floor(Date.now() / 1000);

		const userResult = execute(
			"DELETE FROM user_restrictions WHERE restricted_until IS NOT NULL AND restricted_until < ?",
			[now],
		);

		const globalResult = execute(
			"DELETE FROM global_restrictions WHERE restricted_until IS NOT NULL AND restricted_until < ?",
			[now],
		);

		logger.info("Cleaned expired restrictions", {
			userRestrictions: userResult.changes,
			globalRestrictions: globalResult.changes,
		});
	}
}
