/**
 * Callback query handlers for inline keyboard interactions.
 * Processes button presses from inline keyboards throughout the bot.
 *
 * @module handlers/callbacks
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import type { CallbackQuery } from "telegraf/types";
import { execute, get } from "../database";
import { JailService } from "../services/jailService";
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
	mainMenuKeyboard,
	severityKeyboard,
} from "../utils/keyboards";
import { logger, StructuredLogger } from "../utils/logger";
import {
	cleanupMenuByMessage,
	getMenuSessionByMessage,
	validateMenuInteraction,
} from "../utils/menuSession";
import { AmountPrecision } from "../utils/precision";
import { checkIsElevated, isImmuneToModeration } from "../utils/roles";
import { formatUserIdDisplay, resolveUserId } from "../utils/userResolver";
import { addPattern, type SpamPatternField } from "./spamPatterns";

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
 * Verify user still has admin or higher role.
 * Used in session handlers since role could change between session creation and execution.
 */
function verifyAdminRole(userId: number): boolean {
	return checkIsElevated(userId);
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
	{ prefix: "duration_", handler: handleDurationCallback },
	{ prefix: "giveaway_fund_", handler: handleGiveawayFundCallback },
	{ prefix: "giveaway_create_", handler: handleGiveawayCreateCallback },
	{ prefix: "claim_giveaway_", handler: handleGiveawayClaimCallback },
	{ prefix: "give_", handler: handleGiveawayCallback },
	{ prefix: "action_", handler: handleGlobalActionCallback },
	{ prefix: "role_", handler: handleRoleCallback },
	{ prefix: "list_", handler: handleListCallback },
	{ prefix: "perm_", handler: handlePermissionCallback },
	{ prefix: "confirm_", handler: handleConfirmationCallback },
	{ prefix: "menu_", handler: handleMenuCallback },
	{ prefix: "select_user_", handler: handleUserSelectionCallback },
	{ prefix: "spamfield_", handler: handleSpamFieldCallback },
];

/**
 * Registers all callback query handlers with the bot
 */
export function registerCallbackHandlers(bot: Telegraf<Context>): void {
	/**
	 * Handle all callback queries
	 */
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
						await ctx.answerCbQuery(
							"Only the person who started this can cancel it.",
						);
						return;
					}
					cleanupMenuByMessage(chatId, messageId);
				}
				clearSession(userId);
				await ctx.answerCbQuery();
				await ctx.editMessageText("Action cancelled.");
				return;
			}

			if (data === "noop") {
				await ctx.answerCbQuery();
				return;
			}

			// Answer the callback to remove loading state
			await ctx.answerCbQuery();

			// Route using dispatch table
			for (const { prefix, handler } of callbackHandlers) {
				if (data.startsWith(prefix)) {
					await handler(ctx, data, userId);
					return;
				}
			}
		} catch (error) {
			logger.error("Error handling callback query", { userId, data, error });
			await ctx.answerCbQuery("An error occurred. Please try again.");
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
	setSession(userId, "add_restriction", 1, { restrictionType });

	await ctx.editMessageText(
		fmt`${bold(`Add Restriction: ${restrictionType}`)}

Please reply with the user ID or @username to restrict.

Format: ${code("userId")} or ${code("@username")}`,
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
		await ctx.editMessageText("Session expired. Please start over.");
		return;
	}

	// Verify user still has admin privileges
	if (!verifyAdminRole(userId)) {
		await ctx.editMessageText(
			"Your admin privileges have been revoked. Action cancelled.",
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
		await ctx.editMessageText("Session expired. Please start over.");
		return;
	}

	// Verify user still has admin privileges
	if (!verifyAdminRole(userId)) {
		await ctx.editMessageText(
			"Your admin privileges have been revoked. Action cancelled.",
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

	// Apply the restriction
	addUserRestriction(
		targetId,
		restrictionType,
		undefined,
		undefined,
		undefined,
		severity,
		threshold,
		jailDuration,
		jailFine,
	);

	StructuredLogger.logSecurityEvent("Restriction added via interactive flow", {
		adminId: userId,
		userId: targetId,
		operation: "add_restriction",
		restriction: restrictionType,
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

	await ctx.editMessageText(
		fmt`${bold("Restriction Applied")}

Type: ${restrictionType}
Target: ${targetDisplay}
Severity: ${severity}
${autoJailText}

Use ${code(`/listrestrictions ${targetId}`)} to view all restrictions.`,
	);

	clearSession(userId);
}

/**
 * Handle jail duration selection
 */
async function handleJailCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	if (data === "jail_custom") {
		setSession(userId, "jail", 1, {});
		await ctx.editMessageText(
			fmt`${bold("Custom Jail Duration")}

Please reply with:
1. User ID or @username
2. Duration in minutes

Format: ${code("@username 45")} or ${code("123456 30")}`,
		);
		return;
	}

	const minutes = parseInt(data.replace("jail_", ""), 10);
	setSession(userId, "jail", 1, { minutes });

	await ctx.editMessageText(
		fmt`${bold(`Jail User for ${minutes} minutes`)}

Please reply with the user ID or @username to jail.

Format: ${code("userId")} or ${code("@username")}`,
	);
}

/**
 * Handle duration selection for restrictions
 */
async function handleDurationCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const session = getSession(userId);
	if (!session) {
		await ctx.editMessageText("Session expired. Please start over.");
		return;
	}

	let duration: number | null;
	if (data === "duration_permanent") {
		duration = null;
	} else {
		duration = parseInt(data.replace("duration_", ""), 10);
	}

	session.data.duration = duration;
	setSession(userId, session.action, session.step + 1, session.data);

	const durationText = duration ? `${duration / 3600} hours` : "permanent";
	await ctx.editMessageText(
		`Duration set to: ${durationText}

Restriction will be applied. Use /listrestrictions <userId> to verify.`,
	);

	// Clear session after completion
	clearSession(userId);
}

/**
 * Handle giveaway amount selection
 */
async function handleGiveawayCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	if (data === "give_custom") {
		setSession(userId, "giveaway", 1, {});
		await ctx.editMessageText(
			fmt`${bold("Custom Giveaway Amount")}

Please reply with:
1. User ID or @username
2. Amount in JUNO

Format: ${code("@username 15.5")} or ${code("123456 20")}`,
		);
		return;
	}

	const amount = parseFloat(data.replace("give_", ""));
	setSession(userId, "giveaway", 1, { amount });

	await ctx.editMessageText(
		fmt`${bold(`Giveaway: ${amount} JUNO`)}

Please reply with the user ID or @username to receive the giveaway.

Format: ${code("userId")} or ${code("@username")}`,
	);
}

/**
 * Handle global action selection
 */
async function handleGlobalActionCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const actionType = data.replace("action_", "");

	setSession(userId, "add_global_action", 1, { actionType });

	await ctx.editMessageText(
		fmt`${bold(`Add Global Action: ${actionType}`)}

This will restrict ALL users from: ${actionType}

Optionally, reply with a specific action to restrict (e.g., specific sticker pack name, domain, etc.)
Or type "apply" to apply globally.`,
	);
}

/**
 * Handle role assignment selection
 */
async function handleRoleCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const roleAction = data.replace("role_", "");

	setSession(userId, `role_${roleAction}`, 1, {});

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
	}

	await ctx.editMessageText(
		fmt`${message}

Format: ${code("@username")} or ${code("userId")}`,
	);
}

