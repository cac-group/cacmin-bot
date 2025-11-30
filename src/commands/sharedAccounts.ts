/**
 * Shared Account Commands
 *
 * Commands for managing and using shared accounts.
 * Shared accounts allow multiple users to access a common wallet with different permission levels.
 *
 * @module commands/sharedAccounts
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { elevatedAdminOnly } from "../middleware";
import { SharedAccountService } from "../services/sharedAccountService";
import { UnifiedWalletService } from "../services/unifiedWalletService";
import { logger, StructuredLogger } from "../utils/logger";

/**
 * Registers all shared account commands
 */
export function registerSharedAccountCommands(bot: Telegraf): void {
	bot.command("createshared", elevatedAdminOnly, handleCreateShared);
	bot.command("deleteshared", handleDeleteShared);
	bot.command("grantaccess", handleGrantAccess);
	bot.command("revokeaccess", handleRevokeAccess);
	bot.command("updateaccess", handleUpdateAccess);
	bot.command("sharedbalance", handleSharedBalance);
	bot.command("sharedsend", handleSharedSend);
	bot.command("shareddeposit", handleSharedDeposit);
	bot.command("myshared", handleMyShared);
	bot.command("sharedinfo", handleSharedInfo);
	bot.command("sharedhistory", handleSharedHistory);
	bot.command("listshared", elevatedAdminOnly, handleListShared);
}

/**
 * /createshared - Creates a new shared account
 * Usage: /createshared <name> <display_name> [description]
 * Permission: Owner/Elevated Admin only
 */
