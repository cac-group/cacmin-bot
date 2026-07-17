/**
 * Main entry point for the CAC Admin Bot.
 * Initializes the Telegram bot instance, database, wallet services, and all command handlers.
 * Manages periodic cleanup tasks and graceful shutdown.
 *
 * @module bot
 */

import { Telegraf } from "telegraf";
import { registerDepositCommands } from "./commands/deposit";
import { registerDuelCommands } from "./commands/duel";
import { registerFineConfigCommands } from "./commands/fineConfig";
import {
	initializeRollSystem,
	registerGamblingCommands,
	rotateServerSeed,
} from "./commands/gambling";
import { registerGiveawayCommands } from "./commands/giveaway";
import { registerHelpCommand } from "./commands/help";
import { registerJailCommands } from "./commands/jail";
import { registerModerationCommands } from "./commands/moderation";
import { registerPaymentCommands } from "./commands/payment";
import { registerSharedAccountCommands } from "./commands/sharedAccounts";
import { registerStickerCommands } from "./commands/sticker";
import { registerWalletCommands } from "./commands/wallet";
import { registerWalletTestCommands } from "./commands/walletTest";
import { config, validateConfig } from "./config";
import { execute, initDb } from "./database";
import { registerActionHandlers } from "./handlers/actions";
import { registerBlacklistHandlers } from "./handlers/blacklist";
import {
	handleSessionText,
	registerCallbackHandlers,
} from "./handlers/callbacks";
import {
	registerIdentityBlockHandlers,
	registerIdentityBlockModeration,
} from "./handlers/identityBlocks";
import { registerReactionSpamHandler } from "./handlers/reactionSpam";
import { registerRestrictionHandlers } from "./handlers/restrictions";
import { registerRoleHandlers } from "./handlers/roles";
import { registerSpamReactHandlers } from "./handlers/spamReacts";
import { registerViolationHandlers } from "./handlers/violations";
import { messageFilterMiddleware } from "./middleware/messageFilter";
import { ChatIndexerService } from "./services/chatIndexerService";
import { ChatInteractionIndexerService } from "./services/chatInteractionIndexerService";
import { DuelService } from "./services/duelService";
import { JailService } from "./services/jailService";
import { LedgerService } from "./services/ledgerService";
import { PriceService } from "./services/priceService";
import { RestrictionService } from "./services/restrictionService";
import { TransactionLockService } from "./services/transactionLock";
import { UnifiedWalletService } from "./services/unifiedWalletService";
import { setBotInstance } from "./utils/adminNotify";
import { waitForBotLaunch } from "./utils/botLifecycle";
import { logger } from "./utils/logger";

/**
 * Main initialization and startup function for the CAC Admin Bot.
 *
 * Performs the following initialization sequence:
 * 1. Validates configuration from environment variables
 * 2. Initializes SQLite database and creates tables
 * 3. Initializes ledger system for internal accounting
 * 4. Initializes unified wallet system with deposit monitoring
 * 5. Cleans up stale transaction locks from previous session
 * 6. Creates Telegraf bot instance
 * 7. Registers all middleware and command handlers
 * 8. Sets up periodic cleanup tasks (restrictions, jails, locks, reconciliation)
 * 9. Configures graceful shutdown handlers
 * 10. Launches the bot
 *
 * @throws {Error} If configuration validation fails or bot cannot start
 *
 * @example
 * ```typescript
 * // Bot is started automatically when the module is loaded
 * // The main() function handles all initialization
 * ```
 */
