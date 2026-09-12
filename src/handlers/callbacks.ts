/**
 * Callback query handlers for inline keyboard interactions.
 * Processes button presses from inline keyboards throughout the bot.
 *
 * @module handlers/callbacks
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, type FmtString, fmt } from "telegraf/format";
import type { CallbackQuery, InlineKeyboardMarkup } from "telegraf/types";
import { execute, get } from "../database";
import { DEFAULT_JAIL_BAIL_AMOUNT, JailService } from "../services/jailService";
import { LedgerService } from "../services/ledgerService";
import {
	getGiveawayEscrowId,
	SYSTEM_USER_IDS,
} from "../services/unifiedWalletService";
import {
	addUserRestriction,
	getUserById,
	setUserRole,
} from "../services/userService";
import {
	autoJailKeyboard,
	giveawayClaimKeyboard,
	listActionKeyboard,
	mainMenuKeyboard,
	noKeyboard,
	roleKeyboard,
	severityKeyboard,
} from "../utils/keyboards";
import { logger, StructuredLogger } from "../utils/logger";
import {
	cleanupMenuByMessage,
	editMenu,
	getMenuSessionByMessage,
	type MenuRef,
	menuRefFromContext,
	validateMenuInteraction,
} from "../utils/menuSession";
import { AmountPrecision } from "../utils/precision";
import { normalizeRandomDeleteChance } from "../utils/randomDelete";
import { isAdmin, isImmuneToModeration, isOwner } from "../utils/roles";
import { formatUserIdDisplay, resolveUserId } from "../utils/userResolver";
import { addPattern, type SpamReactField } from "./spamReacts";

interface Giveaway {
	id: number;
	created_by: number;
	funded_by: number;
	total_amount: number; // Stored as micro-units in DB
	amount_per_slot: number; // Stored as micro-units in DB
	total_slots: number;
	claimed_slots: number;
	chat_id: number;
	message_id: number | null;
	status: "active" | "completed" | "cancelled";
}

/** Convert giveaway DB row (micro-units) to JUNO amounts */
function giveawayFromDb(row: Giveaway): Giveaway {
	return {
		...row,
		total_amount: AmountPrecision.fromDbMicro(row.total_amount),
		amount_per_slot: AmountPrecision.fromDbMicro(row.amount_per_slot),
	};
}

// Store for tracking multi-step interactions
export interface SessionData {
	action: string;
	step: number;
	data: Record<string, any>;
	timestamp: number;
}

const sessions = new Map<number, SessionData>();

// Session timeout: 5 minutes
const SESSION_TIMEOUT = 5 * 60 * 1000;

/**
 * Get or create a session for a user
 */
export function getSession(userId: number): SessionData | null {
	const session = sessions.get(userId);
	if (!session) return null;

	// Check if session expired
	if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
		sessions.delete(userId);
		return null;
	}

	return session;
}

/**
 * Set session data for a user
 */
export function setSession(
	userId: number,
	action: string,
	step: number,
	data: Record<string, any>,
): void {
	sessions.set(userId, {
		action,
		step,
		data,
		timestamp: Date.now(),
	});
}

/**
 * Clear session for a user
 */
export function clearSession(userId: number): void {
	sessions.delete(userId);
}

/**
 * Attach the originating menu message to new session data so later steps can
 * render into it instead of sending follow-up messages.
 */
function withMenuRef(
	ctx: Context,
	data: Record<string, any> = {},
): Record<string, any> {
	const ref = menuRefFromContext(ctx);
	if (ref) data.menuRef = ref;
	return data;
}

/**
 * Render a terminal result into the flow's originating menu message,
 * falling back to a reply if there was no menu (e.g. a text-initiated step).
 */
async function finishMenu(
	ctx: Context,
	session: SessionData | null,
	text: string | FmtString,
): Promise<void> {
	await editMenu(ctx, session?.data?.menuRef as MenuRef | undefined, text);
}

/**
 * Verify user still has admin or owner role. Used in session handlers since a
 * role could change between session creation and execution. Mirrors the
 * `adminOrHigher` middleware used by the originating commands.
 */
function verifyAdminRole(userId: number): boolean {
	return isAdmin(userId) || isOwner(userId);
}

/** Verify user still has owner role (owner-only interactive flows). */
function verifyOwner(userId: number): boolean {
	return isOwner(userId);
}

/**
 * Callback handler type for dispatch table
 */
type CallbackHandler = (
	ctx: Context,
	data: string,
	userId: number,
) => Promise<void>;

/**
 * Dispatch table mapping callback prefixes to their handlers.
 * Order matters - more specific prefixes should come before general ones.
 */
const callbackHandlers: Array<{ prefix: string; handler: CallbackHandler }> = [
	{ prefix: "restrict_", handler: handleRestrictionCallback },
	{ prefix: "severity_", handler: handleSeverityCallback },
	{ prefix: "autojail_", handler: handleAutoJailCallback },
	{ prefix: "jail_", handler: handleJailCallback },
	{ prefix: "giveaway_fund_", handler: handleGiveawayFundCallback },
	{ prefix: "giveaway_create_", handler: handleGiveawayCreateCallback },
	{ prefix: "claim_giveaway_", handler: handleGiveawayClaimCallback },
	{ prefix: "action_", handler: handleGlobalActionCallback },
	{ prefix: "role_", handler: handleRoleCallback },
	{ prefix: "list_", handler: handleListCallback },
	{ prefix: "menu_", handler: handleMenuCallback },
	{ prefix: "spamfield_", handler: handleSpamFieldCallback },
];

/**
 * Registers all callback query handlers with the bot
 */
