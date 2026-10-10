import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigration as run009 } from "../../src/migrations/009_null_placeholder_usernames";
import { runMigration as run010 } from "../../src/migrations/010_normalize_bail_units";
import { runMigration as run011 } from "../../src/migrations/011_reconcile_user_balances";
import { runMigration as run012 } from "../../src/migrations/012_mute_kinds";
import { runMigration as run013 } from "../../src/migrations/013_drop_fine_config";
import { runMigration as run014 } from "../../src/migrations/014_jailings";
import { runMigration as run015 } from "../../src/migrations/015_rejoin_cooldowns";
import { runMigration as run016 } from "../../src/migrations/016_membership_events";
import { Database } from "../../src/sqlite";

const DB_PATH = join(__dirname, `../test-data/db-migrations-${process.pid}.db`);

let db: Database;

function num(sql: string): number {
	const row = db.prepare(sql).get() as { v: number } | undefined;
	return Number(row?.v ?? 0);
}

beforeEach(() => {
	const dir = join(__dirname, "../test-data");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
	db = new Database(DB_PATH);
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, updated_at INTEGER);
		CREATE TABLE user_balances (user_id INTEGER PRIMARY KEY, balance REAL DEFAULT 0, last_updated INTEGER);
		CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_type TEXT NOT NULL,
			from_user_id INTEGER, to_user_id INTEGER, amount REAL NOT NULL);
		CREATE TABLE violations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, bail_amount REAL DEFAULT 0,
			timestamp INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE jail_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, event_type TEXT,
			bail_amount REAL DEFAULT 0, timestamp INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE user_restrictions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, restriction TEXT,
			auto_jail_fine REAL DEFAULT 10000000, created_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
	`);
});

afterEach(() => {
	db.close();
	if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe("migration 009 null placeholder usernames", () => {
	it("nulls unknown and user_<digits>, keeps real handles", () => {
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(
			1,
			"unknown",
		);
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(
			2,
			"user_2",
		);
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(
			3,
			"@alice",
		);
		// digits-only guard: a real-looking handle that merely starts with user_ is kept
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(
			4,
			"user_123abc",
		);

		run009(db);

		const rows = db.prepare("SELECT id, username FROM users ORDER BY id").all();
		expect(rows).toEqual([
			{ id: 1, username: null },
			{ id: 2, username: null },
			{ id: 3, username: "@alice" },
			{ id: 4, username: "user_123abc" },
		]);
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_009_null_placeholder_usernames'",
			),
		).toBe(1);
	});
});

describe("migration 010 normalize bail units", () => {
	it("scales only post-migration-001 decimal JUNO and leaves micro/zero untouched", () => {
		db.prepare(
			"INSERT INTO system_state (key, value, updated_at) VALUES ('migration_001_integer_balances','completed',1000)",
		).run();
		// Written before migration 001: already micro, must not be scaled.
		db.prepare(
			"INSERT INTO violations (user_id, bail_amount, timestamp) VALUES (1, 500000, 500)",
		).run();
		// Written after migration 001: decimal JUNO.
		db.prepare(
			"INSERT INTO violations (user_id, bail_amount, timestamp) VALUES (1, 4.17, 2000)",
		).run();
		db.prepare(
			"INSERT INTO violations (user_id, bail_amount, timestamp) VALUES (1, 0, 2000)",
		).run();
		db.prepare(
			"INSERT INTO jail_events (user_id, event_type, bail_amount, timestamp) VALUES (1,'jailed',69.42,2000)",
		).run();
		db.prepare(
			"INSERT INTO jail_events (user_id, event_type, bail_amount, timestamp) VALUES (1,'jailed',5000000,2000)",
		).run();
		db.prepare(
			"INSERT INTO user_restrictions (user_id, restriction, auto_jail_fine, created_at) VALUES (1,'no_urls',10.0,2000)",
		).run();

		run010(db);

		expect(num("SELECT bail_amount AS v FROM violations WHERE id=1")).toBe(
			500000,
		);
		expect(num("SELECT bail_amount AS v FROM violations WHERE id=2")).toBe(
			4170000,
		);
		expect(num("SELECT bail_amount AS v FROM violations WHERE id=3")).toBe(0);
		expect(num("SELECT bail_amount AS v FROM jail_events WHERE id=1")).toBe(
			69420000,
		);
		expect(num("SELECT bail_amount AS v FROM jail_events WHERE id=2")).toBe(
			5000000,
		);
		expect(
			num("SELECT auto_jail_fine AS v FROM user_restrictions WHERE id=1"),
		).toBe(10000000);
	});

	it("is idempotent and does not double-scale on a second run", () => {
		db.prepare(
			"INSERT INTO violations (user_id, bail_amount, timestamp) VALUES (1, 4.17, 2000)",
		).run();
		run010(db);
		run010(db);
		expect(num("SELECT bail_amount AS v FROM violations WHERE id=1")).toBe(
			4170000,
		);
	});
});

describe("migration 011 reconcile user balances", () => {
	it("recomputes real users, resets only system accounts, and preserves escrow", () => {
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (1, 100)",
		).run();
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (2, 0)",
		).run();
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (3, 0)",
		).run();
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (-1, 791558)",
		).run();
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (-2, 0)",
		).run();
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (-3, 0)",
		).run();
		// Giveaway escrow holds real funds and must survive untouched.
		db.prepare(
			"INSERT INTO user_balances (user_id, balance) VALUES (-1001, 400000)",
		).run();

		db.prepare(
			"INSERT INTO transactions (transaction_type, to_user_id, amount) VALUES ('giveaway', 1, 5000000)",
		).run();
		db.prepare(
			"INSERT INTO transactions (transaction_type, to_user_id, amount) VALUES ('deposit', 2, 2000000)",
		).run();
		db.prepare(
			"INSERT INTO transactions (transaction_type, from_user_id, to_user_id, amount) VALUES ('bail', 2, 3, 2000000)",
		).run();

		run011(db);

		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=1")).toBe(
			5000000,
		);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=2")).toBe(
			0,
		);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=3")).toBe(
			0,
		);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=-1")).toBe(
			0,
		);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=-2")).toBe(
			0,
		);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=-3")).toBe(
			0,
		);
		expect(
			num("SELECT balance AS v FROM user_balances WHERE user_id=-1001"),
		).toBe(400000);
	});
});

describe("migration 012 mute kinds", () => {
	it("adds a kind column and allows one row per kind per user", () => {
		db.exec("PRAGMA foreign_keys = ON");
		db.prepare("INSERT INTO users (id) VALUES (1)").run();
		db.exec(`
			CREATE TABLE user_rate_limit_mutes (
				user_id INTEGER PRIMARY KEY,
				muted_until INTEGER NOT NULL,
				limiting_window TEXT NOT NULL,
				permission_snapshot TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
		`);
		db.prepare(
			"INSERT INTO user_rate_limit_mutes (user_id, muted_until, limiting_window, permission_snapshot) VALUES (1, 999, '15m', '{\"a\":1}')",
		).run();

		run012(db);

		expect(
			db
				.prepare("SELECT kind FROM user_rate_limit_mutes WHERE user_id=1")
				.get(),
		).toEqual({ kind: "rate_limit" });
		db.prepare(
			"INSERT INTO user_rate_limit_mutes (user_id, kind, muted_until, limiting_window, permission_snapshot) VALUES (1, 'jail', 1000, 'jail', '{}')",
		).run();
		expect(
			num("SELECT COUNT(*) AS v FROM user_rate_limit_mutes WHERE user_id=1"),
		).toBe(2);
	});

	it("is idempotent: a second run leaves the rebuilt table intact", () => {
		db.exec("PRAGMA foreign_keys = ON");
		db.prepare("INSERT INTO users (id) VALUES (1)").run();
		db.exec(`
			CREATE TABLE user_rate_limit_mutes (
				user_id INTEGER PRIMARY KEY, muted_until INTEGER NOT NULL,
				limiting_window TEXT NOT NULL, permission_snapshot TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
		`);
		db.prepare(
			"INSERT INTO user_rate_limit_mutes (user_id, muted_until, limiting_window, permission_snapshot) VALUES (1, 999, '15m', '{}')",
		).run();
		run012(db);
		run012(db);
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_012_mute_kinds'",
			),
		).toBe(1);
		// The rebuilt table still has `kind` and its row survived.
		expect(
			db
				.prepare("SELECT kind FROM user_rate_limit_mutes WHERE user_id=1")
				.get(),
		).toEqual({ kind: "rate_limit" });
	});
});

describe("migration 013 drop fine config", () => {
	it("drops fine_config and the restriction fine columns, keeping rows", () => {
		db.exec(
			"ALTER TABLE user_restrictions ADD COLUMN fine_amount REAL DEFAULT 0",
		);
		db.exec(
			"CREATE TABLE fine_config (fine_type TEXT PRIMARY KEY, amount_usd REAL NOT NULL)",
		);
		db.prepare(
			"INSERT INTO user_restrictions (user_id, restriction, auto_jail_fine) VALUES (1,'no_urls',10)",
		).run();

		run013(db);

		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='fine_config'",
				)
				.all(),
		).toEqual([]);
		const columns = db
			.prepare("PRAGMA table_info(user_restrictions)")
			.all() as { name: string }[];
		expect(columns.some((c) => c.name === "auto_jail_fine")).toBe(false);
		expect(columns.some((c) => c.name === "fine_amount")).toBe(false);
		expect(num("SELECT COUNT(*) AS v FROM user_restrictions")).toBe(1);
	});

	it("is idempotent", () => {
		run013(db);
		run013(db);
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_013_drop_fine_config'",
			),
		).toBe(1);
	});
});

describe("migration 014 jailings", () => {
	it("creates jailings, backfills jailed events, and marks paid from bail_paid", () => {
		db.exec("ALTER TABLE jail_events ADD COLUMN duration_minutes INTEGER");
		db.exec("ALTER TABLE jail_events ADD COLUMN admin_id INTEGER");
		db.exec("ALTER TABLE jail_events ADD COLUMN paid_by_user_id INTEGER");
		db.exec("ALTER TABLE jail_events ADD COLUMN payment_tx TEXT");
		db.exec("ALTER TABLE jail_events ADD COLUMN metadata TEXT");
		db.prepare("INSERT INTO users (id, username) VALUES (1, 'u1')").run();
		db.prepare("INSERT INTO users (id, username) VALUES (2, 'u2')").run();
		db.prepare(
			"INSERT INTO jail_events (user_id, event_type, bail_amount, duration_minutes, timestamp) VALUES (1,'jailed',69420000,60,1000)",
		).run();
		db.prepare(
			"INSERT INTO jail_events (user_id, event_type, bail_amount, paid_by_user_id, payment_tx, timestamp) VALUES (1,'bail_paid',69420000,1,'TX1',1100)",
		).run();

		const result = run014(db);
		expect(result.errors).toEqual([]);

		const rows = db
			.prepare(
				"SELECT user_id, bail_amount, paid, payment_tx, jailing_id FROM jailings",
			)
			.all() as Array<{
			user_id: number;
			bail_amount: number;
			paid: number;
			payment_tx: string | null;
			jailing_id: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe(1);
		expect(rows[0].bail_amount).toBe(69420000);
		expect(rows[0].paid).toBe(1);
		expect(rows[0].payment_tx).toBe("TX1");
		expect(rows[0].jailing_id).toMatch(/^[A-Z][A-Z0-9]{7}$/);

		// The unique payment-tx index blocks reuse.
		expect(() =>
			db
				.prepare(
					"INSERT INTO jailings (jailing_id, user_id, bail_amount, muted_until, payment_tx) VALUES ('ZZZZZZZZ',2,1,1,'TX1')",
				)
				.run(),
		).toThrow();
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_014_jailings'",
			),
		).toBe(1);
	});

	it("is idempotent", () => {
		db.exec("ALTER TABLE jail_events ADD COLUMN duration_minutes INTEGER");
		db.exec("ALTER TABLE jail_events ADD COLUMN admin_id INTEGER");
		db.exec("ALTER TABLE jail_events ADD COLUMN paid_by_user_id INTEGER");
		db.exec("ALTER TABLE jail_events ADD COLUMN payment_tx TEXT");
		db.exec("ALTER TABLE jail_events ADD COLUMN metadata TEXT");
		run014(db);
		run014(db);
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_014_jailings'",
			),
		).toBe(1);
	});
});

describe("migration 015 rejoin cooldowns", () => {
	it("creates the cooldown table and marker, and is idempotent", () => {
		const first = run015(db);
		expect(first.errors).toEqual([]);
		db.prepare("INSERT INTO users (id, username) VALUES (1, 'u1')").run();
		db.prepare(
			"INSERT INTO user_rejoin_cooldowns (user_id, pending, remaining_seconds) VALUES (1, 1, 300)",
		).run();
		const row = db
			.prepare(
				"SELECT pending, remaining_seconds FROM user_rejoin_cooldowns WHERE user_id = 1",
			)
			.get() as { pending: number; remaining_seconds: number };
		expect(row).toEqual({ pending: 1, remaining_seconds: 300 });

		const second = run015(db);
		expect(second.errors).toEqual([]);
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_015_rejoin_cooldowns'",
			),
		).toBe(1);
	});
});

describe("migration 016 membership events", () => {
	it("creates an append-only log that survives unknown users, and is idempotent", () => {
		const first = run016(db);
		expect(first.errors).toEqual([]);
		// No FK: history is durable even for a user never recorded in `users`.
		db.prepare(
			"INSERT INTO user_membership_events (user_id, chat_id, event_type, source, occurred_at) VALUES (999, -1, 'join', 'test', 1000)",
		).run();
		expect(num("SELECT COUNT(*) AS v FROM user_membership_events")).toBe(1);
		expect(() =>
			db
				.prepare(
					"INSERT INTO user_membership_events (user_id, event_type, occurred_at) VALUES (1, 'bogus', 1)",
				)
				.run(),
		).toThrow();

		const second = run016(db);
		expect(second.errors).toEqual([]);
		expect(
			num(
				"SELECT COUNT(*) AS v FROM system_state WHERE key='migration_016_membership_events'",
			),
		).toBe(1);
	});
});
