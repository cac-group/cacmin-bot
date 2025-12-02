/**
 * Moderation command handlers for the CAC Admin Bot.
 * Provides admin commands for jailing/unjailing users, issuing warnings,
 * clearing violations, and viewing bot statistics.
 *
 * @module commands/moderation
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { execute, get } from "../database";
import { adminOrHigher, ownerOnly } from "../middleware/index";
import { JailService } from "../services/jailService";
import { getCommandArgs, getUserIdentifier } from "../utils/commandHelper";
import { logger, StructuredLogger } from "../utils/logger";
import { isImmuneToModeration } from "../utils/roles";
import {
	formatUserIdDisplay,
	getRemainingArgs,
	resolveTargetUser,
	resolveUserId,
} from "../utils/userResolver";

/**
 * Registers all moderation commands with the bot.
 *
 * Commands registered:
 * - /jail (alias: /silence) - Restrict a user (admin only)
 * - /unjail (alias: /unsilence) - Release a user from jail (admin only)
 * - /warn - Issue a warning to a user (admin only)
 * - /clearviolations - Clear all violations for a user (owner only)
 * - /stats - View comprehensive bot statistics (owner only)
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerModerationCommands } from './commands/moderation';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerModerationCommands(bot);
 * ```
 */
export function registerModerationCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /jail (alias: /silence)
	 * Jail a user by restricting their permissions in the group.
	 *
	 * Permission: Admin or owner
	 * Syntax (reply): /jail <minutes>
	 * Syntax (direct): /jail <@username|userId> <minutes>
	 *
	 * @example
	 * User: /jail @alice 30
	 * Bot: User @alice has been jailed for 30 minutes.
	 *      Bail amount: 3.50 JUNO
	 *      They can pay bail using /paybail or check their status with /mystatus
	 *
	 * @example
	 * User: (reply to message) /jail 60
	 * Bot: User 123456 has been jailed for 60 minutes.
	 *      Bail amount: 7.00 JUNO
	 */
	const jailHandler = async (ctx: Context) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		// Get user identifier (supports reply-to-message or explicit username/userId)
		const userIdentifier = getUserIdentifier(ctx);
		const isReply =
			ctx.message &&
			"reply_to_message" in ctx.message &&
			ctx.message.reply_to_message;

		// Get command arguments (excluding user identifier if not a reply)
		const args = isReply
			? ctx.message && "text" in ctx.message
				? ctx.message.text.split(" ").slice(1)
				: []
			: getCommandArgs(ctx, true);

		if (!userIdentifier) {
			return ctx.reply(
				fmt`⚠️ ${bold("Usage:")}
• Reply to a user: ${code("/jail <minutes>")}
• Direct: ${code("/jail <@username|userId> <minutes>")}
• Alias: ${code("/silence")}`,
			);
		}

		if (args.length < 1) {
			return ctx.reply("⚠️ Please specify duration in minutes.");
		}

		const minutesStr = args[0];
		const minutes = parseInt(minutesStr, 10);

		// Resolve username or userId to numeric ID
		const userId = resolveUserId(userIdentifier);
		if (!userId) {
			return ctx.reply(
				"⚠️ User not found. Please use a valid @username or userId.",
			);
		}

		// Check if target user is immune to moderation
		if (isImmuneToModeration(userId)) {
			const userDisplay = formatUserIdDisplay(userId);
			return ctx.reply(
				fmt`⛔ Cannot jail ${userDisplay} - admins and owners are immune to moderation actions.`,
			);
		}

		if (Number.isNaN(minutes) || minutes < 1) {
			return ctx.reply(
				"⚠️ Invalid duration. Minutes must be a positive number.",
			);
		}

		// Check if bot has admin permissions in this chat
		if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
			try {
				const botInfo = await ctx.telegram.getMe();
				const botMember = await ctx.telegram.getChatMember(
					ctx.chat.id,
					botInfo.id,
				);
				const canDelete =
					botMember.status === "administrator" &&
					"can_delete_messages" in botMember &&
					botMember.can_delete_messages;

				if (!canDelete) {
					await ctx.reply(
						fmt`⚠️ Warning: Bot is not an administrator or lacks "Delete Messages" permission.
User will be marked as jailed, but messages cannot be deleted automatically.
Please make the bot an admin with delete permissions.`,
					);
				}
			} catch (error) {
				logger.error("Failed to check bot permissions", {
					chatId: ctx.chat.id,
					error,
				});
			}
		}

		const mutedUntil = Math.floor(Date.now() / 1000) + minutes * 60;
		const bailAmount = await JailService.calculateBailAmount(minutes);

		// Update database
		execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
			mutedUntil,
			Math.floor(Date.now() / 1000),
			userId,
		]);

		// Log the jail event
		JailService.logJailEvent(userId, "jailed", adminId, minutes, bailAmount);

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
				StructuredLogger.logSecurityEvent("User restricted in Telegram", {
					userId: adminId,
					username: ctx.from?.username,
					operation: "jail",
					targetUserId: userId,
					duration: minutes,
					amount: bailAmount.toString(),
				});
			} catch (error) {
				logger.error("Failed to restrict user in Telegram", {
					userId,
					chatId: ctx.chat.id,
					error,
				});
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				await ctx.reply(
					fmt`⚠️ Database updated but failed to restrict user in Telegram.
Error: ${errorMsg}
The bot may lack admin permissions or the user may have left.`,
				);
			}
		}

		const userDisplay = formatUserIdDisplay(userId);
		await ctx.reply(
			fmt`🔒 User ${userDisplay} has been jailed for ${minutes} minutes.
Bail amount: ${bailAmount.toFixed(2)} JUNO

They can pay bail using /paybail or check their status with /mystatus`,
		);
		logger.info("User jailed", { adminId, userId, minutes, bailAmount });
	};

	bot.command("jail", adminOrHigher, jailHandler);
	bot.command("silence", adminOrHigher, jailHandler); // Alias for jail

	/**
	 * Command: /unjail (alias: /unsilence)
	 * Release a user from jail and restore their permissions.
	 *
	 * Permission: Admin or owner
	 * Syntax: /unjail <@username|userId>
	 *
	 * @example
	 * User: /unjail @alice
	 * Bot: User @alice has been released from jail.
	 *
	 * @example
	 * User: /unjail 123456
	 * Bot: User 123456 has been released from jail.
	 */
	const unjailHandler = async (ctx: Context) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		const args =
			ctx.message && "text" in ctx.message
				? ctx.message.text.split(" ").slice(1)
				: [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /unjail <@username|userId> or reply to a user's message with /unjail",
			);
		}

		const userId = target.userId;

		// Update database
		execute(
			"UPDATE users SET muted_until = NULL, updated_at = ? WHERE id = ?",
			[Math.floor(Date.now() / 1000), userId],
		);

		// Log the unjail event
		JailService.logJailEvent(userId, "unjailed", adminId);

		// Restore user permissions in Telegram (if in a group)
		if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
			try {
				await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
					permissions: {
						can_send_messages: true,
						can_send_audios: true,
						can_send_documents: true,
						can_send_photos: true,
						can_send_videos: true,
						can_send_video_notes: true,
						can_send_voice_notes: true,
						can_send_polls: true,
						can_send_other_messages: true,
						can_add_web_page_previews: true,
						can_change_info: false,
						can_invite_users: true,
						can_pin_messages: false,
						can_manage_topics: false,
					},
				});
				StructuredLogger.logSecurityEvent(
					"User permissions restored in Telegram",
					{
						userId: adminId,
						username: ctx.from?.username,
						operation: "unjail",
						targetUserId: userId,
					},
				);
			} catch (error) {
				logger.error("Failed to restore user permissions in Telegram", {
					userId,
					chatId: ctx.chat.id,
					error,
				});
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				await ctx.reply(
					fmt`⚠️ Database updated but failed to restore user permissions in Telegram.
Error: ${errorMsg}
The bot may lack admin permissions or the user may have left.`,
				);
			}
		}

		const userDisplay = formatUserIdDisplay(userId);
		await ctx.reply(fmt`🔓 User ${userDisplay} has been released from jail.`);
		logger.info("User unjailed", { adminId, userId });
	};

	bot.command("unjail", adminOrHigher, unjailHandler);
	bot.command("unsilence", adminOrHigher, unjailHandler); // Alias for unjail

	/**
	 * Command: /warn
	 * Issue a formal warning to a user.
	 *
	 * Permission: Admin or owner (enforced by adminOrHigher middleware)
	 * Syntax: /warn <userId> <reason>
	 *
	 * @example
	 * User: /warn 123456 Spamming in chat
	 * Bot: User 123456 has been warned.
	 *      Reason: Spamming in chat
	 */
	bot.command("warn", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /warn <@username|userId> <reason> or reply to a user's message with /warn <reason>",
			);
		}

		const remainingArgs = getRemainingArgs(args, target);
		const reason = remainingArgs.join(" ");

		if (!reason) {
			return ctx.reply("Please provide a reason for the warning.");
		}

		const userId = target.userId;

		// Check if target user is immune to moderation
		if (isImmuneToModeration(userId)) {
			return ctx.reply(
				fmt`⛔ Cannot warn user ${userId} - admins and owners are immune to moderation actions.`,
			);
		}

		// Create warning violation
		execute(
			"INSERT INTO violations (user_id, restriction, message, bail_amount) VALUES (?, ?, ?, ?)",
			[userId, "warning", reason, 0],
		);

		execute(
			"UPDATE users SET warning_count = warning_count + 1, updated_at = ? WHERE id = ?",
			[Math.floor(Date.now() / 1000), userId],
		);

		await ctx.reply(
			fmt`⚠️ User ${userId} has been warned.
Reason: ${reason}`,
		);

		// Try to notify the user
		try {
			await bot.telegram.sendMessage(
				userId,
				fmt`⚠️ You have received a warning from an admin.
Reason: ${reason}
Please follow the group rules.`,
			);
		} catch (error) {
			logger.debug("Could not send warning to user", { userId, error });
		}

		logger.info("User warned", { adminId, userId, reason });
	});

	/**
	 * Command: /clearviolations
	 * Clear all violations and reset warning count for a user.
	 *
	 * Permission: Owner only (enforced by ownerOnly middleware)
	 * Syntax: /clearviolations <userId>
	 *
	 * @example
	 * User: /clearviolations 123456
	 * Bot: All violations cleared for user 123456.
	 */
	bot.command("clearviolations", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		if (!ownerId) return;

		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /clearviolations <@username|userId> or reply to a user's message",
			);
		}

		const userId = target.userId;

		execute("DELETE FROM violations WHERE user_id = ?", [userId]);
		execute("UPDATE users SET warning_count = 0, updated_at = ? WHERE id = ?", [
			Math.floor(Date.now() / 1000),
			userId,
		]);

		await ctx.reply(fmt`All violations cleared for @${target.username}.`);
		logger.info("Violations cleared", { ownerId, userId });
	});

	/**
	 * Command: /stats
	 * View comprehensive bot statistics including users, violations, jails, and fines.
	 *
	 * Permission: Owner only (enforced by ownerOnly middleware)
	 * Syntax: /stats
	 *
	 * Displays:
	 * - Total users, blacklisted, whitelisted
	 * - Total violations, unpaid/paid fines
	 * - Active jails, total jail events, bails paid
	 * - Active restrictions
	 *
	 * @example
	 * User: /stats
	 * Bot: Bot Statistics
	 *
	 *      Users
	 *      Total: 150
	 *      Blacklisted: 5
	 *      Whitelisted: 20
	 *
	 *      Violations
	 *      Total: 75
	 *      Unpaid Fines: 125.50 JUNO
	 *      Paid Fines: 300.75 JUNO
	 */
	bot.command("stats", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		if (!ownerId) return;

		const now = Math.floor(Date.now() / 1000);

		const stats = {
			totalUsers:
				get<{ count: number }>("SELECT COUNT(*) as count FROM users")?.count ||
				0,
			blacklisted:
				get<{ count: number }>(
					"SELECT COUNT(*) as count FROM users WHERE blacklist = 1",
				)?.count || 0,
			whitelisted:
				get<{ count: number }>(
					"SELECT COUNT(*) as count FROM users WHERE whitelist = 1",
				)?.count || 0,
			totalViolations:
				get<{ count: number }>("SELECT COUNT(*) as count FROM violations")
					?.count || 0,
			unpaidFines:
				get<{ total: number }>(
					"SELECT SUM(bail_amount) as total FROM violations WHERE paid = 0",
				)?.total || 0,
			paidFines:
				get<{ total: number }>(
					"SELECT SUM(bail_amount) as total FROM violations WHERE paid = 1",
				)?.total || 0,
			activeRestrictions:
				get<{ count: number }>(
					"SELECT COUNT(*) as count FROM user_restrictions WHERE restricted_until IS NULL OR restricted_until > ?",
					[now],
				)?.count || 0,
			activeJails:
				get<{ count: number }>(
					"SELECT COUNT(*) as count FROM users WHERE muted_until IS NOT NULL AND muted_until > ?",
					[now],
				)?.count || 0,
			totalJailEvents:
				get<{ count: number }>("SELECT COUNT(*) as count FROM jail_events")
					?.count || 0,
			totalBailsPaid:
				get<{ count: number }>(
					"SELECT COUNT(*) as count FROM jail_events WHERE event_type = ?",
					["bail_paid"],
				)?.count || 0,
			totalBailAmount:
				get<{ total: number }>(
					"SELECT SUM(bail_amount) as total FROM jail_events WHERE event_type = ?",
					["bail_paid"],
				)?.total || 0,
		};

		await ctx.reply(
			fmt`📊 ${bold("Bot Statistics")}

${bold("Users")}
Total: ${stats.totalUsers}
Blacklisted: ${stats.blacklisted}
Whitelisted: ${stats.whitelisted}

${bold("Violations")}
Total: ${stats.totalViolations}
Unpaid Fines: ${stats.unpaidFines.toFixed(2)} JUNO
Paid Fines: ${stats.paidFines.toFixed(2)} JUNO

${bold("Jails")}
Currently Jailed: ${stats.activeJails}
Total Jail Events: ${stats.totalJailEvents}
Bails Paid: ${stats.totalBailsPaid}
Total Bail Revenue: ${stats.totalBailAmount.toFixed(2)} JUNO

Active Restrictions: ${stats.activeRestrictions}`,
		);
	});
}
