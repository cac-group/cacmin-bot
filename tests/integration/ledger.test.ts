/**
 * Core integration tests for ledger operations
 * Tests essential financial flows with real database
 */

import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { LedgerService, TransactionType } from "../../src/services/ledgerService";
import { TransactionLockService } from "../../src/services/transactionLock";

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
	if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
	if (existsSync(INTEGRATION_DB_PATH)) unlinkSync(INTEGRATION_DB_PATH);

	db = new Database(INTEGRATION_DB_PATH);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT DEFAULT 'pleb',
			whitelist INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0, warning_count INTEGER DEFAULT 0,
			muted_until INTEGER, created_at INTEGER DEFAULT (strftime('%s', 'now')),
			updated_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE user_balances (user_id INTEGER PRIMARY KEY, balance REAL DEFAULT 0,
			last_updated INTEGER DEFAULT (strftime('%s', 'now')), created_at INTEGER DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_type TEXT NOT NULL,
			from_user_id INTEGER, to_user_id INTEGER, amount REAL NOT NULL, balance_after REAL,
			description TEXT, tx_hash TEXT, external_address TEXT, status TEXT DEFAULT 'completed',
			created_at INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT,
			FOREIGN KEY (from_user_id) REFERENCES users(id), FOREIGN KEY (to_user_id) REFERENCES users(id));
		CREATE TABLE system_wallets (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE,
			description TEXT, created_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE violations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
			rule_id INTEGER, restriction TEXT, message TEXT, timestamp INTEGER DEFAULT (strftime('%s', 'now')),
			bail_amount REAL DEFAULT 0, paid INTEGER DEFAULT 0, payment_tx TEXT,
			paid_by_user_id INTEGER, paid_at INTEGER, FOREIGN KEY (user_id) REFERENCES users(id));
		CREATE TABLE user_locks (user_id INTEGER PRIMARY KEY, lock_type TEXT NOT NULL,
			locked_at INTEGER DEFAULT (strftime('%s', 'now')), expires_at INTEGER NOT NULL, metadata TEXT,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE transaction_locks (user_id INTEGER PRIMARY KEY, lock_type TEXT NOT NULL,
			amount REAL DEFAULT 0, target_address TEXT, tx_hash TEXT, status TEXT DEFAULT 'pending',
			metadata TEXT, locked_at INTEGER DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
	`);
}

function createTestUsers(): void {
	for (const user of [
		{ id: 1001, username: "alice" },
		{ id: 1002, username: "bob" },
	]) {
		dbHelpers.execute("INSERT INTO users (id, username, role) VALUES (?, ?, 'pleb')", [
			user.id,
			user.username,
		]);
	}
}

function cleanTestData(): void {
	if (!db) return;
	db.exec(`DELETE FROM transaction_locks; DELETE FROM user_locks; DELETE FROM transactions;
		DELETE FROM user_balances; DELETE FROM violations; DELETE FROM system_wallets; DELETE FROM users;`);
}

vi.mock("../../src/database", () => ({
	query: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.query(sql, params)),
	execute: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.execute(sql, params)),
	get: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.get(sql, params)),
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

	it("should maintain balance accuracy across all transaction types", async () => {
		const userId = 1001;

		// Deposit
		const deposit = await LedgerService.processDeposit(userId, 1000, "TX1", "juno1addr");
		expect(deposit.success).toBe(true);
		expect(await LedgerService.getUserBalance(userId)).toBe(1000);

		// Withdrawal
		await LedgerService.processWithdrawal(userId, 200, "juno1recipient", "TX2");
		expect(await LedgerService.getUserBalance(userId)).toBe(800);

		// Fine
		await LedgerService.processFine(userId, 50, 1);
		expect(await LedgerService.getUserBalance(userId)).toBe(750);

		// Giveaway
		await LedgerService.processGiveaway(userId, 150);
		expect(await LedgerService.getUserBalance(userId)).toBe(900);

		// Bail payment
		await LedgerService.processBail(userId, 1002, 100);
		expect(await LedgerService.getUserBalance(userId)).toBe(800);

		// Final withdrawal
		await LedgerService.processWithdrawal(userId, 100, "juno1recipient2", "TX3");
		expect(await LedgerService.getUserBalance(userId)).toBe(700);

		// Verify transaction history
		const transactions = (await LedgerService.getUserTransactions(userId)) as any[];
		expect(transactions.length).toBeGreaterThanOrEqual(6);
	});

	it("should reject operations with insufficient balance", async () => {
		await LedgerService.processDeposit(1001, 100, "TX1", "juno1addr");

		// Withdrawal exceeds balance
		const withdrawal = await LedgerService.processWithdrawal(1001, 500, "juno1recipient");
		expect(withdrawal.success).toBe(false);
		expect(withdrawal.error).toBe("Insufficient balance");
		expect(await LedgerService.getUserBalance(1001)).toBe(100);

		// Fine exceeds balance
		const fine = await LedgerService.processFine(1001, 200);
		expect(fine.success).toBe(false);
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
	});

	it("should transfer tokens between users correctly", async () => {
		await LedgerService.processDeposit(1001, 1000, "TX1", "juno1addr");
		await LedgerService.processDeposit(1002, 500, "TX2", "juno1addr");

		const result = await LedgerService.transferBetweenUsers(1001, 1002, 250);

		expect(result.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(750);
		expect(await LedgerService.getUserBalance(1002)).toBe(750);

		// Verify closed system (total unchanged)
		const total = await LedgerService.getTotalUserBalance();
		expect(total).toBe(1500);
	});

	it("should debit network fees from the user without touching other balances", async () => {
		await LedgerService.processDeposit(1001, 100, "TX1", "juno1addr");
		await LedgerService.processDeposit(1002, 50, "TX2", "juno1addr");

		const feeResult = await LedgerService.processFee(
			1001,
			0.00975,
			"Withdrawal network fee",
		);

		expect(feeResult.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(99.99025);
		expect(await LedgerService.getUserBalance(1002)).toBe(50);
		expect(await LedgerService.getTotalUserBalance()).toBe(149.99025);

		const transactions = (await LedgerService.getUserTransactions(1001)) as any[];
		expect(
			transactions.some((tx) => tx.transaction_type === TransactionType.FEE),
		).toBe(true);
	});

	it("should prevent concurrent operations with transaction locks", async () => {
		// First lock succeeds
		const first = await TransactionLockService.acquireLock(1001, "withdrawal");
		expect(first).toBe(true);
		expect(await TransactionLockService.hasLock(1001)).toBe(true);

		// Second lock fails while first is held
		const second = await TransactionLockService.acquireLock(1001, "transfer");
		expect(second).toBe(false);

		// Release and verify
		await TransactionLockService.releaseLock(1001);
		expect(await TransactionLockService.hasLock(1001)).toBe(false);

		// Can acquire again after release
		const third = await TransactionLockService.acquireLock(1001, "withdrawal");
		expect(third).toBe(true);
	});
});
