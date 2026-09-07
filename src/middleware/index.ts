/** User management and permission control middleware */

import type { Context, MiddlewareFn } from "telegraf";
import { config } from "../config";
import { query } from "../database";
import { LedgerService } from "../services/ledgerService";
import { ensureUserExists, getUserRestrictions } from "../services/userService";
import type { User } from "../types";
import { logger, StructuredLogger } from "../utils/logger";

/** Extract the leading "/command" (stripping @bot suffix) from a message, if any. */
function commandName(ctx: Context): string | undefined {
	const text =
		ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
	if (!text || !text.startsWith("/")) return undefined;
	return text.split(/\s+/)[0].split("@")[0];
}

/**
 * Logs every command invoked by a privileged user (owner/admin/elevated).
 * Central visibility for all admin actions, independent of whether the
 * individual command handler logs anything itself.
 */
export const logPrivilegedCommands: MiddlewareFn<Context> = async (
	ctx,
	next,
) => {
	const userId = ctx.from?.id;
	const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
	if (!userId || !text.startsWith("/")) return next();
	const user = query<User>("SELECT role FROM users WHERE id = ?", [userId])[0];
	const role = user?.role || "";
	if (
		!["owner", "admin", "elevated"].includes(role) &&
		!config.ownerIds.includes(userId) &&
		!config.adminIds.includes(userId)
	) {
		return next();
	}
	const command = commandName(ctx);
	StructuredLogger.logSecurityEvent("Admin command executed", {
		tag: "admin",
		subtag: command?.slice(1) || "command",
		grantedBy: userId,
		actorUsername: ctx.from?.username,
		command,
		args: text.slice(text.indexOf(" ") + 1),
		chatType: ctx.chat?.type,
		chatId: ctx.chat?.id,
		role,
		operation: "admin_command",
	});
	return next();
};

/**
 * Middleware that ensures users exist in the database, initializes their wallet balance,
 * and preloads their restrictions. This middleware runs early in the pipeline to:
 * 1. Synchronize Telegram users with the bot's database
 * 2. Create a ledger balance entry for new users (starts at 0 JUNO)
 * 3. Load all active restrictions into the context state for later use
 *
 * This ensures every user is automatically "registered" when they first interact with the bot.
 *
 * @param ctx - Telegraf context object containing user information
 * @param next - Next middleware function in the chain
 * @returns Promise that resolves when user is loaded, balance created, and restrictions preloaded
 *
 * @example
 * ```typescript
 * // User restrictions and balance are available in handlers after this middleware
 * bot.use(userManagementMiddleware);
 * bot.command('balance', (ctx) => {
 *   const restrictions = ctx.state.restrictions; // Available here
 *   // User balance entry guaranteed to exist in ledger
 * });
 * ```
 */
export const userManagementMiddleware: MiddlewareFn<Context> = async (
	ctx,
	next,
) => {
	if (!ctx.from || !ctx.from.id) {
		logger.warn("Request received without user information");
		return next(); // Skip if no user information is available
	}

	const userId = ctx.from.id;
	const username = ctx.from.username || "unknown";

	try {
		// Ensure the user is in the database
		ensureUserExists(userId, username);

		// Ensure user has a balance entry in the ledger
		await LedgerService.ensureUserBalance(userId);

		// Fetch and preload user restrictions
		const restrictions = getUserRestrictions(userId);
		ctx.state.restrictions = restrictions;

		logger.debug("User initialized", {
			userId,
			username,
			restrictionCount: restrictions.length,
		});
	} catch (error) {
		logger.error("Error loading user", { userId, username, error });
		ctx.reply("Error processing request");
	}

	return next(); // Proceed with the next middleware or handler
};

/**
 * Middleware that restricts command access to the group owner only.
 * Checks the user's role in the database and only allows execution if role is 'owner'.
 *
 * @param ctx - Telegraf context object containing user information
 * @param next - Next middleware function to call if user is owner
 * @returns Promise that resolves with error message if not owner, or continues to next middleware
 *
 * @example
 * // Apply to owner-only commands
 * bot.command('setowner', ownerOnly, (ctx) => {
 *   // Only owners can reach this handler
 * });
 */
