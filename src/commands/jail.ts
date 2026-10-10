/**
 * Jail command handlers for the CAC Admin Bot.
 * Provides commands for viewing jail statistics, checking user status,
 * listing active jails, and paying bail for users.
 *
 * @module commands/jail
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { config } from "../config";
import { get } from "../database";
import { adminOrHigher, elevatedOrHigher } from "../middleware/index";
import { ChatIndexerService } from "../services/chatIndexerService";
import { releaseMember } from "../services/chatMuteService";
import { CosmosRestService } from "../services/cosmosRestService";
import { JailService } from "../services/jailService";
import { JunoService } from "../services/junoService";
import { LedgerService } from "../services/ledgerService";
import { getActiveCooldown } from "../services/rejoinCooldownService";
import { SYSTEM_USER_IDS } from "../services/unifiedWalletService";
import type { User } from "../types";
import { formatActiveTime } from "../utils/activeTime";
import { autoDeleteInGroup } from "../utils/autoDelete";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import {
	formatUserIdDisplay,
	resolveTargetUser,
	resolveUserId,
} from "../utils/userResolver";

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
 * Send bail payment instructions for a user's current jail.
 * Shared by /paybail and the legacy fine-payment aliases.
 */
async function sendBailInstructions(
	ctx: Context,
	targetUserId: number,
): Promise<void> {
	const user = get<User>("SELECT * FROM users WHERE id = ?", [targetUserId]);
	if (!user) {
		const msg = await ctx.reply(fmt`User not found in database.`);
		autoDeleteInGroup(ctx, msg.message_id);
		return;
	}

	const now = Math.floor(Date.now() / 1000);
	const jailing = JailService.getActiveJailing(targetUserId);
	if ((!user.muted_until || user.muted_until <= now) && !jailing) {
		const msg = await ctx.reply(
			fmt`You are not currently jailed. No bail required!`,
		);
		autoDeleteInGroup(ctx, msg.message_id);
		return;
	}

	const timeRemaining = jailing
		? Math.max(0, jailing.mutedUntil - now)
		: (user.muted_until ?? now) - now;
	const bailAmount =
		jailing?.bailAmount ?? JailService.getCurrentBailAmount(targetUserId);
	const jailingLine = jailing
		? fmt`Jailing ID: ${code(jailing.jailingId)}\n`
		: "";
	const memoLine = jailing
		? fmt`\n${bold("IMPORTANT:")} put the Jailing ID (${code(jailing.jailingId)}) in the transaction MEMO so the payment is credited to this jailing.\n`
		: "";

	const msg = await ctx.reply(
		fmt`${bold("Pay Your Bail")}
${jailingLine}
Current jail time remaining: ${formatTimeRemaining(timeRemaining)}
Bail amount: ${bailAmount.toFixed(3)} JUNO

Send exactly ${bailAmount.toFixed(3)} JUNO to:
${code(JunoService.getPaymentAddress())}
${memoLine}
After payment, send:
/verifybail <txhash>`,
	);
	autoDeleteInGroup(ctx, msg.message_id);
}

/**
 * Verify an on-chain bail payment (the tx memo carries the jailing id) and
 * release the jailed user. Shared by /verifybail and the /verifypayment alias.
 */
async function verifyBailPayment(
	ctx: Context,
	paidByUserId: number,
	txHash: string,
): Promise<void> {
	const fail = async (text: string) => {
		const msg = await ctx.reply(text);
		autoDeleteInGroup(ctx, msg.message_id);
	};

	const tx = await CosmosRestService.fetchTransaction(txHash);
	if (!tx || tx.code !== 0) {
		return fail("Transaction not found or failed on-chain.");
	}

	const jailing = JailService.getJailingByPublicId(tx.memo ?? "");
	if (!jailing) {
		return fail(
			"The transaction memo must contain a valid, open Jailing ID (alphanumeric).",
		);
	}
	if (JailService.isBailPaymentUsed(txHash)) {
		return fail(
			"This transaction hash has already been used for a bail payment.",
		);
	}

	const treasury = config.botTreasuryAddress;
	const transfer = treasury
		? CosmosRestService.findMsgSend(tx, treasury)
		: null;
	if (
		!transfer ||
		transfer.amountMicro !== AmountPrecision.toDbMicro(jailing.bailAmount)
	) {
		return fail(
			"Payment amount does not match the bail amount, or was not sent to the treasury.",
		);
	}

	const payment = JailService.payJailing(
		jailing.jailingId,
		paidByUserId,
		txHash,
	);
	if (!payment.success) {
		return fail(
			payment.duplicate
				? "This transaction hash has already been used for a bail payment."
				: "The jailing is no longer open (expired or already paid).",
		);
	}

	const userId = jailing.userId;
	if (config.groupChatId) {
		try {
			await releaseMember({
				telegram: ctx.telegram,
				chatId: config.groupChatId,
				userId,
			});
		} catch (error) {
			logger.error("Failed to restore permissions after bail payment", {
				userId,
				error,
			});
		}
	}

	const msg = await ctx.reply(
		fmt`${bold("Bail Payment Verified!")}

Jailing ${code(jailing.jailingId)} paid for user ${code(String(userId))}. They have been released.
Transaction: ${code(txHash)}`,
	);
	autoDeleteInGroup(ctx, msg.message_id);

	StructuredLogger.logTransaction("Bail paid and verified", {
		userId,
		txHash,
		amount: jailing.bailAmount.toString(),
		operation: "bail_verification",
	});
}

