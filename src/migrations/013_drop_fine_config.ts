/**
 * Migration 013: Drop the fine configuration table and unused restriction
 * fine columns.
 *
 * All fines/bails are the fixed 69.420 JUNO bail. `fine_config` and
 * `user_restrictions.auto_jail_fine` / `fine_amount` are no longer read or
 * written by any code path.
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
				"SELECT value FROM system_state WHERE key = 'migration_013_drop_fine_config'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Drop `fine_config` and the two restriction fine columns if present.
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
		db.exec("DROP TABLE IF EXISTS fine_config");

		const columns = db
			.prepare("PRAGMA table_info(user_restrictions)")
			.all() as {
			name: string;
		}[];
		for (const column of ["auto_jail_fine", "fine_amount"]) {
			if (columns.some((existing) => existing.name === column)) {
				db.exec(`ALTER TABLE user_restrictions DROP COLUMN ${column}`);
			}
		}

		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_013_drop_fine_config', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info(
			"Migration 013 completed: fine_config table and restriction fine columns dropped",
		);
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// BEGIN itself may have failed; nothing to roll back.
		}
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 013 failed, rolled back", { error });
	}

	return result;
}
