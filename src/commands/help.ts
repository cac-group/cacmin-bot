/**
 * Help command handler for the CAC Admin Bot.
 * Provides comprehensive, role-based command reference accessible via DM.
 *
 * Displays commands organized by category:
 * - Wallet commands (deposits, withdrawals, transfers, transactions)
 * - Shared account commands (create, manage, use shared wallets)
 * - User commands (status, jails, violations)
 * - Payment commands (fines, bail)
 * - Elevated commands (view lists, restrictions, create shared accounts)
 * - Admin commands (moderation, treasury, role management)
 * - Owner commands (advanced role management, test suite, full access)
 *
 * @module commands/help
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, type FmtString, fmt } from "telegraf/format";
import type { InlineKeyboardMarkup } from "telegraf/types";
import { get } from "../database";
import { ensureUserExists } from "../services/userService";
import type { User } from "../types";
import { logger } from "../utils/logger";

/**
 * Registers the help command with the bot.
 *
 * The help command displays a comprehensive list of available commands
 * based on the user's role (pleb, elevated, admin, owner).
 *
 * Command:
 * - /help - Display role-based command reference (DM only)
 *
 * @param bot - Telegraf bot instance
 *
 * @example
 * ```typescript
 * import { Telegraf } from 'telegraf';
 * import { registerHelpCommand } from './commands/help';
 *
 * const bot = new Telegraf(process.env.BOT_TOKEN);
 * registerHelpCommand(bot);
 * ```
 */
