import Database from "better-sqlite3";
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
import { ChatIndexerService } from "../../src/services/chatIndexerService";

const TEST_DIR = join(__dirname, "../.tmp-indexer-test");
const TEST_DB_PATH = join(TEST_DIR, "test-indexer.db");

/**
 * Creates the explorer-compatible schema in a test DB.
 */
function createExplorerSchema(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");

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
			raw_html TEXT
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

describe("ChatIndexerService", () => {
	let db: Database.Database;

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

		// Cleanup test files
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
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
		const row = verifyDb.prepare("SELECT * FROM messages WHERE id = ?").get(42) as any;

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
		const row = verifyDb.prepare("SELECT * FROM messages WHERE id = ?").get(400);

		expect(row).toBeUndefined();

		verifyDb.close();
	});

	it("should classify messages into existing topics", async () => {
		// Insert a test topic
		const setupDb = new Database(TEST_DB_PATH);
		setupDb
			.prepare("INSERT INTO topics (name, keywords, message_count) VALUES (?, ?, 0)")
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
		const row = verifyDb.prepare("SELECT * FROM messages WHERE id = ?").get(601) as any;

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
		const row = verifyDb.prepare("SELECT * FROM messages WHERE id = ?").get(800) as any;

		expect(row.author).toBe("John Doe");

		verifyDb.close();
	});
});
