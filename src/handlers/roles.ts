/**
 * Role management handlers for the CAC Admin Bot.
 * Implements a four-tier role hierarchy: owner > admin > elevated > pleb.
 * Provides commands for promoting, demoting, and managing user privileges.
 *
 * Role Hierarchy:
 * - owner: Full control, can promote admins and elevated users
 * - admin: Can elevate users and manage restrictions
 * - elevated: Can manage bot functions but cannot assign roles
 * - pleb: Default role for all users
 *
 * @module handlers/roles
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, query } from "../database";
import {
	adminOrHigher,
	elevatedAdminOnly,
	ownerOnly,
} from "../middleware/index";
import type { User } from "../types";
import { StructuredLogger } from "../utils/logger";
import { resolveTargetUser } from "../utils/userResolver";

/**
 * Registers all role management command handlers with the bot.
 * Provides commands for managing the user role hierarchy and permissions.
 *
 * Commands registered:
 * - /setowner - Initialize the master owner from config
 * - /grantowner - Grant owner privileges to another user
 * - /elevate - Elevate a user to elevated role
 * - /makeadmin - Promote a user to admin role
 * - /revoke - Revoke elevated/admin roles
 * - /listadmins - List all users with elevated privileges
 *
 * @param bot - The Telegraf bot instance
 *
 * @example
 * ```typescript
 * const bot = new Telegraf(token);
 * registerRoleHandlers(bot);
 * ```
 */
