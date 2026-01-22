/**
 * Global action restriction handlers for the CAC Admin Bot.
 * Manages global restrictions that apply to all users in the chat,
 * such as disabling certain sticker packs, URLs, or message patterns.
 *
 * @module handlers/actions
 */

import type { Context, Telegraf } from "telegraf";
import { execute, query } from "../database";
import { adminOrHigher } from "../middleware";
import type { GlobalAction } from "../types";
import { StructuredLogger } from "../utils/logger";

/**
 * Registers all global action restriction command handlers with the bot.
 * Provides commands to manage restrictions that affect all users.
 *
 * Commands registered:
 * - /viewactions - View all global restrictions
 * - /addaction - Add a global restriction
 * - /removeaction - Remove a global restriction
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * ```typescript
 * const bot = new Telegraf(token);
 * registerActionHandlers(bot);
 * ```
 */
export const registerActionHandlers = (bot: Telegraf<Context>) => {
	/**
	 * Command handler for /viewactions.
	 * Displays all currently active global restrictions.
	 *
	 * Permission: All users can view
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /viewactions
	 */
	bot.command("viewactions", async (ctx) => {
		try {
			const actions = query<GlobalAction>(
				`SELECT id, restriction, restricted_action AS restrictedAction, metadata,
				 restricted_until AS restrictedUntil, created_at AS createdAt
				 FROM global_restrictions`,
			);
			if (actions.length === 0) {
				return ctx.reply("No restricted actions found.");
			}

			const message = actions
				.map(
					(action) =>
						`Type: ${action.restriction}, Action: ${action.restrictedAction || "N/A"}`,
				)
				.join("\n");
			await ctx.reply(`Restricted Actions:\n${message}`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId: ctx.from?.id,
				operation: "view_actions",
			});
			await ctx.reply("An error occurred while fetching actions.");
		}
	});

	/**
	 * Command handler for /addaction.
	 * Adds a new global restriction that applies to all users.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /addaction <restriction> [restrictedAction]
	 * Example: /addaction no_stickers offensive_pack
	 * Example: /addaction no_urls
	 */
	bot.command("addaction", adminOrHigher, async (ctx) => {
		const ownerId = ctx.from?.id;
		const [restriction, restrictedAction] =
			ctx.message?.text.split(" ").slice(1) || [];

		if (!restriction) {
			return ctx.reply("Usage: /addaction <restriction> [restrictedAction]");
		}

		try {
			execute(
				"INSERT INTO global_restrictions (restriction, restricted_action) VALUES (?, ?)",
				[restriction, restrictedAction || null],
			);
			StructuredLogger.logSecurityEvent("Global action restriction added", {
				userId: ownerId,
				operation: "add_global_action",
				restriction,
				restrictedAction,
			});
			await ctx.reply(`Action '${restriction}' has been added.`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId: ownerId,
				operation: "add_global_action",
				restriction,
			});
			await ctx.reply("An error occurred while adding the action.");
		}
	});

	/**
	 * Command handler for /removeaction.
	 * Removes a global restriction from all users.
	 *
	 * Permission: Admin or higher
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /removeaction <restriction>
	 * Example: /removeaction no_stickers
	 */
	bot.command("removeaction", adminOrHigher, async (ctx) => {
		const ownerId = ctx.from?.id;
		const [restriction] = ctx.message?.text.split(" ").slice(1) || [];

		if (!restriction) {
			return ctx.reply("Usage: /removeaction <restriction>");
		}

		try {
			execute("DELETE FROM global_restrictions WHERE restriction = ?", [
				restriction,
			]);
			StructuredLogger.logSecurityEvent("Global action restriction removed", {
				userId: ownerId,
				operation: "remove_global_action",
				restriction,
			});
			await ctx.reply(`Action '${restriction}' has been removed.`);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId: ownerId,
				operation: "remove_global_action",
				restriction,
			});
			await ctx.reply("An error occurred while removing the action.");
		}
	});
};
