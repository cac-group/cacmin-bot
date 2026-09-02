import { bold, type FmtString, fmt } from "telegraf/format";

export type HelpRole = "pleb" | "elevated" | "admin" | "owner";

export const ALL_ROLES: readonly HelpRole[] = [
	"pleb",
	"elevated",
	"admin",
	"owner",
];
export const ELEVATED_ROLES: readonly HelpRole[] = [
	"elevated",
	"admin",
	"owner",
];
export const ADMIN_ROLES: readonly HelpRole[] = ["admin", "owner"];
export const OWNER_ROLES: readonly HelpRole[] = ["owner"];

/**
 * A node in the help tree. Leaf nodes carry `content`; branch nodes carry
 * `children`. Every node declares the roles that may view it, so sensitive
 * topics and functions stay hidden from lower-tier users.
 */
export interface HelpNode {
	/** Unique navigation key, e.g. "wallet:account". */
	key: string;
	/** Button label and section heading. */
	title: string;
	/** Roles allowed to access this node and its subtree. */
	roles: readonly HelpRole[];
	/** Leaf content; required when the node has no children. */
	content?: FmtString;
	/** Sub-sections; required when the node has no content. */
	children?: readonly HelpNode[];
}

/** Return true when the given role may access the node. */
export function canAccessHelpNode(node: HelpNode, role: HelpRole): boolean {
	return node.roles.includes(role);
}

/** Recursively locate a node by its full key. */
export function findHelpNode(
	nodes: readonly HelpNode[],
	key: string,
): HelpNode | null {
	for (const node of nodes) {
		if (node.key === key) return node;
		if (node.children) {
			const found = findHelpNode(node.children, key);
			if (found) return found;
		}
	}
	return null;
}

/** Return the parent key for a node key, or null when it has no parent. */
export function parentHelpKey(key: string): string | null {
	const separator = key.lastIndexOf(":");
	return separator === -1 ? null : key.slice(0, separator);
}

