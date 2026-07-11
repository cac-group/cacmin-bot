import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { Database, type SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface TelegramUserIdentity {
	id: number;
	first_name?: string;
	last_name?: string;
	username?: string;
	is_bot?: boolean;
}

interface ReactionIdentity {
	type: "emoji" | "custom_emoji" | "paid";
	value: string;
}

export class ChatInteractionIndexerService {
	private static db: SqliteDatabase | null = null;
	private static enabled = false;

	static initialize(bot: Telegraf<Context>): void {
		if (!config.indexerEnabled || !config.indexerDbPath) return;
		try {
			ChatInteractionIndexerService.db = new Database(config.indexerDbPath);
			ChatInteractionIndexerService.db.exec("PRAGMA journal_mode = WAL");
			ChatInteractionIndexerService.ensureSchema();
			ChatInteractionIndexerService.enabled = true;
			bot.on("message_reaction", async (ctx, next) => {
				ChatInteractionIndexerService.indexReaction(ctx.messageReaction);
				await next();
			});
			logger.info("Chat interaction indexer initialized", {
				dbPath: config.indexerDbPath,
			});
		} catch (error) {
			logger.error("Failed to initialize chat interaction indexer", { error });
			ChatInteractionIndexerService.shutdown();
		}
	}

	private static ensureSchema(): void {
		const db = ChatInteractionIndexerService.db;
		if (!db) return;
		try {
			db.exec("ALTER TABLE messages ADD COLUMN author_user_id INTEGER");
		} catch {
			// Column already exists.
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS telegram_users (
				user_id INTEGER PRIMARY KEY,
				is_bot INTEGER,
				first_seen_unix INTEGER NOT NULL,
				last_seen_unix INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS telegram_user_identity_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				username TEXT,
				first_name TEXT,
				last_name TEXT,
				display_name TEXT,
				observed_at_unix INTEGER NOT NULL,
				source_message_id INTEGER,
				source TEXT NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identity_observation
			ON telegram_user_identity_history(
				user_id, COALESCE(username, ''), COALESCE(first_name, ''),
				COALESCE(last_name, ''), COALESCE(display_name, ''), observed_at_unix,
				COALESCE(source_message_id, -1), source
			);
			CREATE TABLE IF NOT EXISTS telegram_user_aliases (
				user_id INTEGER NOT NULL,
				alias_type TEXT NOT NULL,
				alias_value TEXT NOT NULL,
				normalized_value TEXT NOT NULL,
				first_seen_unix INTEGER NOT NULL,
				last_seen_unix INTEGER NOT NULL,
				PRIMARY KEY (user_id, alias_type, normalized_value)
			);
			CREATE INDEX IF NOT EXISTS idx_user_alias_lookup
			ON telegram_user_aliases(normalized_value, alias_type, user_id);
			CREATE TABLE IF NOT EXISTS message_user_mentions (
				message_id INTEGER NOT NULL,
				mentioned_user_id INTEGER NOT NULL,
				source TEXT NOT NULL,
				PRIMARY KEY (message_id, mentioned_user_id)
			);
			CREATE TABLE IF NOT EXISTS unresolved_user_references (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_message_id INTEGER,
				role TEXT NOT NULL,
				raw_value TEXT NOT NULL,
				normalized_value TEXT NOT NULL,
				observed_at_unix INTEGER NOT NULL,
				reason TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				resolved_user_id INTEGER,
				UNIQUE(source_message_id, role, normalized_value)
			);
			CREATE TABLE IF NOT EXISTS active_message_reactions (
				message_id INTEGER NOT NULL,
				reactor_user_id INTEGER NOT NULL,
				reaction_key TEXT NOT NULL,
				reaction_type TEXT NOT NULL,
				reaction_value TEXT NOT NULL,
				reacted_at_unix INTEGER NOT NULL,
				PRIMARY KEY (message_id, reactor_user_id, reaction_key)
			);
			CREATE TABLE IF NOT EXISTS interaction_dirty_messages (
				message_id INTEGER PRIMARY KEY,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				updated_at_unix INTEGER NOT NULL
			)
		`);
	}

	static indexMessageIdentity(ctx: Context): void {
		const db = ChatInteractionIndexerService.db;
		const message = ctx.message || (ctx as any).editedMessage;
		const user = ctx.from;
		if (!ChatInteractionIndexerService.enabled || !db || !message || !user)
			return;
		if (config.groupChatId && ctx.chat?.id !== config.groupChatId) return;

		try {
			const apply = db.transaction(() => {
				ChatInteractionIndexerService.recordIdentity(
					user,
					message.date,
					message.message_id,
				);
				db.prepare("UPDATE messages SET author_user_id = ? WHERE id = ?").run(
					user.id,
					message.message_id,
				);
				ChatInteractionIndexerService.recordMentions(message as any);
				ChatInteractionIndexerService.enqueue(message.message_id, message.date);
			});
			apply();
		} catch (error) {
			logger.error("Failed to index chat identity", {
				error,
				messageId: message.message_id,
			});
		}
	}

	static indexReaction(reaction: any): void {
		const db = ChatInteractionIndexerService.db;
		if (!ChatInteractionIndexerService.enabled || !db || !reaction?.user)
			return;
		if (config.groupChatId && reaction.chat?.id !== config.groupChatId) return;

		try {
			const oldReactions = new Map<string, ReactionIdentity>(
				(reaction.old_reaction || []).map((value: any) => {
					const parsed = ChatInteractionIndexerService.parseReaction(value);
					return [ChatInteractionIndexerService.reactionKey(parsed), parsed];
				}),
			);
			const newReactions = new Map<string, ReactionIdentity>(
				(reaction.new_reaction || []).map((value: any) => {
					const parsed = ChatInteractionIndexerService.parseReaction(value);
					return [ChatInteractionIndexerService.reactionKey(parsed), parsed];
				}),
			);
			const apply = db.transaction(() => {
				ChatInteractionIndexerService.recordIdentity(
					reaction.user,
					reaction.date,
					reaction.message_id,
				);
				for (const key of oldReactions.keys()) {
					if (newReactions.has(key)) continue;
					db.prepare(`
						DELETE FROM active_message_reactions
						WHERE message_id = ? AND reactor_user_id = ? AND reaction_key = ?
					`).run(reaction.message_id, reaction.user.id, key);
				}
				for (const [key, value] of newReactions) {
					db.prepare(`
						INSERT OR IGNORE INTO active_message_reactions (
							message_id, reactor_user_id, reaction_key, reaction_type,
							reaction_value, reacted_at_unix
						) VALUES (?, ?, ?, ?, ?, ?)
					`).run(
						reaction.message_id,
						reaction.user.id,
						key,
						value.type,
						value.value,
						reaction.date,
					);
				}
				ChatInteractionIndexerService.enqueue(
					reaction.message_id,
					reaction.date,
				);
			});
			apply();
		} catch (error) {
			logger.error("Failed to index chat reaction", {
				error,
				messageId: reaction.message_id,
			});
		}
	}

	private static recordMentions(message: any): void {
		const db = ChatInteractionIndexerService.db;
		if (!db) return;
		const text = message.text || message.caption || "";
		const entities = message.entities || message.caption_entities || [];
		for (const entity of entities) {
			const rawValue = text.slice(entity.offset, entity.offset + entity.length);
			if (entity.type === "text_mention" && entity.user?.id) {
				ChatInteractionIndexerService.recordIdentity(
					entity.user,
					message.date,
					message.message_id,
				);
				db.prepare(`
					INSERT OR IGNORE INTO message_user_mentions (message_id, mentioned_user_id, source)
					VALUES (?, ?, 'telegram-live')
				`).run(message.message_id, entity.user.id);
			} else if (entity.type === "mention" && rawValue) {
				const normalized = ChatInteractionIndexerService.normalize(
					rawValue,
					true,
				);
				const matches = db
					.prepare(`
					SELECT DISTINCT user_id FROM telegram_user_aliases
					WHERE alias_type = 'username' AND normalized_value = ?
				`)
					.all(normalized) as Array<{ user_id: number }>;
				if (matches.length === 1) {
					db.prepare(`
						INSERT OR IGNORE INTO message_user_mentions (message_id, mentioned_user_id, source)
						VALUES (?, ?, 'telegram-live')
					`).run(message.message_id, matches[0].user_id);
				} else {
					db.prepare(`
						INSERT INTO unresolved_user_references (
							source_message_id, role, raw_value, normalized_value,
							observed_at_unix, reason
						) VALUES (?, 'mention', ?, ?, ?, ?)
						ON CONFLICT(source_message_id, role, normalized_value) DO UPDATE SET
							raw_value = excluded.raw_value, observed_at_unix = excluded.observed_at_unix,
							reason = excluded.reason
					`).run(
						message.message_id,
						rawValue,
						normalized,
						message.date,
						matches.length > 1 ? "ambiguous-username" : "unknown-username",
					);
				}
			}
		}
	}

	private static recordIdentity(
		user: TelegramUserIdentity,
		observedAtUnix: number,
		sourceMessageId: number,
	): void {
		const db = ChatInteractionIndexerService.db;
		if (!db) return;
		const username = user.username?.trim().replace(/^@/, "") || null;
		const firstName = user.first_name?.trim() || null;
		const lastName = user.last_name?.trim() || null;
		const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;
		db.prepare(`
			INSERT INTO telegram_users (user_id, is_bot, first_seen_unix, last_seen_unix)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				is_bot = COALESCE(excluded.is_bot, telegram_users.is_bot),
				first_seen_unix = MIN(first_seen_unix, excluded.first_seen_unix),
				last_seen_unix = MAX(last_seen_unix, excluded.last_seen_unix)
		`).run(
			user.id,
			user.is_bot == null ? null : Number(user.is_bot),
			observedAtUnix,
			observedAtUnix,
		);
		db.prepare(`
			INSERT OR IGNORE INTO telegram_user_identity_history (
				user_id, username, first_name, last_name, display_name,
				observed_at_unix, source_message_id, source
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'telegram-live')
		`).run(
			user.id,
			username,
			firstName,
			lastName,
			displayName,
			observedAtUnix,
			sourceMessageId,
		);
		ChatInteractionIndexerService.upsertAlias(
			user.id,
			"user_id",
			String(user.id),
			observedAtUnix,
		);
		if (username)
			ChatInteractionIndexerService.upsertAlias(
				user.id,
				"username",
				username,
				observedAtUnix,
			);
		if (firstName)
			ChatInteractionIndexerService.upsertAlias(
				user.id,
				"first_name",
				firstName,
				observedAtUnix,
			);
		if (lastName)
			ChatInteractionIndexerService.upsertAlias(
				user.id,
				"last_name",
				lastName,
				observedAtUnix,
			);
		if (displayName)
			ChatInteractionIndexerService.upsertAlias(
				user.id,
				"display_name",
				displayName,
				observedAtUnix,
			);
	}

	private static upsertAlias(
		userId: number,
		aliasType: string,
		aliasValue: string,
		observedAtUnix: number,
	): void {
		ChatInteractionIndexerService.db
			?.prepare(`
			INSERT INTO telegram_user_aliases (
				user_id, alias_type, alias_value, normalized_value,
				first_seen_unix, last_seen_unix
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, alias_type, normalized_value) DO UPDATE SET
				alias_value = CASE WHEN excluded.last_seen_unix >= last_seen_unix
					THEN excluded.alias_value ELSE alias_value END,
				first_seen_unix = MIN(first_seen_unix, excluded.first_seen_unix),
				last_seen_unix = MAX(last_seen_unix, excluded.last_seen_unix)
		`)
			.run(
				userId,
				aliasType,
				aliasValue,
				ChatInteractionIndexerService.normalize(
					aliasValue,
					aliasType === "username",
				),
				observedAtUnix,
				observedAtUnix,
			);
	}

	private static normalize(value: string, username = false): string {
		const normalized = value
			.normalize("NFKC")
			.trim()
			.replace(/\s+/g, " ")
			.toLocaleLowerCase("en-US");
		return username ? normalized.replace(/^@/, "") : normalized;
	}

	private static parseReaction(reaction: any): ReactionIdentity {
		if (reaction.type === "emoji")
			return { type: "emoji", value: reaction.emoji };
		if (reaction.type === "custom_emoji") {
			return { type: "custom_emoji", value: reaction.custom_emoji_id };
		}
		return { type: "paid", value: "paid" };
	}

	private static reactionKey(reaction: ReactionIdentity): string {
		return `${reaction.type}:${reaction.value}`;
	}

	private static enqueue(messageId: number, updatedAtUnix: number): void {
		ChatInteractionIndexerService.db
			?.prepare(`
			INSERT INTO interaction_dirty_messages (message_id, attempts, last_error, updated_at_unix)
			VALUES (?, 0, NULL, ?)
			ON CONFLICT(message_id) DO UPDATE SET
				attempts = 0, last_error = NULL, updated_at_unix = excluded.updated_at_unix
		`)
			.run(messageId, updatedAtUnix);
	}

	static shutdown(): void {
		if (ChatInteractionIndexerService.db) {
			try {
				ChatInteractionIndexerService.db.close();
			} catch {
				// Ignore close errors during shutdown.
			}
		}
		ChatInteractionIndexerService.db = null;
		ChatInteractionIndexerService.enabled = false;
	}
}
