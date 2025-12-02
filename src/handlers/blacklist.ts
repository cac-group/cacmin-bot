/**
 * Whitelist and blacklist management handlers for the CAC Admin Bot.
 * Provides commands for managing user whitelist and blacklist status,
 * controlling user access and permissions within the chat.
 *
 * @module handlers/blacklist
 */

import type { Context, Telegraf } from "telegraf";
import { execute, query } from "../database";
import { adminOrHigher } from "../middleware";
import type { User } from "../types";
import { StructuredLogger } from "../utils/logger";
import { isImmuneToModeration } from "../utils/roles";
import { resolveTargetUser } from "../utils/userResolver";

/**
 * Registers all whitelist and blacklist command handlers with the bot.
 * Provides commands for admins to manage user access control lists.
 *
 * Commands registered:
 * - /viewwhitelist - View all whitelisted users
 * - /addwhitelist - Add a user to the whitelist
 * - /removewhitelist - Remove a user from the whitelist
 * - /viewblacklist - View all blacklisted users
 * - /addblacklist - Add a user to the blacklist
 * - /removeblacklist - Remove a user from the blacklist
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
	 * Usage: /addwhitelist <userId>
	 * Example: /addwhitelist 123456789
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
	 * Usage: /removewhitelist <userId>
	 * Example: /removewhitelist 123456789
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

	/**
	 * Command handler for /viewblacklist.
	 * Displays all users currently on the blacklist.
	 *
	 * Permission: All users can view
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /viewblacklist
	 */
	bot.command("viewblacklist", async (ctx) => {
		try {
			const blacklist = query<User>(
				"SELECT id, username FROM users WHERE blacklist = 1",
			);
			if (blacklist.length === 0) {
				return ctx.reply("The blacklist is empty.");
			}

			const message = blacklist
				.map((user) => `ID: ${user.id}, Username: ${user.username}`)
				.join("\n");
			await ctx.reply(`Blacklisted Users:\n${message}`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId: ctx.from?.id,
				operation: "view_blacklist",
			});
			await ctx.reply("An error occurred while fetching the blacklist.");
		}
	});

	/**
	 * Command handler for /addblacklist.
	 * Adds a user to the blacklist, restricting their access and privileges.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /addblacklist <userId>
	 * Example: /addblacklist 123456789
	 */
	bot.command("addblacklist", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /addblacklist <@username|userId> or reply to a user's message",
			);
		}

		// Check if target user is immune to moderation
		if (isImmuneToModeration(target.userId)) {
			return ctx.reply(
				`Cannot blacklist @${target.username} - admins and owners are immune to moderation actions.`,
			);
		}

		try {
			execute("UPDATE users SET blacklist = 1 WHERE id = ?", [target.userId]);
			StructuredLogger.logSecurityEvent("User added to blacklist", {
				adminId,
				userId: target.userId,
				operation: "add_blacklist",
			});
			await ctx.reply(`@${target.username} has been blacklisted.`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "add_blacklist",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});

	/**
	 * Command handler for /removeblacklist.
	 * Removes a user from the blacklist.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /removeblacklist <userId>
	 * Example: /removeblacklist 123456789
	 */
	bot.command("removeblacklist", adminOrHigher, async (ctx) => {
		const adminId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /removeblacklist <@username|userId> or reply to a user's message",
			);
		}

		try {
			execute("UPDATE users SET blacklist = 0 WHERE id = ?", [target.userId]);
			StructuredLogger.logSecurityEvent("User removed from blacklist", {
				adminId,
				userId: target.userId,
				operation: "remove_blacklist",
			});
			await ctx.reply(
				`@${target.username} has been removed from the blacklist.`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				adminId,
				userId: target.userId,
				operation: "remove_blacklist",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});
};
