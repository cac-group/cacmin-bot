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

	// Handle help category callbacks - specific categories only, exclude 'menu' and 'games'
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
						[{ text: "<- Back to Menu", callback_data: "help_menu" }],
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

	// Handle games sub-menu
	bot.action("help_games", async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const gamesMenuKeyboard: InlineKeyboardMarkup = {
				inline_keyboard: [
					[
						{ text: "Roll", callback_data: "help_games_roll" },
						{ text: "Duel", callback_data: "help_games_duel" },
					],
					[{ text: "<- Back to Menu", callback_data: "help_menu" }],
				],
			};

			await ctx.editMessageText(
				fmt`${bold("Games")}\n\nSelect a game to view commands:`,
				{ reply_markup: gamesMenuKeyboard },
			);
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error("Error showing games menu", { userId, error });
			await ctx.answerCbQuery("Error loading games menu");
		}
	});

	// Handle games sub-categories
	bot.action(/^help_games_(roll|duel)$/, async (ctx) => {
		const game = ctx.match[1];
		const userId = ctx.from?.id;
		if (!userId) return;

		try {
			const helpText = helpContent[`games_${game}`];
			if (!helpText) {
				await ctx.answerCbQuery("Game help not found");
				return;
			}

			const backKeyboard: InlineKeyboardMarkup = {
				inline_keyboard: [
					[{ text: "<- Back to Games", callback_data: "help_games" }],
					[{ text: "<- Back to Menu", callback_data: "help_menu" }],
				],
			};

			await ctx.editMessageText(helpText, {
				reply_markup: backKeyboard,
			});
			await ctx.answerCbQuery();
		} catch (error) {
			logger.error("Error in games help callback", { userId, game, error });
			await ctx.answerCbQuery("Error loading game help");
		}
	});
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
		[
			{ text: "Payments", callback_data: "help_payments" },
			{ text: "Games", callback_data: "help_games" },
		],
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
export const helpContent: Record<string, FmtString> = {
	wallet: fmt([
		bold("Wallet Commands"),
		"\n\n",
		"/balance (or /bal)\n",
		"  View your current JUNO balance in the internal wallet. This shows funds available for transfers and withdrawals.\n\n",
		"/deposit\n",
		"  Get your unique deposit address and memo. Send JUNO from any wallet to this address with your memo to credit your account.\n\n",
		"/verifydeposit <txhash>\n",
		"  Verify and credit a deposit transaction by hash.\n\n",
		"/withdraw <amount> <address>\n",
		"  Send JUNO from your internal balance to any external Juno address. Requires sufficient balance plus network fees.\n\n",
		"/send <amount> <user> (or /transfer)\n",
		"  Transfer JUNO to another bot user instantly with no fees, or send to an external Juno address. Use @username, user ID, or juno1....\n\n",
		"/transactions [@user|userId] (or /history)\n",
		"  View your 10 most recent transactions. Owners can pass a target user to inspect someone else's history.\n\n",
		"/checkdeposit <txhash> (or /checktx)\n",
		"  Check whether a specific deposit transaction has already been processed.\n\n",
		"/unclaimeddeposits\n",
		"  View the current UNCLAIMED deposit pool and recent deposits that arrived with a missing or invalid memo.\n\n",
		"/wallethelp\n",
		"  Display detailed wallet command help and examples.\n\n",
		bold("Game Treasury:"),
		"\n",
		"/fundtreasury <amount>\n",
		"  Transfer JUNO from your balance to the game treasury to support game payouts.\n\n",
		"/fundtreasury deposit\n",
		"  Get external deposit instructions for the game treasury.",
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
		"/sharedsend <name> <@username|user_id> <amount> [description]\n",
		"  Send JUNO from a shared account to another bot user. Requires spend or admin permissions and respects spending limits.\n\n",
		"/shareddeposit <name> <amount>\n",
		"  Move JUNO from your own balance into a shared account you can access.\n\n",
		"/sharedhistory <name> [limit]\n",
		"  View transaction history for a shared account.\n\n",
		"/grantaccess <account_name> <@username|user_id> <level> [spend_limit]\n",
		"  Grant another user access to a shared account. Requires admin permissions. Levels: view, spend, admin. Optional spend limit supported.\n\n",
		"/revokeaccess <account_name> <@username|user_id>\n",
		"  Remove a user's access to a shared account. Requires admin permissions.\n\n",
		"/updateaccess <account_name> <@username|user_id> <level> [spend_limit]\n",
		"  Update a user's permission level on a shared account. Requires admin permissions.\n\n",
		"/deleteshared <name>\n",
		"  Delete an empty shared account. Requires admin permission on the account.",
	]),

	user: fmt([
		bold("User Commands"),
		"\n\n",
		"/mystatus\n",
		"  View your complete user profile including role, whitelist and blacklist status, warnings, active jails, and current restrictions.\n\n",
		"/jails\n",
		"  View all currently jailed users, their jail duration, remaining time, and bail amounts.\n\n",
		"/violations\n",
		"  View your violation history including fines, payment status, and violation reasons.\n\n",
		"/viewwhitelist\n",
		"  Display all users on the whitelist who are exempt from certain automated restrictions.\n\n",
		"/viewblacklist\n",
		"  Display all blacklisted users and their blacklist reasons.\n\n",
		"/viewactions\n",
		"  View all currently active global restrictions (no stickers, no URLs, etc) applied to the chat.\n\n",
		bold("Sticker Commands:"),
		"\n",
		"/cac\n",
		"  Send the first sticker from the CACGifs pack.\n\n",
		"/sendsticker [name]\n",
		"  Send a named sticker from the CACGifs pack.\n\n",
		"/getsticker\n",
		"  Reply to any sticker to get its file_id for bot configuration.",
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
		"- Admins and owners can choose to fund from treasury instead\n",
		"- You can cancel anytime to reclaim unclaimed funds\n",
		"- Each giveaway has a unique ID shown in the confirmation",
	]),

	payments: fmt([
		bold("Payment Commands"),
		"\n\n",
		"/payfine [id]\n",
		"  Without an ID, list your unpaid fines and payment instructions. With an ID, show payment details for one specific violation.\n\n",
		"/payfines\n",
		"  View all your unpaid fines with payment options. Direct message only.\n\n",
		"/payallfines\n",
		"  Pay all your outstanding unpaid fines at once from your internal wallet. Direct message only.\n\n",
		"/paybail\n",
		"  Pay your bail amount to immediately get unjailed. Requires sufficient wallet balance.\n\n",
		"/paybailfor <@username|userId>\n",
		"  Pay bail for another jailed user. Deducts from your balance.\n\n",
		"/verifypayment <violationId> <txhash>\n",
		"  Verify an on-chain fine payment for a specific violation.\n\n",
		"/verifybail <txhash>\n",
		"  Verify an on-chain bail payment transaction.\n\n",
		"/verifybailfor <@username|userId> <txhash>\n",
		"  Verify an on-chain bail payment made for another user.",
	]),

	games_roll: fmt([
		bold("Roll Game"),
		"\n\n",
		"/roll <amount>\n",
		"  Roll a 9-digit number. If the last 2+ digits match (dubs), you win 9x profit!\n\n",
		"  ",
		bold("Rules:"),
		"\n",
		"  - Win condition: Last 2+ digits match\n",
		"  - Win chance: 10% (1 in 10)\n",
		"  - Win payout: 9x profit (get back 10x your bet)\n",
		"  - Bet limits: 0.1 - 100 JUNO\n",
		"  - Fair game: Expected value = 0\n\n",
		"  Example: ",
		code("/roll 5"),
		" to bet 5 JUNO\n\n",
		"/rollstats\n",
		"  View your personal gambling statistics including total rolls, wagered, won, and net profit.\n\n",
		"/rollodds\n",
		"  View detailed game rules, win probabilities, and how the random number generation works.\n\n",
		bold("Match Types:"),
		"\n",
		"  - Dubs (2 match): 10% chance\n",
		"  - Trips (3 match): 1% chance\n",
		"  - Quads (4 match): 0.1% chance\n",
		"  - Higher matches: increasingly rare",
	]),

	games_duel: fmt([
		bold("Duel Game"),
		"\n\n",
		"/duel <@username|userId> <amount>\n",
		"  Challenge another user to a 1v1 wager. Both players put up the same amount and winner takes all.\n\n",
		"  ",
		bold("How it works:"),
		"\n",
		"  1. You challenge a user with ",
		code("/duel @user 10"),
		"\n",
		"  2. Your wager is reserved in escrow immediately\n",
		"  3. Opponent sees Accept/Reject buttons\n",
		"  4. If accepted, the opponent's wager is reserved and both players roll\n",
		"  5. If declined, cancelled, or expired after 5 minutes, the challenger is refunded\n\n",
		"/duelstats\n",
		"  View your duel statistics including wins, losses, and profit.\n\n",
		"/duelhistory [limit]\n",
		"  View your recent completed duels with outcomes and wagers. Optional limit defaults to 10 and caps at 20.\n\n",
		"/duelcancel\n",
		"  Cancel your pending outgoing duel challenge before it is accepted.\n\n",
		bold("Rules:"),
		"\n",
		"  - Bet limits: 0.1 - 50 JUNO\n",
		"  - Both players must have sufficient balance\n",
		"  - Pending duels expire after 5 minutes\n",
		"  - You cannot duel yourself\n",
		"  - Winner takes the full pot (2x bet amount)",
	]),

	elevated: fmt([
		bold("Elevated Commands"),
		"\n\n",
		"/jailstats [@user|userId]\n",
		"  View active jail status, or pass a user to inspect that user's current jail state and recent jail history.\n\n",
		"/createshared <name> <display_name> [description]\n",
		"  Create a new shared account that multiple users can access. Quote multi-word display names or descriptions. You become the initial admin with full permissions.\n\n",
		"/listshared\n",
		"  View all shared accounts in the system, their balances, and admin information.\n\n",
		"/listadmins\n",
		"  View all users with elevated, admin, or owner roles.\n\n",
		"/listrestrictions <@username|userId>\n",
		"  View all active restrictions for a user.\n\n",
		"/removerestriction <@username|userId> [type]\n",
		"  Remove one restriction, or omit [type] to remove them all.\n\n",
		"/clearrestrictions <@username|userId>\n",
		"  Remove all content restrictions from a user.",
	]),

	admin: fmt([
		bold("Admin Commands"),
		"\n\n",
		bold("Moderation:"),
		"\n",
		"/jail <@username|userId> <minutes> (or /silence)\n",
		"  Jail a user by removing chat permissions for the specified duration. User can pay bail to unjail early.\n\n",
		"/unjail <@username|userId> (or /unsilence)\n",
		"  Immediately release a jailed user and restore their chat permissions.\n\n",
		"/warn <@username|userId> <reason>\n",
		"  Issue a formal warning to a user. Increments warning count and creates a violation record.\n\n",
		bold("Role Management:"),
		"\n",
		"/elevate <@username|userId>\n",
		"  Promote a user from 'pleb' to 'elevated' role.\n\n",
		"/revoke <@username|userId>\n",
		"  Demote an elevated user back to 'pleb' role.\n\n",
		bold("Restrictions:"),
		"\n",
		"/addrestriction <@username|userId> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]\n",
		"  Add a content restriction. Supports @username, userId, or reply-to-message.\n",
		"  Types: no_stickers, no_urls, no_media, no_photos, no_videos, no_documents, no_gifs, no_specific_gif, no_voice, no_forwarding, regex_block, random_delete.\n",
		"  no_specific_gif uses [action] as the GIF's file_unique_id (reply to the GIF with /getgifid to get it).\n",
		"  random_delete uses [action] as a chance like 10%, 25, 0.1, or default.\n",
		"  Severity: delete (default), mute, jail. Auto-escalation after threshold (default 5) violations.\n\n",
		"/getgifid\n",
		"  Reply to a GIF to get its file_unique_id for a no_specific_gif restriction.\n\n",
		"/regexhelp\n",
		"  Display regex pattern examples for text blocking.\n\n",
		"/addaction <type> [action]\n",
		"  Add a global restriction that applies to all non-elevated users.\n\n",
		"/removeaction <type>\n",
		"  Remove a global restriction.\n\n",
		bold("Deposit Recovery:"),
		"\n",
		"/claimdeposit <txhash> <userId|@username>\n",
		"  Manually assign an unclaimed deposit to a known user by user ID or @username.\n\n",
		"/processdeposit <txhash>\n",
		"  Manually process a pending deposit that already contains a valid user ID memo.\n\n",
		bold("Whitelist/Blacklist:"),
		"\n",
		"/addwhitelist <@username|userId>\n",
		"  Add a user to the whitelist (exempt from automated restrictions).\n\n",
		"/removewhitelist <@username|userId>\n",
		"  Remove a user from the whitelist.\n\n",
		"/addblacklist <@username|userId>\n",
		"  Add a user to the blacklist (stricter moderation).\n\n",
		"/removeblacklist <@username|userId>\n",
		"  Remove a user from the blacklist.\n\n",
		bold("Game Treasury:"),
		"\n",
		"/treasurybalance (or /gamebalance)\n",
		"  Check the current game treasury balance available for payouts.\n\n",
		"/contributetreasury <amount>\n",
		"  Contribute JUNO from your balance to the game treasury. Helps fund game payouts like /roll wins.\n\n",
		"Owners can fully manage the treasury: transfer to users, withdraw off-chain, move funds between the treasury and reserve, and view full details (see Owner section).",
		bold("Spam Reaction Patterns:"),
		"\n",
		"/listspamreacts\n",
		"  View all active custom spam-reaction profile patterns plus the always-on built-ins.\n\n",
		"/spamreacthelp\n",
		"  Display the field, pattern, and testing guide for spam-reaction matching.\n\n",
		bold("Identity Block Patterns:"),
		"\n",
		"/listidentityblocks\n",
		"  View active name and username block patterns plus the always-on built-ins.\n\n",
		"/identityblockhelp\n",
		"  Display the field, pattern, and testing guide for identity-block matching.",
	]),

	owner: fmt([
		bold("Owner Commands"),
		"\n\n",
		bold("Role Management:"),
		"\n",
		"/makeadmin <@username|userId>\n",
		"  Promote a user to admin role with full moderation powers.\n\n",
		"/grantowner <@username|userId>\n",
		"  Grant owner role to another user. Full system access.\n\n",
		"/setowner\n",
		"  Register the caller as an owner when their Telegram ID is already configured in OWNER_ID/OWNER_IDs.\n\n",
		bold("Treasury:"),
		"\n",
		"/treasury\n",
		"  View treasury and ledger status with on-chain balance.\n\n",
		"/botbalance\n",
		"  Check the bot's on-chain wallet balance.\n\n",
		"/reconcile\n",
		"  Trigger balance reconciliation between ledger and on-chain wallet.\n\n",
		"/adjustbalance <amount> <debit|credit> [reason]\n",
		"  Adjust SYSTEM_RESERVE balance for reconciliation. Debit reduces, credit increases internal total.\n\n",
		bold("Game Treasury Management:"),
		"\n",
		"/treasurybalance (or /gamebalance)\n",
		"  Check the current game treasury balance.\n\n",
		"/withdrawtreasury <amount>\n",
		"  Withdraw JUNO from the game treasury to your balance.\n\n",
		"/treasurytransfer <@user|userId> <amount>\n",
		"  Send JUNO from the game treasury to a specific user's balance.\n\n",
		"/treasurywithdraw <amount> <juno1...address>\n",
		"  Withdraw JUNO from the game treasury directly to an external Juno address.\n\n",
		"/treasuryreserve <amount> <to|from>\n",
		"  Move JUNO between the game treasury and the system reserve account. Use 'to' (treasury -> reserve) or 'from' (reserve -> treasury).\n\n",
		"/treasurydetails\n",
		"  View full treasury details: on-chain address and balance, internal ledger balances, and recent treasury transactions.",
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
		"/processdeposit <txhash>\n",
		"  Process a pending deposit. Extracts user ID from the transaction memo.\n\n",
		"/claimdeposit <txhash> <userId|@username>\n",
		"  Manually assign an unclaimed deposit to a specific known user.\n\n",
		bold("Fines Configuration:"),
		"\n",
		"/setfine <type> <amount_usd> [description]\n",
		"  Set the fine amount in USD for a violation type. Optional description supported.\n\n",
		"/listfines\n",
		"  View all configured fine amounts.\n\n",
		"/initfines\n",
		"  Initialize default fine configuration.\n\n",
		"/customjail <@username|userId> <minutes> <juno_amount> <reason>\n",
		"  Jail a user with a custom fine amount and explicit reason.\n\n",
		"/junoprice\n",
		"  Check current JUNO price.\n\n",
		bold("Moderation:"),
		"\n",
		"/clearviolations <@username|userId>\n",
		"  Clear all violations for a user.\n\n",
		bold("Spam Reaction Patterns:"),
		"\n",
		"Manage patterns matched against profiles of users who react to messages. Matching users are permanently banned.\n\n",
		"/addspamreact [pattern] [bio|channel|both]\n",
		"  Add a spam reaction pattern. No args for interactive mode.\n\n",
		"/removespamreact <id>\n",
		"  Remove a pattern by its ID.\n\n",
		"/listspamreacts\n",
		"  View all active custom patterns.\n\n",
		"/testspamreact <pattern> <sample>\n",
		"  Test a pattern against sample text without saving.\n\n",
		"/spamreacthelp\n",
		"  Detailed guide with examples.\n\n",
		bold("Identity Block Patterns:"),
		"\n",
		"Manage patterns matched against first name, last name, full display name, and username. Matching non-admin users are permanently banned.\n\n",
		"/addidentityblock <pattern> [name|username|both]\n",
		"  Add an identity block pattern for join, message, and chat-member checks.\n\n",
		"/removeidentityblock <id>\n",
		"  Remove an identity block pattern by its ID.\n\n",
		"/listidentityblocks\n",
		"  View all active identity block patterns.\n\n",
		"/testidentityblock <pattern> <sample>\n",
		"  Test an identity block pattern against sample text without saving.\n\n",
		"/identityblockhelp\n",
		"  Detailed guide with examples.\n\n",
		bold("Wallet Test Commands:"),
		"\n",
		"/testbalance\n",
		"  Check your internal balance and the bot treasury balance.\n\n",
		"/testdeposit\n",
		"  Show the raw deposit address and memo generated for you.\n\n",
		"/testtransfer <toUserId> <amount>\n",
		"  Run a direct internal transfer test to another user ID.\n\n",
		"/testfine [amount]\n",
		"  Run a fine-payment test from your own balance.\n\n",
		"/testwithdraw <address> <amount>\n",
		"  Run a dry-run withdrawal validation without broadcasting a transaction.\n\n",
		"/testverify <txhash>\n",
		"  Test on-chain transaction verification for a specific hash.\n\n",
		"/testwalletstats\n",
		"  Dump detailed wallet and reconciliation stats for diagnostics.\n\n",
		"/testsimulatedeposit [userId] [amount]\n",
		"  Simulate a deposit directly into the ledger for testing.\n\n",
		"/testhistory\n",
		"  Show a short recent transaction history sample.\n\n",
		"/testfullflow\n",
		"  Run the full wallet-flow integration test sequence from inside the bot.",
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
