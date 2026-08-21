/**
 * Migration 002: Drop the orphaned user_message_counts table
 *
 * The user_message_counts table was a lightweight message counter used by the
 * reaction-based spam detection to exempt established users. It has been
 * replaced by an account-age check (see reactionSpam.ts) and is no longer
 * written to or read from. This migration removes the now-dead table.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

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
				"SELECT value FROM system_state WHERE key = 'migration_002_drop_user_message_counts'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Drop the user_message_counts table and mark the migration complete.
 *
 * @param db - The SQLite database
 * @returns The migration result
 */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };

	if (isMigrationApplied(db)) {
		logger.info("Migration 002 already applied, skipping");
		result.success = true;
		return result;
	}

	logger.info("Starting migration 002: Dropping user_message_counts table");

	try {
		db.exec("BEGIN TRANSACTION");

		db.exec("DROP TABLE IF EXISTS user_message_counts");

		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_002_drop_user_message_counts', 'completed', strftime('%s', 'now'))`,
		).run();

		db.exec("COMMIT");

		result.success = true;
		logger.info("Migration 002 completed: dropped user_message_counts table");
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 002 failed, rolled back", { error });
	}

	return result;
}
