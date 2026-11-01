/**
 * Migration 018: denom-aware ledger.
 *
 * `user_balances` moves from one row per user to one row per
 * `(user_id, denom)`. Existing balances become `ujuno` rows. Transactions and
 * processed deposits gain a `denom` column, and processed deposits also record
 * the source network so per-chain heights do not collide.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

const JUNO_DENOM = "ujuno";

/** Check whether migration 018 has already completed. */
export function isMigrationApplied(db: SqliteDatabase): boolean {
	try {
		const row = db
			.prepare(
				"SELECT value FROM system_state WHERE key = 'migration_018_multi_denom_v2'",
			)
			.get() as { value: string } | undefined;
		return row?.value === "completed";
	} catch {
		return false;
	}
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
	}>;
	return columns.some((entry) => entry.name === column);
}

function hasTable(db: SqliteDatabase, table: string): boolean {
	return !!db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
}

/** Rebuild `user_balances` as `(user_id, denom)` and add denom columns. */
export function runMigration(db: SqliteDatabase): MigrationResult {
	const result: MigrationResult = { success: false, errors: [] };
	if (isMigrationApplied(db)) {
		result.success = true;
		return result;
	}

	try {
		db.exec("BEGIN TRANSACTION");

		if (
			hasTable(db, "user_balances") &&
			!hasColumn(db, "user_balances", "denom")
		) {
			const orphans = db
				.prepare(
					"SELECT COUNT(*) AS count FROM user_balances WHERE user_id NOT IN (SELECT id FROM users)",
				)
				.get() as { count: number } | undefined;
			if ((orphans?.count ?? 0) > 0) {
				throw new Error(
					`Migration 018 aborted: ${orphans?.count} user_balances row(s) have no matching users row. Resolve or remove them before upgrading so no funds disappear from the active ledger.`,
				);
			}

			const createdAt = hasColumn(db, "user_balances", "created_at")
				? "COALESCE(created_at, last_updated, strftime('%s', 'now'))"
				: "COALESCE(last_updated, strftime('%s', 'now'))";
			db.exec(`
				CREATE TABLE user_balances_new (
					user_id INTEGER NOT NULL,
					denom TEXT NOT NULL DEFAULT '${JUNO_DENOM}',
					balance REAL DEFAULT 0,
					last_updated INTEGER DEFAULT (strftime('%s', 'now')),
					created_at INTEGER DEFAULT (strftime('%s', 'now')),
					PRIMARY KEY (user_id, denom),
					FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
				);
				INSERT INTO user_balances_new (user_id, denom, balance, last_updated, created_at)
					SELECT user_id, '${JUNO_DENOM}', balance,
						COALESCE(last_updated, strftime('%s', 'now')), ${createdAt}
					FROM user_balances
					WHERE user_id IN (SELECT id FROM users);
				DROP TABLE user_balances;
				ALTER TABLE user_balances_new RENAME TO user_balances;
			`);
		}

		if (
			hasTable(db, "transactions") &&
			!hasColumn(db, "transactions", "denom")
		) {
			db.exec(
				`ALTER TABLE transactions ADD COLUMN denom TEXT NOT NULL DEFAULT '${JUNO_DENOM}'`,
			);
		}

		if (
			hasTable(db, "processed_deposits") &&
			!hasColumn(db, "processed_deposits", "denom")
		) {
			db.exec(
				`ALTER TABLE processed_deposits ADD COLUMN denom TEXT NOT NULL DEFAULT '${JUNO_DENOM}'`,
			);
		}
		if (
			hasTable(db, "processed_deposits") &&
			!hasColumn(db, "processed_deposits", "network")
		) {
			db.exec(
				"ALTER TABLE processed_deposits ADD COLUMN network TEXT NOT NULL DEFAULT 'juno'",
			);
		}

		// Deposit idempotency compares hashes as strings. Normalize historical
		// rows so a lowercase paste matches an uppercase chain response (and vice
		// versa). OR IGNORE tolerates the unlikely case of duplicate casing.
		if (hasTable(db, "processed_deposits")) {
			db.exec(
				"UPDATE OR IGNORE processed_deposits SET tx_hash = lower(tx_hash)",
			);
		}
		if (
			hasTable(db, "transactions") &&
			hasColumn(db, "transactions", "tx_hash")
		) {
			db.exec(
				"UPDATE transactions SET tx_hash = lower(tx_hash) WHERE tx_hash IS NOT NULL",
			);
		}

		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_user_balances_balance
				ON user_balances(balance);
			CREATE INDEX IF NOT EXISTS idx_user_balances_denom
				ON user_balances(denom);
			CREATE INDEX IF NOT EXISTS idx_transactions_denom
				ON transactions(denom);
		`);

		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_018_multi_denom_v2', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 018 completed: ledger is denom-aware");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// BEGIN itself may have failed; nothing to roll back.
		}
		result.errors.push(String(error));
		logger.error("Migration 018 failed, rolled back", { error });
	}

	return result;
}
