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
import {
	isMigrationApplied as check005,
	runMigration as run005,
} from "./005_backfill_message_count";
import {
	isMigrationApplied as check006,
	runMigration as run006,
} from "./006_global_restrictions_unique";
import {
	isMigrationApplied as check007,
	runMigration as run007,
} from "./007_user_restrictions_unique";
import {
	isMigrationApplied as check008,
	runMigration as run008,
} from "./008_drop_blacklist";
import {
	isMigrationApplied as check009,
	runMigration as run009,
} from "./009_null_placeholder_usernames";
import {
	isMigrationApplied as check010,
	runMigration as run010,
} from "./010_normalize_bail_units";
import {
	isMigrationApplied as check011,
	runMigration as run011,
} from "./011_reconcile_user_balances";
import {
	isMigrationApplied as check012,
	runMigration as run012,
} from "./012_mute_kinds";
import {
	isMigrationApplied as check013,
	runMigration as run013,
} from "./013_drop_fine_config";
import {
	isMigrationApplied as check014,
	runMigration as run014,
} from "./014_jailings";
import {
	isMigrationApplied as check015,
	runMigration as run015,
} from "./015_rejoin_cooldowns";
import {
	isMigrationApplied as check016,
	runMigration as run016,
} from "./016_membership_events";

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
	{
		id: "005",
		name: "backfill_message_count",
		check: check005,
		run: run005,
	},
	{
		id: "006",
		name: "global_restrictions_unique",
		check: check006,
		run: run006,
	},
	{
		id: "007",
		name: "user_restrictions_unique",
		check: check007,
		run: run007,
	},
	{
		id: "008",
		name: "drop_blacklist",
		check: check008,
		run: run008,
	},
	{
		id: "009",
		name: "null_placeholder_usernames",
		check: check009,
		run: run009,
	},
	{
		id: "010",
		name: "normalize_bail_units",
		check: check010,
		run: run010,
	},
	{
		id: "011",
		name: "reconcile_user_balances",
		check: check011,
		run: run011,
	},
	{
		id: "012",
		name: "mute_kinds",
		check: check012,
		run: run012,
	},
	{
		id: "013",
		name: "drop_fine_config",
		check: check013,
		run: run013,
	},
	{
		id: "014",
		name: "jailings",
		check: check014,
		run: run014,
	},
	{
		id: "015",
		name: "rejoin_cooldowns",
		check: check015,
		run: run015,
	},
	{
		id: "016",
		name: "membership_events",
		check: check016,
		run: run016,
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