export function registerCallbackHandlers(bot: Telegraf<Context>): void {
	/**
	 * Handle all callback queries
	 */
	// Interactive main menu (DM only), the entry point for menu_* callbacks.
	bot.command("menu", async (ctx) => {
		if (ctx.chat?.type !== "private") {
			return ctx.reply("Use /menu in a direct message with me.");
		}
		await ctx.reply(
			fmt`${bold("CAC Admin Bot")}\n\nSelect a category to view commands:`,
			{ reply_markup: mainMenuKeyboard },
		);
	});

	bot.on("callback_query", async (ctx) => {
		const callbackQuery = ctx.callbackQuery as CallbackQuery.DataQuery;
		const data = callbackQuery.data;
		const userId = ctx.from?.id;

		if (!userId) return;

		try {
			const chatId = ctx.chat?.id;
			const messageId = ctx.callbackQuery?.message?.message_id;

			// Handle special cases first
			if (data === "cancel") {
				// Check if this message has a menu session
				if (chatId && messageId) {
					const menuSession = getMenuSessionByMessage(chatId, messageId);
					if (menuSession && menuSession.userId !== userId) {
						await ctx
							.answerCbQuery("Only the person who started this can cancel it.")
							.catch(() => {});
						return;
					}
					cleanupMenuByMessage(chatId, messageId);
				}
				clearSession(userId);
				await ctx.answerCbQuery().catch(() => {});
				await ctx
					.editMessageText("Action cancelled.", { reply_markup: noKeyboard })
					.catch(() => {});
				return;
			}

			if (data === "noop") {
				await ctx.answerCbQuery().catch(() => {});
				return;
			}

			// Route using dispatch table. Handlers may answer with a toast;
			// if they don't, the finally block dismisses the loading state.
			for (const { prefix, handler } of callbackHandlers) {
				if (data.startsWith(prefix)) {
					try {
						await handler(ctx, data, userId);
					} finally {
						await ctx.answerCbQuery().catch(() => {});
					}
					return;
				}
			}
			await ctx.answerCbQuery().catch(() => {});
		} catch (error) {
			logger.error("Error handling callback query", { userId, data, error });
			await ctx.answerCbQuery().catch(() => {});
		}
	});
}

/**
 * Handle restriction type selection
 */
async function handleRestrictionCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const restrictionType = data.replace("restrict_", "");

	// Store the restriction type in session
	setSession(
		userId,
		"add_restriction",
		1,
		withMenuRef(ctx, { restrictionType }),
	);

	await ctx.editMessageText(
		fmt`${bold(`Add Restriction: ${restrictionType}`)}

Please reply with the user ID or @username to restrict.

Format: ${code("userId")} or ${code("@username")}`,
		{ reply_markup: noKeyboard },
	);
}

/**
 * Handles severity level selection in the interactive restriction flow.
 * This is step 2 of the restriction creation process (after target user is selected).
 *
 * Severity levels determine how violations are handled:
 * - "delete": Just delete the violating message (default)
 * - "mute": Apply a 30-minute mute on each violation
 * - "jail": Immediate 1-hour jail with 5 JUNO fine
 *
 * After severity selection, prompts user for auto-jail settings.
 *
 * @param ctx - Telegraf callback query context
 * @param data - Callback data in format "severity_<level>"
 * @param userId - ID of the user who clicked the button
 */
async function handleSeverityCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const session = getSession(userId);
	if (!session || session.action !== "add_restriction" || session.step !== 2) {
		await ctx.editMessageText("Session expired. Please start over.", {
			reply_markup: noKeyboard,
		});
		return;
	}

	// Verify user still has admin privileges
	if (!verifyAdminRole(userId)) {
		await ctx.editMessageText(
			"Your admin privileges have been revoked. Action cancelled.",
			{ reply_markup: noKeyboard },
		);
		clearSession(userId);
		return;
	}

	const severity = data.replace("severity_", "") as "delete" | "mute" | "jail";
	session.data.severity = severity;
	setSession(userId, "add_restriction", 3, session.data);

	const { restrictionType, targetId } = session.data;
	const targetDisplay = formatUserIdDisplay(targetId);

	await ctx.editMessageText(
		fmt`${bold(`Restriction: ${restrictionType}`)}
Target: ${targetDisplay}
Severity: ${severity}

${bold("Select auto-jail settings:")}
(Auto-jail triggers after repeated violations within 60 minutes)

• ${bold("Default")} - Jail after 5 violations (2 days, 10 JUNO fine)
• ${bold("Strict")} - Jail after 3 violations (3 days, 15 JUNO fine)
• ${bold("Lenient")} - Jail after 10 violations (1 day, 5 JUNO fine)
• ${bold("Disabled")} - No automatic jailing`,
		{
			reply_markup: autoJailKeyboard,
		},
	);
}

/**
 * Applies a restriction to a user and sends confirmation.
 * Shared by the auto-jail callback (non-regex) and the regex pattern text handler.
 */
async function applyRestriction(
	ctx: Context,
	session: SessionData | null,
	adminId: number,
	targetId: number,
	restrictionType: string,
	action: string | undefined,
	severity: "delete" | "mute" | "jail",
	autoJailSetting: string,
	threshold: number,
	jailDuration: number,
	jailFine: number,
): Promise<void> {
	addUserRestriction(
		targetId,
		restrictionType,
		action,
		undefined,
		undefined,
		severity,
		threshold,
		jailDuration,
		jailFine,
	);

	StructuredLogger.logSecurityEvent("Restriction added via interactive flow", {
		adminId,
		userId: targetId,
		operation: "add_restriction",
		restriction: restrictionType,
		action,
		severity,
		autoJailSetting,
		threshold,
		jailDuration,
		jailFine,
	});

	const targetDisplay = formatUserIdDisplay(targetId);
	const autoJailText =
		autoJailSetting === "disabled"
			? "Auto-jail: Disabled"
			: `Auto-jail: After ${threshold} violations (${Math.round(jailDuration / 1440)} day(s), ${jailFine.toFixed(1)} JUNO fine)`;
	const actionText = action
		? restrictionType === "regex_block"
			? fmt`Pattern: ${code(action)}`
			: restrictionType === "random_delete"
				? fmt`Chance: ${code(action)}`
				: fmt`Action: ${code(action)}`
		: null;

	await finishMenu(
		ctx,
		session,
		fmt`${bold("Restriction Applied")}

Type: ${restrictionType}
Target: ${targetDisplay}
${actionText || ""}
Severity: ${severity}
${autoJailText}

Use ${code(`/listrestrictions ${targetId}`)} to view all restrictions.`,
	);

	clearSession(adminId);
}

