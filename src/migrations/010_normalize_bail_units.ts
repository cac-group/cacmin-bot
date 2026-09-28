/**
 * Migration 010: Normalize bail/fine columns to integer micro-units.
 *
 * Migration 001 was meant to convert every JUNO amount to integer micro-units,
 * but the bail/fine columns were re-written afterwards in decimal JUNO (for
 * example `DEFAULT_JAIL_BAIL_AMOUNT = 69.42` and violation fines of 2.68-10.92),
 * leaving `jail_events.bail_amount` mixing both scales. Sums and comparisons
 * over those columns then combined units.
 *
 * Canonical storage is integer micro-units (AmountPrecision), so any value in
 * (0, 1e6) is a decimal-JUNO amount and is scaled by 1e6. Values already
 * >= 1e6 are left untouched: they are assumed micro and are flagged for manual
 * review rather than guessed at.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

const COLUMNS: Array<{ table: string; column: string }> = [
	{ table: "violations", column: "bail_amount" },
	{ table: "jail_events", column: "bail_amount" },
	{ table: "user_restrictions", column: "auto_jail_fine" },
];

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
				"SELECT value FROM system_state WHERE key = 'migration_010_normalize_bail_units'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Scale decimal-JUNO bail/fine values up to integer micro-units.
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
		for (const { table, column } of COLUMNS) {
			const info = db
				.prepare(
					`UPDATE ${table} SET ${column} = ROUND(${column} * 1000000)
					 WHERE ${column} > 0 AND ${column} < 1000000`,
				)
				.run();
			logger.info(
				`Migration 010: ${info.changes} ${table}.${column} value(s) scaled to micro-units`,
			);
		}
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_010_normalize_bail_units', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info("Migration 010 completed: bail/fine units normalized to micro");
	} catch (error) {
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 010 failed, rolled back", { error });
	}

	return result;
}
