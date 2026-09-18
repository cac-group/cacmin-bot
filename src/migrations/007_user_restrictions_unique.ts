/**
 * Migration 007: Make user restrictions idempotent.
 *
 * Re-adding the same restriction for the same user (same type and action) used
 * to append another row. Normalize the action column, collapse duplicates, and
 * add a unique index on (user_id, restriction, restricted_action) so writes can
 * upsert.
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
				"SELECT value FROM system_state WHERE key = 'migration_007_user_restrictions_unique'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Normalize, dedupe (keeping the most recent row), and add the unique index.
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

	try {
		db.exec("BEGIN TRANSACTION");
		db.exec(
			"UPDATE user_restrictions SET restricted_action = '' WHERE restricted_action IS NULL",
		);
		db.exec(`
			DELETE FROM user_restrictions
			WHERE id NOT IN (
				SELECT MAX(id) FROM user_restrictions GROUP BY user_id, restriction, restricted_action
			)
		`);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_restrictions_unique
			 ON user_restrictions(user_id, restriction, restricted_action)`,
		);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_007_user_restrictions_unique', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 007 completed: user_restrictions deduped");
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 007 failed, rolled back", { error });
	}

	return result;
}