async function handleCreateShared(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/createshared <name> <display_name> [description]")}\n\nExample: ${code('/createshared admin_pool "Admin Pool" "Shared treasury for admins"')}\n\nName requirements:\n• Lowercase letters, numbers, and underscores only\n• 3-32 characters\n• Must be unique`,
			);
			return;
		}

		const name = args[0];
		const displayName = args[1].replace(/^["']|["']$/g, ""); // Remove quotes
		const description =
			args
				.slice(2)
				.join(" ")
				.replace(/^["']|["']$/g, "") || `Shared account ${displayName}`;

		await ctx.reply("Creating shared account...");

		const accountId = await SharedAccountService.createSharedAccount(
			name,
			displayName,
			description,
			userId,
		);

		const balance = await UnifiedWalletService.getSharedBalance(accountId);

		await ctx.reply(
			fmt`${bold("Shared Account Created")}\n\nName: ${code(name)}\nDisplay: ${displayName}\nAccount ID: ${code(accountId.toString())}\nBalance: ${balance.toFixed(6)} JUNO\n\nYou have been granted admin permission.\n\nUse ${code(`/grantaccess ${name} @username <level>`)} to add members.`,
		);

		StructuredLogger.logTransaction("Shared account created", {
			userId,
			accountId: accountId.toString(),
			accountName: name,
			operation: "create_shared",
		});
	} catch (error) {
		logger.error("Create shared account failed", {
			userId: ctx.from?.id,
			error,
		});
		await ctx.reply(
			`Failed to create shared account: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * /deleteshared - Deletes a shared account
 * Usage: /deleteshared <name>
 * Permission: Account admin only
 */
async function handleDeleteShared(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 1) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/deleteshared <account_name>")}\nExample: ${code("/deleteshared admin_pool")}`,
			);
			return;
		}

		const name = args[0];

		const account = await SharedAccountService.getSharedAccountByName(name);
		if (!account) {
			await ctx.reply(`Shared account '${name}' not found.`);
			return;
		}

		// Check balance before deleting
		const balance = await UnifiedWalletService.getSharedBalance(account.id);
		if (balance > 0) {
			await ctx.reply(
				fmt`${bold("Warning")}: This shared account has a balance of ${balance.toFixed(6)} JUNO.\n\nPlease withdraw all funds before deleting the account.`,
			);
			return;
		}

		await SharedAccountService.deleteSharedAccount(account.id, userId);

		await ctx.reply(
			fmt`${bold("Shared Account Deleted")}\n\nAccount '${name}' has been deleted.`,
		);

		StructuredLogger.logTransaction("Shared account deleted", {
			userId,
			accountId: account.id.toString(),
			accountName: name,
			operation: "delete_shared",
		});
	} catch (error) {
		logger.error("Delete shared account failed", {
			userId: ctx.from?.id,
			error,
		});
		await ctx.reply(
			`Failed to delete shared account: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * /grantaccess - Grants permission to a user
 * Usage: /grantaccess <account_name> <@username|user_id> <level> [spend_limit]
 * Permission: Account admin only
 */
async function handleGrantAccess(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 3) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/grantaccess <account_name> <@username|user_id> <level> [spend_limit]")}\n\nLevels: ${code("view")}, ${code("spend")}, ${code("admin")}\n\nExamples:\n• ${code("/grantaccess admin_pool @alice admin")}\n• ${code("/grantaccess project_fund 123456 spend 100")}\n• ${code("/grantaccess event_budget @bob view")}`,
			);
			return;
		}

		const accountName = args[0];
		const targetUser = args[1];
		const level = args[2].toLowerCase();
		const spendLimit = args[3] ? parseFloat(args[3]) : undefined;

		if (!["view", "spend", "admin"].includes(level)) {
			await ctx.reply("Invalid permission level. Use: view, spend, or admin");
			return;
		}

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Resolve target user
		let targetUserId: number;
		if (targetUser.startsWith("@")) {
			const user = await UnifiedWalletService.findUserByUsername(targetUser);
			if (!user) {
				await ctx.reply(
					`User ${targetUser} not found. They need to interact with the bot first.`,
				);
				return;
			}
			targetUserId = user.id;
		} else {
			targetUserId = parseInt(targetUser, 10);
			if (Number.isNaN(targetUserId)) {
				await ctx.reply(`Invalid user ID: ${targetUser}`);
				return;
			}
		}

		await SharedAccountService.grantPermission(
			account.id,
			targetUserId,
			level as any,
			userId,
			spendLimit,
		);

		await ctx.reply(
			fmt`${bold("Permission Granted")}\n\nAccount: ${account.displayName || accountName}\nUser: ${targetUser}\nLevel: ${level}\n${spendLimit ? `Spend Limit: ${spendLimit.toString()} JUNO\n` : ""}`,
		);

		StructuredLogger.logTransaction("Permission granted", {
			userId,
			accountId: account.id.toString(),
			targetUserId: targetUserId.toString(),
			permissionLevel: level,
			operation: "grant_access",
		});
	} catch (error) {
		logger.error("Grant access failed", { userId: ctx.from?.id, error });
		await ctx.reply(
			`Failed to grant access: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * /revokeaccess - Revokes permission from a user
 * Usage: /revokeaccess <account_name> <@username|user_id>
 * Permission: Account admin only
 */
async function handleRevokeAccess(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/revokeaccess <account_name> <@username|user_id>")}\nExample: ${code("/revokeaccess admin_pool @alice")}`,
			);
			return;
		}

		const accountName = args[0];
		const targetUser = args[1];

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Resolve target user
		let targetUserId: number;
		if (targetUser.startsWith("@")) {
			const user = await UnifiedWalletService.findUserByUsername(targetUser);
			if (!user) {
				await ctx.reply(`User ${targetUser} not found.`);
				return;
			}
			targetUserId = user.id;
		} else {
			targetUserId = parseInt(targetUser, 10);
			if (Number.isNaN(targetUserId)) {
				await ctx.reply(`Invalid user ID: ${targetUser}`);
				return;
			}
		}

		await SharedAccountService.revokePermission(
			account.id,
			targetUserId,
			userId,
		);

		await ctx.reply(
			fmt`${bold("Permission Revoked")}\n\nAccount: ${account.displayName || accountName}\nUser: ${targetUser}\n\nAccess has been revoked.`,
		);

		StructuredLogger.logTransaction("Permission revoked", {
			userId,
			accountId: account.id.toString(),
			targetUserId: targetUserId.toString(),
			operation: "revoke_access",
		});
	} catch (error) {
		logger.error("Revoke access failed", { userId: ctx.from?.id, error });
		await ctx.reply(
			`Failed to revoke access: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * /updateaccess - Updates permission level or spend limit
 * Usage: /updateaccess <account_name> <@username|user_id> <level> [spend_limit]
 * Permission: Account admin only
 */
async function handleUpdateAccess(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 3) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/updateaccess <account_name> <@username|user_id> <level> [spend_limit]")}\nExample: ${code("/updateaccess project_fund @alice spend 500")}`,
			);
			return;
		}

		const accountName = args[0];
		const targetUser = args[1];
		const level = args[2].toLowerCase();
		const spendLimit = args[3] ? parseFloat(args[3]) : undefined;

		if (!["view", "spend", "admin"].includes(level)) {
			await ctx.reply("Invalid permission level. Use: view, spend, or admin");
			return;
		}

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Resolve target user
		let targetUserId: number;
		if (targetUser.startsWith("@")) {
			const user = await UnifiedWalletService.findUserByUsername(targetUser);
			if (!user) {
				await ctx.reply(`User ${targetUser} not found.`);
				return;
			}
			targetUserId = user.id;
		} else {
			targetUserId = parseInt(targetUser, 10);
			if (Number.isNaN(targetUserId)) {
				await ctx.reply(`Invalid user ID: ${targetUser}`);
				return;
			}
		}

		await SharedAccountService.updatePermission(
			account.id,
			targetUserId,
			level as any,
			userId,
			spendLimit,
		);

		await ctx.reply(
			fmt`${bold("Permission Updated")}\n\nAccount: ${account.displayName || accountName}\nUser: ${targetUser}\nNew Level: ${level}\n${spendLimit ? `New Spend Limit: ${spendLimit.toString()} JUNO\n` : ""}`,
		);

		StructuredLogger.logTransaction("Permission updated", {
			userId,
			accountId: account.id.toString(),
			targetUserId: targetUserId.toString(),
			permissionLevel: level,
			operation: "update_access",
		});
	} catch (error) {
		logger.error("Update access failed", { userId: ctx.from?.id, error });
		await ctx.reply(
			`Failed to update access: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * /sharedbalance - Checks shared account balance
 * Usage: /sharedbalance <account_name>
 * Permission: Any user with access to the account
 */
async function handleSharedBalance(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 1) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/sharedbalance <account_name>")}\nExample: ${code("/sharedbalance admin_pool")}`,
			);
			return;
		}

		const accountName = args[0];

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Check if user has access
		const permission = await SharedAccountService.getUserPermission(
			account.id,
			userId,
		);
		if (!permission) {
			await ctx.reply(
				`You do not have access to shared account '${accountName}'.`,
			);
			return;
		}

		const balance = await UnifiedWalletService.getSharedBalance(account.id);

		await ctx.reply(
			fmt`${bold(account.displayName || accountName)}\n\nBalance: ${code(`${balance.toFixed(6)} JUNO`)}\nYour Permission: ${permission.permissionLevel}\n${permission.spendLimit ? `Your Spend Limit: ${permission.spendLimit.toString()} JUNO\n` : ""}Account ID: ${code(account.id.toString())}`,
		);
	} catch (error) {
		logger.error("Shared balance check failed", {
			userId: ctx.from?.id,
			error,
		});
		await ctx.reply("Failed to check balance");
	}
}

