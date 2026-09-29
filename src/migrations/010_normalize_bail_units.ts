/**
 * Migration 010: Normalize bail/fine columns to integer micro-units.
 *
 * Migration 001 converted every pre-existing JUNO amount to integer micro-units
 * (marker `migration_001_integer_balances`, completed 2025-12-18), but the
 * bail/fine writers kept storing decimal JUNO afterwards, leaving
 * `jail_events.bail_amount` mixing both scales. Sums and comparisons over those
 * columns then combined units.
 *
 * Canonical storage is integer micro-units (AmountPrecision). A value that was
 * written *after* migration 001 is decimal JUNO and is scaled by 1e6; a value
 * written before it is already micro and must not be touched. The cutoff comes
 * from the migration 001 marker time, so a legitimate sub-1-JUNO micro amount
 * (e.g. 500000) is never double-scaled. If the marker is absent (fresh DB with
 * no rows) the cutoff is 0 and every `(0, 1e6)` value is considered JUNO.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";

interface MigrationResult {
	success: boolean;
	errors: string[];
}

const COLUMNS: Array<{ table: string; column: string; timeColumn: string }> = [
	{ table: "violations", column: "bail_amount", timeColumn: "timestamp" },
	{ table: "jail_events", column: "bail_amount", timeColumn: "timestamp" },
	{
		table: "user_restrictions",
		column: "auto_jail_fine",
		timeColumn: "created_at",
	},
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
 * Scale decimal-JUNO bail/fine values written after migration 001 up to micro.
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
		const marker = db
			.prepare(
				"SELECT updated_at FROM system_state WHERE key = 'migration_001_integer_balances'",
			)
			.get() as { updated_at: number } | undefined;
		const cutoff = marker?.updated_at ?? 0;
		if (!marker) {
			logger.warn(
				"Migration 010: migration 001 marker missing; scaling every (0,1e6) value as JUNO",
			);
		}

		db.exec("BEGIN TRANSACTION");
		for (const { table, column, timeColumn } of COLUMNS) {
			const scheduled = db
				.prepare(
					`SELECT COUNT(*) AS count FROM ${table}
					 WHERE ${column} > 0 AND ${column} < 1000000 AND ${timeColumn} > ?`,
				)
				.get(cutoff) as { count: number };
			const info = db
				.prepare(
					`UPDATE ${table} SET ${column} = ROUND(${column} * 1000000)
					 WHERE ${column} > 0 AND ${column} < 1000000 AND ${timeColumn} > ?`,
				)
				.run(cutoff);
			logger.info(
				`Migration 010: ${info.changes}/${scheduled.count} ${table}.${column} value(s) scaled to micro (cutoff ${cutoff})`,
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