export function registerHelpCommand(bot: Telegraf<Context>): void {
	/**
	 * Command: /help
	 * Display comprehensive, role-based command reference.
	 *
	 * Permission: Any user
	 * Syntax: /help
	 * Location: Direct message only
	 *
	 * Displays different command sets based on user role:
	 * - Universal: Wallet, shared accounts, user status, payment commands
	 * - Elevated: View restrictions, lists, jail statistics, create shared accounts
	 * - Admin: Role management, moderation, treasury, deposits, statistics
	 * - Owner: Owner-specific commands, test suite, view any user's data
	 *
	 * @example
	 * User: /help
	 * Bot: CAC Admin Bot - Command Reference
	 *
	 *      Your Role: `pleb`
	 *
	 *      Wallet Commands:
	 *      /balance - Check your wallet balance
	 *      /deposit - Get deposit instructions
	 *      [... full command list based on role ...]
	 */
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
			const role = user?.role || "pleb";

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

	// Handle back to menu - Register BEFORE regex to prevent matching
	bot.action("help_menu", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
			const role = user?.role || "pleb";

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

	// Handle help category callbacks - specific categories only, exclude 'menu'
	bot.action(
		/^help_(wallet|shared|user|giveaways|payments|elevated|admin|owner)$/,
		async (ctx) => {
			const category = ctx.match[1];
			const userId = ctx.from?.id;
			if (!userId) return;

			try {
				const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
				const role = user?.role || "pleb";

				const helpText = getHelpTextForCategory(category, role);
				if (!helpText) {
					await ctx.answerCbQuery("Category not available for your role");
					return;
				}

				const backKeyboard: InlineKeyboardMarkup = {
					inline_keyboard: [
						[{ text: "← Back to Menu", callback_data: "help_menu" }],
					],
				};

				await ctx.editMessageText(helpText, {
					reply_markup: backKeyboard,
				});
				await ctx.answerCbQuery();
			} catch (error) {
				logger.error("Error in help callback", { userId, category, error });
				await ctx.answerCbQuery("Error loading help category");
			}
		},
	);
}

/**
 * Build the help menu keyboard based on user role
 */
function buildHelpMenu(role: string): InlineKeyboardMarkup {
	const buttons = [
		[
			{ text: "Wallet", callback_data: "help_wallet" },
			{ text: "Shared Accounts", callback_data: "help_shared" },
		],
		[
			{ text: "User", callback_data: "help_user" },
			{ text: "Giveaways", callback_data: "help_giveaways" },
		],
		[{ text: "Payments", callback_data: "help_payments" }],
	];

	// Add elevated, admin, owner buttons based on role
	if (role === "elevated" || role === "admin" || role === "owner") {
		buttons.push([{ text: "Elevated", callback_data: "help_elevated" }]);
	}

	if (role === "admin" || role === "owner") {
		buttons.push([{ text: "Admin", callback_data: "help_admin" }]);
	}

	if (role === "owner") {
		buttons.push([{ text: "Owner", callback_data: "help_owner" }]);
	}

	return { inline_keyboard: buttons };
}

/**
 * Help content map for each category
 */
const helpContent: Record<string, FmtString> = {
	wallet: fmt([
		bold("Wallet Commands"),
		"\n\n",
		"/balance (or /bal)\n",
		"  View your current JUNO balance in the internal wallet. This shows funds available for transfers and withdrawals.\n\n",
		"/deposit\n",
		"  Get your unique deposit address and memo. Send JUNO from any wallet to this address with your memo to credit your account.\n\n",
		"/verifydeposit <txhash>\n",
		"  Verify a deposit transaction and check its processing status.\n\n",
		"/withdraw <amount> <address>\n",
		"  Send JUNO from your internal balance to any external Juno address. Requires sufficient balance plus network fees.\n\n",
		"/send <amount> <user> (or /transfer)\n",
		"  Transfer JUNO to another bot user instantly with no fees. Use @username or user ID.\n\n",
		"/transactions [limit] (or /history)\n",
		"  View your transaction history including deposits, withdrawals, transfers, and fines. Optional limit parameter (default: 10).\n\n",
		"/checkdeposit <txhash> (or /checktx)\n",
		"  Check the status of a specific deposit transaction.\n\n",
		"/wallethelp\n",
		"  Display detailed wallet command help and examples.",
	]),

	shared: fmt([
		bold("Shared Account Commands"),
		"\n\n",
		"/myshared\n",
		"  List all shared accounts you have access to and your permission level (view, spend, admin) for each.\n\n",
		"/sharedbalance <name>\n",
		"  Check the current balance of a shared account. You must have at least view permissions.\n\n",
		"/sharedinfo <name>\n",
		"  View detailed info about a shared account including all members and their permissions.\n\n",
		"/sharedsend <name> <amount> <user>\n",
		"  Send JUNO from a shared account to another user. Requires spend or admin permissions and respects spending limits.\n\n",
		"/shareddeposit <name>\n",
		"  Get deposit instructions for a shared account.\n\n",
		"/sharedhistory <name> [limit]\n",
		"  View transaction history for a shared account.\n\n",
		"/grantaccess <name> <user> <level>\n",
		"  Grant another user access to a shared account. Requires admin permissions. Levels: view, spend, admin.\n\n",
		"/revokeaccess <name> <user>\n",
		"  Remove a user's access to a shared account. Requires admin permissions.\n\n",
		"/updateaccess <name> <user> <level>\n",
		"  Update a user's permission level on a shared account. Requires admin permissions.",
	]),

	user: fmt([
		bold("User Commands"),
		"\n\n",
		"/mystatus\n",
		"  View your complete user profile including role, whitelist/blacklist status, warnings, active jails, and current restrictions.\n\n",
		"/jails\n",
		"  View all currently jailed users, their jail duration, remaining time, and bail amounts.\n\n",
		"/violations\n",
		"  View your violation history including fines, payment status, and violation reasons.\n\n",
		"/viewwhitelist\n",
		"  Display all users on the whitelist who are exempt from certain automated restrictions.\n\n",
		"/viewblacklist\n",
		"  Display all blacklisted users and their blacklist reasons.\n\n",
		"/viewactions\n",
		"  View all currently active global restrictions (no stickers, no URLs, etc) applied to the chat.",
	]),

	giveaways: fmt([
		bold("Giveaway Commands"),
		"\n\n",
		"/giveaway <amount>\n",
		"  Create an open giveaway funded from your balance. After entering the amount, you'll select how many slots (10, 25, 50, or 100) to split it into. Each user can claim one slot.\n\n",
		"  Example: ",
		code("/giveaway 100"),
		" with 10 slots = 10 JUNO per claim\n\n",
		"/cancelgiveaway [id]\n",
		"  Cancel an active giveaway you created. Unclaimed funds are returned to your balance. Without an ID, shows your active giveaways.\n\n",
		bold("How Giveaways Work:"),
		"\n",
		"1. Run ",
		code("/giveaway <amount>"),
		" with the total JUNO to give away\n",
		"2. Select number of slots (10, 25, 50, or 100)\n",
		"3. Funds are debited from your balance into escrow\n",
		"4. A message with a Claim button appears in chat\n",
		"5. Users click Claim to receive their share (one claim per user)\n",
		"6. When all slots are claimed, the giveaway completes\n\n",
		bold("Notes:"),
		"\n",
		"- Admins/owners can choose to fund from treasury instead\n",
		"- You can cancel anytime to reclaim unclaimed funds\n",
		"- Each giveaway has a unique ID shown in the confirmation",
	]),

	payments: fmt([
		bold("Payment Commands"),
		"\n\n",
		"/payfine <id>\n",
		"  Pay a specific fine by its violation ID. Deducts the fine amount from your wallet balance.\n\n",
		"/payfines\n",
		"  View all your unpaid fines with payment options.\n\n",
		"/payallfines\n",
		"  Pay all your outstanding unpaid fines at once. Shows total amount before confirmation.\n\n",
		"/paybail\n",
		"  Pay your bail amount to immediately get unjailed. Requires sufficient wallet balance.\n\n",
		"/paybailfor <user>\n",
		"  Pay bail for another jailed user. Deducts from your balance.\n\n",
		"/verifypayment <txhash>\n",
		"  Verify an on-chain fine payment transaction.\n\n",
		"/verifybail <txhash>\n",
		"  Verify an on-chain bail payment transaction.\n\n",
		"/verifybailfor <user> <txhash>\n",
		"  Verify an on-chain bail payment made for another user.",
	]),

	elevated: fmt([
		bold("Elevated Commands"),
		"\n\n",
		"/jailstats\n",
		"  View comprehensive jail statistics including total jails, active jails, average duration, and bail revenue.\n\n",
		"/createshared <name>\n",
		"  Create a new shared account that multiple users can access. You become the initial admin with full permissions.\n\n",
		"/listshared\n",
		"  View all shared accounts in the system, their balances, and admin information.\n\n",
		"/listadmins\n",
		"  View all users with admin or owner roles.\n\n",
		"/listrestrictions <user>\n",
		"  View all active restrictions for a user.\n\n",
		"/removerestriction <user> <type>\n",
		"  Remove a specific content restriction from a user.",
	]),

	admin: fmt([
		bold("Admin Commands"),
		"\n\n",
		bold("Moderation:"),
		"\n",
		"/jail <user> <minutes> (or /silence)\n",
		"  Jail a user by removing chat permissions for the specified duration. User can pay bail to unjail early.\n\n",
		"/unjail <user> (or /unsilence)\n",
		"  Immediately release a jailed user and restore their chat permissions.\n\n",
		"/warn <user> <reason>\n",
		"  Issue a formal warning to a user. Increments warning count and creates a violation record.\n\n",
		bold("Role Management:"),
		"\n",
		"/elevate <user>\n",
		"  Promote a user from 'pleb' to 'elevated' role.\n\n",
		"/revoke <user>\n",
		"  Demote an elevated user back to 'pleb' role.\n\n",
		bold("Restrictions:"),
		"\n",
		"/addrestriction <user> <type> [action] [until] [severity]\n",
		"  Add a content restriction. Types: no_stickers, no_urls, no_media, no_photos, no_videos, no_documents, no_gifs, no_voice, no_forwarding, regex_block, muted. Severity: delete, mute, jail.\n\n",
		"/regexhelp\n",
		"  Display regex pattern examples for text blocking.\n\n",
		"/addaction <type> [action]\n",
		"  Add a global restriction that applies to all non-elevated users.\n\n",
		"/removeaction <type>\n",
		"  Remove a global restriction.\n\n",
		bold("Whitelist/Blacklist:"),
		"\n",
		"/addwhitelist <user>\n",
		"  Add a user to the whitelist (exempt from automated restrictions).\n\n",
		"/removewhitelist <user>\n",
		"  Remove a user from the whitelist.\n\n",
		"/addblacklist <user>\n",
		"  Add a user to the blacklist (stricter moderation).\n\n",
		"/removeblacklist <user>\n",
		"  Remove a user from the blacklist.",
	]),

	owner: fmt([
		bold("Owner Commands"),
		"\n\n",
		bold("Role Management:"),
		"\n",
		"/makeadmin <user>\n",
		"  Promote a user to admin role with full moderation powers.\n\n",
		"/grantowner <user>\n",
		"  Grant owner role to another user. Full system access.\n\n",
		"/setowner <user>\n",
		"  Set the primary owner (first-time setup only).\n\n",
		bold("Treasury:"),
		"\n",
		"/treasury\n",
		"  View treasury and ledger status with on-chain balance.\n\n",
		"/botbalance\n",
		"  Check the bot's on-chain wallet balance.\n\n",
		"/reconcile\n",
		"  Trigger balance reconciliation between ledger and on-chain wallet.\n\n",
		"/adjustbalance <user> <amount> [reason]\n",
		"  Manually adjust a user's balance (positive to add, negative to subtract).\n\n",
		bold("Statistics:"),
		"\n",
		"/stats\n",
		"  View comprehensive bot statistics.\n\n",
		"/walletstats\n",
		"  View detailed wallet and transaction statistics.\n\n",
		bold("Deposits:"),
		"\n",
		"/unclaimeddeposits\n",
		"  List deposits without valid memo (held in UNCLAIMED).\n\n",
		"/processdeposit <txhash> <userid>\n",
		"  Manually assign an unclaimed deposit to a user.\n\n",
		"/claimdeposit <txhash>\n",
		"  Process a specific deposit claim.\n\n",
		bold("Fines Configuration:"),
		"\n",
		"/setfine <type> <amount>\n",
		"  Set the fine amount for a violation type.\n\n",
		"/listfines\n",
		"  View all configured fine amounts.\n\n",
		"/initfines\n",
		"  Initialize default fine configuration.\n\n",
		"/customjail <user> <min> <fine> [reason]\n",
		"  Jail with custom fine amount.\n\n",
		"/junoprice\n",
		"  Check current JUNO price.\n\n",
		bold("Moderation:"),
		"\n",
		"/clearviolations <user>\n",
		"  Clear all violations for a user.",
	]),
};

/**
 * Role requirements for each help category
 */
const categoryRoleRequirements: Record<string, string[]> = {
	wallet: ["pleb", "elevated", "admin", "owner"],
	shared: ["pleb", "elevated", "admin", "owner"],
	user: ["pleb", "elevated", "admin", "owner"],
	giveaways: ["pleb", "elevated", "admin", "owner"],
	payments: ["pleb", "elevated", "admin", "owner"],
	elevated: ["elevated", "admin", "owner"],
	admin: ["admin", "owner"],
	owner: ["owner"],
};

/**
 * Get help text for a specific category
 */
function getHelpTextForCategory(
	category: string,
	role: string,
): FmtString | null {
	const allowedRoles = categoryRoleRequirements[category];
	if (!allowedRoles || !allowedRoles.includes(role)) {
		return null;
	}
	return helpContent[category] || null;
}