/**
 * /sharedsend - Sends funds from shared account
 * Usage: /sharedsend <account_name> <@username|user_id> <amount> [description]
 * Permission: Spend or admin permission required
 */
async function handleSharedSend(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 3) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/sharedsend <account_name> <@username|user_id> <amount> [description]")}\nExample: ${code('/sharedsend admin_pool @alice 50 "Project payment"')}`,
			);
			return;
		}

		const accountName = args[0];
		const recipient = args[1];
		const amount = parseFloat(args[2]);
		const description = args
			.slice(3)
			.join(" ")
			.replace(/^["']|["']$/g, "");

		if (Number.isNaN(amount) || amount <= 0) {
			await ctx.reply("Invalid amount. Must be a positive number.");
			return;
		}

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Resolve recipient
		let recipientId: number;
		if (recipient.startsWith("@")) {
			const user = await UnifiedWalletService.findUserByUsername(recipient);
			if (!user) {
				await ctx.reply(
					`User ${recipient} not found. They need to interact with the bot first.`,
				);
				return;
			}
			recipientId = user.id;
		} else {
			recipientId = parseInt(recipient, 10);
			if (Number.isNaN(recipientId)) {
				await ctx.reply(`Invalid user ID: ${recipient}`);
				return;
			}
		}

		await ctx.reply("Processing transaction...");

		const result = await UnifiedWalletService.sendFromShared(
			account.id,
			userId,
			recipientId,
			amount,
			description,
		);

		if (!result.success) {
			await ctx.reply(`Transaction failed: ${result.error || "Unknown error"}`);
			return;
		}

		await ctx.reply(
			fmt`${bold("Transaction Successful")}\n\nFrom: ${account.displayName || accountName}\nTo: ${recipient}\nAmount: ${code(`${amount.toFixed(6)} JUNO`)}\nNew Account Balance: ${code(`${result.sharedBalance?.toFixed(6) || "0"} JUNO`)}`,
		);

		StructuredLogger.logTransaction("Shared account send", {
			userId,
			accountId: account.id.toString(),
			recipientId: recipientId.toString(),
			amount: amount.toString(),
			operation: "shared_send",
		});
	} catch (error) {
		logger.error("Shared send failed", { userId: ctx.from?.id, error });
		await ctx.reply("Transaction failed");
	}
}

