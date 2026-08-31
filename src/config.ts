/**
 * Configuration module for the CAC Admin Bot.
 * Loads environment variables and provides typed configuration object.
 * Validates required configuration values on startup.
 *
 * @module config
 */

import { resolve } from "node:path";
import * as dotenv from "dotenv";
import { logger } from "./utils/logger";

// Load environment variables from .env file
dotenv.config({ path: resolve(__dirname, "../.env") });

/**
 * Configuration interface defining all bot settings.
 *
 * @interface Config
 */
interface Config {
	/** Telegram bot API token from BotFather */
	botToken: string;

	/** HTTP(S) origin for Telegram Bot API requests */
	telegramApiRoot: string;

	/** Optional HTTP(S) origin for serving local Telegram files */
	telegramFileRoot?: string;

	/** Juno blockchain RPC endpoint URL */
	junoRpcUrl: string;

	/** Juno blockchain REST API endpoint URL (optional) */
	junoApiUrl?: string;

	/** Telegram chat ID for admin notifications */
	adminChatId: number;

	/** Telegram group chat ID where bot operates (optional) */
	groupChatId?: number;

	/** Telegram user ID(s) of the bot owner(s) - supports multiple via comma-separated list */
	ownerIds: number[];

	/** Telegram user ID(s) of pre-configured admin(s) - supports multiple via comma-separated list */
	adminIds: number[];

	/** Juno wallet address for user fund operations (optional) */
	userFundsAddress?: string;

	/** BIP39 mnemonic for signing withdrawal transactions (optional) */
	userFundsMnemonic?: string;

	/** Bot treasury Juno wallet address (optional, defaults to userFundsAddress) */
	botTreasuryAddress?: string;

	/** File path to SQLite database */
	databasePath: string;

	/** Logging level (error, warn, info, debug) */
	logLevel: string;

	/**
	 * Legacy fine amounts in JUNO tokens (fallback values).
	 * Actual fines are now calculated using USD amounts from the database
	 * converted to JUNO via the PriceService using CoinGecko rolling averages.
	 * Use /setfine to configure USD-based fine amounts.
	 */
	fineAmounts: {
		/** Fine for sending restricted stickers */
		sticker: number;
		/** Fine for posting restricted URLs */
		url: number;
		/** Fine for matching restricted regex patterns */
		regex: number;
		/** Fine for blacklisted actions */
		blacklist: number;
	};

	/** Duration settings for various restriction types */
	restrictionDurations: {
		/** Warning duration in milliseconds */
		warning: number;
		/** Mute duration in milliseconds */
		mute: number;
		/** Temporary ban duration in milliseconds */
		tempBan: number;
	};

	/** Whether the chat indexer feature is enabled */
	indexerEnabled: boolean;

	/** Path to the indexer dataset SQLite database */
	indexerDbPath?: string;

	/** Dataset ID for media path construction */
	indexerDatasetId?: string;

	/** Base directory for downloaded media files */
	indexerMediaDir?: string;

	/** Whether cacmin-bot should run its own embedding batch loop */
	indexerEmbeddingsEnabled: boolean;

	/** File to touch when enough live rows are ready for external embedding */
	indexerEmbedTriggerFile?: string;

	/** Number of eligible live inserts before touching the external embedding trigger */
	indexerEmbedTriggerBatchSize: number;

	/** Ollama API endpoint URL */
	ollamaUrl: string;

	/** Ollama embedding model name */
	embedModel: string;

	/** Ollama vision model name for image descriptions */
	visionModel: string;

	/** Interval in ms between embedding batch runs (default: 5 min) */
	embedBatchIntervalMs: number;

	/** JUNO fees for clearing each message rate-limit window */
	rateLimitResetFees: { "15m": number; "1h": number; "24h": number };
}