/**
 * Handles auto-jail settings selection and applies the restriction.
 * This is the final step (step 3) of the interactive restriction creation flow.
 *
 * Auto-jail settings determine when repeated violations trigger automatic jailing:
 * - "default": 5 violations in 60 min -> 2 day jail, 10 JUNO fine
 * - "strict": 3 violations in 60 min -> 3 day jail, 15 JUNO fine
 * - "lenient": 10 violations in 60 min -> 1 day jail, 5 JUNO fine
 * - "disabled": No automatic jailing (threshold set to 999999)
 *
 * After selection, the restriction is applied to the target user with all
 * configured options (type, severity, auto-jail settings).
 *
 * @param ctx - Telegraf callback query context
 * @param data - Callback data in format "autojail_<setting>"
 * @param userId - ID of the user who clicked the button
 */
async function handleAutoJailCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const session = getSession(userId);
	if (!session || session.action !== "add_restriction" || session.step !== 3) {
		await ctx.editMessageText("Session expired. Please start over.", {
			reply_markup: noKeyboard,
		});
		return;
	}

	// Verify user still has admin privileges
	if (!verifyAdminRole(userId)) {
		await ctx.editMessageText(
			"Your admin privileges have been revoked. Action cancelled.",
			{ reply_markup: noKeyboard },
		);
		clearSession(userId);
		return;
	}

	const autoJailSetting = data.replace("autojail_", "");
	const { restrictionType, targetId, severity } = session.data;

	// Configure auto-jail parameters based on selection
	let threshold: number;
	let jailDuration: number;
	let jailFine: number;

	switch (autoJailSetting) {
		case "strict":
			threshold = 3;
			jailDuration = 4320; // 3 days
			jailFine = 15.0;
			break;
		case "lenient":
			threshold = 10;
			jailDuration = 1440; // 1 day
			jailFine = 5.0;
			break;
		case "disabled":
			threshold = 999999; // Effectively disabled
			jailDuration = 0;
			jailFine = 0;
			break;
		default:
			threshold = 5;
			jailDuration = 2880; // 2 days
			jailFine = 10.0;
			break;
	}

	// Some restriction types need extra input before they can be applied.
	if (
		restrictionType === "regex_block" ||
		restrictionType === "random_delete" ||
		restrictionType === "no_specific_gif"
	) {
		session.data.threshold = threshold;
		session.data.jailDuration = jailDuration;
		session.data.jailFine = jailFine;
		session.data.autoJailSetting = autoJailSetting;
		setSession(userId, "add_restriction", 4, session.data);

		if (restrictionType === "regex_block") {
			await ctx.editMessageText(
				fmt`${bold("Regex Block Pattern")}

Reply with the pattern to block. Examples:
${code('"fa99ot"')} - simple text match
${code('"spam*here"')} - wildcard match
${code("/\\b(word1|word2)\\b/i")} - regex pattern

Multiple words can be combined with | in regex:
${code("/\\b(fa99ot|fa990t)\\b/i")}`,
				{ reply_markup: noKeyboard },
			);
			return;
		}

		if (restrictionType === "no_specific_gif") {
			await ctx.editMessageText(
				fmt`${bold("Specific GIF Block")}

Reply with the GIF file\\_unique\\_id to block.

Get it by replying to the target GIF with ${code("/getgifid")}.

If you want to block ALL GIFs instead, use ${code("no_gifs")}.`,
				{ reply_markup: noKeyboard },
			);
			return;
		}

		await ctx.editMessageText(
			fmt`${bold("Random Delete Chance")}

Reply with the delete chance for longer text messages.

Accepted formats:
${code("10%")} - ten percent chance
${code("25")} - twenty-five percent chance
${code("0.1")} - ten percent chance
${code("default")} - use the standard ${code("10%")} chance`,
			{ reply_markup: noKeyboard },
		);
		return;
	}

	// Apply the restriction (non-regex types)
	await applyRestriction(
		ctx,
		session,
		userId,
		targetId,
		restrictionType,
		undefined,
		severity,
		autoJailSetting,
		threshold,
		jailDuration,
		jailFine,
	);
}

/**
 * Handle jail duration selection
 */
async function handleJailCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	if (!verifyAdminRole(userId)) {
		await ctx.editMessageText("You need admin permissions for that action.", {
			reply_markup: noKeyboard,
		});
		return;
	}

	if (data === "jail_custom") {
		setSession(userId, "jail", 1, withMenuRef(ctx, {}));
		await ctx.editMessageText(
			fmt`${bold("Custom Jail Duration")}

Please reply with:
1. User ID or @username
2. Duration in minutes

Format: ${code("@username 45")} or ${code("123456 30")}`,
			{ reply_markup: noKeyboard },
		);
		return;
	}

	const minutes = parseInt(data.replace("jail_", ""), 10);
	setSession(userId, "jail", 1, withMenuRef(ctx, { minutes }));

	await ctx.editMessageText(
		fmt`${bold(`Jail User for ${minutes} minutes`)}

Please reply with the user ID or @username to jail.

Format: ${code("userId")} or ${code("@username")}`,
		{ reply_markup: noKeyboard },
	);
}

/**
 * Handle global action selection (/addaction interactive).
 */
async function handleGlobalActionCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const actionType = data.replace("action_", "");

	setSession(userId, "add_global_action", 1, withMenuRef(ctx, { actionType }));

	await ctx.editMessageText(
		fmt`${bold(`Add Global Action: ${actionType}`)}

This will restrict ALL users from: ${actionType}

Optionally, reply with a specific action to restrict (e.g., specific sticker pack name, domain, etc.)
Or type "apply" to apply globally.`,
		{ reply_markup: noKeyboard },
	);
}

/**
 * Handle role assignment selection. Per-action permissions mirror the
 * dedicated commands: admins may elevate/revoke, only owners may make admins.
 */
