/**
 * Migration 006: Make global restrictions idempotent.
 *
 * Global restrictions had no uniqueness, so re-adding the same restriction
 * (e.g. banning the same GIF globally twice) stacked duplicate rows. Normalize
 * the action column, collapse existing duplicates, and add a unique index so
 * writes can upsert.
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
				"SELECT value FROM system_state WHERE key = 'migration_006_global_restrictions_unique'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Normalize, dedupe, and add the unique index on global_restrictions.
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
			"UPDATE global_restrictions SET restricted_action = '' WHERE restricted_action IS NULL",
		);
		db.exec(`
			DELETE FROM global_restrictions
			WHERE id NOT IN (
				SELECT MIN(id) FROM global_restrictions GROUP BY restriction, restricted_action
			)
		`);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_global_restrictions_unique
			 ON global_restrictions(restriction, restricted_action)`,
		);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_006_global_restrictions_unique', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 006 completed: global_restrictions deduped");
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 006 failed, rolled back", { error });
	}

	return result;
}
