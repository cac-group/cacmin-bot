/**
 * Migration 011: Reconcile user_balances with the transaction ledger.
 *
 * `user_balances` is the spendable-balance source of truth and every balance
 * mutation records a matching `transactions` row (LedgerService). A read-only
 * audit found 5 of 46 rows off: three by 1-3 micro-units (rounding drift from
 * the REAL -> micro migration) and two system accounts. Recompute real users
 * from their ledger entries and reset the system accounts (negative ids) to
 * zero.
 *
 * A `bail` transaction records the bailed user in `to_user_id` but does not
 * credit them, so its `to_user_id` side is excluded from credits.
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
				"SELECT value FROM system_state WHERE key = 'migration_011_reconcile_user_balances'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Recompute real user balances from the ledger and zero system accounts.
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
		const now = Math.floor(Date.now() / 1000);
		db.exec("BEGIN TRANSACTION");
		const recomputed = db
			.prepare(
				`UPDATE user_balances SET balance = (
				   COALESCE((SELECT SUM(t.amount) FROM transactions t
				             WHERE t.to_user_id = user_balances.user_id
				               AND t.transaction_type <> 'bail'), 0)
				   - COALESCE((SELECT SUM(t.amount) FROM transactions t
				             WHERE t.from_user_id = user_balances.user_id), 0)
				 ), last_updated = ?
				 WHERE user_id > 0`,
			)
			.run(now);
		const reset = db
			.prepare(
				"UPDATE user_balances SET balance = 0, last_updated = ? WHERE user_id < 0",
			)
			.run(now);
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_011_reconcile_user_balances', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info(
			`Migration 011 completed: ${recomputed.changes} user balance(s) recomputed, ${reset.changes} system account(s) zeroed`,
		);
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 011 failed, rolled back", { error });
	}

	return result;
}
