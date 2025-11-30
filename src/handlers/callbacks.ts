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
import { LedgerService } from "../services/ledgerService";
import {
	getGiveawayEscrowId,
	SYSTEM_USER_IDS,
} from "../services/unifiedWalletService";
import { giveawayClaimKeyboard, mainMenuKeyboard } from "../utils/keyboards";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

interface Giveaway {
	id: number;
	created_by: number;
	funded_by: number;
	total_amount: number;
	amount_per_slot: number;
	total_slots: number;
	claimed_slots: number;
	chat_id: number;
	message_id: number | null;
	status: "active" | "completed" | "cancelled";
}

// Store for tracking multi-step interactions
interface SessionData {
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
function getSession(userId: number): SessionData | null {
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
function setSession(
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
function clearSession(userId: number): void {
	sessions.delete(userId);
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
			// Answer the callback to remove loading state
			await ctx.answerCbQuery();

			// Handle special cases first
			if (data === "cancel") {
				clearSession(userId);
				await ctx.editMessageText("Action cancelled.");
				return;
			}

			if (data === "noop") {
				return;
			}

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

	const chatId = ctx.chat?.id;
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
		const result = execute(
			`INSERT INTO giveaways (created_by, funded_by, total_amount, amount_per_slot, total_slots, claimed_slots, chat_id, status)
			 VALUES (?, ?, ?, ?, ?, 0, ?, 'active')`,
			[userId, fundedBy, totalAmount, amountPerSlot, totalSlots, chatId],
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

	// Fetch giveaway
	const giveaway = get<Giveaway>(
		"SELECT * FROM giveaways WHERE id = ? AND status = 'active'",
		[giveawayId],
	);

	if (!giveaway) {
		await ctx.answerCbQuery("This giveaway has ended.");
		return;
	}

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

		// Record claim
		execute(
			"INSERT INTO giveaway_claims (giveaway_id, user_id, amount) VALUES (?, ?, ?)",
			[giveawayId, userId, giveaway.amount_per_slot],
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
