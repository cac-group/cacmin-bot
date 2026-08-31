/** Migration 004: persistent per-user message character rate limits. */

import type { SqliteDatabase } from "../sqlite";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

/** Check whether migration 004 has already completed. */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	const row = db
		.prepare("SELECT value FROM system_state WHERE key = ?")
		.get("migration_004_message_rate_limits") as { value: string } | undefined;
	return row?.value === "completed";
}

/** Create the rate-limit usage, mute, and payment-request tables. */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) return { success: true, errors: [] };

	try {
		db.exec("BEGIN TRANSACTION");
		db.exec(`
			CREATE TABLE IF NOT EXISTS user_rate_limits (
				user_id INTEGER PRIMARY KEY,
				limit_15m INTEGER NOT NULL,
				limit_1h INTEGER NOT NULL,
				limit_24h INTEGER NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS user_rate_limit_usage (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL,
				message_id INTEGER NOT NULL,
				characters INTEGER NOT NULL CHECK (characters >= 0),
				created_at INTEGER NOT NULL,
				UNIQUE (user_id, message_id),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_window
				ON user_rate_limit_usage(user_id, created_at);
			CREATE TABLE IF NOT EXISTS user_rate_limit_mutes (
				user_id INTEGER PRIMARY KEY,
				muted_until INTEGER NOT NULL,
				limiting_window TEXT NOT NULL,
				permission_snapshot TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS rate_limit_reset_payments (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				payer_user_id INTEGER NOT NULL,
				target_user_id INTEGER NOT NULL,
				window TEXT NOT NULL,
				amount_micro INTEGER NOT NULL,
				instruction_chat_id INTEGER,
				instruction_message_id INTEGER,
				payment_tx TEXT UNIQUE,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				verified_at INTEGER,
				FOREIGN KEY (payer_user_id) REFERENCES users(id),
				FOREIGN KEY (target_user_id) REFERENCES users(id)
			);
			CREATE INDEX IF NOT EXISTS idx_rate_reset_pending
				ON rate_limit_reset_payments(payer_user_id, status, created_at);
		`);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES (?, 'completed', strftime('%s', 'now'))`,
		).run("migration_004_message_rate_limits");
		db.exec("COMMIT");
		result.success = true;
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(String(error));
	}
	return result;
}
