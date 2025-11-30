/**
 * User restriction management handlers for the CAC Admin Bot.
 * Provides commands for adding, removing, and listing user-specific restrictions
 * such as sticker limitations, URL blocking, and regex-based message filtering.
 *
 * @module handlers/restrictions
 */

import type { Context, Telegraf } from "telegraf";
import { adminOrHigher, elevatedOrHigher } from "../middleware";
import {
	addUserRestriction,
	getUserRestrictions,
	removeUserRestriction,
} from "../services/userService";
import { restrictionTypeKeyboard } from "../utils/keyboards";
import { StructuredLogger } from "../utils/logger";
import { escapeMarkdownV2 } from "../utils/markdown";
import { isImmuneToModeration } from "../utils/roles";

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
	 * Adds a specific restriction to a user with optional expiration.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /addrestriction <userId> <restriction> [restrictedAction] [restrictedUntil]
	 * Example: /addrestriction 123456 no_stickers stickerpack_name 1735689600
	 */
	bot.command("addrestriction", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const [
			userId,
			restriction,
			restrictedAction,
			restrictedUntil,
			severity,
			violationThreshold,
			autoJailDuration,
			autoJailFine,
		] = args;

		// If no arguments, show interactive keyboard
		if (!userId || !restriction) {
			return ctx.reply(
				"*Add User Restriction*\n\n" +
					"Select a restriction type to apply:\n\n" +
					"*Restriction Types:*\n" +
					"• *No Stickers* \\- Block all stickers or specific packs\n" +
					"• *No URLs* \\- Block URL links or specific domains\n" +
					"• *No Media \\(All\\)* \\- Block photos, videos, documents, audio\n" +
					"• *No Photos* \\- Block only photo messages\n" +
					"• *No Videos* \\- Block only video messages\n" +
					"• *No Documents* \\- Block only document files\n" +
					"• *No GIFs* \\- Block GIF animations\n" +
					"• *No Voice* \\- Block voice messages and video notes\n" +
					"• *No Forwarding* \\- Block forwarded messages\n" +
					"• *Regex Block* \\- Block messages matching text patterns\n\n" +
					"*Severity Levels:*\n" +
					"• *delete* \\(default\\) \\- Just delete the violating message\n" +
					"• *mute* \\- 30\\-minute mute on each violation\n" +
					"• *jail* \\- Immediate 1\\-hour jail with 5 JUNO fine\n\n" +
					"_Command format:_\n" +
					"`/addrestriction <userId> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]`\n\n" +
					"*Examples:*\n" +
					"`/addrestriction 123456 no_photos` \\(delete only\\)\n" +
					"`/addrestriction 123456 no_photos - - mute` \\(mute 30min\\)\n" +
					"`/addrestriction 123456 no_stickers - - delete 3` \\(auto\\-jail after 3 violations\\)\n" +
					'`/addrestriction 123456 regex_block "spam" - jail` \\(instant jail\\)\n\n' +
					"_Auto\\-escalation:_ After threshold violations \\(default 5\\) within 60 minutes, user gets auto\\-jailed for jailDuration \\(default 2880 min = 2 days\\) with jailFine \\(default 10 JUNO\\)\\.\n\n" +
					"_For regex pattern examples:_ `/regexhelp`",
				{
					parse_mode: "MarkdownV2",
					reply_markup: restrictionTypeKeyboard,
				},
			);
		}

		try {
			const targetUserId = parseInt(userId, 10);

			// Check if target user is immune to moderation
			if (isImmuneToModeration(targetUserId)) {
				return ctx.reply(
					`Cannot restrict user ${escapeMarkdownV2(targetUserId.toString())} \\- admins and owners are immune to moderation actions\\.`,
					{ parse_mode: "MarkdownV2" },
				);
			}

			const untilTimestamp =
				restrictedUntil && restrictedUntil !== "-"
					? parseInt(restrictedUntil, 10)
					: undefined;
			const action =
				restrictedAction && restrictedAction !== "-"
					? restrictedAction
					: undefined;
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
				targetUserId,
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
				userId: parseInt(userId, 10),
				operation: "add_restriction",
				restriction,
				restrictedAction: action,
				restrictedUntil: untilTimestamp,
				severity: severityLevel,
				violationThreshold: threshold,
				autoJailDuration: jailDuration,
				autoJailFine: jailFine,
			});

			let reply = `Restriction '${escapeMarkdownV2(restriction)}' added for user ${escapeMarkdownV2(userId)}\\.\\n`;
			reply += `Severity: ${escapeMarkdownV2(severityLevel)}\\n`;
			reply += `Auto\\-jail after ${escapeMarkdownV2(threshold.toString())} violations in 60 minutes \\(${escapeMarkdownV2(jailDuration.toString())} min jail, ${escapeMarkdownV2(jailFine.toFixed(1))} JUNO fine\\)`;

			await ctx.reply(reply, { parse_mode: "MarkdownV2" });
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: parseInt(userId, 10),
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

		const [userId, restriction] = ctx.message?.text.split(" ").slice(1) || [];
		if (!userId || !restriction) {
			return ctx.reply("Usage: /removerestriction <userId> <restriction>", {
				parse_mode: "MarkdownV2",
			});
		}

		try {
			removeUserRestriction(parseInt(userId, 10), restriction);
			StructuredLogger.logSecurityEvent("Restriction removed from user", {
				adminId,
				userId: parseInt(userId, 10),
				operation: "remove_restriction",
				restriction,
			});
			await ctx.reply(
				`Restriction '${escapeMarkdownV2(restriction)}' removed for user ${escapeMarkdownV2(userId)}\\.`,
				{ parse_mode: "MarkdownV2" },
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: parseInt(userId, 10),
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

		const [userId] = ctx.message?.text.split(" ").slice(1) || [];
		if (!userId) {
			return ctx.reply("Usage: /listrestrictions <userId>", {
				parse_mode: "MarkdownV2",
			});
		}

		try {
			const restrictions = getUserRestrictions(parseInt(userId, 10));
			if (restrictions.length === 0) {
				return ctx.reply(
					`No restrictions found for user ${escapeMarkdownV2(userId)}\\.`,
					{ parse_mode: "MarkdownV2" },
				);
			}

			const message = restrictions
				.map((r) => {
					const lines = [
						`*Type:* ${escapeMarkdownV2(r.restriction)}`,
						`*Action:* ${escapeMarkdownV2(r.restrictedAction || "N/A")}`,
						`*Severity:* ${escapeMarkdownV2(r.severity || "delete")}`,
						`*Threshold:* ${escapeMarkdownV2((r.violationThreshold || 5).toString())} violations in 60 min`,
						`*Auto\\-jail:* ${escapeMarkdownV2((r.autoJailDuration || 2880).toString())} min \\(${escapeMarkdownV2(Math.round((r.autoJailDuration || 2880) / 1440).toString())} days\\)`,
						`*Fine:* ${escapeMarkdownV2((r.autoJailFine || 10.0).toFixed(1))} JUNO`,
						`*Expires:* ${escapeMarkdownV2(r.restrictedUntil ? new Date(r.restrictedUntil * 1000).toLocaleString() : "Never (Permanent)")}`,
					];
					return lines.join("\n");
				})
				.join("\n\n━━━━━━━━━━━━━━\n\n");
			await ctx.reply(
				`*Restrictions for user ${escapeMarkdownV2(userId)}:*\n\n${message}`,
				{
					parse_mode: "MarkdownV2",
				},
			);

			StructuredLogger.logUserAction("Restrictions queried", {
				adminId,
				userId: parseInt(userId, 10),
				operation: "list_restrictions",
				count: restrictions.length.toString(),
			});
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: parseInt(userId, 10),
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
		const helpMessage = `*Regex Pattern Guide*

*Pattern Types:*

*Simple Text* \\(exact phrase, case\\-insensitive\\)
\`/addrestriction 123456 regex_block "buy now"\`
Blocks: "buy now", "BUY NOW", "Buy Now"

*Wildcards* \\(\\* = any chars, ? = one char\\)
\`/addrestriction 123456 regex_block "*crypto scam*"\`
\`/addrestriction 123456 regex_block "test?pattern"\`

*Full Regex* \\(/pattern/flags format\\)
\`/addrestriction 123456 regex_block "/spam.*here/i"\`

━━━━━━━━━━━━━━━━━━

*Common Examples:*

*Block spam phrases:*
\`/addrestriction 123456 regex_block "/buy.*now|click.*here|limited.*offer/i"\`

*Block phone numbers:*
\`/addrestriction 123456 regex_block "/\\\\+?[0-9]{10,15}/i"\`

*Block crypto addresses:*
\`/addrestriction 123456 regex_block "/0x[a-fA-F0-9]{40}/"\`
\`/addrestriction 123456 regex_block "/(cosmos|juno)[a-z0-9]{39}/"\`

*Block excessive caps:*
\`/addrestriction 123456 regex_block "/^[A-Z\\\\s!?.,]{20,}$/"\`

*Block repeated chars:*
\`/addrestriction 123456 regex_block "/(.)\\\\1{4,}/"\`
Blocks: "aaaaa", "\\!\\!\\!\\!\\!", "😂😂😂😂😂"

*Block profanity:*
\`/addrestriction 123456 regex_block "/\\\\b(word1|word2|word3)\\\\b/i"\`

*Block social handles:*
\`/addrestriction 123456 regex_block "/follow.*instagram|check.*my.*ig/i"\`

━━━━━━━━━━━━━━━━━━

*Testing Tips:*
• Test in a test group first
• Use temporary restrictions \\(add seconds at end\\)
• Start with simple patterns, then expand

*Example with 1 hour timeout:*
\`/addrestriction 123456 regex_block "test" 3600\`

Full documentation: See REGEX\\_PATTERNS\\.md`;

		await ctx.reply(helpMessage, { parse_mode: "MarkdownV2" });
	});
};
