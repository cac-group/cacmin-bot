/**
 * Database migrations runner
 *
 * Migrations are run in order by their numeric prefix.
 * Each migration is idempotent and tracks its completion state.
 */

import Database from "better-sqlite3";
import { logger } from "../utils/logger";
import {
	runMigration as run001,
	isMigrationApplied as check001,
} from "./001_integer_balances";

interface Migration {
	id: string;
	name: string;
	check: (db: Database.Database) => boolean;
	run: (db: Database.Database) => { success: boolean; errors: string[] };
}

const migrations: Migration[] = [
	{
		id: "001",
		name: "integer_balances",
		check: check001,
		run: run001,
	},
];

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database): void {
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
