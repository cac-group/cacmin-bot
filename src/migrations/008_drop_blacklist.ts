/**
 * Migration 008: Drop the unused blacklist column.
 *
 * `users.blacklist` was stored and displayed but never enforced by any code
 * path. The commands/UI were removed, so drop the column and its index.
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
				"SELECT value FROM system_state WHERE key = 'migration_008_drop_blacklist'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Drop the blacklist index and column if present.
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
		const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{
			name: string;
		}>;
		if (columns.some((column) => column.name === "blacklist")) {
			db.exec("DROP INDEX IF EXISTS idx_users_blacklist");
			db.exec("ALTER TABLE users DROP COLUMN blacklist");
		}
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_008_drop_blacklist', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 008 completed: blacklist column dropped");
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 008 failed, rolled back", { error });
	}

	return result;
}