function parseNonNegativeInteger(
	value: string | undefined,
	fallback: number,
): number {
	if (!value) return fallback;
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveNumber(
	value: string | undefined,
	fallback: number,
): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface TelegramEndpointConfig {
	telegramApiRoot: string;
	telegramFileRoot?: string;
}

function normalizeHttpOrigin(value: string, variableName: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${variableName} must be an HTTP(S) origin`);
	}

	const hasOnlyTrailingSlashes = /^\/+$/.test(url.pathname);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		!hasOnlyTrailingSlashes ||
		url.search ||
		url.hash
	) {
		throw new Error(`${variableName} must be an HTTP(S) origin`);
	}

	return url.origin;
}

export function parseTelegramEndpointConfig(
	environment: NodeJS.ProcessEnv,
): TelegramEndpointConfig {
	const apiRoot =
		environment.TELEGRAM_API_ROOT?.trim() || "https://api.telegram.org";
	const fileRoot = environment.TELEGRAM_FILE_ROOT?.trim();

	return {
		telegramApiRoot: normalizeHttpOrigin(apiRoot, "TELEGRAM_API_ROOT"),
		telegramFileRoot: fileRoot
			? normalizeHttpOrigin(fileRoot, "TELEGRAM_FILE_ROOT")
			: undefined,
	};
}

const telegramEndpoints = parseTelegramEndpointConfig(process.env);

/**
 * Main configuration object populated from environment variables.
 * Falls back to default values where appropriate.
 *
 * @constant config
 * @type {Config}
 */
export const config: Config = {
	botToken: process.env.BOT_TOKEN || "",
	...telegramEndpoints,
	junoRpcUrl: process.env.JUNO_RPC_URL || "https://rpc.juno.basementnodes.ca",
	junoApiUrl: process.env.JUNO_API_URL || "https://api.juno.basementnodes.ca",
	adminChatId: parseInt(process.env.ADMIN_CHAT_ID || "0", 10),
	groupChatId: process.env.GROUP_CHAT_ID
		? parseInt(process.env.GROUP_CHAT_ID, 10)
		: undefined,
	ownerIds: (process.env.OWNER_ID || "")
		.split(",")
		.map((id) => parseInt(id.trim(), 10))
		.filter((id) => !Number.isNaN(id)),
	adminIds: (process.env.ADMIN_ID || "")
		.split(",")
		.map((id) => parseInt(id.trim(), 10))
		.filter((id) => !Number.isNaN(id)),
	userFundsAddress: process.env.USER_FUNDS_ADDRESS,
	userFundsMnemonic: process.env.USER_FUNDS_MNEMONIC,
	botTreasuryAddress:
		process.env.BOT_TREASURY_ADDRESS || process.env.USER_FUNDS_ADDRESS,
	databasePath: process.env.DATABASE_PATH || "./data/bot.db",
	logLevel: process.env.LOG_LEVEL || "info",
	fineAmounts: {
		sticker: 1.0,
		url: 2.0,
		regex: 1.5,
		blacklist: 5.0,
	},
	restrictionDurations: {
		warning: 24 * 60 * 60 * 1000, // 24 hours
		mute: 60 * 60 * 1000, // 1 hour
		tempBan: 7 * 24 * 60 * 60 * 1000, // 7 days
	},

	indexerEnabled: process.env.INDEXER_ENABLED === "true",
	indexerDbPath: process.env.INDEXER_DB_PATH,
	indexerDatasetId: process.env.INDEXER_DATASET_ID,
	indexerMediaDir: process.env.INDEXER_MEDIA_DIR,
	indexerEmbeddingsEnabled: process.env.INDEXER_EMBEDDINGS_ENABLED === "true",
	indexerEmbedTriggerFile:
		process.env.INDEXER_EMBED_TRIGGER_FILE ||
		process.env.LIVE_EMBED_TRIGGER_FILE,
	indexerEmbedTriggerBatchSize: parseNonNegativeInteger(
		process.env.INDEXER_EMBED_TRIGGER_BATCH_SIZE ||
			process.env.LIVE_EMBED_TRIGGER_BATCH_SIZE,
		25,
	),
	ollamaUrl: process.env.OLLAMA_URL || "http://192.168.0.170:26886",
	embedModel: process.env.EMBED_MODEL || "nomic-embed-text",
	visionModel: process.env.VISION_MODEL || "qwen3-vl:2b",
	embedBatchIntervalMs: parseNonNegativeInteger(
		process.env.EMBED_BATCH_INTERVAL_MS,
		300000,
	),
	rateLimitResetFees: {
		"15m": parsePositiveNumber(process.env.RATELIMIT_RESET_FEE_15M, 1),
		"1h": parsePositiveNumber(process.env.RATELIMIT_RESET_FEE_1H, 3),
		"24h": parsePositiveNumber(process.env.RATELIMIT_RESET_FEE_24H, 10),
	},
};

/**
 * Validates that all required configuration values are present and valid.
 * Called at bot startup to ensure proper configuration before initialization.
 *
 * Required values:
 * - botToken: Must be set to a valid Telegram bot token
 * - ownerId: Must be set to the Telegram user ID of the bot owner
 *
 * Optional warnings:
 * - userFundsAddress/userFundsMnemonic: If not fully configured, deposit/withdrawal features will be limited
 *
 * @throws {Error} If BOT_TOKEN is not set
 * @throws {Error} If OWNER_ID is not set
 *
 * @example
 * ```typescript
 * // Called at bot startup
 * validateConfig();
 * ```
 */
export function validateConfig(): void {
	if (!config.botToken) {
		throw new Error("BOT_TOKEN is required in environment variables");
	}
	if (!config.ownerIds || config.ownerIds.length === 0) {
		throw new Error(
			"OWNER_ID is required in environment variables (comma-separated for multiple owners)",
		);
	}

	// Warn about ledger system configuration
	if (!config.userFundsAddress || !config.userFundsMnemonic) {
		logger.warn(
			"User funds wallet not fully configured - deposit/withdrawal features will be limited",
		);
	}
}