async function handleRoleCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const roleAction = data.replace("role_", "");

	if (roleAction === "admin" && !isOwner(userId)) {
		await ctx.editMessageText("Only owners can promote admins.", {
			reply_markup: noKeyboard,
		});
		return;
	}
	if (
		(roleAction === "elevated" || roleAction === "revoke") &&
		!(isAdmin(userId) || isOwner(userId))
	) {
		await ctx.editMessageText("You need admin permissions for that action.", {
			reply_markup: noKeyboard,
		});
		return;
	}

	let message = "";
	if (roleAction === "admin") {
		message = `${bold("Make Admin")}

Please reply with the user ID or @username to promote to admin.`;
	} else if (roleAction === "elevated") {
		message = `${bold("Elevate User")}

Please reply with the user ID or @username to elevate.`;
	} else if (roleAction === "revoke") {
		message = `${bold("Revoke Role")}

Please reply with the user ID or @username to demote.`;
	} else {
		await ctx.editMessageText("Unknown role action.", {
			reply_markup: noKeyboard,
		});
		return;
	}

	setSession(userId, `role_${roleAction}`, 1, withMenuRef(ctx, {}));

	await ctx.editMessageText(
		fmt`${message}

Format: ${code("@username")} or ${code("userId")}`,
		{ reply_markup: noKeyboard },
	);
}

/**
 * Handle list management callback. Requires admin or owner.
 */
async function handleListCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	if (!(isAdmin(userId) || isOwner(userId))) {
		await ctx.editMessageText("You need admin permissions for that action.", {
			reply_markup: noKeyboard,
		});
		return;
	}

	const action = data.replace("list_", "");

	if (action === "view_white" || action === "view_black") {
		// Import and call view functions directly
		const { query } = await import("../database");
		const listType = action === "view_white" ? "whitelist" : "blacklist";
		const column = action === "view_white" ? "whitelist" : "blacklist";

		type User = { id: number; username?: string };
		const users = query<User>(
			`SELECT id, username FROM users WHERE ${column} = 1`,
		);

		if (users.length === 0) {
			await ctx.editMessageText(`The ${listType} is empty.`, {
				reply_markup: noKeyboard,
			});
			return;
		}

		const message = users
			.map(
				(u) => `- ${u.username ? `@${u.username}` : `User ${u.id}`} (${u.id})`,
			)
			.join("\n");
		await ctx.editMessageText(
			fmt`${bold(`${listType.charAt(0).toUpperCase() + listType.slice(1)}:`)}

${message}`,
			{ reply_markup: noKeyboard },
		);
		return;
	}

	setSession(userId, `list_${action}`, 1, withMenuRef(ctx, {}));

	await ctx.editMessageText(
		fmt`${bold("List Management")}

Action: ${action}

Please reply with the user ID or @username.

Format: ${code("@username")} or ${code("userId")}`,
		{ reply_markup: noKeyboard },
	);
}

/**
 * Menu content map for main menu navigation
 * Uses Telegraf's Format module for formatting
 */
const menuContent: Record<string, ReturnType<typeof fmt>> = {
	wallet: fmt`${bold("Wallet Commands")}

/balance - Check balance
/deposit - Get deposit instructions
/withdraw - Withdraw funds
/send - Send funds
/transactions - View history`,
	shared: fmt`${bold("Shared Account Commands")}

/myshared - View your shared accounts
/createshared - Create new shared account
/sharedbalance - Check shared balance`,
	moderation: fmt`${bold("Moderation Commands")}

/jail - Jail user
/unjail - Release user
/warn - Issue warning
/addrestriction - Add restriction`,
	lists: fmt`${bold("List Management")}

/viewwhitelist - View whitelist
/viewblacklist - View blacklist
/addwhitelist - Add to whitelist
/addblacklist - Add to blacklist`,
	roles: fmt`${bold("Role Management")}

/makeadmin - Promote to admin
/elevate - Elevate user
/revoke - Revoke privileges
/listadmins - List all admins`,
	stats: fmt`${bold("Statistics")}

/stats - Bot statistics
/jailstats - Jail statistics
/walletstats - Wallet statistics`,
	help: fmt`${bold("Help")}

Use /help in a DM for comprehensive command reference.`,
};

const mainMenuText = fmt`${bold("CAC Admin Bot")}

Select a category to view commands:`;

/** Append a back-to-menu row to a management keyboard. */
function withMenuBack(keyboard: InlineKeyboardMarkup): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			...keyboard.inline_keyboard,
			[{ text: "<- Back", callback_data: "menu_home" }],
		],
	};
}

/**
 * Handle main menu navigation. Lists and Roles open their management
 * keyboards (admin/owner only); every management keyboard has a Back button.
 */
async function handleMenuCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const menuItem = data.replace("menu_", "");

	if (menuItem === "home" || menuItem === "back") {
		await ctx.editMessageText(mainMenuText, { reply_markup: mainMenuKeyboard });
		return;
	}

	if (menuItem === "roles" || menuItem === "lists") {
		if (!(isAdmin(userId) || isOwner(userId))) {
			await ctx.editMessageText("You need admin permissions for that.", {
				reply_markup: mainMenuKeyboard,
			});
			return;
		}
		const keyboard = menuItem === "roles" ? roleKeyboard : listActionKeyboard;
		await ctx.editMessageText(menuContent[menuItem], {
			reply_markup: withMenuBack(keyboard),
		});
		return;
	}

	const message = menuContent[menuItem];
	if (message) {
		await ctx.editMessageText(message, {
			reply_markup: mainMenuKeyboard,
		});
	}
}

/**
 * Handle funding source selection for admin giveaways
 * Format: giveaway_fund_<amount>_<source>
 * Shows slot selection after funding source is chosen
 */
async function handleGiveawayFundCallback(
	ctx: Context,
	data: string,
	_userId: number,
): Promise<void> {
	// Validate menu ownership and expiry
	const validationError = await validateMenuInteraction(ctx, "giveaway_setup");
	if (validationError) {
		await ctx.answerCbQuery(validationError);
		return;
	}

	// Parse: giveaway_fund_100_self or giveaway_fund_100_treasury
	const parts = data.replace("giveaway_fund_", "").split("_");
	if (parts.length !== 2) {
		await ctx.editMessageText("Invalid giveaway data.");
		return;
	}

	const totalAmount = parseFloat(parts[0]);
	const fundingSource = parts[1]; // "self" or "treasury"

	if (Number.isNaN(totalAmount)) {
		await ctx.editMessageText("Invalid giveaway parameters.");
		return;
	}

	const slotInfo = [10, 25, 50, 100]
		.map((s) => `- ${s} slots = ${(totalAmount / s).toFixed(6)} JUNO each`)
		.join("\n");

	const sourceLabel =
		fundingSource === "treasury" ? "Treasury" : "Your Balance";

	await ctx.editMessageText(
		fmt`${bold(`Create Giveaway: ${totalAmount} JUNO`)}

Funding from: ${sourceLabel}

Select number of slots:
${slotInfo}`,
		{
			reply_markup: {
				inline_keyboard: [
					[
						{
							text: "10 slots",
							callback_data: `giveaway_create_${totalAmount}_10_${fundingSource}`,
						},
						{
							text: "25 slots",
							callback_data: `giveaway_create_${totalAmount}_25_${fundingSource}`,
						},
					],
					[
						{
							text: "50 slots",
							callback_data: `giveaway_create_${totalAmount}_50_${fundingSource}`,
						},
						{
							text: "100 slots",
							callback_data: `giveaway_create_${totalAmount}_100_${fundingSource}`,
						},
					],
					[{ text: "Cancel", callback_data: "cancel" }],
				],
			},
		},
	);
}

