/**
 * Migration 016: append-only join/leave event log.
 *
 * `user_memberships` only records the first observed join (member age). This
 * table records every join and leave transition so join/leave activity can be
 * surfaced as statistics. It is append-only; nothing is updated or deleted.
 *
 * The bot is the sole writer. Consumers (telegram-chat-explorer, the CAC museum
 * mini-app) read it live and never write back.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

/** Check whether migration 016 has already completed. */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	try {
		const row = db
			.prepare(
				"SELECT value FROM system_state WHERE key = 'migration_016_membership_events'",
			)
			.get() as { value: string } | undefined;
		return row?.value === "completed";
	} catch {
		return false;
	}
}

/** Create the `user_membership_events` table and its lookup index. */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) {
		result.success = true;
		return result;
	}

	try {
		db.exec("BEGIN TRANSACTION");
		db.exec(`
			CREATE TABLE IF NOT EXISTS user_membership_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				chat_id INTEGER,
				event_type TEXT NOT NULL CHECK (event_type IN ('join', 'leave')),
				source TEXT,
				occurred_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
			);
			CREATE INDEX IF NOT EXISTS idx_membership_events_user
				ON user_membership_events(user_id, occurred_at);
		`);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_016_membership_events', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info(
			"Migration 016 completed: user_membership_events table created",
		);
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// BEGIN itself may have failed; nothing to roll back.
		}
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 016 failed, rolled back", { error });
	}

	return result;
}
