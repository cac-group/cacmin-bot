/**
 * Migration 009: Store absent Telegram usernames as NULL.
 *
 * `unknown` and `user_<id>` are generated placeholders, never real Telegram
 * handles. They were historically written into `users.username` (712 rows for
 * `unknown` alone), which pollutes `idx_users_username` and any username
 * lookup. Identity is always the user id, so a missing handle should be NULL.
 * The runtime guard lives in `normalizeUsernameForStorage`.
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
				"SELECT value FROM system_state WHERE key = 'migration_009_null_placeholder_usernames'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Null out stored placeholder usernames.
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
		const info = db
			.prepare(
				`UPDATE users SET username = NULL, updated_at = ?
				 WHERE username IS NOT NULL
				   AND (
				     lower(ltrim(trim(username), '@')) = 'unknown'
				     OR lower(ltrim(trim(username), '@')) GLOB 'user_[0-9]*'
				   )`,
			)
			.run(Math.floor(Date.now() / 1000));
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_009_null_placeholder_usernames', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info(
			`Migration 009 completed: ${info.changes} placeholder username(s) set to NULL`,
		);
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 009 failed, rolled back", { error });
	}

	return result;
}