/**
 * Handle giveaway creation (slot count selection)
 * Format: giveaway_create_<amount>_<slots>_<source>
 *
 * IMPORTANT: This function debits funds IMMEDIATELY from the funder.
 * Funds are held in the giveaway until claimed or cancelled.
 */
async function handleGiveawayCreateCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	// Validate menu ownership and expiry
	const validationError = await validateMenuInteraction(ctx, "giveaway_setup");
	if (validationError) {
		await ctx.answerCbQuery(validationError);
		return;
	}

	const chatId = ctx.chat?.id;
	const messageId = ctx.callbackQuery?.message?.message_id;

	// Clean up the menu session since we're proceeding
	if (chatId && messageId) {
		cleanupMenuByMessage(chatId, messageId);
	}

	// Parse: giveaway_create_100_10_self -> amount=100, slots=10, source=self
	const parts = data.replace("giveaway_create_", "").split("_");
	if (parts.length !== 3) {
		await ctx.editMessageText("Invalid giveaway data.");
		return;
	}

	const totalAmount = parseFloat(parts[0]);
	const totalSlots = parseInt(parts[1], 10);
	const fundingSource = parts[2]; // "self" or "treasury"

	if (Number.isNaN(totalAmount) || Number.isNaN(totalSlots)) {
		await ctx.editMessageText("Invalid giveaway parameters.");
		return;
	}

	const amountPerSlot = AmountPrecision.toExact6Decimals(
		totalAmount / totalSlots,
	);

	if (!chatId) {
		await ctx.editMessageText("Cannot create giveaway: no chat context.");
		return;
	}

	// Determine who pays for this giveaway
	const fundedBy =
		fundingSource === "treasury" ? SYSTEM_USER_IDS.BOT_TREASURY : userId;

	try {
		// STEP 1: Verify balance AGAIN (could have changed since command)
		const currentBalance = await LedgerService.getUserBalance(fundedBy);
		if (currentBalance < totalAmount) {
			const source =
				fundedBy === SYSTEM_USER_IDS.BOT_TREASURY ? "Treasury" : "Your balance";
			await ctx.editMessageText(
				`Insufficient funds.\n${source}: ${currentBalance.toFixed(6)} JUNO\nRequired: ${totalAmount.toFixed(6)} JUNO`,
			);
			return;
		}

		// STEP 2: Create giveaway record FIRST to get the ID
		// Store amounts in micro-units (integer) for exact precision
		const totalAmountMicro = AmountPrecision.toDbMicro(totalAmount);
		const amountPerSlotMicro = AmountPrecision.toDbMicro(amountPerSlot);
		const result = execute(
			`INSERT INTO giveaways (created_by, funded_by, total_amount, amount_per_slot, total_slots, claimed_slots, chat_id, status)
			 VALUES (?, ?, ?, ?, ?, 0, ?, 'active')`,
			[
				userId,
				fundedBy,
				totalAmountMicro,
				amountPerSlotMicro,
				totalSlots,
				chatId,
			],
		);
		const giveawayId = result.lastInsertRowid as number;

		// STEP 3: Create dedicated escrow account for this giveaway
		const escrowId = getGiveawayEscrowId(giveawayId);
		const { createUser, userExists } = await import("../services/userService");
		if (!userExists(escrowId)) {
			createUser(
				escrowId,
				`GIVEAWAY_ESCROW_${giveawayId}`,
				"system",
				"giveaway",
			);
			await LedgerService.ensureUserBalance(escrowId);
		}

		// STEP 4: Transfer funds to dedicated escrow account
		const debitResult = await LedgerService.transferBetweenUsers(
			fundedBy,
			escrowId,
			totalAmount,
			`Giveaway #${giveawayId} escrow funding`,
		);

		if (!debitResult.success) {
			// Rollback: delete the giveaway record
			execute("DELETE FROM giveaways WHERE id = ?", [giveawayId]);
			await ctx.editMessageText("Failed to reserve funds for giveaway.");
			return;
		}

		const sourceLabel =
			fundedBy === SYSTEM_USER_IDS.BOT_TREASURY ? "Treasury" : "your balance";

		// Edit the original message to show creation confirmation
		await ctx.editMessageText(
			fmt`Giveaway #${giveawayId} created!
Total: ${totalAmount} JUNO (debited from ${sourceLabel})
Slots: ${totalSlots}
Per slot: ${amountPerSlot.toFixed(6)} JUNO`,
			{ reply_markup: noKeyboard },
		);

		// Send the actual giveaway message with claim button
		const giveawayMsg = await ctx.reply(
			fmt`${bold("JUNO Giveaway")}

${amountPerSlot.toFixed(6)} JUNO per claim
Slots: ${totalSlots}/${totalSlots} available

Click below to claim your share!`,
			{
				reply_markup: giveawayClaimKeyboard(giveawayId, 0, totalSlots),
			},
		);

		// Store the message ID for later updates
		execute("UPDATE giveaways SET message_id = ? WHERE id = ?", [
			giveawayMsg.message_id,
			giveawayId,
		]);

		StructuredLogger.logUserAction("Open giveaway created", {
			userId,
			operation: "create_giveaway",
			giveawayId,
			escrowId,
			totalAmount,
			totalSlots,
			amountPerSlot,
			fundedBy,
			fundingSource,
		});
	} catch (error) {
		logger.error("Failed to create giveaway", { userId, error });
		await ctx.editMessageText("Failed to create giveaway. Please try again.");
	}
}