/** The role-gated, categorized help tree. */
export const helpTree: readonly HelpNode[] = [
	{
		key: "wallet",
		title: "Wallet",
		roles: ALL_ROLES,
		children: [
			{
				key: "wallet:account",
				title: "Balance & History",
				roles: ALL_ROLES,
				content: fmt([
					bold("Balance & History"),
					"\n\n",
					"/balance (or /bal)\n",
					"  View your current JUNO balance in the internal wallet.\n\n",
					"/transactions [@user|userId] (or /history)\n",
					"  View your 10 most recent transactions. Owners may pass a target user to inspect someone else's history.\n\n",
					"/wallethelp\n",
					"  Display the detailed wallet command reference.",
				]),
			},
			{
				key: "wallet:deposits",
				title: "Deposits",
				roles: ALL_ROLES,
				content: fmt([
					bold("Deposits"),
					"\n\n",
					"/deposit\n",
					"  Get your unique deposit address and memo. Send JUNO from any wallet to this address with your memo to credit your account.\n\n",
					"/verifydeposit <txhash>\n",
					"  Verify and credit a deposit transaction by hash.\n\n",
					"/checkdeposit <txhash> (or /checktx)\n",
					"  Check whether a specific deposit transaction has already been processed.\n\n",
					"/unclaimeddeposits\n",
					"  View the current UNCLAIMED deposit pool and recent deposits that arrived with a missing or invalid memo.",
				]),
			},
			{
				key: "wallet:send",
				title: "Send & Withdraw",
				roles: ALL_ROLES,
				content: fmt([
					bold("Send & Withdraw"),
					"\n\n",
					"/withdraw <amount> <address>\n",
					"  Send JUNO from your internal balance to any external Juno address. Requires sufficient balance plus network fees.\n\n",
					"/send <amount> <user> (or /transfer)\n",
					"  Transfer JUNO to another bot user instantly with no fees, or send to an external Juno address. Use @username, user ID, or juno1....",
				]),
			},
			{
				key: "wallet:treasury",
				title: "Game Treasury",
				roles: ALL_ROLES,
				content: fmt([
					bold("Game Treasury"),
					"\n\n",
					"/fundtreasury <amount>\n",
					"  Transfer JUNO from your balance to the game treasury to support game payouts.\n\n",
					"/fundtreasury deposit\n",
					"  Get external deposit instructions for the game treasury.",
				]),
			},
		],
	},
	{
		key: "shared",
		title: "Shared Accounts",
		roles: ALL_ROLES,
		children: [
			{
				key: "shared:view",
				title: "View",
				roles: ALL_ROLES,
				content: fmt([
					bold("View"),
					"\n\n",
					"/myshared\n",
					"  List all shared accounts you have access to and your permission level (view, spend, admin) for each.\n\n",
					"/sharedbalance <name>\n",
					"  Check the current balance of a shared account. Requires at least view permissions.\n\n",
					"/sharedinfo <name>\n",
					"  View detailed info about a shared account including all members and their permissions.\n\n",
					"/sharedhistory <name> [limit]\n",
					"  View transaction history for a shared account. Requires at least view permissions.",
				]),
			},
			{
				key: "shared:operate",
				title: "Send & Deposit",
				roles: ALL_ROLES,
				content: fmt([
					bold("Send & Deposit"),
					"\n\n",
					"/sharedsend <name> <@username|user_id> <amount> [description]\n",
					"  Send JUNO from a shared account to another bot user. Requires spend or admin permissions and respects spending limits.\n\n",
					"/shareddeposit <name> <amount>\n",
					"  Move JUNO from your own balance into a shared account you can access.",
				]),
			},
			{
				key: "shared:manage",
				title: "Manage",
				roles: ALL_ROLES,
				content: fmt([
					bold("Manage"),
					"\n\n",
					"Management commands require admin permission on the target account.\n\n",
					"/grantaccess <account_name> <@username|user_id> <level> [spend_limit]\n",
					"  Grant another user access to a shared account. Levels: view, spend, admin. Optional spend limit supported.\n\n",
					"/revokeaccess <account_name> <@username|user_id>\n",
					"  Remove a user's access to a shared account.\n\n",
					"/updateaccess <account_name> <@username|user_id> <level> [spend_limit]\n",
					"  Update a user's permission level on a shared account.\n\n",
					"/deleteshared <name>\n",
					"  Delete an empty shared account.",
				]),
			},
		],
	},
	{
		key: "user",
		title: "User",
		roles: ALL_ROLES,
		children: [
			{
				key: "user:profile",
				title: "Profile & Status",
				roles: ALL_ROLES,
				content: fmt([
					bold("Profile & Status"),
					"\n\n",
					"/mystatus\n",
					"  View your complete user profile including role, whitelist and blacklist status, warnings, active jails, and current restrictions.\n\n",
					"/jails\n",
					"  View all currently jailed users, their jail duration, remaining time, and bail amounts.\n\n",
					"/violations\n",
					"  View your violation history including fines, payment status, and violation reasons.",
				]),
			},
			{
				key: "user:restrictions",
				title: "Restrictions (View)",
				roles: ALL_ROLES,
				content: fmt([
					bold("Restrictions (View)"),
					"\n\n",
					"/viewwhitelist\n",
					"  Display all users on the whitelist who are exempt from certain automated restrictions.\n\n",
					"/viewblacklist\n",
					"  Display all blacklisted users and their blacklist reasons.\n\n",
					"/viewactions\n",
					"  View all currently active global restrictions (no stickers, no URLs, etc) applied to the chat.",
				]),
			},
			{
				key: "user:ratelimits",
				title: "Message Rate Limits",
				roles: ALL_ROLES,
				content: fmt([
					bold("Message Rate Limits"),
					"\n\n",
					"/ratelimit\n",
					"  View your 15-minute, 1-hour, and 24-hour character usage, including one-period rollover capacity.\n\n",
					"/ratelimits\n",
					"  Explain rate-limit windows, rollover, enforcement, and paid resets.\n\n",
					"/ratelimitreset <15m|1h|24h>\n",
					"  Purchase a JUNO reset for one usage window. Reply to the instructions with the transaction hash or send it in a DM.\n\n",
					"/verifyratelimitreset <txhash>\n",
					"  Verify the latest purchased rate-limit reset by transaction hash.",
				]),
			},
			{
				key: "user:stickers",
				title: "Stickers",
				roles: ALL_ROLES,
				content: fmt([
					bold("Stickers"),
					"\n\n",
					"/cac\n",
					"  Send the first sticker from the CACGifs pack.\n\n",
					"/sendsticker [name]\n",
					"  Send a named sticker from the CACGifs pack.\n\n",
					"/getsticker\n",
					"  Reply to any sticker to get its file_id for bot configuration.",
				]),
			},
		],
	},
	{
		key: "giveaways",
		title: "Giveaways",
		roles: ALL_ROLES,
		content: fmt([
			bold("Giveaway Commands"),
			"\n\n",
			"/giveaway <amount>\n",
			"  Create an open giveaway funded from your balance. After entering the amount, you will select how many slots (10, 25, 50, or 100) to split it into. Each user can claim one slot.\n\n",
			"/cancelgiveaway [id]\n",
			"  Cancel an active giveaway you created. Unclaimed funds are returned to your balance. Without an ID, shows your active giveaways.\n\n",
			bold("How Giveaways Work:"),
			"\n",
			"  - Funds are debited from your balance into escrow\n",
			"  - A message with a Claim button appears in chat\n",
			"  - Users click Claim to receive their share (one claim per user)\n",
			"  - When all slots are claimed, the giveaway completes\n",
			"  - Owners and admins can fund from the treasury instead\n",
			"  - Cancel anytime to reclaim unclaimed funds",
		]),
	},
	{
		key: "payments",
		title: "Payments",
		roles: ALL_ROLES,
		children: [
			{
				key: "payments:fines",
				title: "Fines",
				roles: ALL_ROLES,
				content: fmt([
					bold("Fines"),
					"\n\n",
					"/payfine [id]\n",
					"  Without an ID, list your unpaid fines and payment instructions. With an ID, show payment details for one specific violation.\n\n",
					"/payfines\n",
					"  View all your unpaid fines with payment options. Direct message only.\n\n",
					"/payallfines\n",
					"  Pay all your outstanding unpaid fines at once from your internal wallet. Direct message only.\n\n",
					"/verifypayment <violationId> <txhash>\n",
					"  Verify an on-chain fine payment for a specific violation.",
				]),
			},
			{
				key: "payments:bail",
				title: "Bail",
				roles: ALL_ROLES,
				content: fmt([
					bold("Bail"),
					"\n\n",
					"/paybail <@username|userId>\n",
					"  Pay your own bail, or specify a jailed user. You can also reply /paybail to their group message.\n\n",
					"/verifybail <@username|userId> <txhash>\n",
					"  Verify a bail payment and release from jail. Reply /verifybail <txhash> to the user's group message to verify for someone else.\n\n",
					"/bailhelp\n",
					"  DM the bot for complete bail payment, transaction verification, and tracking details.",
				]),
			},
		],
	},
	{
		key: "games",
		title: "Games",
		roles: ALL_ROLES,
		children: [
			{
				key: "games:roll",
				title: "Roll",
				roles: ALL_ROLES,
				content: fmt([
					bold("Roll Game"),
					"\n\n",
					"/roll <amount>\n",
					"  Roll a 9-digit number. If the last 2+ digits match (dubs), you win 9x profit!\n\n",
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
			},
			{
				key: "games:duel",
				title: "Duel",
				roles: ALL_ROLES,
				content: fmt([
					bold("Duel Game"),
					"\n\n",
					"/duel <@username|userId> <amount>\n",
					"  Challenge another user to a 1v1 wager. Both players put up the same amount and winner takes all.\n\n",
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
			},
		],
	},
	{
		key: "elevated",
		title: "Elevated",
		roles: ELEVATED_ROLES,
		children: [
			{
				key: "elevated:shared",
				title: "Shared Accounts",
				roles: ELEVATED_ROLES,
				content: fmt([
					bold("Shared Accounts"),
					"\n\n",
					"/createshared <name> <display_name> [description]\n",
					"  Create a new shared account that multiple users can access. Quote multi-word display names or descriptions. You become the initial admin with full permissions.\n\n",
					"/listshared\n",
					"  View all shared accounts in the system, their balances, and admin information.",
				]),
			},
			{
				key: "elevated:moderation",
				title: "Moderation",
				roles: ELEVATED_ROLES,
				content: fmt([
					bold("Moderation"),
					"\n\n",
					"/jailstats [@user|userId]\n",
					"  View active jail status, or pass a user to inspect that user's current jail state and recent jail history.\n\n",
					"/listrestrictions <@username|userId>\n",
					"  View all active restrictions for a user.\n\n",
					"/removerestriction <@username|userId> [type]\n",
					"  Remove one restriction, or omit [type] to remove them all.\n\n",
					"/clearrestrictions <@username|userId>\n",
					"  Remove all content restrictions from a user.",
				]),
			},
			{
				key: "elevated:directory",
				title: "Directory",
				roles: ELEVATED_ROLES,
				content: fmt([
					bold("Directory"),
					"\n\n",
					"/listadmins\n",
					"  View all users with elevated, admin, or owner roles.",
				]),
			},
		],
	},
	{
		key: "admin",
		title: "Admin",
		roles: ADMIN_ROLES,
		children: [
			{
				key: "admin:moderation",
				title: "Moderation",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Moderation"),
					"\n\n",
					"/jail <@username|userId> <minutes> (or /silence)\n",
					"  Jail a user by removing chat permissions for the specified duration. Bail defaults to 69.420 JUNO unless /customjail specifies an amount.\n\n",
					"/unjail <@username|userId> (or /unsilence)\n",
					"  Immediately release a jailed user and restore their chat permissions.\n\n",
					"/warn <@username|userId> <reason>\n",
					"  Issue a formal warning to a user. Increments warning count and creates a violation record.",
				]),
			},
			{
				key: "admin:roles",
				title: "Role Management",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Role Management"),
					"\n\n",
					"/elevate <@username|userId>\n",
					"  Promote a user from 'pleb' to 'elevated' role.\n\n",
					"/revoke <@username|userId>\n",
					"  Demote an elevated user back to 'pleb' role.",
				]),
			},
			{
				key: "admin:restrictions",
				title: "Restrictions",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Restrictions"),
					"\n\n",
					"/addrestriction <@username|userId> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]\n",
					"  Add a content restriction. Supports @username, userId, or reply-to-message.\n",
					"  Types: no_stickers, no_urls, no_media, no_photos, no_videos, no_documents, no_gifs, no_specific_gif, no_voice, no_forwarding, regex_block, random_delete.\n",
					"  no_specific_gif uses [action] as the GIF's file_unique_id (reply to the GIF with /getgifid to get it).\n",
					"  random_delete uses [action] as a chance like 10%, 25, 0.1, or default.\n",
					"  Severity: delete (default), mute, jail. Auto-escalation after threshold (default 5) violations; auto-jails use a 69.420 JUNO bail amount.\n\n",
					"/getgifid\n",
					"  Reply to a GIF to get its file_unique_id for a no_specific_gif restriction.\n\n",
					"/regexhelp\n",
					"  Display regex pattern examples for text blocking.\n\n",
					"/addaction <type> [action]\n",
					"  Add a global restriction that applies to all non-elevated users.\n\n",
					"/removeaction <type>\n",
					"  Remove a global restriction.",
				]),
			},
			{
				key: "admin:ratelimits",
				title: "Rate Limits",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Rate Limits"),
					"\n\n",
					"/listratelimits\n",
					"  List every user with an active rate limit and how much of each window remains.\n\n",
					"/setratelimit <user> <15m_chars>\n",
					"  Configure a user's base limit; 1-hour is 2x and 24-hour is 8x the base. One period of unused capacity rolls over without compounding. Changing an existing limit resets accumulated counts. Emoji count as 2 characters, stickers as 5, and a shared image as 25.\n\n",
					"/clearratelimit <user>\n",
					"  Remove a user's character rate limit.\n\n",
					"/resetratelimit <user>\n",
					"  Clear a user's accumulated rate-limit usage and any active rate-limit mute without changing their configured limits.",
				]),
			},
			{
				key: "admin:whitelist",
				title: "Whitelist / Blacklist",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Whitelist / Blacklist"),
					"\n\n",
					"/addwhitelist <@username|userId> and /removewhitelist <@username|userId>\n",
					"  Manage whitelist entries (exempt from automated restrictions).\n\n",
					"/addblacklist <@username|userId> and /removeblacklist <@username|userId>\n",
					"  Manage blacklist entries (stricter moderation).",
				]),
			},
			{
				key: "admin:treasury",
				title: "Game Treasury",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Game Treasury"),
					"\n\n",
					"/treasurybalance (or /gamebalance)\n",
					"  Check the current game treasury balance available for payouts.\n\n",
					"/contributetreasury <amount>\n",
					"  Contribute JUNO from your balance to the game treasury. Helps fund game payouts like /roll wins.",
				]),
			},
			{
				key: "admin:deposits",
				title: "Deposit Recovery",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Deposit Recovery"),
					"\n\n",
					"/claimdeposit <txhash> <userId|@username>\n",
					"  Manually assign an unclaimed deposit to a known user by user ID or @username.\n\n",
					"/processdeposit <txhash>\n",
					"  Manually process a pending deposit that already contains a valid user ID memo.",
				]),
			},
			{
				key: "admin:patterns",
				title: "Spam & Identity Patterns",
				roles: ADMIN_ROLES,
				content: fmt([
					bold("Spam & Identity Patterns"),
					"\n\n",
					"/listspamreacts\n",
					"  View all active custom spam-reaction profile patterns plus the always-on built-ins.\n\n",
					"/spamreacthelp\n",
					"  Display the field, pattern, and testing guide for spam-reaction matching.\n\n",
					"/listidentityblocks\n",
					"  View active name and username block patterns plus the always-on built-ins.\n\n",
					"/identityblockhelp\n",
					"  Display the field, pattern, and testing guide for identity-block matching.",
				]),
			},
		],
	},
	{
		key: "owner",
		title: "Owner",
		roles: OWNER_ROLES,
		children: [
			{
				key: "owner:roles",
				title: "Role Management",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Role Management"),
					"\n\n",
					"/makeadmin <@username|userId>\n",
					"  Promote a user to admin role with full moderation powers.\n\n",
					"/grantowner <@username|userId>\n",
					"  Grant owner role to another user. Full system access.\n\n",
					"/setowner\n",
					"  Register the caller as an owner when their Telegram ID is already configured in OWNER_ID/OWNER_IDs.",
				]),
			},
			{
				key: "owner:treasury",
				title: "Treasury",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Treasury"),
					"\n\n",
					"/treasury\n",
					"  View treasury and ledger status with on-chain balance.\n\n",
					"/botbalance\n",
					"  Check the bot's on-chain wallet balance.\n\n",
					"/reconcile\n",
					"  Trigger balance reconciliation between ledger and on-chain wallet.\n\n",
					"/adjustbalance <amount> <debit|credit> [reason]\n",
					"  Adjust SYSTEM_RESERVE balance for reconciliation. Debit reduces, credit increases internal total.",
				]),
			},
			{
				key: "owner:gametreasury",
				title: "Game Treasury",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Game Treasury Management"),
					"\n\n",
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
				]),
			},
			{
				key: "owner:stats",
				title: "Statistics",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Statistics"),
					"\n\n",
					"/stats\n",
					"  View comprehensive bot statistics.\n\n",
					"/walletstats\n",
					"  View detailed wallet and transaction statistics.",
				]),
			},
			{
				key: "owner:deposits",
				title: "Deposit Recovery",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Deposit Recovery"),
					"\n\n",
					"/unclaimeddeposits\n",
					"  List deposits without a valid memo (held in UNCLAIMED).\n\n",
					"/processdeposit <txhash>\n",
					"  Process a pending deposit. Extracts user ID from the transaction memo.\n\n",
					"/claimdeposit <txhash> <userId|@username>\n",
					"  Manually assign an unclaimed deposit to a specific known user.",
				]),
			},
			{
				key: "owner:fines",
				title: "Fines Configuration",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Fines Configuration"),
					"\n\n",
					"/setfine <type> <amount_usd> [description]\n",
					"  Set the fine amount in USD for a violation type. Optional description supported.\n\n",
					"/listfines\n",
					"  View all configured fine amounts.\n\n",
					"/initfines\n",
					"  Initialize default fine configuration.\n\n",
					"/customjail <@username|userId> <minutes> <juno_amount> <reason>\n",
					"  Jail a user with a custom fine amount and explicit reason.\n\n",
					"/junoprice\n",
					"  Check the current JUNO price.",
				]),
			},
			{
				key: "owner:moderation",
				title: "Moderation",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Moderation"),
					"\n\n",
					"/clearviolations <@username|userId>\n",
					"  Clear all violations for a user and reset their warning count.",
				]),
			},
			{
				key: "owner:patterns",
				title: "Spam & Identity Block Patterns",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Spam & Identity Block Patterns"),
					"\n\n",
					"Patterns matched against profiles of users who react to messages. Matching users are permanently banned.\n\n",
					"/addspamreact [pattern] [bio|channel|both]\n",
					"  Add a spam reaction pattern. No args for interactive mode.\n\n",
					"/removespamreact <id>\n",
					"  Remove a pattern by its ID.\n\n",
					"/testspamreact <pattern> <sample>\n",
					"  Test a pattern against sample text without saving.\n\n",
					"/listspamreacts\n",
					"  View all active custom patterns.\n\n",
					"/spamreacthelp\n",
					"  Detailed guide with examples.\n\n",
					"Patterns matched against first name, last name, full display name, and username. Matching non-admin users are permanently banned.\n\n",
					"/addidentityblock <pattern> [name|username|both]\n",
					"  Add an identity block pattern for join, message, and chat-member checks.\n\n",
					"/removeidentityblock <id>\n",
					"  Remove an identity block pattern by its ID.\n\n",
					"/testidentityblock <pattern> <sample>\n",
					"  Test an identity block pattern against sample text without saving.\n\n",
					"/listidentityblocks\n",
					"  View all active identity block patterns.\n\n",
					"/identityblockhelp\n",
					"  Detailed guide with examples.",
				]),
			},
			{
				key: "owner:wallet-tests",
				title: "Wallet Test Suite",
				roles: OWNER_ROLES,
				content: fmt([
					bold("Wallet Test Commands"),
					"\n\n",
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
			},
		],
	},
];
