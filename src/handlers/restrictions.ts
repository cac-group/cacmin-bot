/**
 * User restriction management handlers for the CAC Admin Bot.
 * Provides commands for adding, removing, and listing user-specific restrictions
 * such as sticker limitations, URL blocking, and regex-based message filtering.
 *
 * @module handlers/restrictions
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { adminOrHigher, elevatedOrHigher } from "../middleware";
import {
	addUserRestriction,
	getUserRestrictions,
	removeUserRestriction,
} from "../services/userService";
import { restrictionTypeKeyboard } from "../utils/keyboards";
import { StructuredLogger } from "../utils/logger";
import { normalizeRandomDeleteChance } from "../utils/randomDelete";
import { isImmuneToModeration } from "../utils/roles";
import { getRemainingArgs, resolveTargetUser } from "../utils/userResolver";

/**
 * Registers all restriction management command handlers with the bot.
 * Provides commands for admins and elevated users to manage user-specific restrictions.
 *
 * Commands registered:
 * - /addrestriction - Add a restriction to a user
 * - /removerestriction - Remove a restriction from a user
 * - /listrestrictions - List all restrictions for a user
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * ```typescript
 * const bot = new Telegraf(token);
 * registerRestrictionHandlers(bot);
 * ```
 */
export const registerRestrictionHandlers = (bot: Telegraf<Context>) => {
	/**
	 * Command handler for /addrestriction.
	 * Adds a specific restriction to a user with configurable severity and auto-jail settings.
	 *
	 * Permission: Admin or higher
	 *
	 * **Two invocation modes:**
	 *
	 * 1. **Interactive mode** (no arguments):
	 *    Shows a keyboard to select restriction type, then prompts for:
	 *    - Target user (via text reply)
	 *    - Severity level (delete/mute/jail)
	 *    - Auto-jail settings (default/strict/lenient/disabled)
	 *
	 * 2. **Command-line mode** (with arguments):
	 *    Full control via command arguments:
	 *    `/addrestriction <user> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]`
	 *
	 * **Restriction Types:**
	 * no_stickers, no_urls, no_media, no_photos, no_videos, no_documents,
	 * no_gifs, no_voice, no_forwarding, regex_block, random_delete
	 *
	 * **Severity Levels:**
	 * - delete: Just delete the violating message (default)
	 * - mute: 30-minute mute on each violation
	 * - jail: Immediate 1-hour jail with 5 JUNO fine
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * // Interactive mode - just run the command
	 * /addrestriction
	 *
	 * @example
	 * // Command-line mode - full specification
	 * /addrestriction @alice no_photos
	 * /addrestriction 123456 no_stickers - - mute
	 * /addrestriction @bob regex_block "spam" - jail
	 * /addrestriction @bob random_delete 25% - delete
	 *
	 * @example
	 * // Reply-based - reply to user's message
	 * /addrestriction no_urls - - delete 3
	 */
	bot.command("addrestriction", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];

		// If no arguments, show interactive keyboard
		if (args.length === 0) {
			return ctx.reply(
				fmt`${bold("Add User Restriction")}

Select a restriction type to apply:

${bold("Restriction Types:")}
• ${bold("No Stickers")} - Block all stickers or specific packs
• ${bold("No URLs")} - Block URL links or specific domains
• ${bold("No Media (All)")} - Block photos, videos, documents, audio
• ${bold("No Photos")} - Block only photo messages
• ${bold("No Videos")} - Block only video messages
• ${bold("No Documents")} - Block only document files
• ${bold("No GIFs")} - Block GIF animations
• ${bold("No Voice")} - Block voice messages and video notes
• ${bold("No Forwarding")} - Block forwarded messages
• ${bold("Regex Block")} - Block messages matching text patterns
• ${bold("Random Delete")} - Randomly delete longer text messages using a configurable chance

${bold("Severity Levels:")}
• ${bold("delete")} (default) - Just delete the violating message
• ${bold("mute")} - 30-minute mute on each violation
• ${bold("jail")} - Immediate 1-hour jail with 5 JUNO fine

Command format:
${code("/addrestriction <@username|userId> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]")}

${bold("Examples:")}
${code("/addrestriction @alice no_photos")} (delete only)
${code("/addrestriction 123456 no_photos - - mute")} (mute 30min)
${code("/addrestriction @bob no_stickers - - delete 3")} (auto-jail after 3 violations)
${code('/addrestriction 123456 regex_block "spam" - jail')} (instant jail)
${code("/addrestriction 123456 random_delete 25%")} (25% delete chance on longer text)

Auto-escalation: After threshold violations (default 5) within 60 minutes, user gets auto-jailed for jailDuration (default 2880 min = 2 days) with jailFine (default 10 JUNO).

For regex pattern examples: ${code("/regexhelp")}

You can also reply to a user's message: ${code("/addrestriction <type> [options...]")}`,
				{
					reply_markup: restrictionTypeKeyboard,
				},
			);
		}

		// Resolve target user (supports @username, userId, reply-to)
		const target = resolveTargetUser(ctx, args);
		if (!target) {
			return ctx.reply(
				fmt`${bold("Usage")}: /addrestriction <@username|userId> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]

Or reply to a user's message with: /addrestriction <type> [options...]`,
			);
		}

		const remainingArgs = getRemainingArgs(args, target);
		const [
			restriction,
			restrictedAction,
			restrictedUntil,
			severity,
			violationThreshold,
			autoJailDuration,
			autoJailFine,
		] = remainingArgs;

		if (!restriction) {
			return ctx.reply(
				"Please specify a restriction type. Use /regexhelp for pattern examples.",
			);
		}

		try {
			// Check if target user is immune to moderation
			if (isImmuneToModeration(target.userId)) {
				return ctx.reply(
					fmt`Cannot restrict @${target.username} - admins and owners are immune to moderation actions.`,
				);
			}

			const untilTimestamp =
				restrictedUntil && restrictedUntil !== "-"
					? parseInt(restrictedUntil, 10)
					: undefined;
			// Strip surrounding quotes from action if present (from command parsing)
			let action =
				restrictedAction && restrictedAction !== "-"
					? restrictedAction
					: undefined;
			if (action?.startsWith('"') && action.endsWith('"')) {
				action = action.slice(1, -1);
			}
			if (restriction === "random_delete") {
				const normalizedChance = normalizeRandomDeleteChance(action);
				if (!normalizedChance) {
					return ctx.reply(
						"Random delete chance must be between 0 and 100%. Examples: 10%, 25, 0.1, or default.",
					);
				}
				action = normalizedChance;
			}
			const metadata: Record<string, any> | undefined = undefined;

			// Parse severity parameters with defaults
			const severityLevel =
				severity &&
				severity !== "-" &&
				["delete", "mute", "jail"].includes(severity)
					? (severity as "delete" | "mute" | "jail")
					: "delete";
			const threshold =
				violationThreshold && violationThreshold !== "-"
					? parseInt(violationThreshold, 10)
					: 5;
			const jailDuration =
				autoJailDuration && autoJailDuration !== "-"
					? parseInt(autoJailDuration, 10)
					: 2880;
			const jailFine =
				autoJailFine && autoJailFine !== "-" ? parseFloat(autoJailFine) : 10.0;

			addUserRestriction(
				target.userId,
				restriction,
				action,
				metadata,
				untilTimestamp,
				severityLevel,
				threshold,
				jailDuration,
				jailFine,
			);

			StructuredLogger.logSecurityEvent("Restriction added to user", {
				adminId,
				userId: target.userId,
				operation: "add_restriction",
				restriction,
				restrictedAction: action,
				restrictedUntil: untilTimestamp,
				severity: severityLevel,
				violationThreshold: threshold,
				autoJailDuration: jailDuration,
				autoJailFine: jailFine,
			});

			await ctx.reply(
				fmt`Restriction '${restriction}' added for @${target.username} (${target.userId}).
Severity: ${severityLevel}
Auto-jail after ${threshold} violations in 60 minutes (${jailDuration} min jail, ${jailFine.toFixed(1)} JUNO fine)`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "add_restriction",
				restriction,
			});
			await ctx.reply("An error occurred while adding the restriction.");
		}
	});

	/**
	 * Command handler for /removerestriction.
	 * Removes a specific restriction from a user.
	 *
	 * Permission: Elevated or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /removerestriction <userId> <restriction>
	 * Example: /removerestriction 123456 no_stickers
	 */
	bot.command("removerestriction", elevatedOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];

		const target = resolveTargetUser(ctx, args);
		if (!target) {
			return ctx.reply(
				"Usage: /removerestriction <@username|userId> <restriction> or reply to a user's message",
			);
		}

		const remainingArgs = getRemainingArgs(args, target);
		const [restriction] = remainingArgs;

		if (!restriction) {
			return ctx.reply("Please specify the restriction type to remove.");
		}

		try {
			removeUserRestriction(target.userId, restriction);
			StructuredLogger.logSecurityEvent("Restriction removed from user", {
				adminId,
				userId: target.userId,
				operation: "remove_restriction",
				restriction,
			});
			await ctx.reply(
				fmt`Restriction '${restriction}' removed for @${target.username} (${target.userId}).`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "remove_restriction",
				restriction,
			});
			await ctx.reply("An error occurred while removing the restriction.");
		}
	});

	/**
	 * Command handler for /listrestrictions.
	 * Lists all active restrictions for a specific user.
	 *
	 * Permission: Elevated or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /listrestrictions <userId>
	 * Example: /listrestrictions 123456
	 */
	bot.command("listrestrictions", elevatedOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];

		const target = resolveTargetUser(ctx, args);
		if (!target) {
			return ctx.reply(
				"Usage: /listrestrictions <@username|userId> or reply to a user's message",
			);
		}

		try {
			const restrictions = getUserRestrictions(target.userId);
			if (restrictions.length === 0) {
				return ctx.reply(
					fmt`No restrictions found for @${target.username} (${target.userId}).`,
				);
			}

			const message = restrictions
				.map((r) => {
					const expiresText = r.restrictedUntil
						? new Date(r.restrictedUntil * 1000).toLocaleString()
						: "Never (Permanent)";
					const daysCount = Math.round((r.autoJailDuration || 2880) / 1440);
					return fmt`${bold("Type:")} ${r.restriction}
${bold("Action:")} ${r.restrictedAction || "N/A"}
${bold("Severity:")} ${r.severity || "delete"}
${bold("Threshold:")} ${r.violationThreshold || 5} violations in 60 min
${bold("Auto-jail:")} ${r.autoJailDuration || 2880} min (${daysCount} days)
${bold("Fine:")} ${(r.autoJailFine || 10.0).toFixed(1)} JUNO
${bold("Expires:")} ${expiresText}`.text;
				})
				.join("\n\n━━━━━━━━━━━━━━\n\n");
			await ctx.reply(
				fmt`${bold(`Restrictions for @${target.username} (${target.userId}):`)}

${message}`,
			);

			StructuredLogger.logUserAction("Restrictions queried", {
				adminId,
				userId: target.userId,
				operation: "list_restrictions",
				count: restrictions.length.toString(),
			});
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "list_restrictions",
			});
			await ctx.reply("An error occurred while fetching restrictions.");
		}
	});

	/**
	 * Command handler for /regexhelp.
	 * Displays comprehensive examples for using regex patterns.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 */
	bot.command("regexhelp", adminOrHigher, async (ctx) => {
		await ctx.reply(
			fmt`${bold("Regex Pattern Guide")}

${bold("Pattern Types:")}

${bold("Simple Text")} (exact phrase, case-insensitive)
${code('/addrestriction 123456 regex_block "buy now"')}
Blocks: "buy now", "BUY NOW", "Buy Now"

${bold("Wildcards")} (* = any chars, ? = one char)
${code('/addrestriction 123456 regex_block "*crypto scam*"')}
${code('/addrestriction 123456 regex_block "test?pattern"')}

${bold("Full Regex")} (/pattern/flags format)
${code('/addrestriction 123456 regex_block "/spam.*here/i"')}

━━━━━━━━━━━━━━━━━━

${bold("Common Examples:")}

${bold("Block spam phrases:")}
${code('/addrestriction 123456 regex_block "/buy.*now|click.*here|limited.*offer/i"')}

${bold("Block phone numbers:")}
${code('/addrestriction 123456 regex_block "/\\+?[0-9]{10,15}/i"')}

${bold("Block crypto addresses:")}
${code('/addrestriction 123456 regex_block "/0x[a-fA-F0-9]{40}/"')}
${code('/addrestriction 123456 regex_block "/(cosmos|juno)[a-z0-9]{39}/"')}

${bold("Block excessive caps:")}
${code('/addrestriction 123456 regex_block "/^[A-Z\\s!?.,]{20,}$/"')}

${bold("Block repeated chars:")}
${code('/addrestriction 123456 regex_block "/(.)\\1{4,}/"')}
Blocks: "aaaaa", "!!!!!", "😂😂😂😂😂"

${bold("Block profanity:")}
${code('/addrestriction 123456 regex_block "/\\b(word1|word2|word3)\\b/i"')}

${bold("Block social handles:")}
${code('/addrestriction 123456 regex_block "/follow.*instagram|check.*my.*ig/i"')}

━━━━━━━━━━━━━━━━━━

${bold("Testing Tips:")}
• Test in a test group first
• Use temporary restrictions (add seconds at end)
• Start with simple patterns, then expand

${bold("Example with 1 hour timeout:")}
${code('/addrestriction 123456 regex_block "test" 3600')}

Full documentation: See REGEX_PATTERNS.md`,
		);
	});
};