/**
 * Handle giveaway claim button press
 * Format: claim_giveaway_<giveawayId>
 *
 * IMPORTANT: Funds are transferred FROM SYSTEM_RESERVE TO the claimer.
 * The funds were already debited from the funder when the giveaway was created.
 */
async function handleGiveawayClaimCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const giveawayId = parseInt(data.replace("claim_giveaway_", ""), 10);

	if (Number.isNaN(giveawayId)) {
		await ctx.answerCbQuery("Invalid giveaway.");
		return;
	}

	// Fetch giveaway (amounts stored as micro-units, convert to JUNO)
	const giveawayRow = get<Giveaway>(
		"SELECT * FROM giveaways WHERE id = ? AND status = 'active'",
		[giveawayId],
	);

	if (!giveawayRow) {
		await ctx.answerCbQuery("This giveaway has ended.");
		return;
	}
	const giveaway = giveawayFromDb(giveawayRow);

	// Check if user already claimed
	const existingClaim = get<{ id: number }>(
		"SELECT id FROM giveaway_claims WHERE giveaway_id = ? AND user_id = ?",
		[giveawayId, userId],
	);

	if (existingClaim) {
		await ctx.answerCbQuery("You already claimed from this giveaway!");
		return;
	}

	// Check slots available
	if (giveaway.claimed_slots >= giveaway.total_slots) {
		await ctx.answerCbQuery("All slots have been claimed!");
		return;
	}

	try {
		// Ensure user exists in database (create if new)
		const { ensureUserExists } = await import("../services/userService");
		const username = ctx.from?.username || `user_${userId}`;
		ensureUserExists(userId, username);

		// Transfer funds FROM giveaway's escrow account TO the claimer
		const escrowId = getGiveawayEscrowId(giveawayId);
		const result = await LedgerService.transferBetweenUsers(
			escrowId,
			userId,
			giveaway.amount_per_slot,
			`Giveaway #${giveawayId} claim`,
		);

		if (!result.success) {
			await ctx.answerCbQuery("Failed to process claim. Try again.");
			return;
		}

		// Record claim (store amount in micro-units)
		const claimAmountMicro = AmountPrecision.toDbMicro(
			giveaway.amount_per_slot,
		);
		execute(
			"INSERT INTO giveaway_claims (giveaway_id, user_id, amount) VALUES (?, ?, ?)",
			[giveawayId, userId, claimAmountMicro],
		);

		// Update claimed count
		const newClaimedSlots = giveaway.claimed_slots + 1;
		execute("UPDATE giveaways SET claimed_slots = ? WHERE id = ?", [
			newClaimedSlots,
			giveawayId,
		]);

		// Check if giveaway complete
		const isComplete = newClaimedSlots >= giveaway.total_slots;
		if (isComplete) {
			execute(
				"UPDATE giveaways SET status = 'completed', completed_at = ? WHERE id = ?",
				[Math.floor(Date.now() / 1000), giveawayId],
			);
		}

		// Update the giveaway message
		const remaining = giveaway.total_slots - newClaimedSlots;
		try {
			if (isComplete) {
				await ctx.editMessageText(
					fmt`${bold("JUNO Giveaway Complete")}

${giveaway.amount_per_slot.toFixed(6)} JUNO per claim
All ${giveaway.total_slots} slots claimed!

Total distributed: ${giveaway.total_amount.toFixed(6)} JUNO`,
					{
						reply_markup: {
							inline_keyboard: [
								[{ text: "Giveaway Complete", callback_data: "noop" }],
							],
						},
					},
				);
			} else {
				await ctx.editMessageText(
					fmt`${bold("JUNO Giveaway")}

${giveaway.amount_per_slot.toFixed(6)} JUNO per claim
Slots: ${remaining}/${giveaway.total_slots} available

Click below to claim your share!`,
					{
						reply_markup: giveawayClaimKeyboard(
							giveawayId,
							newClaimedSlots,
							giveaway.total_slots,
						),
					},
				);
			}
		} catch (editError) {
			// Message edit might fail if too many edits - that's ok
			logger.warn("Failed to edit giveaway message", { giveawayId, editError });
		}

		await ctx.answerCbQuery(
			`Claimed ${giveaway.amount_per_slot.toFixed(6)} JUNO!`,
		);

		StructuredLogger.logUserAction("Giveaway claimed", {
			userId,
			operation: "claim_giveaway",
			giveawayId,
			amount: giveaway.amount_per_slot.toString(),
			newBalance: result.toBalance,
		});
	} catch (error) {
		logger.error("Failed to process giveaway claim", {
			userId,
			giveawayId,
			error,
		});
		await ctx.answerCbQuery("An error occurred. Please try again.");
	}
}

/**
 * Handle text message replies for active multi-step sessions.
 * Called from bot.ts when a user sends a text message that might be a session reply.
 *
 * @param ctx - Telegraf context
 * @returns true if message was handled, false otherwise
 */
export async function handleSessionText(ctx: Context): Promise<boolean> {
	const userId = ctx.from?.id;
	if (!userId) return false;

	const session = getSession(userId);
	if (!session) return false;

	const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
	if (!text || text.startsWith("/")) return false; // Ignore commands

	try {
		switch (session.action) {
			case "add_restriction":
				return await processAddRestrictionSession(ctx, session, text);
			case "jail":
				return await processJailSession(ctx, session, text);
			case "add_global_action":
				return await processGlobalActionSession(ctx, session, text);
			case "role_admin":
			case "role_elevated":
			case "role_revoke":
				return await processRoleSession(ctx, session, text);
			case "list_add_white":
			case "list_add_black":
			case "list_remove_white":
			case "list_remove_black":
				return await processListSession(ctx, session, text);
			case "add_spam_react":
				return await processAddSpamReactSession(ctx, session, text);
			default:
				return false;
		}
	} catch (error) {
		logger.error("Session text handler error", { userId, session, error });
		clearSession(userId);
		await ctx.reply("An error occurred. Please start over.");
		return true;
	}
}

