/**
 * Whitelist management handlers for the CAC Admin Bot.
 * Provides commands for managing user whitelist status.
 *
 * @module handlers/blacklist
 */

import type { Context, Telegraf } from "telegraf";
import { execute, query } from "../database";
import { adminOrHigher } from "../middleware";
import type { User } from "../types";
import { StructuredLogger } from "../utils/logger";
import { resolveTargetUser } from "../utils/userResolver";

/**
 * Registers all whitelist command handlers with the bot.
 * Provides commands for admins to manage user access control lists.
 *
 * Commands registered:
 * - /viewwhitelist - View all whitelisted users
 * - /addwhitelist - Add a user to the whitelist
 * - /removewhitelist - Remove a user from the whitelist
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * ```typescript
 * const bot = new Telegraf(token);
 * registerBlacklistHandlers(bot);
 * ```
 */
export const registerBlacklistHandlers = (bot: Telegraf<Context>) => {
	/**
	 * Command handler for /viewwhitelist.
	 * Displays all users currently on the whitelist.
	 *
	 * Permission: All users can view
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /viewwhitelist
	 */
	bot.command("viewwhitelist", async (ctx) => {
		try {
			const whitelist = query<User>(
				"SELECT id, username FROM users WHERE whitelist = 1",
			);
			if (whitelist.length === 0) {
				return ctx.reply("The whitelist is empty.");
			}

			const message = whitelist
				.map((user) => `ID: ${user.id}, Username: ${user.username}`)
				.join("\n");
			await ctx.reply(`Whitelisted Users:\n${message}`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId: ctx.from?.id,
				operation: "view_whitelist",
			});
			await ctx.reply("An error occurred while fetching the whitelist.");
		}
	});

	/**
	 * Command handler for /addwhitelist.
	 * Adds a user to the whitelist, granting them special permissions or exemptions.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /addwhitelist <@username|userId>
	 * Example: /addwhitelist @alice
	 */
	bot.command("addwhitelist", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /addwhitelist <@username|userId> or reply to a user's message",
			);
		}

		try {
			execute("UPDATE users SET whitelist = 1 WHERE id = ?", [target.userId]);
			StructuredLogger.logSecurityEvent("User added to whitelist", {
				adminId,
				userId: target.userId,
				operation: "add_whitelist",
			});
			await ctx.reply(`@${target.username} has been whitelisted.`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "add_whitelist",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});

	/**
	 * Command handler for /removewhitelist.
	 * Removes a user from the whitelist.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /removewhitelist <@username|userId>
	 * Example: /removewhitelist @alice
	 */
	bot.command("removewhitelist", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /removewhitelist <@username|userId> or reply to a user's message",
			);
		}

		try {
			execute("UPDATE users SET whitelist = 0 WHERE id = ?", [target.userId]);
			StructuredLogger.logSecurityEvent("User removed from whitelist", {
				adminId,
				userId: target.userId,
				operation: "remove_whitelist",
			});
			await ctx.reply(
				`@${target.username} has been removed from the whitelist.`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "remove_whitelist",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});
};
