/**
 * Migration 012: key chat mutes by (user_id, kind).
 *
 * `user_rate_limit_mutes` previously held one row per user, so a short jail and
 * a long rate-limit mute overwrote each other. Add a `kind` column and a
 * composite unique key so every mute source keeps its own deadline and binding.
 */

import type { SqliteDatabase } from "../sqlite";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

/** Check whether migration 012 has already completed. */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	const row = db
		.prepare("SELECT value FROM system_state WHERE key = ?")
		.get("migration_012_mute_kinds") as { value: string } | undefined;
	return row?.value === "completed";
}

/** Rebuild `user_rate_limit_mutes` with a `kind` column and composite key. */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) return { success: true, errors: [] };

	try {
		// Rebuilding a table referenced by a foreign key requires foreign keys
		// off; the reference is recreated in the new table definition.
		db.exec("PRAGMA foreign_keys = OFF");
		db.exec("BEGIN TRANSACTION");
		db.exec(`
			CREATE TABLE user_rate_limit_mutes_new (
				user_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				muted_until INTEGER NOT NULL,
				limiting_window TEXT NOT NULL,
				permission_snapshot TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				PRIMARY KEY (user_id, kind),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			INSERT INTO user_rate_limit_mutes_new
				(user_id, kind, muted_until, limiting_window, permission_snapshot, created_at)
			SELECT user_id, 'rate_limit', muted_until, limiting_window, permission_snapshot, created_at
			FROM user_rate_limit_mutes;
			DROP TABLE user_rate_limit_mutes;
			ALTER TABLE user_rate_limit_mutes_new RENAME TO user_rate_limit_mutes;
		`);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES (?, 'completed', strftime('%s', 'now'))`,
		).run("migration_012_mute_kinds");
		db.exec("COMMIT");
		db.exec("PRAGMA foreign_keys = ON");
		result.success = true;
	} catch (error) {
		db.exec("ROLLBACK");
		db.exec("PRAGMA foreign_keys = ON");
		result.errors.push(String(error));
	}
	return result;
}
