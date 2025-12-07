/**
 * Migration 001: Convert REAL balance/amount columns to INTEGER micro-units
 *
 * This migration converts all JUNO amounts from floating-point REAL to INTEGER
 * micro-units (ujuno). 1 JUNO = 1,000,000 ujuno.
 *
 * This eliminates floating-point precision errors that caused issues like:
 * "Precision loss detected converting 4.05195 to micro units"
 *
 * Tables affected:
 * - user_balances: balance
 * - transactions: amount, balance_after
 * - violations: bail_amount
 * - jail_events: bail_amount
 * - user_restrictions: auto_jail_fine
 * - processed_deposits: amount
 * - transaction_locks: amount
 * - giveaways: total_amount, amount_per_slot
 * - giveaway_claims: amount
 * - shared_account_permissions: spend_limit
 * - duels: wager_amount
 *
 * NOT affected (USD values, keep as REAL):
 * - price_history: price_usd
 * - fine_config: amount_usd
 */

import Database from "better-sqlite3";
import { logger } from "../utils/logger";

const MICRO_MULTIPLIER = 1_000_000;

interface MigrationResult {
	success: boolean;
	tablesUpdated: string[];
	rowsConverted: number;
	errors: string[];
}

/**
 * Check if migration has already been applied
 */
export function isMigrationApplied(db: Database.Database): boolean {
	try {
		// Check if the migration marker exists
		const result = db
			.prepare(
				"SELECT value FROM system_state WHERE key = 'migration_001_integer_balances'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Run the integer balance migration
 */
export function runMigration(db: Database.Database): MigrationResult {
	const result: MigrationResult = {
		success: false,
		tablesUpdated: [],
		rowsConverted: 0,
		errors: [],
	};

	// Check if already migrated
	if (isMigrationApplied(db)) {
		logger.info("Migration 001 already applied, skipping");
		result.success = true;
		return result;
	}

	logger.info("Starting migration 001: Converting to integer micro-units");

	try {
		// Start transaction for atomicity
		db.exec("BEGIN TRANSACTION");

		// 1. user_balances.balance
		try {
			const userBalances = db
				.prepare("SELECT user_id, balance FROM user_balances")
				.all() as { user_id: number; balance: number }[];

			for (const row of userBalances) {
				const microBalance = Math.round(row.balance * MICRO_MULTIPLIER);
				db.prepare(
					"UPDATE user_balances SET balance = ? WHERE user_id = ?",
				).run(microBalance, row.user_id);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("user_balances");
			logger.info(`Converted ${userBalances.length} user_balances rows`);
		} catch (e) {
			result.errors.push(`user_balances: ${e}`);
		}

		// 2. transactions.amount and balance_after
		try {
			const transactions = db
				.prepare("SELECT id, amount, balance_after FROM transactions")
				.all() as {
				id: number;
				amount: number;
				balance_after: number | null;
			}[];

			for (const row of transactions) {
				const microAmount = Math.round(row.amount * MICRO_MULTIPLIER);
				const microBalanceAfter =
					row.balance_after !== null
						? Math.round(row.balance_after * MICRO_MULTIPLIER)
						: null;
				db.prepare(
					"UPDATE transactions SET amount = ?, balance_after = ? WHERE id = ?",
				).run(microAmount, microBalanceAfter, row.id);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("transactions");
			logger.info(`Converted ${transactions.length} transactions rows`);
		} catch (e) {
			result.errors.push(`transactions: ${e}`);
		}

		// 3. violations.bail_amount
		try {
			const violations = db
				.prepare("SELECT id, bail_amount FROM violations WHERE bail_amount > 0")
				.all() as { id: number; bail_amount: number }[];

			for (const row of violations) {
				const microBail = Math.round(row.bail_amount * MICRO_MULTIPLIER);
				db.prepare("UPDATE violations SET bail_amount = ? WHERE id = ?").run(
					microBail,
					row.id,
				);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("violations");
			logger.info(`Converted ${violations.length} violations rows`);
		} catch (e) {
			result.errors.push(`violations: ${e}`);
		}

		// 4. jail_events.bail_amount
		try {
			const jailEvents = db
				.prepare(
					"SELECT id, bail_amount FROM jail_events WHERE bail_amount > 0",
				)
				.all() as { id: number; bail_amount: number }[];

			for (const row of jailEvents) {
				const microBail = Math.round(row.bail_amount * MICRO_MULTIPLIER);
				db.prepare("UPDATE jail_events SET bail_amount = ? WHERE id = ?").run(
					microBail,
					row.id,
				);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("jail_events");
			logger.info(`Converted ${jailEvents.length} jail_events rows`);
		} catch (e) {
			result.errors.push(`jail_events: ${e}`);
		}

		// 5. user_restrictions.auto_jail_fine
		try {
			const restrictions = db
				.prepare(
					"SELECT id, auto_jail_fine FROM user_restrictions WHERE auto_jail_fine > 0",
				)
				.all() as { id: number; auto_jail_fine: number }[];

			for (const row of restrictions) {
				const microFine = Math.round(row.auto_jail_fine * MICRO_MULTIPLIER);
				db.prepare(
					"UPDATE user_restrictions SET auto_jail_fine = ? WHERE id = ?",
				).run(microFine, row.id);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("user_restrictions");
			logger.info(`Converted ${restrictions.length} user_restrictions rows`);
		} catch (e) {
			result.errors.push(`user_restrictions: ${e}`);
		}

		// 6. processed_deposits.amount
		try {
			const deposits = db
				.prepare("SELECT id, amount FROM processed_deposits")
				.all() as { id: number; amount: number }[];

			for (const row of deposits) {
				const microAmount = Math.round(row.amount * MICRO_MULTIPLIER);
				db.prepare("UPDATE processed_deposits SET amount = ? WHERE id = ?").run(
					microAmount,
					row.id,
				);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("processed_deposits");
			logger.info(`Converted ${deposits.length} processed_deposits rows`);
		} catch (e) {
			result.errors.push(`processed_deposits: ${e}`);
		}

		// 7. transaction_locks.amount
		try {
			const locks = db
				.prepare(
					"SELECT user_id, amount FROM transaction_locks WHERE amount > 0",
				)
				.all() as { user_id: number; amount: number }[];

			for (const row of locks) {
				const microAmount = Math.round(row.amount * MICRO_MULTIPLIER);
				db.prepare(
					"UPDATE transaction_locks SET amount = ? WHERE user_id = ?",
				).run(microAmount, row.user_id);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("transaction_locks");
			logger.info(`Converted ${locks.length} transaction_locks rows`);
		} catch (e) {
			result.errors.push(`transaction_locks: ${e}`);
		}

		// 8. giveaways.total_amount and amount_per_slot
		try {
			const giveaways = db
				.prepare("SELECT id, total_amount, amount_per_slot FROM giveaways")
				.all() as {
				id: number;
				total_amount: number;
				amount_per_slot: number;
			}[];

			for (const row of giveaways) {
				const microTotal = Math.round(row.total_amount * MICRO_MULTIPLIER);
				const microPerSlot = Math.round(row.amount_per_slot * MICRO_MULTIPLIER);
				db.prepare(
					"UPDATE giveaways SET total_amount = ?, amount_per_slot = ? WHERE id = ?",
				).run(microTotal, microPerSlot, row.id);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("giveaways");
			logger.info(`Converted ${giveaways.length} giveaways rows`);
		} catch (e) {
			result.errors.push(`giveaways: ${e}`);
		}

		// 9. giveaway_claims.amount
		try {
			const claims = db
				.prepare("SELECT id, amount FROM giveaway_claims")
				.all() as { id: number; amount: number }[];

			for (const row of claims) {
				const microAmount = Math.round(row.amount * MICRO_MULTIPLIER);
				db.prepare("UPDATE giveaway_claims SET amount = ? WHERE id = ?").run(
					microAmount,
					row.id,
				);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("giveaway_claims");
			logger.info(`Converted ${claims.length} giveaway_claims rows`);
		} catch (e) {
			result.errors.push(`giveaway_claims: ${e}`);
		}

		// 10. shared_account_permissions.spend_limit
		try {
			const permissions = db
				.prepare(
					"SELECT id, spend_limit FROM shared_account_permissions WHERE spend_limit IS NOT NULL",
				)
				.all() as { id: number; spend_limit: number }[];

			for (const row of permissions) {
				const microLimit = Math.round(row.spend_limit * MICRO_MULTIPLIER);
				db.prepare(
					"UPDATE shared_account_permissions SET spend_limit = ? WHERE id = ?",
				).run(microLimit, row.id);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("shared_account_permissions");
			logger.info(
				`Converted ${permissions.length} shared_account_permissions rows`,
			);
		} catch (e) {
			result.errors.push(`shared_account_permissions: ${e}`);
		}

		// 11. duels.wager_amount
		try {
			const duels = db.prepare("SELECT id, wager_amount FROM duels").all() as {
				id: number;
				wager_amount: number;
			}[];

			for (const row of duels) {
				const microWager = Math.round(row.wager_amount * MICRO_MULTIPLIER);
				db.prepare("UPDATE duels SET wager_amount = ? WHERE id = ?").run(
					microWager,
					row.id,
				);
				result.rowsConverted++;
			}
			result.tablesUpdated.push("duels");
			logger.info(`Converted ${duels.length} duels rows`);
		} catch (e) {
			result.errors.push(`duels: ${e}`);
		}

		// Mark migration as complete
		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_001_integer_balances', 'completed', strftime('%s', 'now'))`,
		).run();

		// Commit transaction
		db.exec("COMMIT");

		result.success = true;
		logger.info(
			`Migration 001 completed: ${result.rowsConverted} rows converted across ${result.tablesUpdated.length} tables`,
		);
	} catch (error) {
		// Rollback on any error
		db.exec("ROLLBACK");
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 001 failed, rolled back", { error });
	}

	return result;
}
