import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { runMigration as run009 } from "../../src/migrations/009_null_placeholder_usernames";
import { runMigration as run010 } from "../../src/migrations/010_normalize_bail_units";
import { runMigration as run011 } from "../../src/migrations/011_reconcile_user_balances";
import { Database } from "../../src/sqlite";

const DB_PATH = join(
	__dirname,
	`../test-data/db-migrations-${process.pid}.db`,
);

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
		CREATE TABLE violations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, bail_amount REAL DEFAULT 0);
		CREATE TABLE jail_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, event_type TEXT, bail_amount REAL DEFAULT 0);
		CREATE TABLE user_restrictions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, restriction TEXT, auto_jail_fine REAL DEFAULT 10.0);
		CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
	`);
});

afterEach(() => {
	db.close();
	if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe("migration 009 null placeholder usernames", () => {
	it("nulls unknown and user_<id>, keeps real handles", () => {
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(1, "unknown");
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(2, "user_2");
		db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(3, "@alice");

		run009(db);

		const rows = db
			.prepare("SELECT id, username FROM users ORDER BY id")
			.all();
		expect(rows).toEqual([
			{ id: 1, username: null },
			{ id: 2, username: null },
			{ id: 3, username: "@alice" },
		]);
		expect(num("SELECT COUNT(*) AS v FROM system_state WHERE key='migration_009_null_placeholder_usernames'")).toBe(1);
	});
});

describe("migration 010 normalize bail units", () => {
	it("scales decimal JUNO to micro and leaves micro/zero untouched", () => {
		db.prepare("INSERT INTO violations (user_id, bail_amount) VALUES (1, 4.17)").run();
		db.prepare("INSERT INTO violations (user_id, bail_amount) VALUES (1, 0)").run();
		db.prepare("INSERT INTO jail_events (user_id, event_type, bail_amount) VALUES (1, 'jailed', 69.42)").run();
		db.prepare("INSERT INTO jail_events (user_id, event_type, bail_amount) VALUES (1, 'jailed', 5000000)").run();
		db.prepare("INSERT INTO user_restrictions (user_id, restriction, auto_jail_fine) VALUES (1, 'no_urls', 10.0)").run();

		run010(db);

		expect(num("SELECT bail_amount AS v FROM violations WHERE id=1")).toBe(4170000);
		expect(num("SELECT bail_amount AS v FROM violations WHERE id=2")).toBe(0);
		expect(num("SELECT bail_amount AS v FROM jail_events WHERE id=1")).toBe(69420000);
		expect(num("SELECT bail_amount AS v FROM jail_events WHERE id=2")).toBe(5000000);
		expect(num("SELECT auto_jail_fine AS v FROM user_restrictions WHERE id=1")).toBe(10000000);
	});
});

describe("migration 011 reconcile user balances", () => {
	it("recomputes real users from the ledger and zeroes system accounts", () => {
		db.prepare("INSERT INTO user_balances (user_id, balance) VALUES (1, 100)").run();
		db.prepare("INSERT INTO user_balances (user_id, balance) VALUES (2, 0)").run();
		db.prepare("INSERT INTO user_balances (user_id, balance) VALUES (3, 0)").run();
		db.prepare("INSERT INTO user_balances (user_id, balance) VALUES (-1, 999999)").run();
		db.prepare("INSERT INTO user_balances (user_id, balance) VALUES (-3, 0)").run();

		// user 1: giveaway credit of 5 JUNO (micro) => balance drifts to 100, should become 5000000
		db.prepare("INSERT INTO transactions (transaction_type, to_user_id, amount) VALUES ('giveaway', 1, 5000000)").run();
		// user 2: deposit then bail paid; bail's to_user is the bailed user, not a credit
		db.prepare("INSERT INTO transactions (transaction_type, to_user_id, amount) VALUES ('deposit', 2, 2000000)").run();
		db.prepare("INSERT INTO transactions (transaction_type, from_user_id, to_user_id, amount) VALUES ('bail', 2, 3, 2000000)").run();

		run011(db);

		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=1")).toBe(5000000);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=2")).toBe(0);
		// user 3 was only the bail beneficiary: must not be credited
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=3")).toBe(0);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=-1")).toBe(0);
		expect(num("SELECT balance AS v FROM user_balances WHERE user_id=-3")).toBe(0);
	});
});
