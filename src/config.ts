/**
 * Configuration module for the CAC Admin Bot.
 * Loads environment variables and provides typed configuration object.
 * Validates required configuration values on startup.
 *
 * This is the single source of truth for tunable values: scheduler intervals,
 * detection thresholds, game economics, chain fee settings, session timings,
 * and bot branding. Runtime code should import `config` rather than declaring
 * module-level constants.
 *
 * @module config
 */

import { logger } from "./utils/logger";

/**
 * Environment variables are loaded natively: Bun reads `.env` from the working
 * directory in production, and tests seed `process.env` in `tests/setup.ts`.
 */

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

	/** Juno blockchain REST API endpoint URL */
	junoApiUrl: string;

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

	/** Concurrency limit for Ollama embedding requests */
	indexerEmbedConcurrency: number;

	/** Number of reply-chain messages to include as context on each side */
	indexerThreadWindow: number;

	/** Number of temporal neighbor messages to include as fallback context */
	indexerLocalWindow: number;

	/** Max characters for contextual embedding text */
	indexerMaxContextChars: number;

	/** Minimum message/caption length the explorer embedding worker will process */
	indexerEmbedTriggerMinTextLength: number;

	/** Member tags applied automatically on group join, keyed by Telegram user id */
	memberTags: Map<number, string>;

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

	/** Minutes an identity-blocked user is jailed instead of permanently banned */
	identityBlockJailMinutes: number;

	/** Minutes a reaction-spam offender is jailed (never banned/kicked) */
	reactionSpamJailMinutes: number;

	/**
	 * Seconds added to a user's rejoin cooldown on each leave/rejoin, and the
	 * size of the first mute. The mute pauses while the user is away. 0 disables.
	 */
	rejoinCooldownSeconds: number;

	/** Group flood limiter settings (delete recent burst and jail the sender) */
	spamLimit: {
		/** Messages allowed within the window before enforcement (0 disables) */
		maxMessages: number;
		/** Sliding window length in milliseconds */
		windowMs: number;
		/** Number of the sender's most recent messages to delete on a burst */
		deleteCount: number;
		/** Jail duration in minutes */
		jailMinutes: number;
	};

	/**
	 * Periodic background task intervals in milliseconds. Keys name the task,
	 * not the schedule: each is passed straight to `setInterval`.
	 */
	intervals: {
		/** Expired restriction cleanup */
		restrictionCleanupMs: number;
		/** Expired chat-mute cleanup */
		muteCleanupMs: number;
		/** Identity crawl batch run */
		identityCrawlMs: number;
		/** Expired jail cleanup */
		jailCleanupMs: number;
		/** Deposit/bail listener poll */
		depositCheckMs: number;
		/** Expired transaction-lock cleanup */
		transactionLockCleanupMs: number;
		/** Expired duel cleanup */
		duelCleanupMs: number;
		/** Ledger balance reconciliation */
		reconciliationMs: number;
		/** JUNO price history update */
		priceUpdateMs: number;
		/** Provable-fairness server seed rotation */
		seedRotationMs: number;
	};

	/** Reaction-spam detection tuning */
	reactionSpam: {
		/** Lifetime group messages after which a user is exempt from spam checks */
		newUserMessageLimit: number;
		/** Account age (seconds) after which a member is treated as established */
		newUserMaxAgeSeconds: number;
		/** Max reactions allowed within the window before a velocity jail */
		velocityReactionLimit: number;
		/** Time window in milliseconds for velocity tracking */
		velocityWindowMs: number;
		/** How often to prune stale entries from the velocity tracker */
		velocityCleanupIntervalMs: number;
		/** How often to prune the established-user exemption cache */
		establishedCacheCleanupIntervalMs: number;
		/** Built-in bio patterns that indicate a spam bot */
		bioPatterns: RegExp[];
		/** Fun messages randomly selected when jailing a reaction spammer */
		jailMessages: string[];
	};

	/** Gambling (/roll) economics */
	gambling: {
		/** Minimum bet in JUNO */
		minBet: number;
		/** Maximum bet in JUNO */
		maxBet: number;
		/** Payout multiplier: profit = bet * winMultiplier */
		winMultiplier: number;
	};

	/** Duel game economics and timing */
	duel: {
		/** Timeout in seconds before an unanswered duel expires */
		timeoutSeconds: number;
		/** Minimum wager in JUNO */
		minWager: number;
		/** Maximum wager in JUNO */
		maxWager: number;
	};

	/** Default bail amount in JUNO for jails without an explicit amount */
	defaultJailBailAmount: number;

	/** Chain transaction fee settings for withdrawals */
	chain: {
		/** Gas price in ujuno, e.g. "0.075ujuno" */
		withdrawalGasPrice: string;
		/** Gas limit for a withdrawal transaction */
		withdrawalGasLimit: number;
	};

	/** JUNO price service settings */
	price: {
		/** How long a fetched price is cached, in milliseconds */
		cacheDurationMs: number;
		/** CoinGecko asset id for JUNO */
		coingeckoId: string;
		/** Rolling average window in hours */
		rollingAverageHours: number;
		/** Days of price history to retain */
		historyRetentionDays: number;
		/** CoinGecko simple-price API URL */
		apiUrl: string;
	};

	/** Interactive session and bot-response timing in milliseconds */
	timing: {
		/** Interactive menu expiry */
		menuExpiryMs: number;
		/** Bot-response dedupe window */
		dedupeWindowMs: number;
		/** Multi-step session timeout */
		sessionTimeoutMs: number;
		/** Cached pattern TTL (identity blocks, spam reacts) */
		patternCacheTtlMs: number;
	};

	/** Input-safety limits and random-delete defaults */
	limits: {
		/** Maximum allowed regex pattern length */
		maxRegexPatternLength: number;
		/** Default random-delete chance, e.g. "10%" */
		randomDeleteDefaultChance: string;
		/** Minimum unique words before random delete can apply */
		randomDeleteMinUniqueWords: number;
	};

	/** Identity crawl tuning */
	identityCrawlThrottleMs: number;
	identityCrawlMaxRetries: number;

	/** Bot branding and support links */
	botIdentity: {
		/** Support bot username without the leading @ (for t.me links) */
		supportUsername: string;
		/** Sticker pack short name (for t.me/addstickers links) */
		stickerPackName: string;
		/** Telegram file id for the first CACGifs sticker (empty when unset) */
		cacgifsFirstStickerId: string;
	};
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

