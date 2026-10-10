/**
 * Migration 017: track the last processed join per user.
 *
 * The rejoin cooldown is now triggered by a *known* member joining (a join for
 * a user we already have is necessarily a rejoin), not by observing a leave
 * event — leave updates are not reliably delivered. `last_join_at` collapses the
 * same join delivered as both a service message and a `chat_member` update.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

/** Check whether migration 017 has already completed. */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	try {
		const row = db
			.prepare(
				"SELECT value FROM system_state WHERE key = 'migration_017_rejoin_last_join'",
			)
			.get() as { value: string } | undefined;
		return row?.value === "completed";
	} catch {
		return false;
	}
}

/** Add `last_join_at` to `user_rejoin_cooldowns`. */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) {
		result.success = true;
		return result;
	}

	try {
		db.exec("BEGIN TRANSACTION");
		db.exec(`
			ALTER TABLE user_rejoin_cooldowns
			ADD COLUMN last_join_at INTEGER NOT NULL DEFAULT 0;
		`);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_017_rejoin_last_join', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info(
			"Migration 017 completed: user_rejoin_cooldowns.last_join_at added",
		);
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// BEGIN itself may have failed; nothing to roll back.
		}
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 017 failed, rolled back", { error });
	}

	return result;
}