/**
 * /shareddeposit - Deposits funds to shared account
 * Usage: /shareddeposit <account_name> <amount>
 * Permission: Any user
 */
async function handleSharedDeposit(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 2) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/shareddeposit <account_name> <amount>")}\nExample: ${code("/shareddeposit event_budget 100")}`,
			);
			return;
		}

		const accountName = args[0];
		const amount = parseFloat(args[1]);

		if (Number.isNaN(amount) || amount <= 0) {
			await ctx.reply("Invalid amount. Must be a positive number.");
			return;
		}

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		await ctx.reply("Processing deposit...");

		const result = await UnifiedWalletService.depositToShared(
			account.id,
			userId,
			amount,
		);

		if (!result.success) {
			await ctx.reply(`Deposit failed: ${result.error || "Unknown error"}`);
			return;
		}

		await ctx.reply(
			fmt`${bold("Deposit Successful")}\n\nTo: ${account.displayName || accountName}\nAmount: ${code(`${amount.toFixed(6)} JUNO`)}\nYour New Balance: ${code(`${result.userBalance?.toFixed(6) || "0"} JUNO`)}\nAccount Balance: ${code(`${result.sharedBalance?.toFixed(6) || "0"} JUNO`)}`,
		);

		StructuredLogger.logTransaction("Shared account deposit", {
			userId,
			accountId: account.id.toString(),
			amount: amount.toString(),
			operation: "shared_deposit",
		});
	} catch (error) {
		logger.error("Shared deposit failed", { userId: ctx.from?.id, error });
		await ctx.reply("Deposit failed");
	}
}

/**
 * /myshared - Lists all shared accounts user has access to
 * Usage: /myshared
 * Permission: Any user
 */
async function handleMyShared(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const permissions = await SharedAccountService.listUserPermissions(userId);

		if (permissions.length === 0) {
			await ctx.reply("You do not have access to any shared accounts.");
			return;
		}

		const parts = [bold("Your Shared Accounts"), "\n\n"];

		for (const permission of permissions) {
			const account = await SharedAccountService.getSharedAccount(
				permission.sharedAccountId,
			);
			if (!account) continue;

			const balance = await UnifiedWalletService.getSharedBalance(account.id);

			parts.push(bold(account.displayName || account.name), "\n");
			parts.push(`├─ Name: ${code(account.name)}\n`);
			parts.push(`├─ Permission: ${permission.permissionLevel}\n`);
			if (permission.spendLimit) {
				parts.push(
					`├─ Spend Limit: ${permission.spendLimit.toString()} JUNO\n`,
				);
			}
			parts.push(`├─ Balance: ${code(`${balance.toFixed(6)} JUNO`)}\n`);
			if (account.description) {
				parts.push(`└─ ${account.description}\n`);
			}
			parts.push("\n");
		}

		await ctx.reply(fmt(parts));
	} catch (error) {
		logger.error("My shared accounts failed", { userId: ctx.from?.id, error });
		await ctx.reply("Failed to list accounts");
	}
}

/**
 * /sharedinfo - Shows detailed info about a shared account
 * Usage: /sharedinfo <account_name>
 * Permission: Any user with access
 */
