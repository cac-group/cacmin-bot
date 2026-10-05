/**
 * Violation tracking and management handlers for the CAC Admin Bot.
 * Tracks user violations, displays violation history, and manages bail payments.
 * Violations can be tracked with associated bail amounts payable in JUNO tokens.
 *
 * @module handlers/violations
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { query } from "../database";
import type { Violation } from "../types";
import { StructuredLogger } from "../utils/logger";

/**
 * Registers all violation management command handlers with the bot.
 * Provides commands for users to view their violations and payment status.
 *
 * Commands registered:
 * - /violations - View user's violation history and payment status
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * ```typescript
 * const bot = new Telegraf(token);
 * registerViolationHandlers(bot);
 * ```
 */
export const registerViolationHandlers = (bot: Telegraf<Context>) => {
	/**
	 * Command handler for /violations.
	 * Displays the user's violation history with bail amounts and payment status.
	 * Users can see their own violations and any outstanding fines.
	 *
	 * Permission: All users (can only view their own violations)
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /violations
	 */
	bot.command("violations", async (ctx) => {
		const userId = ctx.from?.id;

		if (!userId) {
			return ctx.reply("Could not determine your user ID.");
		}

		try {
			const violations = query<Violation>(
				`SELECT id, restriction, message, timestamp
				 FROM violations WHERE user_id = ?`,
				[userId],
			);

			if (violations.length === 0) {
				return ctx.reply("You have no violations!");
			}

			const parts = [bold("Your Violations"), ""];

			for (const v of violations) {
				parts.push(`#${v.id} - ${v.restriction}`);
				if (v.message) {
					parts.push(`Message: ${code(v.message.substring(0, 50))}`);
				}
				parts.push("");
			}

			parts.push(
				"Violations are warning history. A jail's bail is the only amount owed; use /paybail.",
			);
			await ctx.reply(fmt([parts.join("\n")]));

			StructuredLogger.logUserAction("Violations queried", {
				userId,
				operation: "view_violations",
				totalViolations: violations.length.toString(),
			});
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId,
				operation: "view_violations",
			});
			await ctx.reply("An error occurred while fetching your violations.");
		}
	});
};
