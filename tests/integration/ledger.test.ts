/**
 * Core integration tests for ledger operations
 * Tests essential financial flows: deposits, withdrawals, transfers
 */

import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import {
	LedgerService,
	TransactionType,
	TransactionStatus,
} from "../../src/services/ledgerService";
import { TransactionLockService } from "../../src/services/transactionLock";

interface DbTransaction {
	id?: number;
	transaction_type: string;
	from_user_id?: number;
	to_user_id?: number;
	amount: number;
	balance_after?: number;
	status: string;
	tx_hash?: string;
}

const INTEGRATION_DB_PATH = join(__dirname, "../test-data/integration-ledger.db");
let db: Database.Database;

const dbHelpers = {
	query: <T>(sql: string, params: unknown[] = []): T[] =>
		db.prepare(sql).all(params) as T[],
	execute: (sql: string, params: unknown[] = []): Database.RunResult =>
		db.prepare(sql).run(params),
	get: <T>(sql: string, params: unknown[] = []): T | undefined =>
		db.prepare(sql).get(params) as T | undefined,
};

function initIntegrationDb(): void {
	const testDataDir = join(__dirname, "../test-data");
	if (!existsSync(testDataDir)) {
		mkdirSync(testDataDir, { recursive: true });
	}
	if (existsSync(INTEGRATION_DB_PATH)) {
		unlinkSync(INTEGRATION_DB_PATH);
	}

	db = new Database(INTEGRATION_DB_PATH);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY, username TEXT, role TEXT DEFAULT 'pleb',
			whitelist INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0,
			warning_count INTEGER DEFAULT 0, muted_until INTEGER,
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			updated_at INTEGER DEFAULT (strftime('%s', 'now'))
		);
		CREATE TABLE IF NOT EXISTS user_balances (
			user_id INTEGER PRIMARY KEY, balance REAL DEFAULT 0,
			last_updated INTEGER DEFAULT (strftime('%s', 'now')),
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS transactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			transaction_type TEXT NOT NULL, from_user_id INTEGER, to_user_id INTEGER,
			amount REAL NOT NULL, balance_after REAL, description TEXT, tx_hash TEXT,
			external_address TEXT, status TEXT DEFAULT 'completed',
			created_at INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT,
			FOREIGN KEY (from_user_id) REFERENCES users(id),
			FOREIGN KEY (to_user_id) REFERENCES users(id)
		);
		CREATE TABLE IF NOT EXISTS system_wallets (
			id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, description TEXT,
			created_at INTEGER DEFAULT (strftime('%s', 'now'))
		);
		CREATE TABLE IF NOT EXISTS violations (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
			rule_id INTEGER, restriction TEXT, message TEXT,
			timestamp INTEGER DEFAULT (strftime('%s', 'now')),
			bail_amount REAL DEFAULT 0, paid INTEGER DEFAULT 0, payment_tx TEXT,
			paid_by_user_id INTEGER, paid_at INTEGER,
			FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE IF NOT EXISTS user_locks (
			user_id INTEGER PRIMARY KEY, lock_type TEXT NOT NULL,
			locked_at INTEGER DEFAULT (strftime('%s', 'now')),
			expires_at INTEGER NOT NULL, metadata TEXT,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS transaction_locks (
			user_id INTEGER PRIMARY KEY, lock_type TEXT NOT NULL,
			amount REAL DEFAULT 0, target_address TEXT, tx_hash TEXT,
			status TEXT DEFAULT 'pending', metadata TEXT,
			locked_at INTEGER DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_transactions_from_user ON transactions(from_user_id);
		CREATE INDEX IF NOT EXISTS idx_transactions_to_user ON transactions(to_user_id);
	`);
}

function createTestUsers(): void {
	const users = [
		{ id: 1001, username: "alice", role: "pleb" },
		{ id: 1002, username: "bob", role: "pleb" },
		{ id: 1003, username: "charlie", role: "elevated" },
	];
	for (const user of users) {
		dbHelpers.execute(
			"INSERT INTO users (id, username, role) VALUES (?, ?, ?)",
			[user.id, user.username, user.role],
		);
	}
}

function cleanTestData(): void {
	if (!db) return;
	db.exec(`
		DELETE FROM transaction_locks; DELETE FROM user_locks;
		DELETE FROM transactions; DELETE FROM user_balances;
		DELETE FROM violations; DELETE FROM system_wallets; DELETE FROM users;
	`);
}

vi.mock("../../src/database", () => ({
	query: vi.fn((sql: string, params: unknown[] = []) =>
		dbHelpers.query(sql, params),
	),
	execute: vi.fn((sql: string, params: unknown[] = []) =>
		dbHelpers.execute(sql, params),
	),
	get: vi.fn((sql: string, params: unknown[] = []) =>
		dbHelpers.get(sql, params),
	),
	initDb: vi.fn(),
}));

vi.mock("../../src/config", () => ({
	config: {
		databasePath: ":memory:",
		botToken: "test-token",
		groupChatId: "-100123456789",
		botTreasuryAddress: "juno1testtreasuryaddress",
		userFundsAddress: "juno1testuserfundsaddress",
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: {
		logError: vi.fn(),
		logUserAction: vi.fn(),
		logTransaction: vi.fn(),
		logWalletAction: vi.fn(),
	},
}));

describe("Ledger Integration", () => {
	beforeAll(() => {
		initIntegrationDb();
		LedgerService.initialize();
	});

	beforeEach(() => {
		cleanTestData();
		createTestUsers();
	});

	afterAll(() => {
		if (db) db.close();
		if (existsSync(INTEGRATION_DB_PATH)) unlinkSync(INTEGRATION_DB_PATH);
	});

	it("should process deposit and credit user balance", async () => {
		const result = await LedgerService.processDeposit(
			1001,
			100.5,
			"TX_DEPOSIT",
			"juno1external",
		);

		expect(result.success).toBe(true);
		expect(result.newBalance).toBe(100.5);
		expect(await LedgerService.getUserBalance(1001)).toBe(100.5);
	});

	it("should process withdrawal and deduct balance", async () => {
		await LedgerService.processDeposit(1001, 500, "TX_INIT", "juno1init");

		const result = await LedgerService.processWithdrawal(
			1001,
			200,
			"juno1recipient",
			"TX_WITHDRAW",
		);

		expect(result.success).toBe(true);
		expect(result.newBalance).toBe(300);
	});

	it("should reject withdrawal with insufficient balance", async () => {
		await LedgerService.processDeposit(1001, 100, "TX_INIT", "juno1init");

		const result = await LedgerService.processWithdrawal(
			1001,
			500,
			"juno1recipient",
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Insufficient balance");
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
	});

	it("should transfer tokens between users", async () => {
		await LedgerService.processDeposit(1001, 1000, "TX1", "juno1init");
		await LedgerService.processDeposit(1002, 500, "TX2", "juno1init");

		const result = await LedgerService.transferBetweenUsers(1001, 1002, 250);

		expect(result.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(750);
		expect(await LedgerService.getUserBalance(1002)).toBe(750);
	});

	it("should process fine payment", async () => {
		await LedgerService.processDeposit(1001, 200, "TX_INIT", "juno1init");

		const result = await LedgerService.processFine(1001, 50, 123);

		expect(result.success).toBe(true);
		expect(result.newBalance).toBe(150);
	});

	it("should process bail payment", async () => {
		await LedgerService.processDeposit(1001, 500, "TX_INIT", "juno1init");

		const result = await LedgerService.processBail(1001, 1002, 150);

		expect(result.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(350);
	});

	it("should process giveaway distribution", async () => {
		const result = await LedgerService.processGiveaway(1001, 250);

		expect(result.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(250);
	});

	it("should maintain balance accuracy across operations", async () => {
		await LedgerService.processDeposit(1001, 1000, "TX1", "juno1addr");
		await LedgerService.processWithdrawal(1001, 200, "juno1recipient", "TX2");
		await LedgerService.processFine(1001, 50, 1);
		await LedgerService.processGiveaway(1001, 150);
		await LedgerService.processWithdrawal(1001, 100, "juno1recipient2", "TX3");

		// 1000 - 200 - 50 + 150 - 100 = 800
		expect(await LedgerService.getUserBalance(1001)).toBe(800);
	});

	it("should prevent concurrent operations with transaction lock", async () => {
		const first = await TransactionLockService.acquireLock(1001, "withdrawal");
		const second = await TransactionLockService.acquireLock(1001, "transfer");

		expect(first).toBe(true);
		expect(second).toBe(false);

		await TransactionLockService.releaseLock(1001);
		expect(await TransactionLockService.hasLock(1001)).toBe(false);
	});

	it("should record complete transaction history", async () => {
		await LedgerService.processDeposit(1001, 100, "TX1", "juno1addr");
		await LedgerService.processWithdrawal(1001, 30, "juno1recipient", "TX2");

		const transactions = (await LedgerService.getUserTransactions(
			1001,
		)) as unknown as DbTransaction[];

		expect(transactions).toHaveLength(2);
		expect(
			transactions.some((tx) => tx.transaction_type === TransactionType.DEPOSIT),
		).toBe(true);
		expect(
			transactions.some(
				(tx) => tx.transaction_type === TransactionType.WITHDRAWAL,
			),
		).toBe(true);
	});
});
