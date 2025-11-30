/**
 * Jail command handlers for the CAC Admin Bot.
 * Provides commands for viewing jail statistics, checking user status,
 * listing active jails, and paying bail for users.
 *
 * @module commands/jail
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, get } from "../database";
import { elevatedOrHigher } from "../middleware/index";
import { JailService } from "../services/jailService";
import { JunoService } from "../services/junoService";
import {
	getTotalFines,
	getUnpaidViolations,
} from "../services/violationService";
import type { User } from "../types";
import { logger, StructuredLogger } from "../utils/logger";
import { escapeMarkdownV2, escapeNumber } from "../utils/markdown";
import { formatUserIdDisplay, resolveUserId } from "../utils/userResolver";

/**
 * Formats a duration in seconds into a human-readable time string.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted time string (e.g., "2h 30m 15s", "45m 30s", "30s")
 *
 * @example
 * ```typescript
 * formatTimeRemaining(9015); // Returns "2h 30m 15s"
 * formatTimeRemaining(2730); // Returns "45m 30s"
 * formatTimeRemaining(30);   // Returns "30s"
 * ```
 */
function formatTimeRemaining(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m ${secs}s`;
	} else if (minutes > 0) {
		return `${minutes}m ${secs}s`;
	} else {
		return `${secs}s`;
	}
}

/**
 * Registers all jail-related commands with the bot.
 *
 * Commands registered:
 * - /jailstats - View global jail statistics (elevated users only)
 * - /mystatus - Check your own jail status and fines
 * - /jails - List all active jails
 * - /paybail - Pay your own bail
 * - /paybailfor - Pay bail for another user
 * - /verifybail - Verify your bail payment
 * - /verifybailfor - Verify bail payment for another user
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerJailCommands } from './commands/jail';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerJailCommands(bot);
 * ```
 */
export function registerJailCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /jailstats
	 * View comprehensive jail system statistics or specific user jail info.
	 *
	 * Permission: Elevated users or higher (enforced by elevatedOrHigher middleware)
	 * Syntax: /jailstats [username|userId]
	 *
	 * Displays:
	 * - Without argument: Currently active jails with time remaining and bail amounts
	 * - With argument: Specific user's current jail status and history
	 *
	 * @example
	 * User: /jailstats
	 * Bot: Jail System Statistics
	 *
	 *      Currently Active Jails: 2
	 *
	 *      Active Prisoners:
	 *      1. User 123456 - 45m 30s (5.00 JUNO)
	 *      2. @alice - 1h 15m 0s (10.50 JUNO)
	 *
	 * @example
	 * User: /jailstats @alice
	 * Bot: Jail Status for @alice
	 *
	 *      Currently Jailed: Yes
	 *      Time Remaining: 1h 15m 0s
	 *      Bail Amount: 10.50 JUNO
	 *      ...
	 */
	bot.command("jailstats", elevatedOrHigher, async (ctx) => {
		const requesterId = ctx.from?.id;
		if (!requesterId) return;

		const { get: getRecord } = await import("../database");
		const now = Math.floor(Date.now() / 1000);

		// Check if a specific user was requested
		const args = ctx.message?.text.split(" ").slice(1);
		const userIdentifier = args?.[0];

		if (userIdentifier) {
			// Show stats for specific user
			const targetUserId = resolveUserId(userIdentifier);
			if (!targetUserId) {
				return ctx.reply(
					"User not found\\. Please use a valid @username or userId\\.",
					{ parse_mode: "MarkdownV2" },
				);
			}

			const user = get<User>("SELECT * FROM users WHERE id = ?", [
				targetUserId,
			]);
			if (!user) {
				return ctx.reply("User not found in database\\.", {
					parse_mode: "MarkdownV2",
				});
			}

			const userDisplay = formatUserIdDisplay(targetUserId);
			let message = `*Jail Status for ${escapeMarkdownV2(userDisplay)}*\n\n`;

			// Current jail status
			if (user.muted_until && user.muted_until > now) {
				const timeRemaining = user.muted_until - now;
				const bailAmount = await JailService.calculateBailAmount(
					Math.ceil(timeRemaining / 60),
				);

				message += `*Currently Jailed:* Yes\n`;
				message += `Time Remaining: ${escapeMarkdownV2(formatTimeRemaining(timeRemaining))}\n`;
				message += `Bail Amount: ${escapeNumber(bailAmount, 2)} JUNO\n`;
				message += `Jailed Until: ${escapeMarkdownV2(new Date(user.muted_until * 1000).toLocaleString())}\n\n`;
			} else {
				message += `*Currently Jailed:* No\n\n`;
			}

			// Jail history for this user
			const jailEvents = JailService.getUserJailEvents(targetUserId, 5);
			if (jailEvents.length > 0) {
				message += `*Recent Jail History:*\n`;
				for (const event of jailEvents) {
					const eventDate = escapeMarkdownV2(
						new Date((event.timestamp || 0) * 1000).toLocaleString(),
					);
					const eventType = escapeMarkdownV2(event.eventType.replace("_", " "));

					message += `\\- ${eventType}`;
					if (event.durationMinutes) {
						message += ` \\(${event.durationMinutes}min\\)`;
					}
					if (event.bailAmount && event.bailAmount > 0) {
						message += ` \\- ${escapeNumber(event.bailAmount, 2)} JUNO`;
					}
					message += `\n  ${eventDate}\n`;
				}
				message += `\n`;
			}

			// User's jail statistics
			const totalJails =
				getRecord<{ count: number }>(
					"SELECT COUNT(*) as count FROM jail_events WHERE user_id = ? AND event_type = ?",
					[targetUserId, "jailed"],
				)?.count || 0;

			const totalBailsPaid =
				getRecord<{ count: number }>(
					"SELECT COUNT(*) as count FROM jail_events WHERE user_id = ? AND event_type = ?",
					[targetUserId, "bail_paid"],
				)?.count || 0;

			const totalBailSpent =
				getRecord<{ total: number }>(
					"SELECT SUM(bail_amount) as total FROM jail_events WHERE user_id = ? AND event_type = ?",
					[targetUserId, "bail_paid"],
				)?.total || 0;

			message += `*User Statistics:*\n`;
			message += `Times Jailed: ${totalJails}\n`;
			message += `Bails Paid: ${totalBailsPaid}\n`;
			message += `Total Bail Spent: ${escapeNumber(totalBailSpent, 2)} JUNO\n`;

			await ctx.reply(message, { parse_mode: "MarkdownV2" });
			return;
		}

		// Show global statistics (original behavior)
		const activeJails = JailService.getActiveJails();
		const totalJailEvents =
			getRecord<{ count: number }>("SELECT COUNT(*) as count FROM jail_events")
				?.count || 0;

		const totalJailed =
			getRecord<{ count: number }>(
				"SELECT COUNT(DISTINCT user_id) as count FROM jail_events WHERE event_type = ?",
				["jailed"],
			)?.count || 0;

		const totalBailsPaid =
			getRecord<{ count: number }>(
				"SELECT COUNT(*) as count FROM jail_events WHERE event_type = ?",
				["bail_paid"],
			)?.count || 0;

		const totalBailAmount =
			getRecord<{ total: number }>(
				"SELECT SUM(bail_amount) as total FROM jail_events WHERE event_type = ?",
				["bail_paid"],
			)?.total || 0;

		const totalAutoReleases =
			getRecord<{ count: number }>(
				"SELECT COUNT(*) as count FROM jail_events WHERE event_type = ?",
				["auto_unjailed"],
			)?.count || 0;

		const totalManualReleases =
			getRecord<{ count: number }>(
				"SELECT COUNT(*) as count FROM jail_events WHERE event_type = ?",
				["unjailed"],
			)?.count || 0;

		let message = `*Jail System Statistics*\n\n`;
		message += `*Currently Active Jails:* ${activeJails.length}\n\n`;

		if (activeJails.length > 0) {
			message += `*Active Prisoners:*\n`;
			for (let index = 0; index < activeJails.length; index++) {
				const jail = activeJails[index];
				const timeRemaining = formatTimeRemaining(jail.timeRemaining);
				const userDisplay = formatUserIdDisplay(jail.id);
				const bailAmount = await JailService.calculateBailAmount(
					Math.ceil(jail.timeRemaining / 60),
				);
				message += `${escapeMarkdownV2(index + 1)}\\. ${escapeMarkdownV2(userDisplay)} \\- ${escapeMarkdownV2(timeRemaining)} \\(${escapeNumber(bailAmount, 2)} JUNO\\)\n`;
			}
			message += `\n`;
		}

		message += `*All\\-Time Statistics:*\n`;
		message += `Total Jail Events: ${totalJailEvents}\n`;
		message += `Unique Users Jailed: ${totalJailed}\n`;
		message += `Bails Paid: ${totalBailsPaid}\n`;
		message += `Total Bail Revenue: ${escapeNumber(totalBailAmount, 2)} JUNO\n`;
		message += `Auto\\-Releases: ${totalAutoReleases}\n`;
		message += `Manual Releases: ${totalManualReleases}\n\n`;
		message += `_Use /jailstats \\<username\\> to view a specific user's jail history_`;

		await ctx.reply(message, { parse_mode: "MarkdownV2" });
	});

	/**
	 * Command: /mystatus
	 * Check your own status including jail time, role, warnings, and unpaid fines.
	 *
	 * Permission: Any user
	 * Syntax: /mystatus
	 *
	 * @example
	 * User: /mystatus
	 * Bot: Your Status
	 *
	 *      User: @alice
	 *      Role: pleb
	 *      Warnings: 1
	 *
	 *      Currently Jailed
	 *      Time remaining: 30m 15s
	 *      Bail amount: 3.50 JUNO
	 *      To pay bail: /paybail
	 *
	 *      Unpaid Fines
	 *      Count: 2
	 *      Total: 5.00 JUNO
	 */
	bot.command("mystatus", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
		if (!user) {
			return ctx.reply(" User not found in database.");
		}

		const now = Math.floor(Date.now() / 1000);
		let message = `*Your Status*\n\n`;
		message += `User: ${formatUserIdDisplay(userId)}\n`;
		message += `Role: ${user.role}\n`;
		message += `Warnings: ${user.warning_count}\n\n`;

		// Check if jailed
		if (user.muted_until && user.muted_until > now) {
			const timeRemaining = user.muted_until - now;
			const bailAmount = await JailService.calculateBailAmount(
				Math.ceil(timeRemaining / 60),
			);

			message += `*Currently Jailed*\n`;
			message += `Time remaining: ${formatTimeRemaining(timeRemaining)}\n`;
			message += `Bail amount: ${bailAmount.toFixed(2)} JUNO\n\n`;
			message += `To pay bail: /paybail\n\n`;
		} else {
			message += ` Not currently jailed\n\n`;
		}

		// Show unpaid violations
		const violations = getUnpaidViolations(userId);
		if (violations.length > 0) {
			const totalFines = getTotalFines(userId);
			message += `*Unpaid Fines*\n`;
			message += `Count: ${violations.length}\n`;
			message += `Total: ${totalFines.toFixed(2)} JUNO\n\n`;
			message += `View details: /violations\n`;
			message += `Pay fines: /payfine\n`;
		} else {
			message += ` No unpaid fines\n`;
		}

		await ctx.reply(message, { parse_mode: "Markdown" });
	});

	/**
	 * Command: /jails
	 * List all currently active jails with time remaining and bail amounts.
	 *
	 * Permission: Any user
	 * Syntax: /jails
	 *
	 * @example
	 * User: /jails
	 * Bot: Active Jails (2)
	 *
	 *      1. User 123456
	 *         Time: 30m 15s
	 *         Bail: 3.50 JUNO
	 *         Pay: /paybailfor 123456
	 *
	 *      Anyone can pay bail for any user using /paybailfor <userId>
	 */
	bot.command("jails", async (ctx) => {
		const activeJails = JailService.getActiveJails();

		if (activeJails.length === 0) {
			return ctx.reply(" No users currently jailed.");
		}

		let message = `*Active Jails* (${escapeMarkdownV2(activeJails.length)})\n\n`;

		for (let index = 0; index < activeJails.length; index++) {
			const jail = activeJails[index];
			const bailAmount = await JailService.calculateBailAmount(
				Math.ceil(jail.timeRemaining / 60),
			);
			const timeRemaining = formatTimeRemaining(jail.timeRemaining);
			const userDisplay = formatUserIdDisplay(jail.id);

			message += `${escapeMarkdownV2(index + 1)}\\. ${escapeMarkdownV2(userDisplay)}\n`;
			message += `   Time: ${escapeMarkdownV2(timeRemaining)}\n`;
			message += `   Bail: ${escapeNumber(bailAmount, 2)} JUNO\n`;
			message += `   Pay: /paybailfor ${escapeMarkdownV2(jail.id)}\n\n`;
		}

		message += `Anyone can pay bail for any user using /paybailfor <userId>`;

		await ctx.reply(message, { parse_mode: "MarkdownV2" });
	});

	/**
	 * Command: /paybail
	 * Get payment instructions to pay your own bail.
	 *
	 * Permission: Any user
	 * Syntax: /paybail
	 *
	 * @example
	 * User: /paybail
	 * Bot: Pay Your Bail
	 *
	 *      Current jail time remaining: 45m 30s
	 *      Bail amount: 5.00 JUNO
	 *
	 *      Send exactly 5.00 JUNO to:
	 *      `juno1...`
	 *
	 *      After payment, send:
	 *      /verifybail <transaction_hash>
	 */
	bot.command("paybail", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
		if (!user) {
			return ctx.reply(" User not found in database.");
		}

		const now = Math.floor(Date.now() / 1000);

		if (!user.muted_until || user.muted_until <= now) {
			return ctx.reply(" You are not currently jailed. No bail required!");
		}

		const timeRemaining = user.muted_until - now;
		const bailAmount = await JailService.calculateBailAmount(
			Math.ceil(timeRemaining / 60),
		);

		const message =
			`*Pay Your Bail*\n\n` +
			`Current jail time remaining: ${escapeMarkdownV2(formatTimeRemaining(timeRemaining))}\n` +
			`Bail amount: ${escapeNumber(bailAmount, 2)} JUNO\n\n` +
			`Send exactly ${escapeNumber(bailAmount, 2)} JUNO to:\n` +
			`\`${escapeMarkdownV2(JunoService.getPaymentAddress())}\`\n\n` +
			`After payment, send:\n` +
			`/verifybail \\<transaction\\_hash\\>\n\n` +
			`Payment will release you from jail immediately\\!`;

		await ctx.reply(message, { parse_mode: "MarkdownV2" });
	});

	/**
	 * Command: /paybailfor
	 * Get payment instructions to pay bail for another user.
	 *
	 * Permission: Any user
	 * Syntax: /paybailfor <@username|userId>
	 *
	 * @example
	 * User: /paybailfor @alice
	 * Bot: Pay Bail For @alice
	 *
	 *      Current jail time remaining: 1h 15m 0s
	 *      Bail amount: 10.50 JUNO
	 *
	 *      Send exactly 10.50 JUNO to:
	 *      `juno1...`
	 *
	 *      After payment, send:
	 *      /verifybailfor 123456 <transaction_hash>
	 */
	bot.command("paybailfor", async (ctx) => {
		const payerId = ctx.from?.id;
		if (!payerId) return;

		const userIdentifier = ctx.message?.text.split(" ")[1];
		if (!userIdentifier) {
			return ctx.reply("Usage: /paybailfor <@username|userId>");
		}

		const targetUserId = resolveUserId(userIdentifier);
		if (!targetUserId) {
			return ctx.reply(
				" User not found. Please use a valid @username or userId.",
			);
		}

		const user = get<User>("SELECT * FROM users WHERE id = ?", [targetUserId]);
		if (!user) {
			return ctx.reply(" User not found in database.");
		}

		const now = Math.floor(Date.now() / 1000);

		if (!user.muted_until || user.muted_until <= now) {
			return ctx.reply(
				` ${formatUserIdDisplay(targetUserId)} is not currently jailed.`,
			);
		}

		const timeRemaining = user.muted_until - now;
		const bailAmount = await JailService.calculateBailAmount(
			Math.ceil(timeRemaining / 60),
		);

		const message =
			`*Pay Bail For ${escapeMarkdownV2(formatUserIdDisplay(targetUserId))}*\n\n` +
			`Current jail time remaining: ${escapeMarkdownV2(formatTimeRemaining(timeRemaining))}\n` +
			`Bail amount: ${escapeNumber(bailAmount, 2)} JUNO\n\n` +
			`Send exactly ${escapeNumber(bailAmount, 2)} JUNO to:\n` +
			`\`${escapeMarkdownV2(JunoService.getPaymentAddress())}\`\n\n` +
			`After payment, send:\n` +
			`/verifybailfor ${escapeMarkdownV2(targetUserId)} \\<transaction\\_hash\\>\n\n` +
			`Payment will release them from jail immediately\\!`;

		await ctx.reply(message, { parse_mode: "MarkdownV2" });
	});

	/**
	 * Command: /verifybail
	 * Verify your bail payment and get released from jail.
	 *
	 * Permission: Any user
	 * Syntax: /verifybail <txHash>
	 *
	 * @example
	 * User: /verifybail ABC123DEF456...
	 * Bot: Bail Payment Verified!
	 *
	 *      You have been released from jail.
	 *      Transaction: `ABC123DEF456...`
	 */
	bot.command("verifybail", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const txHash = ctx.message?.text.split(" ")[1];
		if (!txHash) {
			return ctx.reply("Usage: /verifybail <txHash>");
		}

		const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
		if (!user) {
			return ctx.reply(" User not found in database.");
		}

		const now = Math.floor(Date.now() / 1000);

		if (!user.muted_until || user.muted_until <= now) {
			return ctx.reply(
				" You are not currently jailed. No bail payment needed.",
			);
		}

		const timeRemaining = user.muted_until - now;
		const bailAmount = await JailService.calculateBailAmount(
			Math.ceil(timeRemaining / 60),
		);

		// Verify payment on blockchain
		const verified = await JunoService.verifyPayment(txHash, bailAmount);

		if (!verified) {
			return ctx.reply(
				" Payment could not be verified. Please check the transaction hash and amount.",
			);
		}

		// Release from jail
		execute(
			"UPDATE users SET muted_until = NULL, updated_at = ? WHERE id = ?",
			[now, userId],
		);

		// Log the bail payment event
		JailService.logJailEvent(
			userId,
			"bail_paid",
			undefined,
			undefined,
			bailAmount,
			userId,
			txHash,
		);

		// Restore permissions in group chat
		if (config.groupChatId) {
			try {
				await bot.telegram.restrictChatMember(config.groupChatId, userId, {
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
				StructuredLogger.logTransaction("User released via bail payment", {
					userId,
					txHash,
					amount: bailAmount.toString(),
					operation: "bail_payment",
				});
			} catch (error) {
				logger.error("Failed to restore permissions after bail payment", {
					userId,
					error,
				});
			}
		}

		await ctx.reply(
			`*Bail Payment Verified\\!*\n\n` +
				`You have been released from jail\\.\n` +
				`Transaction: \`${escapeMarkdownV2(txHash)}\``,
			{ parse_mode: "MarkdownV2" },
		);

		StructuredLogger.logTransaction("Bail paid and verified", {
			userId,
			txHash,
			amount: bailAmount.toString(),
			operation: "bail_verification",
		});
	});

	/**
	 * Command: /verifybailfor
	 * Verify bail payment made for another user.
	 *
	 * Permission: Any user
	 * Syntax: /verifybailfor <userId> <txHash>
	 *
	 * @example
	 * User: /verifybailfor 123456 ABC123DEF456...
	 * Bot: Bail Payment Verified!
	 *
	 *      User 123456 has been released from jail.
	 *      Paid by: @bob
	 *      Transaction: `ABC123DEF456...`
	 */
	bot.command("verifybailfor", async (ctx) => {
		const payerId = ctx.from?.id;
		if (!payerId) return;

		const args = ctx.message?.text.split(" ").slice(1);
		if (!args || args.length < 2) {
			return ctx.reply("Usage: /verifybailfor <userId> <txHash>");
		}

		const [userIdentifier, txHash] = args;
		const targetUserId = resolveUserId(userIdentifier);

		if (!targetUserId) {
			return ctx.reply(
				" User not found. Please use a valid @username or userId.",
			);
		}

		const user = get<User>("SELECT * FROM users WHERE id = ?", [targetUserId]);
		if (!user) {
			return ctx.reply(" User not found in database.");
		}

		const now = Math.floor(Date.now() / 1000);

		if (!user.muted_until || user.muted_until <= now) {
			return ctx.reply(
				` ${formatUserIdDisplay(targetUserId)} is not currently jailed.`,
			);
		}

		const timeRemaining = user.muted_until - now;
		const bailAmount = await JailService.calculateBailAmount(
			Math.ceil(timeRemaining / 60),
		);

		// Verify payment on blockchain
		const verified = await JunoService.verifyPayment(txHash, bailAmount);

		if (!verified) {
			return ctx.reply(
				" Payment could not be verified. Please check the transaction hash and amount.",
			);
		}

		// Release from jail
		execute(
			"UPDATE users SET muted_until = NULL, updated_at = ? WHERE id = ?",
			[now, targetUserId],
		);

		// Log the bail payment event (paid by someone else)
		JailService.logJailEvent(
			targetUserId,
			"bail_paid",
			undefined,
			undefined,
			bailAmount,
			payerId,
			txHash,
		);

		// Restore permissions in group chat
		if (config.groupChatId) {
			try {
				await bot.telegram.restrictChatMember(
					config.groupChatId,
					targetUserId,
					{
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
					},
				);
				StructuredLogger.logTransaction(
					"User released via bail payment by another user",
					{
						userId: targetUserId,
						txHash,
						amount: bailAmount.toString(),
						operation: "bail_payment_for_other",
						payerId: payerId,
					},
				);
			} catch (error) {
				logger.error("Failed to restore permissions after bail payment", {
					targetUserId,
					error,
				});
			}
		}

		// Notify the released user
		try {
			await bot.telegram.sendMessage(
				targetUserId,
				` Good news! ${formatUserIdDisplay(payerId)} paid your bail of ${bailAmount.toFixed(2)} JUNO!\nYou have been released from jail.`,
			);
		} catch (dmError) {
			logger.debug(
				`Could not notify user ${targetUserId} of bail payment`,
				dmError,
			);
		}

		await ctx.reply(
			`*Bail Payment Verified\\!*\n\n` +
				`${escapeMarkdownV2(formatUserIdDisplay(targetUserId))} has been released from jail\\.\n` +
				`Paid by: ${escapeMarkdownV2(formatUserIdDisplay(payerId))}\n` +
				`Transaction: \`${escapeMarkdownV2(txHash)}\``,
			{ parse_mode: "MarkdownV2" },
		);

		StructuredLogger.logTransaction("Bail paid by another user and verified", {
			userId: targetUserId,
			txHash,
			amount: bailAmount.toString(),
			operation: "bail_verification_for_other",
			payerId: payerId,
		});
	});
}