/**
 * Handle list management callback
 */
async function handleListCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
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
			await ctx.editMessageText(`The ${listType} is empty.`);
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
		);
		return;
	}

	setSession(userId, `list_${action}`, 1, {});

	await ctx.editMessageText(
		fmt`${bold("List Management")}

Action: ${action}

Please reply with the user ID or @username.

Format: ${code("@username")} or ${code("userId")}`,
	);
}

/**
 * Handle permission level selection for shared accounts
 */
async function handlePermissionCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const permission = data.replace("perm_", "");
	const session = getSession(userId);

	if (!session) {
		await ctx.editMessageText("Session expired. Please start over.");
		return;
	}

	session.data.permission = permission;
	setSession(userId, session.action, session.step + 1, session.data);

	await ctx.editMessageText(
		`Permission level set to: ${permission}

Access will be granted when you confirm.`,
	);
}

/**
 * Handle confirmation callbacks
 */
async function handleConfirmationCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const action = data.replace("confirm_", "");
	const session = getSession(userId);

	if (!session) {
		await ctx.editMessageText("Session expired. Please start over.");
		return;
	}

	// Execute the confirmed action
	await ctx.editMessageText(`${action} confirmed and executed!`);
	clearSession(userId);
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

/**
 * Handle main menu navigation
 */
async function handleMenuCallback(
	ctx: Context,
	data: string,
	_userId: number,
): Promise<void> {
	const menuItem = data.replace("menu_", "");
	const message = menuContent[menuItem];

	if (message) {
		await ctx.editMessageText(message, {
			reply_markup: mainMenuKeyboard,
		});
	}
}

/**
 * Handle user selection from paginated list
 */