/**
 * Registers all jail-related commands with the bot.
 *
 * Commands registered:
 * - /jailstats - View global jail statistics (elevated users only)
 * - /mystatus - Check your own jail status and fines
 * - /jails - List all active jails
 * - /paybail - Pay your own or another user's bail
 * - /verifybail - Verify your own or another user's bail payment
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
	bot.command("bailhelp", async (ctx) => {
		if (ctx.chat?.type !== "private") {
			await ctx.reply(
				`Please DM me and send /bailhelp for complete bail payment details: https://t.me/${config.botIdentity.supportUsername}`,
			);
			return;
		}

		await ctx.reply(
			`BAIL PAYMENT DETAILS

Send the exact required bail amount in JUNO to:
${JunoService.getPaymentAddress()}

Send /paybail in this DM to see your Jailing ID, the exact amount, and the address, or use /paybail <@username|userId> for another jailed user.

CRITICAL: include the Jailing ID in the transaction MEMO. The Jailing ID is alphanumeric (for example JAIL12AB) and is shown by /paybail. A payment whose memo does not match a valid Jailing ID cannot be allocated to your jailing.

After the transaction confirms, submit its transaction hash:
- /verifybail <txhash>

In a group, you can also reply /paybail to the jailed user's message before sending payment.

The bot confirms the transaction succeeded, the amount matches, the payment went to the treasury, and the memo matches a valid Jailing ID, then releases the user.`,
		);
	});

	/**
	 * Command: /jailstats
	 * View comprehensive jail system statistics or specific user jail info.
	 *
	 * Permission: Elevated users or higher (enforced by elevatedOrHigher middleware)
	 * Syntax: /jailstats [@username|userId]
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
			try {
				// Show stats for specific user
				const targetUserId = resolveUserId(userIdentifier);
				if (!targetUserId) {
					const msg = await ctx.reply(
						fmt`User not found. Please use a valid @username or userId.`,
					);
					autoDeleteInGroup(ctx, msg.message_id);
					return;
				}

				const user = get<User>("SELECT * FROM users WHERE id = ?", [
					targetUserId,
				]);
				if (!user) {
					const msg = await ctx.reply(fmt`User not found in database.`);
					autoDeleteInGroup(ctx, msg.message_id);
					return;
				}

				const userDisplay = formatUserIdDisplay(targetUserId);
				const parts = [bold(`Jail Status for ${userDisplay}`), "\n\n"];

				// Current jail status
				if (user.muted_until && user.muted_until > now) {
					const timeRemaining = user.muted_until - now;
					const bailAmount = JailService.getCurrentBailAmount(targetUserId);

					parts.push(bold("Currently Jailed:"));
					parts.push(" Yes\n");
					parts.push(`Time Remaining: ${formatTimeRemaining(timeRemaining)}\n`);
					parts.push(`Bail Amount: ${bailAmount.toFixed(3)} JUNO\n`);
					parts.push(
						`Jailed Until: ${new Date(user.muted_until * 1000).toLocaleString()}\n\n`,
					);
				} else {
					parts.push(bold("Currently Jailed:"));
					parts.push(" No\n\n");
				}

				// Jail history for this user
				const jailEvents = JailService.getUserJailEvents(targetUserId, 5);
				if (jailEvents.length > 0) {
					parts.push(bold("Recent Jail History:"));
					parts.push("\n");
					for (const event of jailEvents) {
						const eventDate = new Date(
							(event.timestamp || 0) * 1000,
						).toLocaleString();
						const eventType = event.eventType.replace("_", " ");

						parts.push(`- ${eventType}`);
						if (event.durationMinutes) {
							parts.push(` (${event.durationMinutes}min)`);
						}
						if (event.bailAmount && event.bailAmount > 0) {
							parts.push(` - ${event.bailAmount.toFixed(3)} JUNO`);
						}
						parts.push(`\n  ${eventDate}\n`);
					}
					parts.push("\n");
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

				const totalBailSpent = AmountPrecision.fromDbMicro(
					getRecord<{ total: number }>(
						"SELECT SUM(bail_amount) as total FROM jail_events WHERE user_id = ? AND event_type = ?",
						[targetUserId, "bail_paid"],
					)?.total || 0,
				);

				parts.push(bold("User Statistics:"));
				parts.push("\n");
				parts.push(`Times Jailed: ${totalJails}\n`);
				parts.push(`Bails Paid: ${totalBailsPaid}\n`);
				parts.push(`Total Bail Spent: ${totalBailSpent.toFixed(2)} JUNO\n`);

				const msg = await ctx.reply(fmt(parts));
				autoDeleteInGroup(ctx, msg.message_id);
				return;
			} catch (error) {
				logger.error("jailstats user lookup failed", {
					userIdentifier,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
				const msg = await ctx.reply(
					fmt`Error looking up user stats. Please try again.`,
				);
				autoDeleteInGroup(ctx, msg.message_id);
				return;
			}
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

		const totalBailAmount = AmountPrecision.fromDbMicro(
			getRecord<{ total: number }>(
				"SELECT SUM(bail_amount) as total FROM jail_events WHERE event_type = ?",
				["bail_paid"],
			)?.total || 0,
		);

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

		const parts = [bold("Jail System Statistics"), "\n\n"];
		parts.push(bold("Currently Active Jails:"));
		parts.push(` ${activeJails.length}\n\n`);

		if (activeJails.length > 0) {
			parts.push(bold("Active Prisoners:"));
			parts.push("\n");
			for (let index = 0; index < activeJails.length; index++) {
				const jail = activeJails[index];
				const timeRemaining = formatTimeRemaining(jail.timeRemaining);
				const userDisplay = formatUserIdDisplay(jail.id);
				const bailAmount = JailService.getCurrentBailAmount(jail.id);
				parts.push(
					`${index + 1}. ${userDisplay} - ${timeRemaining} (${bailAmount.toFixed(3)} JUNO)\n`,
				);
			}
			parts.push("\n");
		}

		parts.push(bold("All-Time Statistics:"));
		parts.push("\n");
		parts.push(`Total Jail Events: ${totalJailEvents}\n`);
		parts.push(`Unique Users Jailed: ${totalJailed}\n`);
		parts.push(`Bails Paid: ${totalBailsPaid}\n`);
		parts.push(`Total Bail Revenue: ${totalBailAmount.toFixed(2)} JUNO\n`);
		parts.push(`Auto-Releases: ${totalAutoReleases}\n`);
		parts.push(`Manual Releases: ${totalManualReleases}\n`);

		const msg = await ctx.reply(fmt(parts));
		autoDeleteInGroup(ctx, msg.message_id);
	});

	/**
	 * Command: /mystatus
	 * Check your own status including jail time, role, warnings, and violations.
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
	 *      Bail amount: 69.420 JUNO
	 *      To pay bail: /paybail
	 *
	 *      Violations: 2 (view with /violations)
	 */
	bot.command("mystatus", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
		if (!user) {
			const msg = await ctx.reply(fmt`User not found in database.`);
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		const now = Math.floor(Date.now() / 1000);
		const parts = [bold("Your Status"), "\n\n"];
		parts.push(`User: ${formatUserIdDisplay(userId)}\n`);
		parts.push(`Role: ${user.role}\n`);
		parts.push(`Warnings: ${user.warning_count}\n\n`);

		// Check if jailed
		const cooldown =
			user.muted_until && user.muted_until > now
				? null
				: getActiveCooldown(userId, now);
		if (user.muted_until && user.muted_until > now) {
			const timeRemaining = user.muted_until - now;
			const bailAmount = JailService.getCurrentBailAmount(userId);

			parts.push(bold("Currently Jailed"));
			parts.push("\n");
			parts.push(`Time remaining: ${formatTimeRemaining(timeRemaining)}\n`);
			parts.push(`Bail amount: ${bailAmount.toFixed(3)} JUNO\n\n`);
			parts.push("To pay bail: /paybail\n\n");
		} else if (cooldown) {
			parts.push(bold("Currently Muted (rejoin cooldown)"));
			parts.push("\n");
			parts.push(
				`Time remaining: ${formatTimeRemaining(cooldown.mutedUntil - now)}\n`,
			);
			parts.push(
				`Buy-out: ${config.defaultJailBailAmount.toFixed(3)} JUNO\n\n`,
			);
			parts.push("To pay: /paybail\n\n");
		} else {
			parts.push("Not currently jailed\n\n");
		}

		// Show active time stats (matched strictly by user id)
		const activeStats = ChatIndexerService.getActiveTimeStats(userId);
		if (activeStats) {
			parts.push(bold("Activity"));
			parts.push("\n");
			parts.push(
				`Total active time: ${formatActiveTime(activeStats.totalSeconds)}\n`,
			);
			parts.push(
				`Last 7 days: ${formatActiveTime(activeStats.last7dSeconds)}\n`,
			);
			parts.push(
				`Last 30 days: ${formatActiveTime(activeStats.last30dSeconds)}\n`,
			);
			const dailyAvg =
				activeStats.trackedDays > 0
					? Math.round(
							activeStats.last30dSeconds /
								Math.min(activeStats.trackedDays, 30),
						)
					: 0;
			parts.push(`Daily avg (30d): ${formatActiveTime(dailyAvg)}\n`);
			parts.push(`Messages tracked: ${activeStats.messageCount}\n\n`);
		}

		// Violations are warning history; the only payable amount is the bail above.
		const violationCount =
			get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM violations WHERE user_id = ?",
				[userId],
			)?.n ?? 0;
		parts.push(`Violations: ${violationCount} (view with /violations)\n`);

		const msg = await ctx.reply(fmt(parts));
		autoDeleteInGroup(ctx, msg.message_id);
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
	 *         Pay: /paybail 123456
	 */
	bot.command("jails", async (ctx) => {
		const activeJails = JailService.getActiveJails();

		if (activeJails.length === 0) {
			const msg = await ctx.reply(fmt`No users currently jailed.`);
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		const parts = [bold(`Active Jails (${activeJails.length})`), "\n\n"];

		for (let index = 0; index < activeJails.length; index++) {
			const jail = activeJails[index];
			const bailAmount = JailService.getCurrentBailAmount(jail.id);
			const timeRemaining = formatTimeRemaining(jail.timeRemaining);
			const userDisplay = formatUserIdDisplay(jail.id);

			parts.push(`${index + 1}. ${userDisplay}\n`);
			parts.push(`   Time: ${timeRemaining}\n`);
			parts.push(`   Bail: ${bailAmount.toFixed(3)} JUNO\n`);
			parts.push(`   Pay: /paybail ${jail.id}\n\n`);
		}

		const msg = await ctx.reply(fmt(parts));
		autoDeleteInGroup(ctx, msg.message_id);
	});

	/**
	 * Command: /paybail
	 * Get payment instructions to pay your own or another user's bail.
	 *
	 * Permission: Any user
	 * Syntax: /paybail [@username|userId]
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
	 *      /verifybail <txhash>
	 */
	bot.command("paybail", async (ctx) => {
		const payerId = ctx.from?.id;
		if (!payerId) return;
		const args = (ctx.message as any)?.text.split(" ").slice(1) || [];
		const hasReply = Boolean(
			ctx.message &&
				"reply_to_message" in ctx.message &&
				ctx.message.reply_to_message,
		);
		const target =
			resolveTargetUser(ctx, args) ||
			(hasReply ? resolveTargetUser(ctx, []) : null);
		const targetUserId =
			target?.userId || (args.length === 0 && !hasReply ? payerId : undefined);

		if (!targetUserId) {
			const msg = await ctx.reply(
				"Usage: /paybail [@username|userId], or reply /paybail to a jailed user's message.",
			);
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		await sendBailInstructions(ctx, targetUserId);
	});

	// Legacy fine-payment commands are aliases of the single bail flow.
	bot.command("payfine", async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await sendBailInstructions(ctx, userId);
	});
	bot.command("payfines", async (ctx) => {
		const userId = ctx.from?.id;
		if (userId) await sendBailInstructions(ctx, userId);
	});

	/**
	 * Command: /payallfines
	 * Admin/owner-only: cover a jailed user's bail from the system reserve.
	 *
	 * Permission: Admin or owner
	 * Syntax: /payallfines <@username|userId>
	 */
	bot.command("payallfines", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		if (!adminId) return;

		const args = (ctx.message as any)?.text.split(" ").slice(1) || [];
		const hasReply = Boolean(
			ctx.message &&
				"reply_to_message" in ctx.message &&
				ctx.message.reply_to_message,
		);
		const target =
			resolveTargetUser(ctx, args) ||
			(hasReply ? resolveTargetUser(ctx, []) : null);
		const targetUserId = target?.userId;

		if (!targetUserId) {
			const msg = await ctx.reply(
				"Usage: /payallfines <@username|userId>, or reply /payallfines to a jailed user's message.",
			);
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		const jailing = JailService.getActiveJailing(targetUserId);
		if (!jailing) {
			const msg = await ctx.reply(fmt`That user has no active jailing to pay.`);
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}
		const bailAmount = jailing.bailAmount;

		// Cover the bail from the system reserve, never a game/escrow account.
		const adjustment = await LedgerService.processAdjustment(
			SYSTEM_USER_IDS.SYSTEM_RESERVE,
			-bailAmount,
			`Bail paid for jailing ${jailing.jailingId} (user ${targetUserId}) by admin ${adminId}`,
		);
		if (!adjustment.success) {
			const msg = await ctx.reply("Failed to debit the system reserve.");
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		const payment = JailService.payJailing(
			jailing.jailingId,
			adminId,
			`reserve_${jailing.jailingId}_${Date.now()}`,
		);
		if (!payment.success) {
			// Compensate: the reserve was already debited in its own transaction.
			await LedgerService.processAdjustment(
				SYSTEM_USER_IDS.SYSTEM_RESERVE,
				bailAmount,
				`Refund: bail record failed for user ${targetUserId}`,
			);
			const msg = await ctx.reply("Failed to record the bail payment.");
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		if (config.groupChatId) {
			try {
				await releaseMember({
					telegram: ctx.telegram,
					chatId: config.groupChatId,
					userId: targetUserId,
				});
			} catch (error) {
				logger.error("Failed to restore permissions after reserve bail", {
					userId: targetUserId,
					error,
				});
			}
		}

		const userDisplay = formatUserIdDisplay(targetUserId);
		const msg = await ctx.reply(
			fmt`${bold("Bail Paid from Reserve")}

User: ${userDisplay}
Bail: ${bailAmount.toFixed(3)} JUNO
Reserve balance: ${AmountPrecision.format(adjustment.newBalance)} JUNO

The user has been released.`,
		);
		autoDeleteInGroup(ctx, msg.message_id);

		StructuredLogger.logTransaction("Bail paid from system reserve", {
			userId: adminId,
			targetUserId,
			amount: bailAmount.toString(),
			operation: "reserve_bail_payment",
		});
	});

	/**
	 * Command: /verifybail
	 * Verify your bail payment and get released from jail.
	 *
	 * Permission: Any user
	 * Syntax: /verifybail <txhash>
	 *
	 * @example
	 * User: /verifybail ABC123DEF456...
	 * Bot: Bail Payment Verified!
	 *
	 *      You have been released from jail.
	 *      Transaction: `ABC123DEF456...`
	 */
	bot.command("verifybail", async (ctx) => {
		const payerId = ctx.from?.id;
		if (!payerId) return;

		const args = (ctx.message as any)?.text.split(" ").slice(1) || [];
		// The tx memo carries the jailing id, so only the hash is needed.
		const txHash = args[args.length - 1];
		if (!txHash) {
			const msg = await ctx.reply(
				"Usage: /verifybail <txhash>, or reply /verifybail <txhash> to a message.",
			);
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}

		await verifyBailPayment(ctx, payerId, txHash);
	});

	// Legacy fine verification alias: /verifypayment <txhash>.
	bot.command("verifypayment", async (ctx) => {
		const payerId = ctx.from?.id;
		if (!payerId) return;
		const args = (ctx.message as any)?.text.split(" ").slice(1) || [];
		const txHash = args[args.length - 1];
		if (args.length === 0 || !txHash) {
			const msg = await ctx.reply("Usage: /verifypayment <txhash>");
			autoDeleteInGroup(ctx, msg.message_id);
			return;
		}
		await verifyBailPayment(ctx, payerId, txHash);
	});
}