/**
 * Processes step 1 of the add_restriction interactive session.
 * Called when user provides a target userId/username via text reply.
 *
 * **Multi-step Flow:**
 * 1. User runs /addrestriction -> shows restriction type keyboard
 * 2. User clicks restriction type -> handleRestrictionCallback prompts for target
 * 3. User replies with userId/username -> THIS FUNCTION validates and prompts for severity
 * 4. User clicks severity -> handleSeverityCallback prompts for auto-jail settings
 * 5. User clicks auto-jail option -> handleAutoJailCallback applies the restriction
 *
 * @param ctx - Telegraf context from the text message
 * @param session - Current session data containing restriction type
 * @param text - User's text input (should be userId or @username)
 * @returns True if message was handled, false otherwise
 */
async function processAddRestrictionSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const userId = ctx.from?.id;
	if (!userId) return false;

	// Verify user still has admin privileges
	if (!verifyAdminRole(userId)) {
		await ctx.reply(
			"Your admin privileges have been revoked. Action cancelled.",
		);
		clearSession(userId);
		return true;
	}

	const { restrictionType } = session.data;

	// Step 4: Capture extra restriction configuration for types that need it.
	if (session.step === 4) {
		const {
			targetId,
			severity,
			threshold,
			jailDuration,
			jailFine,
			autoJailSetting,
		} = session.data;

		if (restrictionType === "regex_block") {
			const pattern = text.trim();
			if (!pattern) {
				await ctx.reply("Please provide a non-empty pattern.");
				return true;
			}

			// Strip surrounding quotes if present
			let action = pattern;
			if (action.startsWith('"') && action.endsWith('"')) {
				action = action.slice(1, -1);
			}

			await applyRestriction(
				ctx,
				session,
				userId,
				targetId,
				restrictionType,
				action,
				severity,
				autoJailSetting,
				threshold,
				jailDuration,
				jailFine,
			);
			return true;
		}

		if (restrictionType === "random_delete") {
			const normalizedChance = normalizeRandomDeleteChance(text.trim());
			if (!normalizedChance) {
				await ctx.reply(
					"Please provide a valid chance between 0 and 100%. Examples: 10%, 25, 0.1, or default.",
				);
				return true;
			}

			await applyRestriction(
				ctx,
				session,
				userId,
				targetId,
				restrictionType,
				normalizedChance,
				severity,
				autoJailSetting,
				threshold,
				jailDuration,
				jailFine,
			);
			return true;
		}

		if (restrictionType === "no_specific_gif") {
			const fileUniqueId = text.trim();
			if (!fileUniqueId) {
				await ctx.reply("Please provide a non-empty GIF file\\_unique\\_id.");
				return true;
			}

			await applyRestriction(
				ctx,
				session,
				userId,
				targetId,
				restrictionType,
				fileUniqueId,
				severity,
				autoJailSetting,
				threshold,
				jailDuration,
				jailFine,
			);
			return true;
		}
	}

	// Step 1: Resolve the target user from text input
	const targetId = resolveUserId(text.trim());
	if (!targetId) {
		await ctx.reply(
			"User not found. Please provide a valid userId or @username.",
		);
		return true;
	}

	if (isImmuneToModeration(targetId)) {
		await ctx.reply(
			"Cannot restrict this user - admins and owners are immune.",
		);
		clearSession(userId);
		return true;
	}

	// Store target and move to step 2: severity selection
	session.data.targetId = targetId;
	setSession(userId, "add_restriction", 2, session.data);

	const targetDisplay = formatUserIdDisplay(targetId);
	await editMenu(
		ctx,
		session.data.menuRef as MenuRef,
		fmt`${bold(`Restriction: ${restrictionType}`)}
Target: ${targetDisplay}

${bold("Select severity level:")}
• ${bold("Delete Only")} - Just delete the violating message
• ${bold("Mute 30min")} - 30-minute mute on each violation
• ${bold("Instant Jail")} - Immediate 1-hour jail with 5 JUNO fine`,
		severityKeyboard,
	);

	return true;
}

/**
 * Process jail session - user provided target and optionally duration
 */
async function processJailSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const adminId = ctx.from?.id;
	if (!adminId) return false;

	// Verify user still has admin privileges
	if (!verifyAdminRole(adminId)) {
		await ctx.reply(
			"Your admin privileges have been revoked. Action cancelled.",
		);
		clearSession(adminId);
		return true;
	}

	const { minutes } = session.data;

	// Parse: "userId" or "@username" or "userId minutes" for custom
	const parts = text.trim().split(/\s+/);
	const targetId = resolveUserId(parts[0]);

	if (!targetId) {
		await ctx.reply(
			"User not found. Please provide a valid userId or @username.",
		);
		return true;
	}

	const jailMinutes = minutes ?? (parts[1] ? parseInt(parts[1], 10) : 30);

	if (isImmuneToModeration(targetId)) {
		await ctx.reply("Cannot jail this user - admins and owners are immune.");
		clearSession(adminId);
		return true;
	}

	if (Number.isNaN(jailMinutes) || jailMinutes < 1) {
		await ctx.reply(
			"Invalid duration. Please provide a positive number of minutes.",
		);
		return true;
	}

	const { bailAmount } = JailService.jailUser({
		userId: targetId,
		durationMinutes: jailMinutes,
		adminId,
		bailAmount: DEFAULT_JAIL_BAIL_AMOUNT,
	});

	const userDisplay = formatUserIdDisplay(targetId);
	await finishMenu(
		ctx,
		session,
		fmt`User ${userDisplay} has been jailed for ${jailMinutes} minutes.\nBail amount: ${bailAmount.toFixed(3)} JUNO`,
	);

	StructuredLogger.logSecurityEvent("User jailed via interactive flow", {
		adminId,
		userId: targetId,
		operation: "jail",
		duration: jailMinutes,
		bailAmount: bailAmount.toString(),
	});

	clearSession(adminId);
	return true;
}

/**
 * Process global action session - user provided action details
 */
