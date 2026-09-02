/**
 * Help command handler for the CAC Admin Bot.
 * Provides a role-based, keyboard-navigated command reference accessible via DM.
 *
 * Navigation is driven by `helpTree`: categories, subcategories, and leaf
 * sections. Each node declares the roles that may view it, so sensitive
 * topics and functions are hidden from lower-tier users.
 *
 * @module commands/help
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, type FmtString, fmt } from "telegraf/format";
import type {
	InlineKeyboardButton,
	InlineKeyboardMarkup,
} from "telegraf/types";
import { get } from "../database";
import { ensureUserExists } from "../services/userService";
import type { User } from "../types";
import { logger } from "../utils/logger";
import {
	canAccessHelpNode,
	findHelpNode,
	type HelpNode,
	type HelpRole,
	helpTree,
	parentHelpKey,
} from "./helpTree";

/**
 * Registers the help command with the bot.
 *
 * The help command displays a keyboard-based, role-filtered command reference
 * organized into categories and subcategories. DM only.
 *
 * @param bot - Telegraf bot instance
 */
export function registerHelpCommand(bot: Telegraf<Context>): void {
	bot.command("help", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		// Only allow help command in DMs (private chats)
		if (ctx.chat?.type !== "private") {
			const botInfo = await ctx.telegram.getMe();
			return ctx.reply(
				`The /help command is only available via direct message. Please DM me @${botInfo.username}`,
			);
		}

		try {
			// Ensure user exists in database
			ensureUserExists(userId, ctx.from?.username || "unknown");

			const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
			const role = (user?.role || "pleb") as HelpRole;

			// Create help menu with inline keyboard
			const keyboard: InlineKeyboardMarkup = buildHelpMenu(role);

			await ctx.reply(
				fmt`${bold("CAC Admin Bot")}\n\nRole: ${code(role)}\n\nSelect a category to view commands:`,
				{
					reply_markup: keyboard,
				},
			);
		} catch (error) {
			logger.error("Error in help command", { userId, error });
			await ctx.reply("Error loading help");
		}
	});

	// Handle back to menu - Register BEFORE the navigation regex to prevent matching
	bot.action("help_menu", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
			const role = (user?.role || "pleb") as HelpRole;

			const keyboard: InlineKeyboardMarkup = buildHelpMenu(role);

			await ctx.editMessageText(
				fmt`${bold("CAC Admin Bot")}\n\nRole: ${code(role)}\n\nSelect a category to view commands:`,
				{
					reply_markup: keyboard,
				},
			);
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error("Error returning to help menu", { userId, error });
			await ctx.answerCbQuery("Error loading menu");
		}
	});

	// Handle category and section navigation (e.g. "wallet", "wallet:account")
	bot.action(/^help:[a-z0-9:_-]+$/, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;
		const key = ctx.match[0].slice("help:".length);

		try {
			const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
			const role = (user?.role || "pleb") as HelpRole;

			const node = findHelpNode(helpTree, key);
			if (!node || !canAccessHelpNode(node, role)) {
				await ctx.answerCbQuery("Not available for your role");
				return;
			}

			await renderHelpNode(ctx, node, role);
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error("Error in help navigation", { userId, key, error });
			await ctx.answerCbQuery("Error loading help section");
		}
	});
}

/** Build the root menu keyboard from the role-filtered top-level nodes. */
function buildHelpMenu(role: HelpRole): InlineKeyboardMarkup {
	const visible = helpTree.filter((node) => canAccessHelpNode(node, role));
	return {
		inline_keyboard: buildButtonRows(visible, role),
	};
}

/** Render a node: a submenu when it has children, otherwise its leaf content. */
async function renderHelpNode(
	ctx: Context,
	node: HelpNode,
	role: HelpRole,
): Promise<void> {
	if (node.children && node.children.length > 0) {
		const keyboard: InlineKeyboardMarkup = {
			inline_keyboard: [
				...buildButtonRows(node.children, role),
				[backButton(node.key)],
			],
		};
		await ctx.editMessageText(
			fmt`${bold(node.title)}\n\nSelect a section to view commands:`,
			{ reply_markup: keyboard },
		);
	} else {
		const keyboard: InlineKeyboardMarkup = {
			inline_keyboard: [[backButton(node.key)]],
		};
		await ctx.editMessageText(node.content as FmtString, {
			reply_markup: keyboard,
		});
	}
}

/** Layout child buttons two per row, filtered by role. */
function buildButtonRows(
	nodes: readonly HelpNode[],
	role: HelpRole,
): InlineKeyboardButton[][] {
	const visible = nodes.filter((node) => canAccessHelpNode(node, role));
	const rows: InlineKeyboardButton[][] = [];
	for (let i = 0; i < visible.length; i += 2) {
		rows.push(
			visible.slice(i, i + 2).map((node) => ({
				text: node.title,
				callback_data: `help:${node.key}`,
			})),
		);
	}
	return rows;
}

/** Back button that returns to the parent menu, or the root menu at the top. */
function backButton(key: string): InlineKeyboardButton {
	const parent = parentHelpKey(key);
	return {
		text: "<- Back",
		callback_data: parent ? `help:${parent}` : "help_menu",
	};
}