export const ownerOnly: MiddlewareFn<Context> = (ctx, next) => {
	const userId = ctx.from?.id;
	if (!userId) {
		return ctx.reply("User ID not found.");
	}

	// Check if user is in the configured owner IDs list
	if (config.ownerIds.includes(userId)) {
		return next();
	}

	// Also check database role for backward compatibility
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	if (user?.role === "owner") {
		return next();
	}

	StructuredLogger.logSecurityEvent("Denied owner-only command", {
		tag: "admin",
		subtag: "denied",
		grantedBy: userId,
		actorUsername: ctx.from?.username,
		command: commandName(ctx),
		role: user?.role,
		chatType: ctx.chat?.type,
		chatId: ctx.chat?.id,
		operation: "denied_owner_command",
	});
	return ctx.reply("Only owners can use this command.");
};

/**
 * Middleware that restricts command access to admins or higher roles (admin, owner).
 * Checks the user's role hierarchy and allows execution for admin and owner roles.
 *
 * @param ctx - Telegraf context object containing user information
 * @param next - Next middleware function to call if user has sufficient permissions
 * @returns Promise that resolves with error message if unauthorized, or continues to next middleware
 *
 * @example
 * // Apply to admin-level commands
 * bot.command('ban', adminOrHigher, (ctx) => {
 *   // Only admins and owners can reach this handler
 * });
 */
export const adminOrHigher: MiddlewareFn<Context> = (ctx, next) => {
	const userId = ctx.from?.id;
	if (!userId) {
		return ctx.reply("User ID not found.");
	}

	// Check if user is in configured owner IDs
	if (config.ownerIds.includes(userId)) {
		return next();
	}

	// Check database role
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	if (user?.role === "owner" || user?.role === "admin") {
		return next();
	}

	StructuredLogger.logSecurityEvent("Denied admin command", {
		tag: "admin",
		subtag: "denied",
		grantedBy: userId,
		actorUsername: ctx.from?.username,
		command: commandName(ctx),
		role: user?.role,
		chatType: ctx.chat?.type,
		chatId: ctx.chat?.id,
		operation: "denied_admin_command",
	});
	return ctx.reply("You do not have permission to use this command.");
};

/**
 * Middleware that restricts command access to elevated or higher roles (elevated, admin, owner).
 * The elevated role provides read-access and limited modification capabilities, suitable for
 * moderators who need visibility but not full administrative control.
 *
 * @param ctx - Telegraf context object containing user information
 * @param next - Next middleware function to call if user has sufficient permissions
 * @returns Promise that resolves with error message if unauthorized, or continues to next middleware
 *
 * @example
 * // Apply to moderator-level commands
 * bot.command('viewstats', elevatedOrHigher, (ctx) => {
 *   // Elevated users, admins, and owners can reach this handler
 * });
 */
export const elevatedOrHigher: MiddlewareFn<Context> = (ctx, next) => {
	const userId = ctx.from?.id;
	if (!userId) {
		return ctx.reply("User ID not found.");
	}

	// Check if user is in configured owner/admin IDs
	if (config.ownerIds.includes(userId) || config.adminIds.includes(userId)) {
		return next();
	}

	// Check database role
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	if (
		user?.role === "owner" ||
		user?.role === "admin" ||
		user?.role === "elevated"
	) {
		return next();
	}

	StructuredLogger.logSecurityEvent("Denied elevated command", {
		tag: "admin",
		subtag: "denied",
		grantedBy: userId,
		actorUsername: ctx.from?.username,
		command: commandName(ctx),
		role: user?.role,
		chatType: ctx.chat?.type,
		chatId: ctx.chat?.id,
		operation: "denied_elevated_command",
	});
	return ctx.reply("You do not have permission to use this command.");
};

/**
 * Alias for elevatedOrHigher middleware.
 * Used for commands that should be accessible to elevated users and above.
 * Note: Despite the name suggesting "admin only", this actually includes elevated users.
 *
 * @deprecated Consider using explicit `elevatedOrHigher` middleware instead for clarity.
 */
export const elevatedAdminOnly = elevatedOrHigher;