export const registerRoleHandlers = (bot: Telegraf<Context>) => {
	/**
	 * Command handler for /setowner.
	 * Initializes the master owner from the environment configuration.
	 * Can only be run once or by the configured master owner.
	 *
	 * Permission: Master owner from config.ownerId only
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /setowner
	 */
	bot.command("setowner", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		// Only allow if user is a configured owner from .env
		if (!config.ownerIds.includes(userId)) {
			return ctx.reply(
				"Only configured owners (from .env OWNER_ID) can use this command.",
			);
		}

		execute(
			"INSERT OR REPLACE INTO users (id, username, role) VALUES (?, ?, ?)",
			[userId, ctx.from.username || "unknown", "owner"],
		);

		StructuredLogger.logSecurityEvent("Master owner initialized", {
			userId,
			username: ctx.from.username,
			operation: "set_owner",
		});
		ctx.reply("Master owner initialized successfully.");
	});

	/**
	 * Command handler for /grantowner.
	 * Grants owner privileges to another user by username or user ID.
	 * Only existing owner can grant ownership to others.
	 * Can target user by replying to their message or providing username/ID.
	 *
	 * Permission: Owner only (enforced by ownerOnly middleware)
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /grantowner <username> or /grantowner <userId> or reply to a message with /grantowner
	 * Example: /grantowner @alice
	 * Example: /grantowner 123456789
	 */
	bot.command("grantowner", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /grantowner <username|userId> or reply to a user's message with /grantowner",
			);
		}

		try {
			execute(
				"INSERT INTO users (id, username, role) VALUES (?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET role = ?, username = COALESCE(?, username)",
				[target.userId, target.username, "owner", "owner", target.username],
			);

			StructuredLogger.logSecurityEvent("Owner privileges granted", {
				grantedBy: ownerId,
				targetUsername: target.username,
				targetUserId: target.userId,
				operation: "grant_owner",
			});

			await ctx.reply(
				`Owner privileges granted!\n\n` +
					`User ID: ${target.userId}\n` +
					`Username: @${target.username}`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				ownerId,
				targetUserId: target.userId,
				operation: "grant_owner",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});

	/**
	 * Command handler for /elevate.
	 * Elevates a user to the elevated role.
	 * Both admins and owners can elevate users.
	 * Can target user by replying to their message or providing username/ID.
	 *
	 * Permission: Admin or owner role required (enforced by adminOrHigher middleware)
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /elevate <username> or /elevate <userId> or reply to a message with /elevate
	 * Example: /elevate @bob
	 * Example: /elevate 987654321
	 */
	bot.command("elevate", adminOrHigher, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /elevate <username|userId> or reply to a user's message with /elevate",
			);
		}

		try {
			execute(
				"INSERT INTO users (id, username, role) VALUES (?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET role = ?, username = COALESCE(?, username)",
				[
					target.userId,
					target.username,
					"elevated",
					"elevated",
					target.username,
				],
			);

			StructuredLogger.logSecurityEvent("User elevated", {
				adminId: userId,
				targetUsername: target.username,
				targetUserId: target.userId,
				operation: "elevate_user",
			});
			await ctx.reply(
				`Elevated privileges granted!\n\n` +
					`User ID: ${target.userId}\n` +
					`Username: @${target.username}`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId,
				targetUserId: target.userId,
				operation: "elevate_user",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});

	/**
	 * Command handler for /makeadmin.
	 * Promotes a user to admin role.
	 * Only owners can create admins.
	 * Can target user by replying to their message or providing username/ID.
	 *
	 * Permission: Owner only (enforced by ownerOnly middleware)
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /makeadmin <username> or /makeadmin <userId> or reply to a message with /makeadmin
	 * Example: /makeadmin @charlie
	 * Example: /makeadmin 555444333
	 */
	bot.command("makeadmin", ownerOnly, async (ctx) => {
		const ownerId = ctx.from?.id;
		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /makeadmin <username|userId> or reply to a user's message with /makeadmin",
			);
		}

		try {
			execute(
				"INSERT INTO users (id, username, role) VALUES (?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET role = ?, username = COALESCE(?, username)",
				[target.userId, target.username, "admin", "admin", target.username],
			);

			StructuredLogger.logSecurityEvent("User promoted to admin", {
				ownerId,
				targetUsername: target.username,
				targetUserId: target.userId,
				operation: "make_admin",
			});
			await ctx.reply(
				`Admin privileges granted!\n\n` +
					`User ID: ${target.userId}\n` +
					`Username: @${target.username}`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				ownerId,
				targetUserId: target.userId,
				operation: "make_admin",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});

	/**
	 * Command handler for /revoke.
	 * Revokes elevated or admin privileges from a user, demoting them to pleb.
	 * Admins can only revoke elevated users. Owners can revoke any role except other owners.
	 * Can target user by replying to their message or providing username/ID.
	 *
	 * Permission: Admin or owner role required (enforced by adminOrHigher middleware)
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /revoke <username> or /revoke <userId> or reply to a message with /revoke
	 * Example: /revoke @bob
	 * Example: /revoke 987654321
	 */
	bot.command("revoke", adminOrHigher, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		// Get requester role for additional permission check
		const requester = query<User>("SELECT * FROM users WHERE id = ?", [
			userId,
		])[0];

		const args = ctx.message?.text.split(" ").slice(1) || [];
		const target = resolveTargetUser(ctx, args);

		if (!target) {
			return ctx.reply(
				"Usage: /revoke <username|userId> or reply to a user's message with /revoke",
			);
		}

		try {
			const targetUser = query<User>("SELECT * FROM users WHERE id = ?", [
				target.userId,
			])[0];

			if (!targetUser) {
				return ctx.reply("User not found in database.");
			}

			// Admins can only revoke elevated users, not other admins or owners
			if (
				requester.role === "admin" &&
				(targetUser.role === "admin" || targetUser.role === "owner")
			) {
				return ctx.reply(
					"You can only revoke elevated users. Contact an owner to revoke admin or owner privileges.",
				);
			}

			execute("UPDATE users SET role = ? WHERE id = ?", [
				"pleb",
				targetUser.id,
			]);
			StructuredLogger.logSecurityEvent("User privileges revoked", {
				revokerId: userId,
				targetUsername: targetUser.username,
				targetId: targetUser.id,
				operation: "revoke_privileges",
			});
			await ctx.reply(
				`@${targetUser.username || targetUser.id}'s privileges have been revoked.`,
			);
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId,
				targetUserId: target.userId,
				operation: "revoke_privileges",
			});
			await ctx.reply("An error occurred while processing the request.");
		}
	});

	/**
	 * Command handler for /listadmins.
	 * Lists all users with elevated privileges (owner, admin, elevated).
	 * Organized by role hierarchy.
	 *
	 * Permission: Elevated admin or owner (enforced by elevatedAdminOnly middleware)
	 *
	 * @param ctx - Telegraf context
	 *
	 * @example
	 * Usage: /listadmins
	 */
	bot.command("listadmins", elevatedAdminOnly, async (ctx) => {
		try {
			const privilegedUsers = query<User>(
				"SELECT id, username, role FROM users WHERE role IN ('owner', 'admin', 'elevated') ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'elevated' THEN 3 END",
				[],
			);

			if (privilegedUsers.length === 0) {
				return ctx.reply("No users with elevated privileges found.");
			}

			let message = " Users with elevated privileges:\n\n";

			const owners = privilegedUsers.filter((u) => u.role === "owner");
			const admins = privilegedUsers.filter((u) => u.role === "admin");
			const elevated = privilegedUsers.filter((u) => u.role === "elevated");

			if (owners.length > 0) {
				message += " Owners:\n";
				for (const u of owners) {
					message += `  • @${u.username || u.id} (${u.id})\n`;
				}
				message += "\n";
			}

			if (admins.length > 0) {
				message += " Admins:\n";
				for (const u of admins) {
					message += `  • @${u.username || u.id} (${u.id})\n`;
				}
				message += "\n";
			}

			if (elevated.length > 0) {
				message += " Elevated:\n";
				for (const u of elevated) {
					message += `  • @${u.username || u.id} (${u.id})\n`;
				}
			}

			await ctx.reply(message);

			StructuredLogger.logUserAction("Admin list queried", {
				userId: ctx.from?.id,
				operation: "list_admins",
				count: privilegedUsers.length.toString(),
			});
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				userId: ctx.from?.id,
				operation: "list_admins",
			});
			await ctx.reply("An error occurred while fetching admin list.");
		}
	});
};