async function processGlobalActionSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const userId = ctx.from?.id;
	if (!userId) return false;

	// Verify user still has admin privileges
	if (!verifyAdminRole(userId)) {
		await ctx.reply(
			"Your admin privileges have been revoked. Action cancelled.",
		);
		clearSession(userId);
		return true;
	}

	const { actionType } = session.data;

	const cleanText = text.trim().toLowerCase();
	const action = cleanText === "apply" ? undefined : text.trim();

	execute(
		"INSERT INTO global_restrictions (restriction, restricted_action) VALUES (?, ?)",
		[actionType, action || null],
	);

	const actionDesc = action ? ` with action '${action}'` : "";
	await finishMenu(
		ctx,
		session,
		`Global restriction '${actionType}'${actionDesc} has been added.`,
	);

	StructuredLogger.logSecurityEvent(
		"Global action added via interactive flow",
		{
			adminId: userId,
			operation: "add_global_action",
			actionType,
			action,
		},
	);

	clearSession(userId);
	return true;
}

/**
 * Process role session - user provided target for role change
 */
async function processRoleSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const adminId = ctx.from?.id;
	if (!adminId) return false;

	// Re-verify the exact permission required by the chosen action.
	const allowed =
		session.action === "role_admin"
			? isOwner(adminId)
			: isAdmin(adminId) || isOwner(adminId);
	if (!allowed) {
		await finishMenu(
			ctx,
			session,
			"Your admin privileges have been revoked. Action cancelled.",
		);
		clearSession(adminId);
		return true;
	}

	const targetId = resolveUserId(text.trim());
	if (!targetId) {
		await ctx.reply(
			"User not found. Please provide a valid userId or @username.",
		);
		return true;
	}

	const targetUser = getUserById(targetId);
	const username = targetUser?.username || `user_${targetId}`;

	let role: "owner" | "admin" | "elevated" | "pleb";
	let message: string;

	switch (session.action) {
		case "role_admin":
			role = "admin";
			message = `Admin privileges granted to @${username}!`;
			break;
		case "role_elevated":
			role = "elevated";
			message = `Elevated privileges granted to @${username}!`;
			break;
		case "role_revoke":
			role = "pleb";
			message = `Privileges revoked from @${username}.`;
			break;
		default:
			clearSession(adminId);
			return false;
	}

	setUserRole(targetId, username, role);

	await finishMenu(ctx, session, message);

	StructuredLogger.logSecurityEvent("Role changed via interactive flow", {
		adminId,
		targetUserId: targetId,
		operation: session.action,
		newRole: role,
	});

	clearSession(adminId);
	return true;
}

/**
 * Process list session - user provided target for whitelist/blacklist
 */
async function processListSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const adminId = ctx.from?.id;
	if (!adminId) return false;

	if (!(isAdmin(adminId) || isOwner(adminId))) {
		await finishMenu(
			ctx,
			session,
			"Your admin privileges have been revoked. Action cancelled.",
		);
		clearSession(adminId);
		return true;
	}

	const targetId = resolveUserId(text.trim());
	if (!targetId) {
		await ctx.reply(
			"User not found. Please provide a valid userId or @username.",
		);
		return true;
	}

	let message: string;

	switch (session.action) {
		case "list_add_white":
			execute("UPDATE users SET whitelist = 1 WHERE id = ?", [targetId]);
			message = `User ${targetId} has been whitelisted.`;
			break;
		case "list_add_black":
			if (isImmuneToModeration(targetId)) {
				await finishMenu(
					ctx,
					session,
					"Cannot blacklist this user - admins and owners are immune.",
				);
				clearSession(adminId);
				return true;
			}
			execute("UPDATE users SET blacklist = 1 WHERE id = ?", [targetId]);
			message = `User ${targetId} has been blacklisted.`;
			break;
		case "list_remove_white":
			execute("UPDATE users SET whitelist = 0 WHERE id = ?", [targetId]);
			message = `User ${targetId} has been removed from the whitelist.`;
			break;
		case "list_remove_black":
			execute("UPDATE users SET blacklist = 0 WHERE id = ?", [targetId]);
			message = `User ${targetId} has been removed from the blacklist.`;
			break;
		default:
			clearSession(adminId);
			return false;
	}

	await finishMenu(ctx, session, message);

	StructuredLogger.logSecurityEvent("List updated via interactive flow", {
		adminId,
		targetUserId: targetId,
		operation: session.action,
	});

	clearSession(adminId);
	return true;
}

/**
 * Handles spam react field selection from the inline keyboard.
 * Stores the selected field in session and prompts for the pattern text.
 *
 * @param ctx - Telegraf callback query context
 * @param data - Callback data in format "spamfield_<field>"
 * @param userId - ID of the user who clicked the button
 */
async function handleSpamFieldCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	if (!verifyOwner(userId)) {
		await ctx.editMessageText(
			"Your privileges have been revoked. Action cancelled.",
			{ reply_markup: noKeyboard },
		);
		return;
	}

	const field = data.replace("spamfield_", "") as SpamReactField;
	const fieldLabel =
		field === "bio" ? "Bio" : field === "channel" ? "Channel Title" : "Both";

	setSession(userId, "add_spam_react", 1, withMenuRef(ctx, { field }));

	await ctx.editMessageText(
		fmt`${bold(`Add Spam Reaction Pattern [${fieldLabel}]`)}

Reply with the pattern to match against user profiles.

${bold("Pattern formats:")}
${code('"simple text"')} - case-insensitive substring
${code("*wild*card*")} - wildcard matching
${code("/regex/i")} - full regex

${bold("Examples:")}
${code("bonus 1000")} - matches "BONUS 1000$"
${code("/elon\\s*musk/i")} - matches "Elon Musk"
${code("*crypto*giveaway*")} - matches "Free Crypto Giveaway"`,
		{ reply_markup: noKeyboard },
	);
}

/**
 * Processes text input for the add_spam_react interactive session.
 * Called when a user replies with a pattern after selecting a field.
 *
 * @param ctx - Telegraf context
 * @param session - Current session data containing the selected field
 * @param text - User's text input (the pattern)
 * @returns True if handled
 */
async function processAddSpamReactSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const userId = ctx.from?.id;
	if (!userId) return false;

	if (!verifyOwner(userId)) {
		await finishMenu(
			ctx,
			session,
			"Your privileges have been revoked. Action cancelled.",
		);
		clearSession(userId);
		return true;
	}

	const field = session.data.field as SpamReactField;
	const pattern = text.trim();
	const menuRef = session.data.menuRef as MenuRef | undefined;

	clearSession(userId);
	await addPattern(ctx, userId, pattern, field, undefined, (message) =>
		editMenu(ctx, menuRef, message),
	);
	return true;
}
