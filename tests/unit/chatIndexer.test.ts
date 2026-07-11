import { Database } from "../../src/sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../helpers/mockContext";

// Mock config before importing the service
vi.mock("../../src/config", () => ({
	config: {
		indexerEnabled: true,
		indexerDbPath: "",
		indexerDatasetId: "test-dataset",
		indexerMediaDir: "",
		indexerEmbeddingsEnabled: false,
		indexerEmbedTriggerFile: "",
		indexerEmbedTriggerBatchSize: 2,
		ollamaUrl: "http://localhost:11434",
		embedModel: "nomic-embed-text",
		visionModel: "qwen3-vl:2b",
		embedBatchIntervalMs: 300000,
		groupChatId: -1001234567890,
	},
}));

// Mock logger to avoid noise in tests
vi.mock("../../src/utils/logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { config } from "../../src/config";
import { ChatInteractionIndexerService } from "../../src/services/chatInteractionIndexerService";
import { ChatIndexerService } from "../../src/services/chatIndexerService";

const TEST_DIR = join(__dirname, "../.tmp-indexer-test");
const TEST_DB_PATH = join(TEST_DIR, "test-indexer.db");

/**
 * Creates the explorer-compatible schema in a test DB.
 */
function createExplorerSchema(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");

	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY,
			author TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			timestamp_unix INTEGER NOT NULL,
			text TEXT,
			has_media INTEGER DEFAULT 0,
			media_type TEXT,
			media_path TEXT,
			reply_to_id INTEGER,
			is_forwarded INTEGER DEFAULT 0,
			forwarded_from TEXT,
			file_path TEXT NOT NULL,
			raw_html TEXT,
			user_id INTEGER
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS authors (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			message_count INTEGER DEFAULT 0,
			first_seen TEXT,
			last_seen TEXT,
			top_words TEXT
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS dataset_meta (
			key TEXT PRIMARY KEY,
			value TEXT
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS topics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			description TEXT,
			keywords TEXT,
			message_count INTEGER DEFAULT 0
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS message_topics (
			message_id INTEGER NOT NULL,
			topic_id INTEGER NOT NULL,
			confidence REAL DEFAULT 1.0,
			PRIMARY KEY (message_id, topic_id),
			FOREIGN KEY (message_id) REFERENCES messages(id),
			FOREIGN KEY (topic_id) REFERENCES topics(id)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS embeddings (
			message_id INTEGER PRIMARY KEY,
			vector BLOB NOT NULL,
			FOREIGN KEY (message_id) REFERENCES messages(id)
		)
	`);

	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			text, author,
			content='messages',
			content_rowid='id',
			tokenize='porter unicode61'
		)
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts(rowid, text, author) VALUES (new.id, new.text, new.author);
		END
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS image_descriptions (
			message_id INTEGER PRIMARY KEY,
			description TEXT
		)
	`);
}

function getKeyValueRows(table: string): Record<string, string> {
	const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
	const rows = verifyDb.prepare(`SELECT key, value FROM ${table}`).all() as {
		key: string;
		value: string;
	}[];
	verifyDb.close();
	return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

describe("ChatIndexerService", () => {
	let db: Database;

	beforeEach(() => {
		if (!existsSync(TEST_DIR)) {
			mkdirSync(TEST_DIR, { recursive: true });
		}

		// Create fresh test DB with explorer schema
		if (existsSync(TEST_DB_PATH)) {
			rmSync(TEST_DB_PATH);
			// Clean up WAL/SHM files
			if (existsSync(`${TEST_DB_PATH}-wal`)) rmSync(`${TEST_DB_PATH}-wal`);
			if (existsSync(`${TEST_DB_PATH}-shm`)) rmSync(`${TEST_DB_PATH}-shm`);
		}
		db = new Database(TEST_DB_PATH);
		createExplorerSchema(db);
		db.close();

		// Point config to test DB
		(config as any).indexerDbPath = TEST_DB_PATH;
		(config as any).indexerMediaDir = TEST_DIR;
		(config as any).indexerEmbeddingsEnabled = false;
		(config as any).indexerEmbedTriggerFile = join(
			TEST_DIR,
			"embed-missing.trigger",
		);
		(config as any).indexerEmbedTriggerBatchSize = 2;

		// Mock bot with minimal Telegraf shape
		const mockBot = {
			telegram: {
				getFileLink: vi.fn(),
			},
		};

		// Initialize the service
		ChatIndexerService.initialize(mockBot as any);
	});

	afterEach(() => {
		ChatIndexerService.shutdown();
		ChatInteractionIndexerService.shutdown();

		// Cleanup test files
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("waits through short shared-database write contention", () => {
		const db = (ChatIndexerService as any).db;
		expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 30000 });
	});

	it("should index a text message into the DB", async () => {
		const ctx = createMockContext({
			messageText: "Hello this is a test message from the group chat",
			messageId: 42,
			userId: 999,
			firstName: "Alice",
			chatId: -1001234567890,
			chatType: "supergroup",
		});

		await ChatIndexerService.indexMessage(ctx as any);

		// Verify the message was inserted
		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const row = verifyDb
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(42) as any;

		expect(row).toBeDefined();
		expect(row.id).toBe(42);
		expect(row.author).toBe("Alice");
		expect(row.text).toBe("Hello this is a test message from the group chat");
		expect(row.file_path).toBe("live");
		expect(row.has_media).toBe(0);
		expect(row.raw_html).toBeNull();

		verifyDb.close();
	});

	it("should update author stats on message insert", async () => {
		const ctx = createMockContext({
			messageText: "First message",
			messageId: 100,
			userId: 999,
			firstName: "Bob",
			chatId: -1001234567890,
		});

		await ChatIndexerService.indexMessage(ctx as any);

		// Send another message
		const ctx2 = createMockContext({
			messageText: "Second message",
			messageId: 101,
			userId: 999,
			firstName: "Bob",
			chatId: -1001234567890,
		});

		await ChatIndexerService.indexMessage(ctx2 as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const author = verifyDb
			.prepare("SELECT * FROM authors WHERE name = ?")
			.get("Bob") as any;

		expect(author).toBeDefined();
		expect(author.message_count).toBe(2);
		expect(author.first_seen).toBeDefined();
		expect(author.last_seen).toBeDefined();

		verifyDb.close();
	});

	it("refreshes stale dataset metadata on startup", () => {
		ChatIndexerService.shutdown();

		const setupDb = new Database(TEST_DB_PATH);
		setupDb
			.prepare(`
				INSERT INTO messages (
					id, author, timestamp, timestamp_unix, text, has_media, media_type,
					media_path, reply_to_id, is_forwarded, forwarded_from, file_path, raw_html, user_id
				)
				VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, NULL, 'messages.html', '', NULL)
			`)
			.run(
				1000,
				"Historical",
				"2026-07-01T00:00:00.000Z",
				1782878400,
				"Historical message long enough for embedding",
			);
		setupDb
			.prepare(`
				INSERT INTO messages (
					id, author, timestamp, timestamp_unix, text, has_media, media_type,
					media_path, reply_to_id, is_forwarded, forwarded_from, file_path, raw_html, user_id
				)
				VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, NULL, 'messages.html', '', NULL)
			`)
			.run(
				1001,
				"Second",
				"2026-07-02T00:00:00.000Z",
				1782964800,
				"Another historical message long enough for embedding",
			);
		setupDb
			.prepare("INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)")
			.run("messageCount", "1");
		setupDb.close();

		const mockBot = { telegram: { getFileLink: vi.fn() } };
		ChatIndexerService.initialize(mockBot as any);

		const meta = getKeyValueRows("dataset_meta");
		const liveState = getKeyValueRows("live_index_state");
		expect(meta.messageCount).toBe("2");
		expect(meta.authorCount).toBe("2");
		expect(meta.lastMessage).toBe("2026-07-02T00:00:00.000Z");
		expect(liveState.sqlite_messages_total).toBe("2");
		expect(liveState.sqlite_authors_total).toBe("2");
		expect(liveState.latest_message_id).toBe("1001");
		expect(liveState.latest_message_timestamp_unix).toBe("1782964800");
	});

	it("updates dataset metadata and live counters for new inserts without double-counting duplicates", async () => {
		const ctx = createMockContext({
			messageText: "This live message is long enough for semantic embeddings",
			messageId: 1100,
			userId: 999,
			firstName: "Metric",
			chatId: -1001234567890,
		});
		(ctx.message as any).date = 1783190160;

		await ChatIndexerService.indexMessage(ctx as any);
		await ChatIndexerService.indexMessage(ctx as any);

		const meta = getKeyValueRows("dataset_meta");
		const liveState = getKeyValueRows("live_index_state");
		expect(meta.messageCount).toBe("1");
		expect(meta.authorCount).toBe("1");
		expect(meta.lastMessage).toBe(new Date(1783190160 * 1000).toISOString());
		expect(liveState.sqlite_messages_total).toBe("1");
		expect(liveState.sqlite_authors_total).toBe("1");
		expect(liveState.latest_message_id).toBe("1100");
		expect(liveState.latest_message_timestamp_unix).toBe("1783190160");
		expect(liveState.live_messages_inserted_total).toBe("1");
		expect(liveState.live_embedding_candidates_inserted_total).toBe("1");
		expect(liveState.pending_embedding_candidates).toBe("1");
	});

	it("should index messages into FTS", async () => {
		const ctx = createMockContext({
			messageText: "Cosmos blockchain governance proposal voting",
			messageId: 200,
			userId: 999,
			firstName: "Charlie",
			chatId: -1001234567890,
		});

		await ChatIndexerService.indexMessage(ctx as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const ftsResult = verifyDb
			.prepare("SELECT * FROM messages_fts WHERE messages_fts MATCH ?")
			.all("governance") as any[];

		expect(ftsResult.length).toBe(1);
		expect(ftsResult[0].text).toContain("governance");

		verifyDb.close();
	});

	it("should not index duplicate messages", async () => {
		const ctx = createMockContext({
			messageText: "Duplicate test",
			messageId: 300,
			userId: 999,
			firstName: "Dave",
			chatId: -1001234567890,
		});

		await ChatIndexerService.indexMessage(ctx as any);
		await ChatIndexerService.indexMessage(ctx as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const count = verifyDb
			.prepare("SELECT COUNT(*) as cnt FROM messages WHERE id = ?")
			.get(300) as any;

		expect(count.cnt).toBe(1);

		verifyDb.close();
	});

	it("retries identity maintenance for an already indexed message", async () => {
		const ctx = createMockContext({
			messageText: "Identity retry",
			messageId: 301,
			userId: 991,
			firstName: "Retry",
			chatId: -1001234567890,
		});
		await ChatIndexerService.indexMessage(ctx as any);

		const interactionBot = { on: vi.fn() };
		ChatInteractionIndexerService.initialize(interactionBot as any);
		const setupDb = new Database(TEST_DB_PATH);
		setupDb
			.prepare("UPDATE messages SET author_user_id = NULL WHERE id = 301")
			.run();
		setupDb.close();

		await ChatIndexerService.indexMessage(ctx as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			verifyDb
				.prepare("SELECT author_user_id FROM messages WHERE id = 301")
				.get(),
		).toEqual({ author_user_id: 991 });
		expect(
			verifyDb
				.prepare("SELECT user_id FROM telegram_users WHERE user_id = 991")
				.get(),
		).toEqual({ user_id: 991 });
		verifyDb.close();
	});

	it("should skip messages from non-group chats", async () => {
		const ctx = createMockContext({
			messageText: "Private message",
			messageId: 400,
			userId: 999,
			firstName: "Eve",
			chatId: 999,
			chatType: "private",
		});

		await ChatIndexerService.indexMessage(ctx as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const row = verifyDb
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(400);

		expect(row).toBeUndefined();

		verifyDb.close();
	});

	it("touches the embedding trigger after enough eligible inserts", async () => {
		const triggerFile = join(TEST_DIR, "embed-missing.trigger");

		await ChatIndexerService.indexMessage(
			createMockContext({
				messageText: "short",
				messageId: 900,
				userId: 999,
				firstName: "Trigger",
				chatId: -1001234567890,
			}) as any,
		);

		expect(existsSync(triggerFile)).toBe(false);

		await ChatIndexerService.indexMessage(
			createMockContext({
				messageText: "This message is long enough for semantic embeddings",
				messageId: 901,
				userId: 999,
				firstName: "Trigger",
				chatId: -1001234567890,
			}) as any,
		);
		await ChatIndexerService.indexMessage(
			createMockContext({
				messageText: "This message is long enough for semantic embeddings",
				messageId: 901,
				userId: 999,
				firstName: "Trigger",
				chatId: -1001234567890,
			}) as any,
		);

		expect(existsSync(triggerFile)).toBe(false);

		let verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		let state = verifyDb
			.prepare("SELECT value FROM live_index_state WHERE key = ?")
			.get("pending_embedding_candidates") as any;
		expect(state.value).toBe("1");
		verifyDb.close();

		await ChatIndexerService.indexMessage(
			createMockContext({
				messageText: "Another message long enough for semantic embeddings",
				messageId: 902,
				userId: 999,
				firstName: "Trigger",
				chatId: -1001234567890,
			}) as any,
		);

		expect(existsSync(triggerFile)).toBe(true);
		verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		state = verifyDb
			.prepare("SELECT value FROM live_index_state WHERE key = ?")
			.get("pending_embedding_candidates") as any;
		expect(state.value).toBe("0");
		verifyDb.close();
	});

	it("should classify messages into existing topics", async () => {
		// Insert a test topic
		const setupDb = new Database(TEST_DB_PATH);
		setupDb
			.prepare(
				"INSERT INTO topics (name, keywords, message_count) VALUES (?, ?, 0)",
			)
			.run("Airdrops", "airdrop,airdrops,claim,claiming,free tokens");
		setupDb.close();

		// Re-initialize to pick up the topic patterns
		ChatIndexerService.shutdown();
		const mockBot = { telegram: { getFileLink: vi.fn() } };
		ChatIndexerService.initialize(mockBot as any);

		const ctx = createMockContext({
			messageText: "When is the next airdrop happening?",
			messageId: 500,
			userId: 999,
			firstName: "Frank",
			chatId: -1001234567890,
		});

		await ChatIndexerService.indexMessage(ctx as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const topicMatch = verifyDb
			.prepare("SELECT * FROM message_topics WHERE message_id = ?")
			.get(500) as any;

		expect(topicMatch).toBeDefined();
		expect(topicMatch.confidence).toBe(0.8);

		// Check topic message_count was incremented
		const topic = verifyDb
			.prepare("SELECT * FROM topics WHERE name = ?")
			.get("Airdrops") as any;
		expect(topic.message_count).toBe(1);

		verifyDb.close();
	});

	it("should handle reply_to_id correctly", async () => {
		// Insert an original message first
		const ctx1 = createMockContext({
			messageText: "Original message",
			messageId: 600,
			userId: 999,
			firstName: "Grace",
			chatId: -1001234567890,
		});
		await ChatIndexerService.indexMessage(ctx1 as any);

		// Create a reply context with reply_to_message set
		const ctx2 = createMockContext({
			messageText: "This is a reply",
			messageId: 601,
			userId: 888,
			firstName: "Hank",
			chatId: -1001234567890,
		});
		// Manually add reply_to_message on the mock
		(ctx2.message as any).reply_to_message = {
			message_id: 600,
		};

		await ChatIndexerService.indexMessage(ctx2 as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const row = verifyDb
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(601) as any;

		expect(row.reply_to_id).toBe(600);

		verifyDb.close();
	});

	it("should not throw when indexing fails", async () => {
		// Shutdown service to ensure DB is null
		ChatIndexerService.shutdown();

		// Should not throw even when service is disabled
		const ctx = createMockContext({
			messageText: "Should not throw",
			messageId: 700,
		});

		await expect(
			ChatIndexerService.indexMessage(ctx as any),
		).resolves.toBeUndefined();
	});

	it("should handle messages with first and last name", async () => {
		const ctx = createMockContext({
			messageText: "Full name test",
			messageId: 800,
			userId: 999,
			firstName: "John",
			chatId: -1001234567890,
		});
		// Add last name to mock
		(ctx.from as any).last_name = "Doe";

		await ChatIndexerService.indexMessage(ctx as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		const row = verifyDb
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(800) as any;

		expect(row.author).toBe("John Doe");

		verifyDb.close();
	});

	it("applies edited messages and invalidates stale derived rows", async () => {
		const ctx = createMockContext({
			messageText: "Original content long enough for an embedding",
			messageId: 900,
			userId: 999,
			firstName: "Editor",
			chatId: -1001234567890,
		});
		await ChatIndexerService.indexMessage(ctx as any);
		const setupDb = new Database(TEST_DB_PATH);
		setupDb
			.prepare("INSERT INTO embeddings (message_id, vector) VALUES (?, ?)")
			.run(900, Buffer.alloc(8));
		setupDb
			.prepare(
				"INSERT INTO topics (id, name, keywords) VALUES (900, 'Old', 'old')",
			)
			.run();
		setupDb.prepare("UPDATE topics SET message_count = 1 WHERE id = 900").run();
		setupDb
			.prepare(
				"INSERT INTO message_topics (message_id, topic_id) VALUES (900, 900)",
			)
			.run();
		setupDb
			.prepare("UPDATE authors SET top_words = ? WHERE name = 'Editor'")
			.run('["preserved"]');
		setupDb
			.prepare(
				"INSERT INTO image_descriptions (message_id, description) VALUES (900, 'old')",
			)
			.run();
		setupDb.close();

		await ChatIndexerService.indexEditedMessage({
			chat: { id: -1001234567890 },
			from: { id: 999, first_name: "Editor" },
			editedMessage: {
				message_id: 900,
				date: 1767225700,
				text: "Edited replacement content long enough for an embedding",
			},
		} as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			verifyDb
				.prepare("SELECT text, timestamp_unix FROM messages WHERE id = 900")
				.get(),
		).toEqual({
			text: "Edited replacement content long enough for an embedding",
			timestamp_unix: 1767225700,
		});
		expect(
			verifyDb
				.prepare(
					"SELECT COUNT(*) AS count FROM embeddings WHERE message_id = 900",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			verifyDb
				.prepare(
					"SELECT COUNT(*) AS count FROM message_topics WHERE message_id = 900",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			verifyDb
				.prepare(
					"SELECT COUNT(*) AS count FROM image_descriptions WHERE message_id = 900",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			verifyDb.prepare("SELECT message_count FROM topics WHERE id = 900").get(),
		).toEqual({ message_count: 0 });
		expect(
			verifyDb
				.prepare("SELECT top_words FROM authors WHERE name = 'Editor'")
				.get(),
		).toEqual({ top_words: '["preserved"]' });
		verifyDb.close();
	});

	it("advances an existing vector delete generation when an edit timestamp repeats", async () => {
		const ctx = createMockContext({
			messageText: "Original vector-backed message",
			messageId: 901,
			userId: 999,
			firstName: "Editor",
			chatId: -1001234567890,
		});
		(ctx.message as any).date = 1767225700;
		await ChatIndexerService.indexMessage(ctx as any);

		const setupDb = new Database(TEST_DB_PATH);
		setupDb.exec(`
			ALTER TABLE embeddings ADD COLUMN model TEXT;
			CREATE TABLE vector_sync_state (
				dataset_id TEXT NOT NULL,
				embedding_model TEXT NOT NULL,
				message_id INTEGER NOT NULL,
				operation TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				updated_at_unix INTEGER NOT NULL,
				generation INTEGER NOT NULL DEFAULT 1,
				PRIMARY KEY (dataset_id, embedding_model, message_id)
			);
		`);
		setupDb
			.prepare(
				"INSERT INTO embeddings (message_id, vector, model) VALUES (?, ?, ?)",
			)
			.run(901, Buffer.alloc(8), "nomic-embed-text");
		setupDb
			.prepare(`
				INSERT INTO vector_sync_state (
					dataset_id, embedding_model, message_id, operation,
					attempts, last_error, updated_at_unix, generation
				) VALUES (?, ?, ?, 'upsert', 2, 'old failure', ?, 4)
			`)
			.run("test-dataset", "nomic-embed-text", 901, 1767225700);
		setupDb.close();

		await ChatIndexerService.indexEditedMessage({
			chat: { id: -1001234567890 },
			from: { id: 999, first_name: "Editor" },
			editedMessage: {
				message_id: 901,
				date: 1767225700,
				text: "Edited vector-backed message",
			},
		} as any);

		const verifyDb = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			verifyDb
				.prepare(`
					SELECT operation, attempts, last_error, updated_at_unix, generation
					FROM vector_sync_state
					WHERE dataset_id = ? AND embedding_model = ? AND message_id = ?
				`)
				.get("test-dataset", "nomic-embed-text", 901),
		).toEqual({
			operation: "delete",
			attempts: 0,
			last_error: null,
			updated_at_unix: 1767225700,
			generation: 5,
		});
		verifyDb.close();
	});
});