async function handleUserSelectionCallback(
	ctx: Context,
	data: string,
	userId: number,
): Promise<void> {
	const selectedUserId = parseInt(data.replace("select_user_", ""), 10);
	const session = getSession(userId);

	if (!session) {
		await ctx.editMessageText("Session expired. Please start over.");
		return;
	}

	session.data.targetUserId = selectedUserId;
	setSession(userId, session.action, session.step + 1, session.data);

	await ctx.editMessageText(
		`User ${selectedUserId} selected. Proceeding with ${session.action}...`,
	);
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
			case "giveaway":
				return await processGiveawaySession(ctx, session, text);
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
			case "add_spam_pattern":
				return await processAddSpamPatternSession(ctx, session, text);
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
	await ctx.reply(
		fmt`${bold(`Restriction: ${restrictionType}`)}
Target: ${targetDisplay}

${bold("Select severity level:")}
• ${bold("Delete Only")} - Just delete the violating message
• ${bold("Mute 30min")} - 30-minute mute on each violation
• ${bold("Instant Jail")} - Immediate 1-hour jail with 5 JUNO fine`,
		{
			reply_markup: severityKeyboard,
		},
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

	const mutedUntil = Math.floor(Date.now() / 1000) + jailMinutes * 60;
	const bailAmount = await JailService.calculateBailAmount(jailMinutes);

	// Update database
	execute("UPDATE users SET muted_until = ?, updated_at = ? WHERE id = ?", [
		mutedUntil,
		Math.floor(Date.now() / 1000),
		targetId,
	]);

	// Log the jail event
	JailService.logJailEvent(
		targetId,
		"jailed",
		adminId,
		jailMinutes,
		bailAmount,
	);

	const userDisplay = formatUserIdDisplay(targetId);
	await ctx.reply(
		fmt`User ${userDisplay} has been jailed for ${jailMinutes} minutes.\nBail amount: ${bailAmount.toFixed(2)} JUNO`,
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
 * Process giveaway session - user provided target and optionally amount
 */
async function processGiveawaySession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const userId = ctx.from?.id;
	if (!userId) return false;
	const { amount } = session.data;

	// Parse: "@username amount" or "userId amount" or just "@username" if amount preset
	const parts = text.trim().split(/\s+/);
	const targetId = resolveUserId(parts[0]);

	if (!targetId) {
		await ctx.reply(
			"User not found. Please provide a valid userId or @username.",
		);
		return true;
	}

	const giveAmount = amount ?? (parts[1] ? parseFloat(parts[1]) : null);

	if (!giveAmount || Number.isNaN(giveAmount) || giveAmount <= 0) {
		await ctx.reply("Invalid amount. Please provide a positive JUNO amount.");
		return true;
	}

	// Execute transfer
	const result = await LedgerService.transferBetweenUsers(
		userId,
		targetId,
		giveAmount,
		"Giveaway via interactive flow",
	);

	if (!result.success) {
		await ctx.reply(`Transfer failed: ${result.error || "Unknown error"}`);
		clearSession(userId);
		return true;
	}

	const userDisplay = formatUserIdDisplay(targetId);
	await ctx.reply(
		`Successfully sent ${giveAmount.toFixed(6)} JUNO to ${userDisplay}!`,
	);

	StructuredLogger.logTransaction("Giveaway via interactive flow", {
		userId,
		targetUserId: targetId,
		amount: giveAmount.toString(),
		operation: "giveaway_interactive",
	});

	clearSession(userId);
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
	await ctx.reply(
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

	// Verify user still has admin privileges
	if (!verifyAdminRole(adminId)) {
		await ctx.reply(
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

	await ctx.reply(message);

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

	// Verify user still has admin privileges
	if (!verifyAdminRole(adminId)) {
		await ctx.reply(
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
				await ctx.reply(
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

	await ctx.reply(message);

	StructuredLogger.logSecurityEvent("List updated via interactive flow", {
		adminId,
		targetUserId: targetId,
		operation: session.action,
	});

	clearSession(adminId);
	return true;
}

/**
 * Handles spam pattern field selection from the inline keyboard.
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
	if (!verifyAdminRole(userId)) {
		await ctx.editMessageText(
			"Your privileges have been revoked. Action cancelled.",
		);
		return;
	}

	const field = data.replace("spamfield_", "") as SpamPatternField;
	const fieldLabel =
		field === "bio" ? "Bio" : field === "channel" ? "Channel Title" : "Both";

	setSession(userId, "add_spam_pattern", 1, { field });

	await ctx.editMessageText(
		fmt`${bold(`Add Spam Pattern [${fieldLabel}]`)}

Reply with the pattern to match against user profiles.

${bold("Pattern formats:")}
${code('"simple text"')} - case-insensitive substring
${code("*wild*card*")} - wildcard matching
${code("/regex/i")} - full regex

${bold("Examples:")}
${code("bonus 1000")} - matches "BONUS 1000$"
${code("/elon\\s*musk/i")} - matches "Elon Musk"
${code("*crypto*giveaway*")} - matches "Free Crypto Giveaway"`,
	);
}

/**
 * Processes text input for the add_spam_pattern interactive session.
 * Called when a user replies with a pattern after selecting a field.
 *
 * @param ctx - Telegraf context
 * @param session - Current session data containing the selected field
 * @param text - User's text input (the pattern)
 * @returns True if handled
 */
async function processAddSpamPatternSession(
	ctx: Context,
	session: SessionData,
	text: string,
): Promise<boolean> {
	const userId = ctx.from?.id;
	if (!userId) return false;

	if (!verifyAdminRole(userId)) {
		await ctx.reply("Your privileges have been revoked. Action cancelled.");
		clearSession(userId);
		return true;
	}

	const field = session.data.field as SpamPatternField;
	const pattern = text.trim();

	clearSession(userId);
	await addPattern(ctx, userId, pattern, field);
	return true;
}
