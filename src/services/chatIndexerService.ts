/**
 * Live chat indexer service for the CAC Admin Bot.
 * Captures group messages in real-time and writes them to the telegram-chat-explorer
 * SQLite database, enabling live-updating search and analytics.
 *
 * Features:
 * - Indexes every group message into the explorer's messages table (FTS auto-indexed via triggers)
 * - Upserts author statistics (message_count, first_seen, last_seen)
 * - Downloads photo attachments via Telegram Bot API
 * - Periodically generates semantic embeddings via Ollama
 * - Describes images via Ollama vision model
 * - Keyword-based topic classification against existing topics
 *
 * @module services/chatIndexerService
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { Database, type SqliteDatabase } from "../sqlite";
import { computeActiveTime } from "../utils/activeTime";
import { logger } from "../utils/logger";
import { ChatInteractionIndexerService } from "./chatInteractionIndexerService";

/** Shape of a row in the explorer's messages table */
interface MessageRow {
	id: number;
	text: string;
	timestamp_unix: number;
	reply_to_id: number | null;
	media_type: string | null;
	media_path: string | null;
}

/** Cached topic with compiled keyword regex for fast matching */
interface TopicPattern {
	id: number;
	name: string;
	regex: RegExp;
}

interface DatasetSummary {
	message_count: number;
	author_count: number;
}

interface LatestMessageSummary {
	id: number;
	timestamp: string;
	timestamp_unix: number;
}

/** Concurrency limit for Ollama embedding requests */
const EMBED_CONCURRENCY = 5;
/** Number of reply-chain messages to include as context on each side */
const THREAD_WINDOW = 2;
/** Number of temporal neighbor messages to include as fallback context */
const LOCAL_WINDOW = 5;
/** Max characters for contextual embedding text */
const MAX_CONTEXT_CHARS = 2000;
/** Minimum message/caption length that the explorer embedding worker will process */
const EMBED_TRIGGER_MIN_TEXT_LENGTH = 20;

/**
 * Service that indexes group chat messages into the telegram-chat-explorer database.
 * Follows the static-method service pattern used throughout cacmin-bot.
 */
export class ChatIndexerService {
	private static db: SqliteDatabase | null = null;
	private static bot: Telegraf<Context> | null = null;
	private static topicPatterns: TopicPattern[] = [];
	private static embedInterval: ReturnType<typeof setInterval> | null = null;
	private static photoQueue: { messageId: number; fileId: string }[] = [];
	private static enabled = false;

	/**
	 * Initializes the indexer service by opening a separate DB connection to the
	 * explorer's dataset database and starting periodic tasks.
	 *
	 * @param bot - Telegraf bot instance for Telegram file API access
	 */
	static initialize(bot: Telegraf<Context>): void {
		if (!config.indexerEnabled || !config.indexerDbPath) {
			logger.info(
				"Chat indexer disabled (INDEXER_ENABLED != true or INDEXER_DB_PATH not set)",
			);
			return;
		}

		try {
			if (!existsSync(config.indexerDbPath)) {
				logger.warn(
					`Indexer DB not found at ${config.indexerDbPath}, disabling indexer`,
				);
				return;
			}

			ChatIndexerService.db = new Database(config.indexerDbPath);
			ChatIndexerService.db.exec("PRAGMA journal_mode = WAL");
			ChatIndexerService.db.exec("PRAGMA synchronous = NORMAL");
			ChatIndexerService.bot = bot;
			ChatIndexerService.enabled = true;

			// Ensure image_descriptions table exists (may not if embeddings haven't been run yet)
			ChatIndexerService.db.exec(`
				CREATE TABLE IF NOT EXISTS image_descriptions (
					message_id INTEGER PRIMARY KEY,
					description TEXT
				)
			`);

			// Add user_id column for active time tracking (safe to run repeatedly)
			try {
				ChatIndexerService.db.exec(
					"ALTER TABLE messages ADD COLUMN user_id INTEGER",
				);
				logger.info("Added user_id column to indexer messages table");
			} catch {
				// Column already exists — expected after first run
			}

			// Backfill user_id on historical messages using known author<->user_id mappings
			ChatIndexerService.backfillUserIds();

			// Keep app-visible dataset metadata and metrics state current.
			ChatIndexerService.refreshDatasetMetricsState();

			// Load existing topic patterns for keyword classification
			ChatIndexerService.loadTopicPatterns();

			// Prefer the explorer embedding worker for production so pgvector stays in sync.
			if (config.indexerEmbeddingsEnabled) {
				ChatIndexerService.embedInterval = setInterval(() => {
					ChatIndexerService.runEmbeddingBatch().catch((err) => {
						logger.error("Indexer embedding batch failed", { error: err });
					});
				}, config.embedBatchIntervalMs);
			}

			logger.info("Chat indexer initialized", {
				dbPath: config.indexerDbPath,
				embedInterval: config.indexerEmbeddingsEnabled
					? `${config.embedBatchIntervalMs / 1000}s`
					: "disabled",
				embedTriggerBatchSize: config.indexerEmbedTriggerBatchSize,
			});
		} catch (error) {
			logger.error("Failed to initialize chat indexer, disabling", { error });
			ChatIndexerService.enabled = false;
			ChatIndexerService.db = null;
		}
	}