/** Non-negative integer env var with fallback. */
function envInt(name: string, fallback: number): number {
	return parseNonNegativeInteger(process.env[name], fallback);
}

/** Strictly positive number env var with fallback. */
function envPositive(name: string, fallback: number): number {
	return parsePositiveNumber(process.env[name], fallback);
}

/** Trimmed non-empty string env var with fallback. */
function envString(name: string, fallback: string): string {
	return process.env[name]?.trim() || fallback;
}

/**
 * Parses `MEMBER_TAGS` (`<user_id>:<tag>` pairs, comma-separated) into a map
 * keyed by Telegram user id. Tags are applied on join; see handlers/membership.
 * Entries missing an id or tag are ignored.
 */
export function parseMemberTags(
	value: string | undefined,
): Map<number, string> {
	const tags = new Map<number, string>();
	if (!value) return tags;
	for (const entry of value.split(",")) {
		const separator = entry.indexOf(":");
		if (separator < 0) continue;
		const userId = Number.parseInt(entry.slice(0, separator).trim(), 10);
		const tag = entry.slice(separator + 1).trim();
		if (!Number.isNaN(userId) && tag) tags.set(userId, tag);
	}
	return tags;
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

/** Built-in spam-bot bio patterns (content constant, not env-tunable). */
const DEFAULT_SPAM_BIO_PATTERNS = [
	/18\+/i, // "18+" age indicator
	/secret\s*place/i, // "Secret Place" channel promotion
	/hi,?\s*baby/i, // Spam greeting pattern
	/create\s*(a\s*)?similar\s*video/i, // Video creation spam
	/onlyfans/i, // OnlyFans promotion
	/subscribe.*channel/i, // Channel subscription spam
	/adult\s*content/i, // Explicit adult content
	/private\s*video/i, // Private video spam
	/hot\s*(girl|video|content)/i, // Hot content spam
	/click.*link.*bio/i, // Link in bio spam
	/free\s*nudes/i, // Explicit spam
	/dating\s*site/i, // Dating spam
	/meet\s*single/i, // Dating spam
	/sexy?\s*(girl|video|photo)/i, // Explicit content spam
	/\uD83D\uDD1E/, // 18+ emoji
	/bonus\s*\d+\s*\$/i, // "BONUS 1000$" scam channel spam
	/elon\s*musk/i, // Elon Musk crypto scam channels
];

/** Fun reaction-spam jail messages (content constant, not env-tunable). */
const DEFAULT_REACTION_JAIL_MESSAGES = [
	"{name} has been jailed for spamming reactions.",
	"{name} tried to corrupt the chat. The horny police have intervened.",
	"{name} is cooling off in horny jail for reaction spam.",
];

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
	junoRpcUrl: process.env.JUNO_RPC_URL || "https://rpc-archive.junonetwork.io",
	junoApiUrl: process.env.JUNO_API_URL || "https://lcd-archive.junonetwork.io",
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
	// In-house wallet addresses: sourced ONLY from the environment. No bot command
	// may change them — rotate via .env and restart. The frozen `config` below
	// blocks runtime reassignment.
	userFundsAddress: process.env.USER_FUNDS_ADDRESS,
	userFundsMnemonic: process.env.USER_FUNDS_MNEMONIC,
	botTreasuryAddress:
		process.env.BOT_TREASURY_ADDRESS || process.env.USER_FUNDS_ADDRESS,
	databasePath: process.env.DATABASE_PATH || "./data/bot.db",
	logLevel: process.env.LOG_LEVEL || "info",

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
	indexerEmbedConcurrency: envInt("INDEXER_EMBED_CONCURRENCY", 5),
	indexerThreadWindow: envInt("INDEXER_THREAD_WINDOW", 2),
	indexerLocalWindow: envInt("INDEXER_LOCAL_WINDOW", 5),
	indexerMaxContextChars: envInt("INDEXER_MAX_CONTEXT_CHARS", 2000),
	indexerEmbedTriggerMinTextLength: envInt(
		"INDEXER_EMBED_TRIGGER_MIN_TEXT_LENGTH",
		20,
	),
	memberTags: parseMemberTags(process.env.MEMBER_TAGS),
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
	identityBlockJailMinutes: parseNonNegativeInteger(
		process.env.IDENTITY_BLOCK_JAIL_MINUTES,
		1440,
	),
	reactionSpamJailMinutes: parseNonNegativeInteger(
		process.env.REACTION_SPAM_JAIL_MINUTES,
		1440,
	),
	rejoinCooldownSeconds: envInt("REJOIN_COOLDOWN_SECONDS", 60 * 60),
	spamLimit: {
		maxMessages: parseNonNegativeInteger(
			process.env.SPAM_LIMIT_MAX_MESSAGES,
			5,
		),
		windowMs: parseNonNegativeInteger(process.env.SPAM_LIMIT_WINDOW_MS, 5000),
		deleteCount: parseNonNegativeInteger(
			process.env.SPAM_LIMIT_DELETE_COUNT,
			5,
		),
		jailMinutes: parsePositiveNumber(process.env.SPAM_LIMIT_JAIL_MINUTES, 5),
	},
	intervals: {
		restrictionCleanupMs: envInt(
			"RESTRICTION_CLEANUP_INTERVAL_MS",
			60 * 60 * 1000,
		),
		muteCleanupMs: envInt("MUTE_CLEANUP_INTERVAL_MS", 60 * 1000),
		identityCrawlMs: envInt("IDENTITY_CRAWL_INTERVAL_MS", 5 * 60 * 1000),
		jailCleanupMs: envInt("JAIL_CLEANUP_INTERVAL_MS", 5 * 60 * 1000),
		depositCheckMs: envInt("DEPOSIT_CHECK_INTERVAL_MS", 90 * 1000),
		transactionLockCleanupMs: envInt("TX_LOCK_CLEANUP_INTERVAL_MS", 60 * 1000),
		duelCleanupMs: envInt("DUEL_CLEANUP_INTERVAL_MS", 60 * 1000),
		reconciliationMs: envInt("RECONCILIATION_INTERVAL_MS", 60 * 60 * 1000),
		priceUpdateMs: envInt("PRICE_UPDATE_INTERVAL_MS", 15 * 60 * 1000),
		seedRotationMs: envInt("SEED_ROTATION_INTERVAL_MS", 60 * 60 * 1000),
	},
	reactionSpam: {
		newUserMessageLimit: envInt("REACTION_NEW_USER_MESSAGE_LIMIT", 5),
		newUserMaxAgeSeconds: envInt(
			"REACTION_NEW_USER_MAX_AGE_SECONDS",
			14 * 24 * 60 * 60,
		),
		velocityReactionLimit: envInt("REACTION_VELOCITY_REACTION_LIMIT", 3),
		velocityWindowMs: envInt("REACTION_VELOCITY_WINDOW_MS", 60_000),
		velocityCleanupIntervalMs: envInt(
			"REACTION_VELOCITY_CLEANUP_INTERVAL_MS",
			300_000,
		),
		establishedCacheCleanupIntervalMs: envInt(
			"REACTION_ESTABLISHED_CACHE_CLEANUP_INTERVAL_MS",
			1_200_000,
		),
		bioPatterns: DEFAULT_SPAM_BIO_PATTERNS,
		jailMessages: DEFAULT_REACTION_JAIL_MESSAGES,
	},
	gambling: {
		minBet: envPositive("GAMBLING_MIN_BET", 0.1),
		maxBet: envPositive("GAMBLING_MAX_BET", 100),
		winMultiplier: envPositive("GAMBLING_WIN_MULTIPLIER", 9),
	},
	duel: {
		timeoutSeconds: envPositive("DUEL_TIMEOUT_SECONDS", 300),
		minWager: envPositive("DUEL_MIN_WAGER", 0.1),
		maxWager: envPositive("DUEL_MAX_WAGER", 50),
	},
	defaultJailBailAmount: envPositive("DEFAULT_JAIL_BAIL_AMOUNT", 69.42),
	chain: {
		withdrawalGasPrice: envString("WITHDRAWAL_GAS_PRICE", "0.075ujuno"),
		withdrawalGasLimit: envInt("WITHDRAWAL_GAS_LIMIT", 130000),
	},
	price: {
		cacheDurationMs: envInt("PRICE_CACHE_DURATION_MS", 5 * 60 * 1000),
		coingeckoId: envString("PRICE_COINGECKO_ID", "juno-network"),
		rollingAverageHours: envPositive("PRICE_ROLLING_AVERAGE_HOURS", 24),
		historyRetentionDays: envPositive("PRICE_HISTORY_RETENTION_DAYS", 7),
		apiUrl: envString(
			"PRICE_API_URL",
			"https://api.coingecko.com/api/v3/simple/price",
		),
	},
	timing: {
		menuExpiryMs: envInt("MENU_EXPIRY_MS", 30 * 1000),
		dedupeWindowMs: envInt("RESPONSE_DEDUPE_WINDOW_MS", 2 * 60 * 1000),
		sessionTimeoutMs: envInt("SESSION_TIMEOUT_MS", 5 * 60 * 1000),
		patternCacheTtlMs: envInt("PATTERN_CACHE_TTL_MS", 60_000),
	},
	limits: {
		maxRegexPatternLength: envInt("MAX_REGEX_PATTERN_LENGTH", 500),
		randomDeleteDefaultChance: envString("RANDOM_DELETE_DEFAULT_CHANCE", "10%"),
		randomDeleteMinUniqueWords: envInt("RANDOM_DELETE_MIN_UNIQUE_WORDS", 6),
	},
	identityCrawlThrottleMs: envInt("IDENTITY_CRAWL_THROTTLE_MS", 60),
	identityCrawlMaxRetries: envInt("IDENTITY_CRAWL_MAX_RETRIES", 3),
	botIdentity: {
		supportUsername: envString("SUPPORT_BOT_USERNAME", "banbabybot"),
		stickerPackName: envString("STICKER_PACK_NAME", "CACGifs"),
		cacgifsFirstStickerId: envString(
			"CACGIFS_FIRST_STICKER_ID",
			"CAACAgIAAxkBAAICIGkIxVYID2ee6Z3t3fzMKGyrzCLlAAJmNgACfvIoSL_cdmEGklS0NgQ",
		),
	},
};

// In-house wallet addresses are .env-only. Make the runtime copies non-writable
// so no code path (including any future bot command) can change them in process.
for (const key of ["userFundsAddress", "botTreasuryAddress"] as const) {
	Object.defineProperty(config, key, {
		writable: false,
		configurable: false,
	});
}

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
