/**
 * Migration 005: Backfill users.message_count from the indexed message history.
 *
 * `users.message_count` decides whether a reactor is "new" (and therefore
 * eligible for reaction-spam checks). It is only incremented from the moment
 * the column exists, so every user who predates the change starts at 0 and is
 * misclassified as new until they send five more messages.
 *
 * This migration reads the live message index (`INDEXER_DB_PATH`) and sets each
 * user's count to their lifetime indexed message total. Counts are grouped
 * strictly by the message author's user id (`author_user_id`, falling back to
 * `user_id`); author/display names are never used because they are not unique.
 * `author_user_id` is the identity-resolved column and covers ~98% of indexed
 * messages. Counts are only raised, never lowered, so live messages counted
 * since deploy are preserved.
 *
 * When the indexer database is unavailable the migration falls back to marking
 * all existing users as established, which is safe (fewer checks) even though
 * it is coarser.
 */

import { existsSync } from "node:fs";
import { config } from "../config";
import { Database, type SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

/** Matches NEW_USER_MESSAGE_LIMIT in handlers/reactionSpam.ts */
const NEW_USER_MESSAGE_LIMIT = 5;

interface MigrationResult {
	success: boolean;
	errors: string[];
}

/**
 * Check if migration has already been applied.
 *
 * @param db - The SQLite database
 * @returns True if the migration marker exists
 */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	try {
		const result = db
			.prepare(
				"SELECT value FROM system_state WHERE key = 'migration_005_backfill_message_count'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Read lifetime message totals per user from the explorer database.
 * Returns null when the indexer DB is not configured or not present.
 */
function loadIndexedCounts(): Map<number, number> | null {
	const dbPath = config.indexerDbPath;
	if (!dbPath || !existsSync(dbPath)) return null;

	let indexer: SqliteDatabase | null = null;
	try {
		indexer = new Database(dbPath, { readonly: true });
		const rows = indexer
			.prepare(
				`SELECT COALESCE(author_user_id, user_id) AS userId, COUNT(*) AS count
				 FROM messages
				 WHERE author_user_id IS NOT NULL OR user_id IS NOT NULL
				 GROUP BY COALESCE(author_user_id, user_id)`,
			)
			.all() as Array<{ userId: number; count: number }>;
		return new Map(rows.map((row) => [row.userId, row.count]));
	} catch (error) {
		logger.error("Migration 005 could not read the message index", {
			dbPath,
			error,
		});
		return null;
	} finally {
		indexer?.close();
	}
}

/**
 * Backfill message counts from the index, or grandfather users if unavailable.
 *
 * @param db - The SQLite database
 * @returns The migration result
 */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) {
		result.success = true;
		return result;
	}

	const counts = loadIndexedCounts();

	try {
		db.exec("BEGIN TRANSACTION");

		let usersUpdated = 0;
		if (counts) {
			const update = db.prepare(
				`UPDATE users
				 SET message_count = ?
				 WHERE id = ? AND COALESCE(message_count, 0) < ?`,
			);
			for (const [userId, count] of counts) {
				usersUpdated += update.run(count, userId, count).changes;
			}
		} else {
			usersUpdated = db
				.prepare("UPDATE users SET message_count = ? WHERE message_count < ?")
				.run(NEW_USER_MESSAGE_LIMIT, NEW_USER_MESSAGE_LIMIT).changes;
		}

		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_005_backfill_message_count', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 005 completed: backfilled message counts", {
			source: counts ? "index" : "grandfather",
			usersUpdated,
		});
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 005 failed, rolled back", { error });
	}

	return result;
}
