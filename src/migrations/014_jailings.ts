/**
 * Migration 014: Add the `jailings` table (canonical jail record).
 *
 * `jailings` is the source of truth for a jail: a unique alphanumeric
 * `jailing_id` the payer puts in the transaction memo, a `paid` flag, and a
 * unique payment tx hash. `jail_events` stays as the append-only audit log.
 *
 * Backfills existing `jailed` events (assigning fresh ids) and marks those with
 * a following `bail_paid` event as paid.
 */

import type { SqliteDatabase } from "../sqlite";
import { generateJailingId } from "../utils/jailingId";
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
				"SELECT value FROM system_state WHERE key = 'migration_014_jailings'",
			)
			.get() as { value: string } | undefined;
		return result?.value === "completed";
	} catch {
		return false;
	}
}

/**
 * Create `jailings`, backfill it from `jail_events`, and mark the one-time
 * migration complete.
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
		db.exec(`
			CREATE TABLE IF NOT EXISTS jailings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				jailing_id TEXT NOT NULL UNIQUE,
				user_id INTEGER NOT NULL,
				bail_amount REAL NOT NULL DEFAULT 0,
				paid INTEGER NOT NULL DEFAULT 0,
				payment_tx TEXT,
				paid_by_user_id INTEGER,
				paid_at INTEGER,
				muted_until INTEGER NOT NULL,
				admin_id INTEGER,
				reason TEXT,
				created_at INTEGER DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (user_id) REFERENCES users(id),
				FOREIGN KEY (paid_by_user_id) REFERENCES users(id),
				FOREIGN KEY (admin_id) REFERENCES users(id)
			);
		`);

		// Backfill every `jailed` event as an unpaid jailing with a fresh id.
		const insert = db.prepare(
			`INSERT INTO jailings (jailing_id, user_id, bail_amount, muted_until, admin_id, reason, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);
		const jailed = db
			.prepare(
				`SELECT user_id, admin_id, duration_minutes, bail_amount, timestamp, metadata
				 FROM jail_events WHERE event_type = 'jailed' ORDER BY user_id, timestamp, id`,
			)
			.all() as Array<{
			user_id: number;
			admin_id: number | null;
			duration_minutes: number | null;
			bail_amount: number;
			timestamp: number;
			metadata: string | null;
		}>;

		const usedIds = new Set<string>();
		for (const row of jailed) {
			let jailingId = generateJailingId();
			while (usedIds.has(jailingId)) jailingId = generateJailingId();
			usedIds.add(jailingId);

			let reason: string | null = null;
			if (row.metadata) {
				try {
					reason =
						(JSON.parse(row.metadata) as { reason?: string }).reason ?? null;
				} catch {
					reason = null;
				}
			}
			const mutedUntil = row.timestamp + (row.duration_minutes ?? 0) * 60;
			insert.run(
				jailingId,
				row.user_id,
				row.bail_amount,
				mutedUntil,
				row.admin_id ?? null,
				reason,
				row.timestamp,
			);
		}

		// Mark backfilled jailings paid from their following `bail_paid` event.
		const findJailing = db.prepare(
			`SELECT id FROM jailings WHERE user_id = ? AND paid = 0 AND created_at <= ?
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
		);
		const markPaid = db.prepare(
			`UPDATE jailings SET paid = 1, payment_tx = ?, paid_by_user_id = ?, paid_at = ? WHERE id = ?`,
		);
		const paidEvents = db
			.prepare(
				`SELECT user_id, payment_tx, paid_by_user_id, timestamp
				 FROM jail_events WHERE event_type = 'bail_paid' AND payment_tx IS NOT NULL
				 ORDER BY timestamp, id`,
			)
			.all() as Array<{
			user_id: number;
			payment_tx: string;
			paid_by_user_id: number | null;
			timestamp: number;
		}>;

		const usedTx = new Set<string>();
		for (const bp of paidEvents) {
			if (usedTx.has(bp.payment_tx)) continue;
			const jailing = findJailing.get(bp.user_id, bp.timestamp) as
				| { id: number }
				| undefined;
			if (jailing) {
				markPaid.run(
					bp.payment_tx,
					bp.paid_by_user_id ?? null,
					bp.timestamp,
					jailing.id,
				);
				usedTx.add(bp.payment_tx);
			}
		}

		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_jailings_payment_tx
			  ON jailings(payment_tx)
			  WHERE payment_tx IS NOT NULL AND payment_tx <> '';
			CREATE INDEX IF NOT EXISTS idx_jailings_user ON jailings(user_id);
			CREATE INDEX IF NOT EXISTS idx_jailings_paid ON jailings(paid);
			CREATE INDEX IF NOT EXISTS idx_jailings_public_id ON jailings(jailing_id);
		`);

		db.prepare(
			`INSERT OR REPLACE INTO system_state (key, value, updated_at)
			 VALUES ('migration_014_jailings', 'completed', strftime('%s', 'now'))`,
		).run();
		db.exec("COMMIT");
		result.success = true;
		logger.info(
			`Migration 014 completed: jailings table created, ${jailed.length} backfilled`,
		);
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// BEGIN itself may have failed; nothing to roll back.
		}
		result.errors.push(`Transaction failed: ${error}`);
		logger.error("Migration 014 failed, rolled back", { error });
	}

	return result;
}