	/**
	 * Indexes a single message from the Telegraf context into the explorer DB.
	 * Fire-and-forget: errors are logged but never thrown.
	 * Only processes messages from the configured group chat.
	 *
	 * @param ctx - Telegraf context containing the message to index
	 */
	static async indexMessage(ctx: Context): Promise<void> {
		if (!ChatIndexerService.enabled || !ChatIndexerService.db) return;

		try {
			const msg = ctx.message;
			if (!msg || !ctx.from) return;

			// Only index messages from the configured group chat
			if (config.groupChatId && ctx.chat?.id !== config.groupChatId) return;

			const messageId = msg.message_id;
			const firstName = ctx.from.first_name || "";
			const lastName = ctx.from.last_name || "";
			const author = lastName ? `${firstName} ${lastName}` : firstName;
			const timestamp = new Date(msg.date * 1000).toISOString();
			const timestampUnix = msg.date;

			// Extract text from various message types
			const text =
				("text" in msg ? msg.text : null) ||
				("caption" in msg ? msg.caption : null) ||
				null;

			// Detect photo media
			const hasPhoto =
				"photo" in msg && Array.isArray(msg.photo) && msg.photo.length > 0;
			const hasMedia = hasPhoto ? 1 : 0;
			const mediaType = hasPhoto ? "photo" : null;

			// Reply threading
			const replyToId =
				"reply_to_message" in msg && msg.reply_to_message
					? msg.reply_to_message.message_id
					: null;

			// Forwarding info
			const isForwarded =
				("forward_from" in msg && !!msg.forward_from) ||
				("forward_from_chat" in msg && !!msg.forward_from_chat)
					? 1
					: 0;
			const forwardedFrom =
				"forward_from" in msg && msg.forward_from
					? (msg.forward_from as { first_name?: string }).first_name || null
					: null;

			// Check for duplicate (idempotent insert)
			const existing = ChatIndexerService.db
				.prepare("SELECT id FROM messages WHERE id = ?")
				.get(messageId);
			if (existing) return;

			const authorAlreadyExists = !!ChatIndexerService.db
				.prepare("SELECT 1 FROM authors WHERE name = ?")
				.get(author);

			// Insert into messages table (FTS triggers fire automatically)
			ChatIndexerService.db
				.prepare(`
					INSERT INTO messages (id, author, timestamp, timestamp_unix, text, has_media,
						media_type, media_path, reply_to_id, is_forwarded, forwarded_from, file_path, raw_html, user_id)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					messageId,
					author,
					timestamp,
					timestampUnix,
					text,
					hasMedia,
					mediaType,
					null, // media_path set after download
					replyToId,
					isForwarded,
					forwardedFrom,
					"live", // sentinel for live messages
					null, // no raw_html for live messages
					ctx.from.id,
				);

			// Update author stats
			ChatIndexerService.updateAuthorStats(author, timestamp);

			// Classify into topics inline (cheap keyword matching)
			if (text) {
				ChatIndexerService.classifyTopics(messageId, text);
			}

			ChatIndexerService.recordLiveInsertMetrics({
				messageId,
				timestamp,
				timestampUnix,
				authorWasNew: !authorAlreadyExists,
				hasPhoto,
				hasEmbeddingCandidate: ChatIndexerService.canEmbedMessage(text),
			});
			ChatIndexerService.recordPendingEmbeddingCandidate(text);
			ChatInteractionIndexerService.indexMessageIdentity(ctx);

			// Queue photo for download if present
			if (hasPhoto && "photo" in msg && msg.photo) {
				const largest = msg.photo[msg.photo.length - 1];
				ChatIndexerService.photoQueue.push({
					messageId,
					fileId: largest.file_id,
				});
				// Process photo download immediately (non-blocking)
				ChatIndexerService.processPhotoQueue().catch(() => {});
			}

			logger.debug("Indexed message", { messageId, author });
		} catch (error) {
			logger.error("Failed to index message", { error });
		}
	}

	/** Applies Telegram message edits without leaving stale derived rows behind. */
	static async indexEditedMessage(ctx: Context): Promise<void> {
		const db = ChatIndexerService.db;
		const msg =
			(ctx as any).editedMessage || (ctx.update as any)?.edited_message;
		if (!ChatIndexerService.enabled || !db || !msg || !ctx.from) return;
		if (config.groupChatId && ctx.chat?.id !== config.groupChatId) return;

		try {
			const existing = db
				.prepare("SELECT author FROM messages WHERE id = ?")
				.get(msg.message_id) as { author: string } | undefined;
			if (!existing) return;
			const firstName = ctx.from.first_name || "";
			const lastName = ctx.from.last_name || "";
			const author = lastName ? `${firstName} ${lastName}` : firstName;
			const text = msg.text || msg.caption || null;
			const timestamp = new Date(msg.date * 1000).toISOString();
			const replyToId = msg.reply_to_message?.message_id || null;
			const modelRows = ChatIndexerService.tableHasColumn("embeddings", "model")
				? (db
						.prepare(
							"SELECT DISTINCT model FROM embeddings WHERE message_id = ? AND model IS NOT NULL",
						)
						.all(msg.message_id) as Array<{ model: string }>)
				: [];
			const apply = db.transaction(() => {
				if (
					config.indexerDatasetId &&
					ChatIndexerService.tableExists("vector_sync_state")
				) {
					const enqueueDelete = db.prepare(`
						INSERT INTO vector_sync_state (
							dataset_id, embedding_model, message_id, operation,
							attempts, last_error, updated_at_unix
						) VALUES (?, ?, ?, 'delete', 0, NULL, ?)
						ON CONFLICT(dataset_id, embedding_model, message_id) DO UPDATE SET
							operation = 'delete', attempts = 0, last_error = NULL,
							updated_at_unix = excluded.updated_at_unix
					`);
					for (const row of modelRows) {
						enqueueDelete.run(
							config.indexerDatasetId,
							row.model,
							msg.message_id,
							msg.date,
						);
					}
				}
				db.prepare("DELETE FROM embeddings WHERE message_id = ?").run(
					msg.message_id,
				);
				db.prepare("DELETE FROM message_topics WHERE message_id = ?").run(
					msg.message_id,
				);
				if (ChatIndexerService.tableExists("image_descriptions")) {
					db.prepare("DELETE FROM image_descriptions WHERE message_id = ?").run(
						msg.message_id,
					);
				}
				db.prepare(`
					UPDATE messages SET
						author = ?, timestamp = ?, timestamp_unix = ?, text = ?,
						reply_to_id = ?, raw_html = NULL
					WHERE id = ?
				`).run(author, timestamp, msg.date, text, replyToId, msg.message_id);
				ChatIndexerService.refreshAuthorStatsExact(existing.author);
				if (author !== existing.author) {
					ChatIndexerService.refreshAuthorStatsExact(author);
				}
			});
			apply();
			if (text) ChatIndexerService.classifyTopics(msg.message_id, text);
			ChatIndexerService.recordPendingEmbeddingCandidate(text);
			ChatInteractionIndexerService.indexMessageIdentity(ctx);
			logger.debug("Indexed edited message", {
				messageId: msg.message_id,
				author,
			});
		} catch (error) {
			logger.error("Failed to index edited message", { error });
		}
	}

	private static tableExists(tableName: string): boolean {
		return !!ChatIndexerService.db
			?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName);
	}

	private static tableHasColumn(
		tableName: string,
		columnName: string,
	): boolean {
		if (!ChatIndexerService.db) return false;
		const columns = ChatIndexerService.db
			.prepare(`PRAGMA table_info(${tableName})`)
			.all() as Array<{ name: string }>;
		return columns.some((column) => column.name === columnName);
	}

	private static refreshAuthorStatsExact(author: string): void {
		const db = ChatIndexerService.db;
		if (!db) return;
		db.prepare("DELETE FROM authors WHERE name = ?").run(author);
		db.prepare(`
			INSERT INTO authors (name, message_count, first_seen, last_seen)
			SELECT author, COUNT(*), MIN(timestamp), MAX(timestamp)
			FROM messages WHERE author = ? GROUP BY author
		`).run(author);
	}

	/**
	 * Keeps an external embedding worker trigger in sync with successful inserts.
	 */
	private static recordPendingEmbeddingCandidate(text: string | null): void {
		const db = ChatIndexerService.db;
		if (
			!db ||
			config.indexerEmbedTriggerBatchSize <= 0 ||
			!ChatIndexerService.canEmbedMessage(text)
		) {
			return;
		}

		try {
			ChatIndexerService.ensureLiveIndexStateTable();
			const row = db
				.prepare("SELECT value FROM live_index_state WHERE key = ?")
				.get("pending_embedding_candidates") as { value: string } | undefined;
			const current = row ? parseInt(row.value, 10) : 0;
			const next = (Number.isFinite(current) ? current : 0) + 1;

			if (next >= config.indexerEmbedTriggerBatchSize) {
				ChatIndexerService.touchEmbeddingTrigger();
				ChatIndexerService.setLiveIndexState(
					"pending_embedding_candidates",
					"0",
				);
				return;
			}

			ChatIndexerService.setLiveIndexState(
				"pending_embedding_candidates",
				String(next),
			);
		} catch (error) {
			logger.error("Failed to update embedding trigger state", { error });
		}
	}

	private static canEmbedMessage(text: string | null): boolean {
		return (text || "").trim().length >= EMBED_TRIGGER_MIN_TEXT_LENGTH;
	}

	private static ensureLiveIndexStateTable(): void {
		ChatIndexerService.db?.exec(`
			CREATE TABLE IF NOT EXISTS live_index_state (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
	}

	private static ensureDatasetMetaTable(): void {
		ChatIndexerService.db?.exec(`
			CREATE TABLE IF NOT EXISTS dataset_meta (
				key TEXT PRIMARY KEY,
				value TEXT
			)
		`);
	}

	private static refreshDatasetMetricsState(): void {
		const db = ChatIndexerService.db;
		if (!db) return;

		try {
			ChatIndexerService.ensureDatasetMetaTable();
			ChatIndexerService.ensureLiveIndexStateTable();

			const summary = db
				.prepare(`
					SELECT
						COUNT(*) AS message_count,
						COUNT(DISTINCT author) AS author_count
					FROM messages
				`)
				.get() as DatasetSummary;
			const latest = db
				.prepare(`
					SELECT id, timestamp, timestamp_unix
					FROM messages
					ORDER BY timestamp_unix DESC, id DESC
					LIMIT 1
				`)
				.get() as LatestMessageSummary | undefined;

			ChatIndexerService.setDatasetMeta(
				"messageCount",
				String(summary.message_count),
			);
			ChatIndexerService.setDatasetMeta(
				"authorCount",
				String(summary.author_count),
			);
			ChatIndexerService.setLiveIndexState(
				"sqlite_messages_total",
				String(summary.message_count),
			);
			ChatIndexerService.setLiveIndexState(
				"sqlite_authors_total",
				String(summary.author_count),
			);
			ChatIndexerService.setLiveIndexState("writer", "cacmin-bot");
			if (config.indexerDatasetId) {
				ChatIndexerService.setLiveIndexState(
					"dataset_id",
					config.indexerDatasetId,
				);
			}
			ChatIndexerService.setLiveIndexStateIfMissing(
				"pending_embedding_candidates",
				"0",
			);
			ChatIndexerService.setLiveIndexStateIfMissing(
				"live_messages_inserted_total",
				"0",
			);
			ChatIndexerService.setLiveIndexStateIfMissing(
				"live_embedding_candidates_inserted_total",
				"0",
			);
			ChatIndexerService.setLiveIndexStateIfMissing(
				"live_photo_messages_inserted_total",
				"0",
			);
			ChatIndexerService.setLiveIndexStateIfMissing(
				"live_media_download_success_total",
				"0",
			);
			ChatIndexerService.setLiveIndexStateIfMissing(
				"live_media_download_error_total",
				"0",
			);
			ChatIndexerService.setLiveIndexStateIfMissing(
				"live_embedding_trigger_touches_total",
				"0",
			);

			if (latest) {
				ChatIndexerService.setDatasetMeta("lastMessage", latest.timestamp);
				ChatIndexerService.recordLatestMessageState(
					latest.id,
					latest.timestamp,
					latest.timestamp_unix,
				);
			}
		} catch (error) {
			logger.error("Failed to refresh indexer dataset metrics state", {
				error,
			});
		}
	}

	private static recordLiveInsertMetrics(input: {
		messageId: number;
		timestamp: string;
		timestampUnix: number;
		authorWasNew: boolean;
		hasPhoto: boolean;
		hasEmbeddingCandidate: boolean;
	}): void {
		try {
			ChatIndexerService.ensureDatasetMetaTable();
			ChatIndexerService.ensureLiveIndexStateTable();
			ChatIndexerService.incrementDatasetMetaInteger("messageCount", 1);
			if (input.authorWasNew) {
				ChatIndexerService.incrementDatasetMetaInteger("authorCount", 1);
			}
			ChatIndexerService.setDatasetMeta("lastMessage", input.timestamp);
			ChatIndexerService.incrementLiveIndexCounter("sqlite_messages_total", 1);
			if (input.authorWasNew) {
				ChatIndexerService.incrementLiveIndexCounter("sqlite_authors_total", 1);
			}
			ChatIndexerService.incrementLiveIndexCounter(
				"live_messages_inserted_total",
				1,
			);
			if (input.hasPhoto) {
				ChatIndexerService.incrementLiveIndexCounter(
					"live_photo_messages_inserted_total",
					1,
				);
			}
			if (input.hasEmbeddingCandidate) {
				ChatIndexerService.incrementLiveIndexCounter(
					"live_embedding_candidates_inserted_total",
					1,
				);
			}
			ChatIndexerService.recordLatestMessageState(
				input.messageId,
				input.timestamp,
				input.timestampUnix,
			);
		} catch (error) {
			logger.error("Failed to update live insert metrics", { error });
		}
	}

	private static recordLatestMessageState(
		messageId: number,
		timestamp: string,
		timestampUnix: number,
	): void {
		ChatIndexerService.setLiveIndexState(
			"latest_message_id",
			String(messageId),
		);
		ChatIndexerService.setLiveIndexState("latest_message_timestamp", timestamp);
		ChatIndexerService.setLiveIndexState(
			"latest_message_timestamp_unix",
			String(timestampUnix),
		);
		ChatIndexerService.setLiveIndexState(
			"latest_live_message_id",
			String(messageId),
		);
		ChatIndexerService.setLiveIndexState(
			"latest_live_message_timestamp",
			timestamp,
		);
		ChatIndexerService.setLiveIndexState(
			"latest_live_message_timestamp_unix",
			String(timestampUnix),
		);
	}

	private static setDatasetMeta(key: string, value: string): void {
		ChatIndexerService.db
			?.prepare(`
			INSERT INTO dataset_meta (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`)
			.run(key, value);
	}

	private static incrementDatasetMetaInteger(
		key: string,
		amount: number,
	): void {
		const current = ChatIndexerService.readIntegerValue("dataset_meta", key);
		ChatIndexerService.setDatasetMeta(key, String(current + amount));
	}

	private static setLiveIndexState(key: string, value: string): void {
		ChatIndexerService.db
			?.prepare(`
			INSERT INTO live_index_state (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`)
			.run(key, value);
	}

	private static setLiveIndexStateIfMissing(key: string, value: string): void {
		ChatIndexerService.db
			?.prepare(`
			INSERT OR IGNORE INTO live_index_state (key, value)
			VALUES (?, ?)
		`)
			.run(key, value);
	}

	private static incrementLiveIndexCounter(key: string, amount: number): void {
		const current = ChatIndexerService.readIntegerValue(
			"live_index_state",
			key,
		);
		ChatIndexerService.setLiveIndexState(key, String(current + amount));
	}

	private static readIntegerValue(table: string, key: string): number {
		const row = ChatIndexerService.db
			?.prepare(`SELECT value FROM ${table} WHERE key = ?`)
			.get(key) as { value: string } | undefined;
		const parsed = row ? parseInt(row.value, 10) : 0;
		return Number.isFinite(parsed) ? parsed : 0;
	}

	private static touchEmbeddingTrigger(): void {
		const triggerFile =
			config.indexerEmbedTriggerFile ||
			(config.indexerDbPath
				? join(
						dirname(config.indexerDbPath),
						"..",
						"state",
						"embed-missing.trigger",
					)
				: null);
		if (!triggerFile) return;

		mkdirSync(dirname(triggerFile), { recursive: true });
		writeFileSync(triggerFile, `${new Date().toISOString()}\n`);
		ChatIndexerService.incrementLiveIndexCounter(
			"live_embedding_trigger_touches_total",
			1,
		);
		logger.debug("Touched indexer embedding trigger", { triggerFile });
	}

	/**
	 * Downloads queued photos via the Telegram Bot API and updates the DB.
	 */
	private static async processPhotoQueue(): Promise<void> {
		if (!ChatIndexerService.bot || !ChatIndexerService.db) return;

		while (ChatIndexerService.photoQueue.length > 0) {
			const item = ChatIndexerService.photoQueue.shift();
			if (!item) break;

			try {
				const fileLink = await ChatIndexerService.bot.telegram.getFileLink(
					item.fileId,
				);
				const response = await fetch(fileLink.href);
				if (!response.ok) continue;

				const buffer = Buffer.from(await response.arrayBuffer());

				// Build media path matching explorer convention
				const datasetId = config.indexerDatasetId || "live";
				const mediaDir = config.indexerMediaDir
					? join(config.indexerMediaDir, datasetId, "photos")
					: join(
							dirname(config.indexerDbPath || ""),
							"media",
							datasetId,
							"photos",
						);

				if (!existsSync(mediaDir)) {
					mkdirSync(mediaDir, { recursive: true });
				}

				const filename = `live_${item.messageId}.jpg`;
				const fullPath = join(mediaDir, filename);
				writeFileSync(fullPath, buffer);

				// Store relative path from DB location (matches explorer convention)
				const relativePath = `media/${datasetId}/photos/${filename}`;
				ChatIndexerService.db
					.prepare("UPDATE messages SET media_path = ? WHERE id = ?")
					.run(relativePath, item.messageId);
				ChatIndexerService.incrementLiveIndexCounter(
					"live_media_download_success_total",
					1,
				);

				logger.debug("Downloaded photo", {
					messageId: item.messageId,
					path: relativePath,
				});
			} catch (error) {
				ChatIndexerService.incrementLiveIndexCounter(
					"live_media_download_error_total",
					1,
				);
				logger.error("Failed to download photo", {
					messageId: item.messageId,
					error,
				});
			}
		}
	}

	/**
	 * Incrementally upserts author statistics in the explorer's authors table.
	 *
	 * @param authorName - Display name of the author
	 * @param timestamp - ISO timestamp of the message
	 */
	private static updateAuthorStats(
		authorName: string,
		timestamp: string,
	): void {
		if (!ChatIndexerService.db) return;

		try {
			ChatIndexerService.db
				.prepare(`
					INSERT INTO authors (name, message_count, first_seen, last_seen)
					VALUES (?, 1, ?, ?)
					ON CONFLICT(name) DO UPDATE SET
						message_count = message_count + 1,
						last_seen = ?
				`)
				.run(authorName, timestamp, timestamp, timestamp);
		} catch (error) {
			logger.error("Failed to update author stats", { authorName, error });
		}
	}

	/**
	 * Classifies a message into existing topics using keyword matching.
	 * Only matches against topics already in the DB (no LLM discovery here).
	 *
	 * @param messageId - The message ID to classify
	 * @param text - The message text to match against topic keywords
	 */
	private static classifyTopics(messageId: number, text: string): void {
		if (!ChatIndexerService.db || ChatIndexerService.topicPatterns.length === 0)
			return;

		try {
			const lowerText = text.toLowerCase();
			const insertTopic = ChatIndexerService.db.prepare(`
				INSERT OR IGNORE INTO message_topics (message_id, topic_id, confidence)
				VALUES (?, ?, ?)
			`);
			const updateCount = ChatIndexerService.db.prepare(`
				UPDATE topics SET message_count = message_count + 1 WHERE id = ?
			`);

			for (const topic of ChatIndexerService.topicPatterns) {
				if (topic.regex.test(lowerText)) {
					insertTopic.run(messageId, topic.id, 0.8);
					updateCount.run(topic.id);
				}
			}
		} catch (error) {
			logger.error("Failed to classify topics", { messageId, error });
		}
	}

	/**
	 * Loads topic keyword patterns from the DB and compiles regexes for fast matching.
	 */
	private static loadTopicPatterns(): void {
		if (!ChatIndexerService.db) return;

		try {
			const topics = ChatIndexerService.db
				.prepare(
					"SELECT id, name, keywords FROM topics WHERE keywords IS NOT NULL",
				)
				.all() as { id: number; name: string; keywords: string }[];

			ChatIndexerService.topicPatterns = topics
				.map((t) => {
					const keywords = t.keywords
						.split(",")
						.map((k) => k.trim().toLowerCase())
						.filter((k) => k.length > 0);
					if (keywords.length === 0) return null;

					// Build a regex that matches any of the keywords as whole words
					const pattern = keywords
						.map((k) => `\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
						.join("|");
					return {
						id: t.id,
						name: t.name,
						regex: new RegExp(pattern, "i"),
					};
				})
				.filter((t): t is TopicPattern => t !== null);

			logger.debug("Loaded topic patterns", {
				count: ChatIndexerService.topicPatterns.length,
			});
		} catch (error) {
			logger.error("Failed to load topic patterns", { error });
		}
	}

	/**
	 * Runs a batch embedding generation cycle.
	 * Queries un-embedded messages, builds contextual text, calls Ollama, stores vectors.
	 * Replicates the logic from telegram-chat-explorer/src/embeddings/generate.ts.
	 */
	private static async runEmbeddingBatch(): Promise<void> {
		const db = ChatIndexerService.db;
		if (!db) return;

		try {
			// Test Ollama connectivity before proceeding
			const tagResp = await fetch(`${config.ollamaUrl}/api/tags`, {
				signal: AbortSignal.timeout(5000),
			});
			if (!tagResp.ok) {
				logger.debug("Ollama unreachable, skipping embedding batch");
				return;
			}
		} catch {
			logger.debug("Ollama unreachable, skipping embedding batch");
			return;
		}

		try {
			// Process image descriptions for photos without descriptions
			await ChatIndexerService.processImageDescriptions();

			// Load image description cache
			const imageDescMap = new Map<number, string>();
			const descRows = db
				.prepare("SELECT message_id, description FROM image_descriptions")
				.all() as { message_id: number; description: string }[];
			for (const row of descRows) {
				imageDescMap.set(row.message_id, row.description);
			}

			// Query messages needing embeddings (text >= 20 chars, no existing embedding)
			const messages = db
				.prepare(`
					SELECT m.id, m.text, m.timestamp_unix, m.reply_to_id, m.media_type, m.media_path
					FROM messages m
					LEFT JOIN embeddings e ON m.id = e.message_id
					WHERE m.text IS NOT NULL
						AND length(m.text) >= 20
						AND e.message_id IS NULL
					ORDER BY m.id
					LIMIT 500
				`)
				.all() as MessageRow[];

			if (messages.length === 0) return;

			logger.info("Embedding batch started", { count: messages.length });

			const insertEmbedding = db.prepare(`
				INSERT OR REPLACE INTO embeddings (message_id, vector)
				VALUES (?, ?)
			`);

			const batchSize = 100;
			let processed = 0;
			let errors = 0;

			for (let i = 0; i < messages.length; i += batchSize) {
				const batch = messages.slice(i, i + batchSize);
				const embeddings: { messageId: number; vector: Buffer }[] = [];

				// Process with limited concurrency
				for (let j = 0; j < batch.length; j += EMBED_CONCURRENCY) {
					const chunk = batch.slice(j, j + EMBED_CONCURRENCY);
					const results = await Promise.allSettled(
						chunk.map(async (msg) => {
							const contextual = ChatIndexerService.buildContextualText(
								msg,
								imageDescMap,
							);
							const vector = await ChatIndexerService.getEmbedding(contextual);
							return {
								messageId: msg.id,
								vector: ChatIndexerService.vectorToBlob(vector),
							};
						}),
					);

					for (const result of results) {
						if (result.status === "fulfilled") {
							embeddings.push(result.value);
						} else {
							errors++;
						}
					}
				}

				// Insert batch in a transaction
				const insertBatch = db.transaction(() => {
					for (const emb of embeddings) {
						insertEmbedding.run(emb.messageId, emb.vector);
					}
				});
				insertBatch();

				processed += batch.length;
			}

			logger.info("Embedding batch completed", { processed, errors });
		} catch (error) {
			logger.error("Embedding batch error", { error });
		}
	}

	/**
	 * Processes photos that don't have image descriptions yet using the Ollama vision model.
	 */
	private static async processImageDescriptions(): Promise<void> {
		if (!ChatIndexerService.db) return;

		const photos = ChatIndexerService.db
			.prepare(`
				SELECT id, media_path
				FROM messages
				WHERE media_type = 'photo' AND media_path IS NOT NULL
					AND id NOT IN (SELECT message_id FROM image_descriptions)
				LIMIT 50
			`)
			.all() as { id: number; media_path: string }[];

		if (photos.length === 0) return;

		const insertDesc = ChatIndexerService.db.prepare(`
			INSERT OR REPLACE INTO image_descriptions (message_id, description)
			VALUES (?, ?)
		`);

		for (const photo of photos) {
			const desc = await ChatIndexerService.describeImage(photo.media_path);
			if (desc) {
				insertDesc.run(photo.id, desc);
			}
		}
	}

	/**
	 * Calls the Ollama vision model to describe a photo.
	 *
	 * @param mediaPath - Relative or absolute path to the image file
	 * @returns Description string or null if unavailable
	 */
	private static async describeImage(
		mediaPath: string,
	): Promise<string | null> {
		try {
			const filePath = isAbsolute(mediaPath)
				? mediaPath
				: join(dirname(config.indexerDbPath || ""), mediaPath);

			if (!existsSync(filePath)) return null;

			const base64 = readFileSync(filePath).toString("base64");
			const resp = await fetch(`${config.ollamaUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: config.visionModel,
					prompt: "Describe the image in one concise sentence.",
					images: [base64],
					stream: false,
				}),
				signal: AbortSignal.timeout(30000),
			});

			if (!resp.ok) return null;
			const data = (await resp.json()) as { response?: string };
			const desc =
				typeof data.response === "string" ? data.response.trim() : null;
			return desc && desc.length > 0 ? desc.slice(0, 500) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Calls the Ollama embedding API to generate a vector for the given text.
	 *
	 * @param text - Text to embed
	 * @returns Float array of embedding dimensions
	 */
	private static async getEmbedding(text: string): Promise<number[]> {
		const response = await fetch(`${config.ollamaUrl}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.embedModel,
				input: text,
			}),
			signal: AbortSignal.timeout(15000),
		});

		if (!response.ok) {
			throw new Error(`Ollama embed API error: ${response.status}`);
		}

		const data = (await response.json()) as { embeddings: number[][] };
		return data.embeddings[0];
	}

	/**
	 * Converts a float array to a binary blob for SQLite storage.
	 *
	 * @param vector - Array of floats from the embedding model
	 * @returns Buffer containing little-endian Float32 values
	 */
	private static vectorToBlob(vector: number[]): Buffer {
		const buffer = Buffer.alloc(vector.length * 4);
		for (let i = 0; i < vector.length; i++) {
			buffer.writeFloatLE(vector[i], i * 4);
		}
		return buffer;
	}

	/**
	 * Builds context-aware text for embedding a message.
	 * Prefers reply-chain context; falls back to temporal neighbors.
	 * Mirrors the logic from telegram-chat-explorer/src/embeddings/generate.ts.
	 *
	 * @param msg - Message row to build context for
	 * @param imageDescMap - Cached image descriptions keyed by message ID
	 * @returns Contextual text suitable for the embedding model
	 */
	private static buildContextualText(
		msg: MessageRow,
		imageDescMap: Map<number, string>,
	): string {
		if (!ChatIndexerService.db) return msg.text || "";

		const lines: string[] = [];
		const mainText = msg.text || "";

		// Prepend image description if available
		if (msg.media_type === "photo" && msg.media_path) {
			const desc = imageDescMap.get(msg.id);
			if (desc) {
				lines.push(`Image description: ${desc}`);
			}
		}

		// Try reply-chain context first
		if (msg.reply_to_id) {
			try {
				const threadMessages = ChatIndexerService.db
					.prepare(`
						WITH RECURSIVE thread(id, reply_to_id, timestamp_unix, text) AS (
							SELECT id, reply_to_id, timestamp_unix, text FROM messages WHERE id = ?
							UNION ALL
							SELECT m.id, m.reply_to_id, m.timestamp_unix, m.text
							FROM messages m
							JOIN thread t ON m.reply_to_id = t.id
						)
						SELECT id, text FROM thread WHERE text IS NOT NULL ORDER BY timestamp_unix
					`)
					.all(msg.reply_to_id) as { id: number; text: string }[];

				if (threadMessages.length > 0) {
					const idx = threadMessages.findIndex((t) => t.id === msg.id);
					const start = Math.max(0, idx - THREAD_WINDOW);
					const end = Math.min(threadMessages.length, idx + THREAD_WINDOW + 1);
					const before = threadMessages
						.slice(start, idx)
						.map((t) => t.text.slice(0, 200));
					const after = threadMessages
						.slice(idx + 1, end)
						.map((t) => t.text.slice(0, 200));

					if (before.length) {
						lines.push("Thread context (before):", ...before);
					}
					lines.push("Message:", mainText.slice(0, 1000));
					if (after.length) {
						lines.push("Thread context (after):", ...after);
					}

					return (
						lines.join("\n").slice(0, MAX_CONTEXT_CHARS) ||
						mainText.slice(0, MAX_CONTEXT_CHARS)
					);
				}
			} catch {
				// Fall through to temporal neighbors
			}
		}

		// Fallback: temporal neighbors
		try {
			const neighbors = ChatIndexerService.db
				.prepare(`
					SELECT text FROM messages
					WHERE text IS NOT NULL
						AND id != ?
						AND timestamp_unix BETWEEN ? - 1000000000 AND ? + 1000000000
					ORDER BY ABS(timestamp_unix - ?)
					LIMIT ?
				`)
				.all(
					msg.id,
					msg.timestamp_unix,
					msg.timestamp_unix,
					msg.timestamp_unix,
					LOCAL_WINDOW,
				) as {
				text: string;
			}[];

			if (neighbors.length) {
				lines.push("Nearby messages:");
				lines.push(...neighbors.map((n) => n.text.slice(0, 200)));
			}
		} catch {
			// Proceed without context
		}

		lines.push("Message:", mainText.slice(0, 1000));
		const joined = lines.join("\n").slice(0, MAX_CONTEXT_CHARS);
		return joined || mainText.slice(0, MAX_CONTEXT_CHARS);
	}

	/**
	 * Bulk backfills user_id on historical messages using known author<->user_id
	 * mappings derived from messages that already have user_id set.
	 * Runs once at startup. Only touches messages within the last 3 months.
	 */
	private static backfillUserIds(): void {
		if (!ChatIndexerService.db) return;

		try {
			const threeMonthsAgo = Math.floor(Date.now() / 1000) - 90 * 86400;

			// Get known author<->user_id mappings from messages that already have user_id
			const mappings = ChatIndexerService.db
				.prepare(
					`SELECT DISTINCT user_id, author FROM messages
					 WHERE user_id IS NOT NULL AND author IS NOT NULL`,
				)
				.all() as { user_id: number; author: string }[];

			if (mappings.length === 0) return;

			const stmt = ChatIndexerService.db.prepare(
				`UPDATE messages SET user_id = ?
				 WHERE author = ? AND user_id IS NULL AND timestamp_unix >= ?`,
			);

			const backfill = ChatIndexerService.db.transaction(() => {
				let total = 0;
				for (const { user_id, author } of mappings) {
					const result = stmt.run(user_id, author, threeMonthsAgo);
					total += result.changes;
				}
				return total;
			});

			const updated = backfill();
			if (updated > 0) {
				logger.info("Backfilled user_id on historical messages", {
					mappings: mappings.length,
					updated,
				});
			}
		} catch (error) {
			logger.error("Failed to backfill user_ids", { error });
		}
	}

	/**
	 * Computes active time statistics for a user based on their indexed messages.
	 * Matches by user_id (for new messages) and author name (for historical messages
	 * that predate the user_id column). Also backfills user_id on matched rows.
	 * Limits historical lookup to 3 months.
	 *
	 * @param userId - Telegram user ID
	 * @param authorName - Display name to match historical messages (firstName + lastName)
	 * @returns Active time stats or null if unavailable
	 */
	static getActiveTimeStats(
		userId: number,
		authorName?: string,
	): {
		totalSeconds: number;
		last30dSeconds: number;
		last7dSeconds: number;
		messageCount: number;
		trackedDays: number;
	} | null {
		if (!ChatIndexerService.enabled || !ChatIndexerService.db) return null;

		try {
			const now = Math.floor(Date.now() / 1000);
			const threeMonthsAgo = now - 90 * 86400;

			// Backfill user_id on historical messages matched by author name
			if (authorName) {
				ChatIndexerService.db
					.prepare(
						`UPDATE messages SET user_id = ?
						 WHERE author = ? AND user_id IS NULL
						 AND timestamp_unix >= ?`,
					)
					.run(userId, authorName, threeMonthsAgo);
			}

			// Query all messages for this user (by user_id, which now includes backfilled rows)
			const allTimestamps = ChatIndexerService.db
				.prepare(
					`SELECT timestamp_unix FROM messages
					 WHERE user_id = ? AND timestamp_unix >= ?
					 ORDER BY timestamp_unix`,
				)
				.all(userId, threeMonthsAgo) as { timestamp_unix: number }[];

			if (allTimestamps.length === 0) return null;

			const allTs = allTimestamps.map((r) => r.timestamp_unix);
			const thirtyDaysAgo = now - 30 * 86400;
			const sevenDaysAgo = now - 7 * 86400;

			const last30dTs = allTs.filter((ts) => ts >= thirtyDaysAgo);
			const last7dTs = allTs.filter((ts) => ts >= sevenDaysAgo);

			const firstTs = allTs[0];
			const trackedDays = Math.max(1, Math.ceil((now - firstTs) / 86400));

			return {
				totalSeconds: computeActiveTime(allTs),
				last30dSeconds: computeActiveTime(last30dTs),
				last7dSeconds: computeActiveTime(last7dTs),
				messageCount: allTs.length,
				trackedDays,
			};
		} catch (error) {
			logger.error("Failed to compute active time stats", {
				userId,
				error,
			});
			return null;
		}
	}

	/**
	 * Gracefully shuts down the indexer service.
	 * Clears periodic tasks and closes the DB connection.
	 */
	static shutdown(): void {
		if (ChatIndexerService.embedInterval) {
			clearInterval(ChatIndexerService.embedInterval);
			ChatIndexerService.embedInterval = null;
		}

		if (ChatIndexerService.db) {
			try {
				ChatIndexerService.db.close();
			} catch {
				// Ignore close errors during shutdown
			}
			ChatIndexerService.db = null;
		}

		ChatIndexerService.enabled = false;
		ChatIndexerService.photoQueue = [];
		logger.info("Chat indexer shut down");
	}
}
