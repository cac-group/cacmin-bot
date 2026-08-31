/**
 * Database migrations runner
 *
 * Migrations are run in order by their numeric prefix.
 * Each migration is idempotent and tracks its completion state.
 */

import type { SqliteDatabase } from "../sqlite";
import { logger } from "../utils/logger";
import {
	isMigrationApplied as check001,
	runMigration as run001,
} from "./001_integer_balances";
import {
	isMigrationApplied as check002,
	runMigration as run002,
} from "./002_drop_user_message_counts";
import {
	isMigrationApplied as check003,
	runMigration as run003,
} from "./003_unique_bail_payment_transactions";
import {
	isMigrationApplied as check004,
	runMigration as run004,
} from "./004_message_rate_limits";

interface Migration {
	id: string;
	name: string;
	check: (db: SqliteDatabase) => boolean;
	run: (db: SqliteDatabase) => { success: boolean; errors: string[] };
}

const migrations: Migration[] = [
	{
		id: "001",
		name: "integer_balances",
		check: check001,
		run: run001,
	},
	{
		id: "002",
		name: "drop_user_message_counts",
		check: check002,
		run: run002,
	},
	{
		id: "003",
		name: "unique_bail_payment_transactions",
		check: check003,
		run: run003,
	},
	{
		id: "004",
		name: "message_rate_limits",
		check: check004,
		run: run004,
	},
];

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase): void {
	logger.info("Checking for pending migrations...");

	let appliedCount = 0;
	let skippedCount = 0;

	for (const migration of migrations) {
		if (migration.check(db)) {
			skippedCount++;
			continue;
		}

		logger.info(`Running migration ${migration.id}: ${migration.name}`);
		const result = migration.run(db);

		if (result.success) {
			appliedCount++;
			logger.info(`Migration ${migration.id} completed successfully`);
		} else {
			logger.error(`Migration ${migration.id} failed`, {
				errors: result.errors,
			});
			throw new Error(
				`Migration ${migration.id} failed: ${result.errors.join(", ")}`,
			);
		}
	}

	if (appliedCount > 0) {
		logger.info(`Applied ${appliedCount} migration(s)`);
	}
	if (skippedCount > 0) {
		logger.info(`Skipped ${skippedCount} already-applied migration(s)`);
	}
}
