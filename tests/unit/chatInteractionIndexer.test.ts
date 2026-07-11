import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config";
import { ChatInteractionIndexerService } from "../../src/services/chatInteractionIndexerService";
import { Database } from "../../src/sqlite";

const TEST_DIR = join(process.cwd(), "data", "chat-interaction-indexer-test");
const TEST_DB_PATH = join(TEST_DIR, "chat.db");

function createMessageSchema(): void {
	const db = new Database(TEST_DB_PATH);
	db.exec(`
		CREATE TABLE messages (
			id INTEGER PRIMARY KEY,
			author TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			timestamp_unix INTEGER NOT NULL,
			text TEXT,
			file_path TEXT NOT NULL
		);
		INSERT INTO messages (id, author, timestamp, timestamp_unix, text, file_path)
		VALUES (100, 'Target', '2026-01-01T00:00:00.000Z', 1767225600, 'target', 'live');
	`);
	db.close();
}

describe("ChatInteractionIndexerService", () => {
	let reactionHandler:
		| ((ctx: any, next: () => Promise<void>) => Promise<void>)
		| undefined;

	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		createMessageSchema();
		(config as any).indexerEnabled = true;
		(config as any).indexerDbPath = TEST_DB_PATH;
		(config as any).groupChatId = -1001234567890;
		const bot = {
			on: vi.fn((event: string, handler: typeof reactionHandler) => {
				if (event === "message_reaction") reactionHandler = handler;
			}),
		};
		ChatInteractionIndexerService.initialize(bot as any);
	});

	afterEach(() => {
		ChatInteractionIndexerService.shutdown();
		if (existsSync(TEST_DIR))
			rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("waits through short shared-database write contention", () => {
		const db = (ChatInteractionIndexerService as any).db;
		expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 30000 });
	});

	it("does not create or register handlers for a missing indexer database", () => {
		ChatInteractionIndexerService.shutdown();
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
		const missingPath = join(TEST_DIR, "missing.db");
		(config as any).indexerDbPath = missingPath;
		const bot = { on: vi.fn() };

		ChatInteractionIndexerService.initialize(bot as any);

		expect(existsSync(missingPath)).toBe(false);
		expect(bot.on).not.toHaveBeenCalled();
	});

	it("does not mutate or register handlers for a database without messages", () => {
		ChatInteractionIndexerService.shutdown();
		const nonIndexerPath = join(TEST_DIR, "not-indexer.db");
		const nonIndexer = new Database(nonIndexerPath);
		nonIndexer.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
		nonIndexer.close();
		(config as any).indexerDbPath = nonIndexerPath;
		const bot = { on: vi.fn() };

		ChatInteractionIndexerService.initialize(bot as any);

		const verify = new Database(nonIndexerPath, { readonly: true });
		expect(
			verify
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
				)
				.all(),
		).toEqual([{ name: "unrelated" }]);
		verify.close();
		expect(bot.on).not.toHaveBeenCalled();
	});

	it("stores multiple active reactions idempotently and removes only the deleted reaction", async () => {
		const next = vi.fn(async () => {});
		const update = {
			update: { update_id: 100 },
			messageReaction: {
				chat: { id: -1001234567890, type: "supergroup" },
				message_id: 100,
				date: 1767398400,
				user: {
					id: 8,
					first_name: "Reaction",
					last_name: "User",
					username: "reactor",
					is_bot: false,
				},
				old_reaction: [],
				new_reaction: [
					{ type: "emoji", emoji: "🔥" },
					{ type: "emoji", emoji: "❤️" },
				],
			},
		};
		expect(reactionHandler).toBeDefined();
		await reactionHandler!(update, next);
		await reactionHandler!(update, next);

		let db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db
				.prepare(`
			SELECT reactor_user_id, reaction_key
			FROM active_message_reactions
			ORDER BY reaction_key
		`)
				.all(),
		).toEqual([
			{ reactor_user_id: 8, reaction_key: "emoji:❤️" },
			{ reactor_user_id: 8, reaction_key: "emoji:🔥" },
		]);
		expect(db.prepare("SELECT user_id FROM telegram_users").all()).toEqual([
			{ user_id: 8 },
		]);
		db.close();

		await reactionHandler!(
			{
				update: { update_id: 101 },
				messageReaction: {
					...update.messageReaction,
					old_reaction: update.messageReaction.new_reaction,
					new_reaction: [update.messageReaction.new_reaction[1]],
				},
			},
			next,
		);
		db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db.prepare("SELECT reaction_key FROM active_message_reactions").all(),
		).toEqual([{ reaction_key: "emoji:❤️" }]);
		expect(
			db.prepare("SELECT message_id FROM interaction_dirty_messages").all(),
		).toEqual([{ message_id: 100 }]);
		db.close();
		expect(next).toHaveBeenCalledTimes(3);
	});

	it("ignores reaction state delivered after a newer update", async () => {
		const next = vi.fn(async () => {});
		const reaction = {
			chat: { id: -1001234567890, type: "supergroup" },
			message_id: 100,
			date: 1767398400,
			user: { id: 8, first_name: "Reaction" },
			old_reaction: [],
			new_reaction: [{ type: "emoji", emoji: "🔥" }],
		};
		await reactionHandler!(
			{ update: { update_id: 200 }, messageReaction: reaction },
			next,
		);
		await reactionHandler!(
			{
				update: { update_id: 201 },
				messageReaction: {
					...reaction,
					old_reaction: reaction.new_reaction,
					new_reaction: [],
				},
			},
			next,
		);
		await reactionHandler!(
			{ update: { update_id: 200 }, messageReaction: reaction },
			next,
		);

		const db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db.prepare("SELECT reaction_key FROM active_message_reactions").all(),
		).toEqual([]);
		expect(
			db
				.prepare(`
				SELECT last_update_id FROM telegram_reaction_state
				WHERE message_id = 100 AND reactor_user_id = 8
			`)
				.get(),
		).toEqual({ last_update_id: 201 });
		db.close();
	});

	it("records live message identity and ID-backed mentions after the message insert", () => {
		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: {
				id: 7,
				first_name: "Current",
				last_name: "Name",
				username: "current",
			},
			message: {
				message_id: 100,
				date: 1767225600,
				text: "hello Mentioned",
				entities: [
					{
						type: "text_mention",
						offset: 6,
						length: 9,
						user: { id: 9, first_name: "Mentioned" },
					},
				],
			},
		} as any);

		const db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db.prepare("SELECT author_user_id FROM messages WHERE id = 100").get(),
		).toEqual({
			author_user_id: 7,
		});
		expect(
			db
				.prepare(
					"SELECT message_id, mentioned_user_id FROM message_user_mentions",
				)
				.all(),
		).toEqual([{ message_id: 100, mentioned_user_id: 9 }]);
		db.close();
	});

	it("replaces mention and unresolved-reference state when a message is edited", () => {
		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: { id: 7, first_name: "Editor" },
			message: {
				message_id: 100,
				date: 1767225600,
				text: "Mentioned @ghost",
				entities: [
					{
						type: "text_mention",
						offset: 0,
						length: 9,
						user: { id: 9, first_name: "Mentioned" },
					},
					{ type: "mention", offset: 10, length: 6 },
				],
			},
		} as any);

		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: { id: 7, first_name: "Editor" },
			editedMessage: {
				message_id: 100,
				date: 1767225700,
				text: "No mentions remain",
				entities: [],
			},
		} as any);

		const db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db
				.prepare("SELECT * FROM message_user_mentions WHERE message_id = 100")
				.all(),
		).toEqual([]);
		expect(
			db
				.prepare(
					"SELECT * FROM unresolved_user_references WHERE source_message_id = 100 AND role = 'mention'",
				)
				.all(),
		).toEqual([]);
		db.close();
	});

	it("maintains the most recently observed user identity summary", () => {
		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: {
				id: 7,
				first_name: "Newest",
				last_name: "Name",
				username: "newest",
			},
			message: { message_id: 100, date: 1767225700, text: "new" },
		} as any);
		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: { id: 7, first_name: "Older", username: "older" },
			message: { message_id: 100, date: 1767225600, text: "old" },
		} as any);

		const db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db
				.prepare(`
					SELECT current_username, current_username_observed_at_unix,
						current_first_name, current_last_name, current_display_name,
						current_name_observed_at_unix
					FROM telegram_users WHERE user_id = 7
				`)
				.get(),
		).toEqual({
			current_username: "newest",
			current_username_observed_at_unix: 1767225700,
			current_first_name: "Newest",
			current_last_name: "Name",
			current_display_name: "Newest Name",
			current_name_observed_at_unix: 1767225700,
		});
		db.close();
	});

	it("uses edit_date for edited identity, reference, and dirty timestamps", () => {
		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: { id: 7, first_name: "Already Newer" },
			message: { message_id: 100, date: 1767225700, text: "before edit" },
		} as any);

		ChatInteractionIndexerService.indexMessageIdentity({
			chat: { id: -1001234567890 },
			from: { id: 7, first_name: "Edited Current" },
			editedMessage: {
				message_id: 100,
				date: 1767225600,
				edit_date: 1767225800,
				text: "Mentioned @ghost",
				entities: [
					{
						type: "text_mention",
						offset: 0,
						length: 9,
						user: { id: 9, first_name: "Mentioned Current" },
					},
					{ type: "mention", offset: 10, length: 6 },
				],
			},
		} as any);

		const db = new Database(TEST_DB_PATH, { readonly: true });
		expect(
			db
				.prepare(`
					SELECT current_display_name, current_name_observed_at_unix
					FROM telegram_users WHERE user_id = 7
				`)
				.get(),
		).toEqual({
			current_display_name: "Edited Current",
			current_name_observed_at_unix: 1767225800,
		});
		expect(
			db
				.prepare(`
					SELECT observed_at_unix FROM telegram_user_identity_history
					WHERE user_id = 9 AND source_message_id = 100
				`)
				.get(),
		).toEqual({ observed_at_unix: 1767225800 });
		expect(
			db
				.prepare(`
					SELECT observed_at_unix FROM unresolved_user_references
					WHERE source_message_id = 100 AND role = 'mention'
				`)
				.get(),
		).toEqual({ observed_at_unix: 1767225800 });
		expect(
			db
				.prepare(
					"SELECT updated_at_unix FROM interaction_dirty_messages WHERE message_id = 100",
				)
				.get(),
		).toEqual({ updated_at_unix: 1767225800 });
		db.close();
	});
});