async function main() {
	try {
		// Validate configuration
		validateConfig();

		// Initialize database
		initDb();

		// Initialize configured owners and admins
		const { createUser, userExists } = await import("./services/userService");
		for (const ownerId of config.ownerIds) {
			if (!userExists(ownerId)) {
				createUser(
					ownerId,
					`owner_${ownerId}`,
					"owner",
					"config_initialization",
				);
				logger.info(`Created owner from config: ${ownerId}`);
			} else {
				// Update existing user to owner role if not already
				execute("UPDATE users SET role = ? WHERE id = ?", ["owner", ownerId]);
				logger.info(`Updated existing user to owner role: ${ownerId}`);
			}
		}
		for (const adminId of config.adminIds) {
			if (!userExists(adminId)) {
				createUser(
					adminId,
					`admin_${adminId}`,
					"admin",
					"config_initialization",
				);
				// Set elevated flag for admins
				execute("UPDATE users SET elevated = 1 WHERE id = ?", [adminId]);
				logger.info(`Created admin from config: ${adminId}`);
			} else {
				// Update existing user to admin role if not already
				execute("UPDATE users SET role = ?, elevated = 1 WHERE id = ?", [
					"admin",
					adminId,
				]);
				logger.info(`Updated existing user to admin role: ${adminId}`);
			}
		}

		// Initialize ledger system
		LedgerService.initialize();

		// Initialize unified wallet system (includes deposit monitoring)
		await UnifiedWalletService.initialize();

		// Clean up any stale locks from previous session
		await TransactionLockService.cleanExpiredLocks();
		logger.info("Cleaned up stale transaction locks");

		// Initialize roll system (loads RNG state from database)
		await initializeRollSystem();

		// Create bot instance
		const bot = new Telegraf(config.botToken);

		// Cache bot info at startup for efficient reply detection
		const botInfo = await bot.telegram.getMe();

		// Set bot instance for admin notifications
		setBotInstance(bot);

		// Initialize jail service with bot instance
		JailService.initialize(bot);

		// Initialize chat indexer for live message indexing to explorer DB
		ChatInteractionIndexerService.initialize(bot);
		ChatIndexerService.initialize(bot);
		bot.on("edited_message", async (ctx, next) => {
			await ChatIndexerService.indexEditedMessage(ctx);
			await next();
		});

		// Check visible identity before other message filtering or command handlers
		registerIdentityBlockModeration(bot); // Name/username identity block moderation

		// Apply global middleware
		bot.use(messageFilterMiddleware);

		// Register command handlers
		registerHelpCommand(bot);
		registerRoleHandlers(bot);
		registerActionHandlers(bot);
		registerBlacklistHandlers(bot);
		registerViolationHandlers(bot);
		registerRestrictionHandlers(bot);
		registerModerationCommands(bot);
		registerPaymentCommands(bot);
		registerJailCommands(bot);
		registerGiveawayCommands(bot);
		registerDepositCommands(bot); // Deposit management commands
		registerWalletCommands(bot);
		registerWalletTestCommands(bot); // Owner-only test commands
		registerSharedAccountCommands(bot); // Shared account management
		registerStickerCommands(bot); // Sticker sending and management
		registerFineConfigCommands(bot); // Fine configuration and custom jail commands
		registerGamblingCommands(bot); // Roll gambling game
		registerDuelCommands(bot); // Duel 2-player game
		registerCallbackHandlers(bot); // Inline keyboard callback handlers
		registerSpamReactHandlers(bot); // Spam reaction pattern management
		registerIdentityBlockHandlers(bot); // Identity block pattern management
		registerReactionSpamHandler(bot); // Reaction-based spam detection

		// Session text handler for multi-step interactive flows
		// Must be after command handlers to avoid intercepting commands
		bot.on("text", async (ctx, next) => {
			// In groups, only handle direct replies to bot messages
			if (ctx.chat?.type !== "private") {
				const isReplyToBot =
					ctx.message &&
					"reply_to_message" in ctx.message &&
					ctx.message.reply_to_message?.from?.id === botInfo.id;
				if (!isReplyToBot) {
					return next();
				}
			}

			const handled = await handleSessionText(ctx);
			if (!handled) {
				await next();
			}
		});

		// Error handling
		bot.catch((err, ctx) => {
			logger.error("Bot error", { error: err, update: ctx.update });
		});

		// Collect interval IDs for cleanup on shutdown
		const intervals: NodeJS.Timeout[] = [];

		// Periodic cleanup of expired restrictions (every hour)
		intervals.push(
			setInterval(
				() => {
					RestrictionService.cleanExpiredRestrictions();
				},
				60 * 60 * 1000,
			),
		);

		// Periodic cleanup of expired jails (every 5 minutes)
		intervals.push(
			setInterval(
				() => {
					JailService.cleanExpiredJails();
				},
				5 * 60 * 1000,
			),
		);

		// Periodic cleanup of expired transaction locks (every minute)
		intervals.push(
			setInterval(async () => {
				await TransactionLockService.cleanExpiredLocks();
			}, 60 * 1000),
		);

		// Periodic cleanup of expired duels (every minute)
		intervals.push(
			setInterval(async () => {
				await DuelService.cleanExpiredDuels();
			}, 60 * 1000),
		);

		// Periodic balance reconciliation check (every hour)
		intervals.push(
			setInterval(
				async () => {
					try {
						const result = await LedgerService.reconcileAndAlert();
						if (!result.matched) {
							logger.warn("Balance reconciliation mismatch detected", result);
						}
					} catch (error) {
						logger.error("Error during periodic reconciliation", { error });
					}
				},
				60 * 60 * 1000,
			),
		);

		// Periodic JUNO price update (every 15 minutes)
		intervals.push(
			setInterval(
				async () => {
					try {
						await PriceService.updatePriceHistory();
					} catch (error) {
						logger.error("Error updating price history", { error });
					}
				},
				15 * 60 * 1000,
			),
		);

		// Periodic server seed rotation for provable fairness (every hour)
		intervals.push(
			setInterval(
				() => {
					try {
						const { oldHash, newHash } = rotateServerSeed();
						logger.info("Roll server seed rotated", {
							previousCommitment: oldHash.substring(0, 16),
							newCommitment: newHash.substring(0, 16),
						});
					} catch (error) {
						logger.error("Error rotating server seed", { error });
					}
				},
				60 * 60 * 1000,
			),
		);

		// Initial price fetch on startup
		PriceService.updatePriceHistory().catch((error) => {
			logger.warn("Initial price fetch failed", { error });
		});

		// Graceful shutdown -- stop bot, clear intervals, then force exit
		let shutdownRequested = false;
		const shutdown = (signal: string) => {
			shutdownRequested = true;
			logger.info(`Shutting down (${signal})...`);
			for (const id of intervals) {
				clearInterval(id);
			}
			ChatIndexerService.shutdown();
			ChatInteractionIndexerService.shutdown();
			bot.stop(signal);
			// Force exit after 5s -- intervals in services/handlers keep the event loop alive
			setTimeout(() => {
				logger.info("Forcing exit after shutdown timeout");
				process.exit(0);
			}, 5000).unref();
		};
		process.once("SIGINT", () => shutdown("SIGINT"));
		process.once("SIGTERM", () => shutdown("SIGTERM"));

		// Start the bot with message_reaction updates enabled for spam detection
		const launchResult = await waitForBotLaunch(
			() =>
				bot.launch({
					allowedUpdates: [
						"message",
						"edited_message",
						"channel_post",
						"edited_channel_post",
						"callback_query",
						"inline_query",
						"chosen_inline_result",
						"shipping_query",
						"pre_checkout_query",
						"poll",
						"poll_answer",
						"my_chat_member",
						"chat_member",
						"chat_join_request",
						"message_reaction", // Required for reaction spam detection
					],
				}),
			() => shutdownRequested,
		);
		if (launchResult === "stopped") {
			logger.info("Bot stopped cleanly");
			return;
		}
		logger.info("Bot started successfully");
		console.log(" CAC Admin Bot is running...");
	} catch (error) {
		logger.error("Failed to start bot", error);
		console.error("Failed to start bot:", error);
		process.exit(1);
	}
}

// Start the bot
main();