async function handleSharedInfo(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 1) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/sharedinfo <account_name>")}\nExample: ${code("/sharedinfo admin_pool")}`,
			);
			return;
		}

		const accountName = args[0];

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Check if user has access
		const userPermission = await SharedAccountService.getUserPermission(
			account.id,
			userId,
		);
		if (!userPermission) {
			await ctx.reply(
				`You do not have access to shared account '${accountName}'.`,
			);
			return;
		}

		const balance = await UnifiedWalletService.getSharedBalance(account.id);
		const permissions = await SharedAccountService.listAccountPermissions(
			account.id,
		);

		const parts = [
			bold(account.displayName || accountName),
			"\n\n",
			`Name: ${code(account.name)}\n`,
			`Account ID: ${code(account.id.toString())}\n`,
			`Balance: ${code(`${balance.toFixed(6)} JUNO`)}\n`,
		];
		if (account.description) {
			parts.push(`Description: ${account.description}\n`);
		}
		parts.push(
			`\n${bold("Access List")} (${permissions.length.toString()} users):\n\n`,
		);

		for (const perm of permissions) {
			const { getUserById } = await import("../services/userService");
			const user = getUserById(perm.userId);
			const username = user?.username || `user_${perm.userId}`;

			parts.push(`• @${username}: ${perm.permissionLevel}`);
			if (perm.spendLimit) {
				parts.push(` (limit: ${perm.spendLimit.toString()} JUNO)`);
			}
			parts.push("\n");
		}

		await ctx.reply(fmt(parts));
	} catch (error) {
		logger.error("Shared info failed", { userId: ctx.from?.id, error });
		await ctx.reply("Failed to get account info");
	}
}

/**
 * /sharedhistory - Shows transaction history for shared account
 * Usage: /sharedhistory <account_name> [limit]
 * Permission: View permission required
 */
async function handleSharedHistory(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const text = (ctx.message as any)?.text || "";
		const args = text.split(" ").slice(1);

		if (args.length < 1) {
			await ctx.reply(
				fmt`${bold("Invalid format")}\n\nUsage: ${code("/sharedhistory <account_name> [limit]")}\nExample: ${code("/sharedhistory admin_pool 20")}`,
			);
			return;
		}

		const accountName = args[0];
		const limit = args[1] ? parseInt(args[1], 10) : 10;

		const account =
			await SharedAccountService.getSharedAccountByName(accountName);
		if (!account) {
			await ctx.reply(`Shared account '${accountName}' not found.`);
			return;
		}

		// Check if user has at least view permission
		if (
			!(await SharedAccountService.hasPermission(account.id, userId, "view"))
		) {
			await ctx.reply(
				"You do not have permission to view this account's history.",
			);
			return;
		}

		const transactions = await UnifiedWalletService.getSharedTransactions(
			account.id,
			limit,
		);

		if (transactions.length === 0) {
			await ctx.reply(
				fmt`${bold("Transaction History")}\n\nNo transactions yet for ${account.displayName || accountName}.`,
			);
			return;
		}

		const parts = [
			bold("Transaction History"),
			"\n\n",
			`Account: ${account.displayName || accountName}\n`,
			`Showing last ${transactions.length.toString()} transactions:\n\n`,
		];

		for (const tx of transactions) {
			const date = new Date(tx.created_at * 1000).toLocaleDateString();
			const direction = tx.from_user_id === account.id ? "→" : "←";
			const amount = tx.amount.toFixed(6);

			parts.push(`${direction} ${amount} JUNO - ${tx.transaction_type}\n`);
			parts.push(`  ${date}`);
			if (tx.description) {
				parts.push(` - ${tx.description}`);
			}
			parts.push("\n\n");
		}

		await ctx.reply(fmt(parts));
	} catch (error) {
		logger.error("Shared history failed", { userId: ctx.from?.id, error });
		await ctx.reply("Failed to get history");
	}
}

/**
 * /listshared - Lists all shared accounts (admin only)
 * Usage: /listshared
 * Permission: Elevated admin only
 */
async function handleListShared(ctx: Context): Promise<void> {
	try {
		const userId = ctx.from?.id;
		if (!userId) return;

		const accounts = await SharedAccountService.listSharedAccounts();

		if (accounts.length === 0) {
			await ctx.reply("No shared accounts exist yet.");
			return;
		}

		const parts = [bold("All Shared Accounts"), "\n\n"];

		for (const account of accounts) {
			const balance = await UnifiedWalletService.getSharedBalance(account.id);
			const permissions = await SharedAccountService.listAccountPermissions(
				account.id,
			);

			parts.push(bold(account.displayName || account.name), "\n");
			parts.push(`├─ Name: ${code(account.name)}\n`);
			parts.push(`├─ ID: ${code(account.id.toString())}\n`);
			parts.push(`├─ Balance: ${balance.toFixed(6)} JUNO\n`);
			parts.push(`└─ Members: ${permissions.length.toString()}\n\n`);
		}

		await ctx.reply(fmt(parts));
	} catch (error) {
		logger.error("List shared accounts failed", {
			userId: ctx.from?.id,
			error,
		});
		await ctx.reply("Failed to list accounts");
	}
}
