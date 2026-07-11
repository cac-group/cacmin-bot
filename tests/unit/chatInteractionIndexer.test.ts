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

	it("stores multiple active reactions idempotently and removes only the deleted reaction", async () => {
		const next = vi.fn(async () => {});
		const update = {
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
});
