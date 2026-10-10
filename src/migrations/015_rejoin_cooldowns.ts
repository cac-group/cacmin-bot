/**
 * Migration 015: leave/rejoin cooldown ledger.
 *
 * A user who leaves and rejoins is muted for one cooldown interval. The active
 * Telegram restriction lives in `user_rate_limit_mutes` (kind `cooldown`); this
 * table only preserves the paused remainder while the user is away, plus the
 * `pending` flag that says a leave is waiting to be re-enforced on rejoin.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

/** Check whether migration 015 has already completed. */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	try {
		const row = db
			.prepare(
				"SELECT value FROM system_state WHERE key = 'migration_015_rejoin_cooldowns'",
			)
			.get() as { value: string } | undefined;
		return row?.value === "completed";
	} catch {
		return false;
	}
}

/** Create the `user_rejoin_cooldowns` table. */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) {
		result.success = true;
		return result;
	}

	try {
		db.exec("BEGIN TRANSACTION");
		db.exec(`
			CREATE TABLE IF NOT EXISTS user_rejoin_cooldowns (
				user_id INTEGER PRIMARY KEY,
				pending INTEGER NOT NULL DEFAULT 0,
				remaining_seconds INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
		`);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_015_rejoin_cooldowns', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 015 completed: user_rejoin_cooldowns table created");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// BEGIN itself may have failed; nothing to roll back.
		}
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 015 failed, rolled back", { error });
	}

	return result;
}
