import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * Integration tests for ledger operations with real database
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { LedgerService, TransactionType, TransactionStatus } from '../../src/services/ledgerService';
import { TransactionLockService } from '../../src/services/transactionLock';

interface DbTransaction {
	id?: number; transaction_type: string; from_user_id?: number; to_user_id?: number;
	amount: number; balance_after?: number; description?: string; tx_hash?: string;
	external_address?: string; status: string; created_at?: number; metadata?: string;
}

const INTEGRATION_DB_PATH = join(__dirname, '../test-data/integration-ledger.db');
let db: Database.Database;

const dbHelpers = {
	query: <T>(sql: string, params: unknown[] = []): T[] => db.prepare(sql).all(params) as T[],
	execute: (sql: string, params: unknown[] = []): Database.RunResult => db.prepare(sql).run(params),
	get: <T>(sql: string, params: unknown[] = []): T | undefined => db.prepare(sql).get(params) as T | undefined
};

function initIntegrationDb(): void {
	const testDataDir = join(__dirname, '../test-data');
	if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
	if (existsSync(INTEGRATION_DB_PATH)) unlinkSync(INTEGRATION_DB_PATH);

	db = new Database(INTEGRATION_DB_PATH);
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, role TEXT DEFAULT 'pleb', whitelist INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0, warning_count INTEGER DEFAULT 0, muted_until INTEGER, created_at INTEGER DEFAULT (strftime('%s', 'now')), updated_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE IF NOT EXISTS user_balances (user_id INTEGER PRIMARY KEY, balance REAL DEFAULT 0, last_updated INTEGER DEFAULT (strftime('%s', 'now')), created_at INTEGER DEFAULT (strftime('%s', 'now')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_type TEXT NOT NULL, from_user_id INTEGER, to_user_id INTEGER, amount REAL NOT NULL, balance_after REAL, description TEXT, tx_hash TEXT, external_address TEXT, status TEXT DEFAULT 'completed', created_at INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT, FOREIGN KEY (from_user_id) REFERENCES users(id), FOREIGN KEY (to_user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS system_wallets (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE IF NOT EXISTS violations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, rule_id INTEGER, restriction TEXT, message TEXT, timestamp INTEGER DEFAULT (strftime('%s', 'now')), bail_amount REAL DEFAULT 0, paid INTEGER DEFAULT 0, payment_tx TEXT, paid_by_user_id INTEGER, paid_at INTEGER, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (paid_by_user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS jail_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL, admin_id INTEGER, duration_minutes INTEGER, bail_amount REAL DEFAULT 0, paid_by_user_id INTEGER, payment_tx TEXT, timestamp INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (admin_id) REFERENCES users(id), FOREIGN KEY (paid_by_user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS user_locks (user_id INTEGER PRIMARY KEY, lock_type TEXT NOT NULL, locked_at INTEGER DEFAULT (strftime('%s', 'now')), expires_at INTEGER NOT NULL, metadata TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE IF NOT EXISTS transaction_locks (user_id INTEGER PRIMARY KEY, lock_type TEXT NOT NULL, amount REAL DEFAULT 0, target_address TEXT, tx_hash TEXT, status TEXT DEFAULT 'pending', metadata TEXT, locked_at INTEGER DEFAULT (strftime('%s', 'now')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, price_usd REAL NOT NULL, timestamp INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE IF NOT EXISTS fine_config (fine_type TEXT PRIMARY KEY, amount_usd REAL NOT NULL, description TEXT, updated_at INTEGER DEFAULT (strftime('%s', 'now')), updated_by INTEGER);
		CREATE INDEX IF NOT EXISTS idx_user_balances_balance ON user_balances(balance);
		CREATE INDEX IF NOT EXISTS idx_transactions_from_user ON transactions(from_user_id);
		CREATE INDEX IF NOT EXISTS idx_transactions_to_user ON transactions(to_user_id);
		CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
		CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
		CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
		CREATE INDEX IF NOT EXISTS idx_user_locks_expires ON user_locks(expires_at);
	`);
}

function createTestUsers(): void {
	const users = [{ id: 1001, username: 'alice', role: 'pleb' }, { id: 1002, username: 'bob', role: 'pleb' }, { id: 1003, username: 'charlie', role: 'elevated' }];
	for (const u of users) dbHelpers.execute('INSERT INTO users (id, username, role) VALUES (?, ?, ?)', [u.id, u.username, u.role]);
}

function cleanTestData(): void {
	if (!db) return;
	db.exec('DELETE FROM transaction_locks; DELETE FROM user_locks; DELETE FROM transactions; DELETE FROM user_balances; DELETE FROM violations; DELETE FROM jail_events; DELETE FROM system_wallets; DELETE FROM users;');
}

function closeIntegrationDb(): void {
	if (db) db.close();
	if (existsSync(INTEGRATION_DB_PATH)) unlinkSync(INTEGRATION_DB_PATH);
}

vi.mock('../../src/database', () => ({
	query: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.query(sql, params)),
	execute: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.execute(sql, params)),
	get: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.get(sql, params)),
	initDb: vi.fn(),
}));

vi.mock('../../src/config', () => ({
	config: { databasePath: ':memory:', botToken: 'test-token', groupChatId: '-100123456789', botTreasuryAddress: 'juno1testtreasuryaddress', userFundsAddress: 'juno1testuserfundsaddress', adminChatId: '123456789', junoRpcUrl: 'https://rpc.juno.basementnodes.ca', junoApiUrl: 'https://api.juno.basementnodes.ca' },
}));

vi.mock('../../src/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logWalletAction: vi.fn() },
}));

describe('Ledger Integration Tests', () => {
	beforeAll(() => { initIntegrationDb(); LedgerService.initialize(); });
	beforeEach(() => { cleanTestData(); createTestUsers(); });
	afterAll(() => closeIntegrationDb());

	describe('Deposit Flow', () => {
		it('processes deposits correctly', async () => {
			const userId = 1001;
			const result = await LedgerService.processDeposit(userId, 100.5, 'DEPOSIT_TX_001', 'juno1external', 'Test deposit');
			expect(result.success).toBe(true);
			expect(result.newBalance).toBe(100.5);

			// Multiple deposits accumulate
			await LedgerService.processDeposit(userId, 50, 'TX2', 'juno1addr');
			expect(await LedgerService.getUserBalance(userId)).toBe(150.5);

			// Verify transaction recorded
			const txs = await LedgerService.getUserTransactions(userId) as unknown as DbTransaction[];
			expect(txs).toHaveLength(2);
			expect(txs.find(t => t.tx_hash === 'DEPOSIT_TX_001')?.transaction_type).toBe(TransactionType.DEPOSIT);
		});

		it('handles deposit errors gracefully', async () => {
			const result = await LedgerService.processDeposit(99999, 100, 'TX_ERROR', 'juno1addr');
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('Withdrawal Flow', () => {
		beforeEach(async () => { await LedgerService.processDeposit(1001, 500, 'INIT_TX', 'juno1init'); });

		it('processes withdrawals with all scenarios', async () => {
			// Successful withdrawal
			let result = await LedgerService.processWithdrawal(1001, 200, 'juno1recipient', 'WITHDRAW_TX', 'Test');
			expect(result.success).toBe(true);
			expect(result.newBalance).toBe(300);
			expect(await LedgerService.getUserBalance(1001)).toBe(300);

			// Verify transaction recorded
			const txs = await LedgerService.getUserTransactions(1001) as unknown as DbTransaction[];
			const withdrawal = txs.find(tx => tx.transaction_type === TransactionType.WITHDRAWAL);
			expect(withdrawal?.status).toBe(TransactionStatus.COMPLETED);

			// Insufficient balance
			result = await LedgerService.processWithdrawal(1001, 400, 'juno1recipient');
			expect(result.success).toBe(false);
			expect(result.error).toBe('Insufficient balance');

			// Pending withdrawal (no tx_hash)
			result = await LedgerService.processWithdrawal(1001, 50, 'juno1recipient');
			expect(result.success).toBe(true);
			const pending = (await LedgerService.getUserTransactions(1001) as unknown as DbTransaction[]).find(tx => tx.id === result.transactionId);
			expect(pending?.status).toBe(TransactionStatus.PENDING);

			// Update pending to completed
			await LedgerService.updateTransactionStatus(result.transactionId!, TransactionStatus.COMPLETED, 'TX_CONFIRMED');
			const updated = (await LedgerService.getUserTransactions(1001) as unknown as DbTransaction[]).find(tx => tx.id === result.transactionId);
			expect(updated?.status).toBe(TransactionStatus.COMPLETED);
		});
	});

	describe('Internal Transfer Flow', () => {
		beforeEach(async () => {
			await LedgerService.processDeposit(1001, 1000, 'INIT_TX_1', 'juno1init');
			await LedgerService.processDeposit(1002, 500, 'INIT_TX_2', 'juno1init');
		});

		it('transfers between users correctly', async () => {
			const result = await LedgerService.transferBetweenUsers(1001, 1002, 250, 'Test transfer');
			expect(result.success).toBe(true);
			expect(result.fromBalance).toBe(750);
			expect(result.toBalance).toBe(750);

			// Both users see the transaction
			const senderTxs = await LedgerService.getUserTransactions(1001) as unknown as DbTransaction[];
			const recipientTxs = await LedgerService.getUserTransactions(1002) as unknown as DbTransaction[];
			const transfer = senderTxs.find(tx => tx.transaction_type === TransactionType.TRANSFER);
			expect(transfer).toBeDefined();
			expect(recipientTxs.find(tx => tx.id === transfer?.id)).toBeDefined();

			// Insufficient balance
			const badResult = await LedgerService.transferBetweenUsers(1001, 1002, 1500);
			expect(badResult.success).toBe(false);

			// Transfer to user with no balance
			const newUserResult = await LedgerService.transferBetweenUsers(1001, 1003, 100);
			expect(newUserResult.success).toBe(true);
			expect(await LedgerService.getUserBalance(1003)).toBe(100);
		});
	});

	describe('Fine and Bail Flow', () => {
		beforeEach(async () => {
			await LedgerService.processDeposit(1001, 500, 'INIT_TX_1', 'juno1init');
			await LedgerService.processDeposit(1002, 100, 'INIT_TX_2', 'juno1init');
		});

		it('processes fines correctly', async () => {
			const result = await LedgerService.processFine(1001, 50, 123, 'Violation');
			expect(result.success).toBe(true);
			expect(result.newBalance).toBe(450);

			// Multiple fines
			await LedgerService.processFine(1001, 30, 124);
			expect(await LedgerService.getUserBalance(1001)).toBe(420);

			// Insufficient balance
			const badResult = await LedgerService.processFine(1001, 600);
			expect(badResult.success).toBe(false);
			expect(badResult.error).toBe('Insufficient balance for fine payment');
		});

		it('processes bail payments correctly', async () => {
			// Pay someone else's bail
			let result = await LedgerService.processBail(1001, 1002, 150, 'Bail payment');
			expect(result.success).toBe(true);
			expect(await LedgerService.getUserBalance(1001)).toBe(350);

			// Pay own bail
			result = await LedgerService.processBail(1001, 1001, 50);
			expect(result.success).toBe(true);
			expect(await LedgerService.getUserBalance(1001)).toBe(300);

			// Insufficient balance
			const badResult = await LedgerService.processBail(1001, 1002, 1000);
			expect(badResult.success).toBe(false);
		});
	});

	describe('Giveaway Flow', () => {
		it('processes giveaways correctly', async () => {
			const result = await LedgerService.processGiveaway(1001, 250, 'Admin giveaway');
			expect(result.success).toBe(true);
			expect(result.newBalance).toBe(250);

			// Adds to existing balance
			await LedgerService.processDeposit(1001, 100, 'TX1', 'juno1addr');
			await LedgerService.processGiveaway(1001, 150);
			expect(await LedgerService.getUserBalance(1001)).toBe(500);

			// Mass distribution
			const users = [1001, 1002, 1003];
			for (const u of users) await LedgerService.processGiveaway(u, 50, 'Mass giveaway');
			const total = await LedgerService.getTotalUserBalance();
			expect(total).toBe(650); // 500 + 50 + 50 + 50
		});
	});

	describe('Transaction Locking', () => {
		beforeEach(async () => { await LedgerService.processDeposit(1001, 1000, 'INIT_TX', 'juno1init'); });

		it('manages locks correctly', async () => {
			// Acquire and verify lock
			expect(await TransactionLockService.acquireLock(1001, 'withdrawal', 100)).toBe(true);
			expect(await TransactionLockService.hasLock(1001)).toBe(true);

			// Concurrent lock fails
			expect(await TransactionLockService.acquireLock(1001, 'transfer')).toBe(false);

			// Release and reacquire
			await TransactionLockService.releaseLock(1001);
			expect(await TransactionLockService.hasLock(1001)).toBe(false);
			expect(await TransactionLockService.acquireLock(1001, 'withdrawal')).toBe(true);
		});

		it('cleans expired locks', async () => {
			const expiredTime = Math.floor(Date.now() / 1000) - 300;
			dbHelpers.execute('INSERT INTO user_locks (user_id, lock_type, expires_at) VALUES (?, ?, ?)', [1001, 'withdrawal', expiredTime]);
			await TransactionLockService.cleanExpiredLocks();
			expect(await TransactionLockService.hasLock(1001)).toBe(false);
		});

		it('allows operation after lock expires', async () => {
			const now = Math.floor(Date.now() / 1000);
			dbHelpers.execute('INSERT INTO user_locks (user_id, lock_type, locked_at, expires_at) VALUES (?, ?, ?, ?)', [1001, 'withdrawal', now, now + 1]);
			await new Promise(resolve => setTimeout(resolve, 1500));
			expect(await TransactionLockService.acquireLock(1001, 'withdrawal')).toBe(true);
		});
	});

	describe('Ledger Integrity', () => {
		it('maintains balance accuracy across operations', async () => {
			await LedgerService.processDeposit(1001, 1000, 'TX1', 'juno1addr');
			await LedgerService.processWithdrawal(1001, 200, 'juno1recipient', 'TX2');
			await LedgerService.processFine(1001, 50, 1);
			await LedgerService.processGiveaway(1001, 150);
			await LedgerService.processWithdrawal(1001, 100, 'juno1recipient2', 'TX3');
			expect(await LedgerService.getUserBalance(1001)).toBe(800); // 1000-200-50+150-100

			// Transfers preserve total balance
			await LedgerService.processDeposit(1002, 500, 'TX4', 'juno1addr');
			const initialTotal = await LedgerService.getTotalUserBalance();
			await LedgerService.transferBetweenUsers(1001, 1002, 200);
			await LedgerService.transferBetweenUsers(1002, 1003, 100);
			expect(await LedgerService.getTotalUserBalance()).toBe(initialTotal);
		});

		it('tracks all transaction types correctly', async () => {
			await LedgerService.processDeposit(1001, 1000, 'TX1', 'juno1addr');
			await LedgerService.processWithdrawal(1001, 100, 'juno1recipient', 'TX2');
			await LedgerService.processFine(1001, 50, 1);
			await LedgerService.processGiveaway(1001, 200);
			await LedgerService.transferBetweenUsers(1001, 1002, 150);

			const txs = await LedgerService.getUserTransactions(1001, 10) as unknown as DbTransaction[];
			expect(txs.some(tx => tx.transaction_type === TransactionType.DEPOSIT)).toBe(true);
			expect(txs.some(tx => tx.transaction_type === TransactionType.WITHDRAWAL)).toBe(true);
			expect(txs.some(tx => tx.transaction_type === TransactionType.FINE)).toBe(true);
			expect(txs.some(tx => tx.transaction_type === TransactionType.GIVEAWAY)).toBe(true);
			expect(txs.some(tx => tx.transaction_type === TransactionType.TRANSFER)).toBe(true);
		});

		it('maintains transaction history integrity with balance_after', async () => {
			await LedgerService.processDeposit(1001, 100, 'TX1', 'juno1addr');
			await LedgerService.processDeposit(1001, 50, 'TX2', 'juno1addr');
			await LedgerService.processWithdrawal(1001, 30, 'juno1recipient', 'TX3');

			const txs = await LedgerService.getUserTransactions(1001) as unknown as DbTransaction[];
			expect(txs.find(tx => tx.tx_hash === 'TX1')?.balance_after).toBe(100);
			expect(txs.find(tx => tx.tx_hash === 'TX2')?.balance_after).toBe(150);
			expect(txs.find(tx => tx.tx_hash === 'TX3')?.balance_after).toBe(120);
		});
	});

	describe('Edge Cases', () => {
		it('handles special values correctly', async () => {
			// Very small amounts
			await LedgerService.processDeposit(1001, 0.000001, 'TX1', 'juno1addr');
			expect(await LedgerService.getUserBalance(1001)).toBe(0.000001);

			// Very large amounts
			await LedgerService.processDeposit(1002, 1000000000, 'TX2', 'juno1addr');
			expect(await LedgerService.getUserBalance(1002)).toBe(1000000000);

			// Special characters in description
			const desc = "Test with 'quotes' and \"double quotes\" and special chars: !@#$%^&*()";
			await LedgerService.processDeposit(1003, 100, 'TX3', 'juno1addr', desc);
			const txs = await LedgerService.getUserTransactions(1003) as unknown as DbTransaction[];
			expect(txs[0].description).toBe(desc);

			// Zero balance operations
			const result = await LedgerService.processWithdrawal(1003, 200, 'juno1recipient');
			expect(result.success).toBe(false);
		});

		it('handles concurrent operations on different users', async () => {
			await LedgerService.processDeposit(1001, 500, 'TX1', 'juno1addr');
			await LedgerService.processDeposit(1002, 500, 'TX2', 'juno1addr');
			await LedgerService.processDeposit(1003, 500, 'TX3', 'juno1addr');

			const results = await Promise.all([
				LedgerService.processWithdrawal(1001, 100, 'juno1recipient1', 'TX_W1'),
				LedgerService.processWithdrawal(1002, 150, 'juno1recipient2', 'TX_W2'),
				LedgerService.processWithdrawal(1003, 200, 'juno1recipient3', 'TX_W3'),
			]);

			expect(results.every(r => r.success)).toBe(true);
			expect(await LedgerService.getUserBalance(1001)).toBe(400);
			expect(await LedgerService.getUserBalance(1002)).toBe(350);
			expect(await LedgerService.getUserBalance(1003)).toBe(300);
		});
	});

	describe('Transaction History and Pagination', () => {
		beforeEach(async () => { for (let i = 0; i < 15; i++) await LedgerService.processDeposit(1001, 10, `TX_${i}`, 'juno1addr'); });

		it('supports pagination', async () => {
			const firstPage = await LedgerService.getUserTransactions(1001, 5, 0) as unknown as DbTransaction[];
			const secondPage = await LedgerService.getUserTransactions(1001, 5, 5) as unknown as DbTransaction[];

			expect(firstPage).toHaveLength(5);
			expect(secondPage).toHaveLength(5);
			expect(firstPage[0].id).not.toBe(secondPage[0].id);

			// Reverse chronological order
			for (let i = 0; i < firstPage.length - 1; i++) {
				expect(firstPage[i].created_at!).toBeGreaterThanOrEqual(firstPage[i + 1].created_at!);
			}
		});
	});

	describe('Complete Workflows', () => {
		it('handles complete user lifecycle', async () => {
			await LedgerService.processDeposit(1001, 1000, 'TX1', 'juno1addr');
			await LedgerService.transferBetweenUsers(1001, 1002, 200);
			await LedgerService.processGiveaway(1001, 100);
			await LedgerService.processFine(1001, 50, 1);
			await LedgerService.processWithdrawal(1001, 350, 'juno1recipient', 'TX2');

			expect(await LedgerService.getUserBalance(1001)).toBe(500); // 1000-200+100-50-350
			const txs = await LedgerService.getUserTransactions(1001, 10) as unknown as DbTransaction[];
			expect(txs).toHaveLength(5);
		});

		it('handles bail payment workflow', async () => {
			await LedgerService.processDeposit(1001, 1000, 'TX1', 'juno1addr');
			const violationId = dbHelpers.execute('INSERT INTO violations (user_id, restriction, bail_amount, paid) VALUES (?, ?, ?, ?)', [1002, 'spam', 200, 0]).lastInsertRowid;

			const bailResult = await LedgerService.processBail(1001, 1002, 200);
			expect(bailResult.success).toBe(true);

			dbHelpers.execute('UPDATE violations SET paid = 1, paid_by_user_id = ?, paid_at = ? WHERE id = ?', [1001, Math.floor(Date.now() / 1000), violationId]);
			const violation = dbHelpers.get<any>('SELECT * FROM violations WHERE id = ?', [violationId]);
			expect(violation!.paid).toBe(1);
		});
	});

	describe('Performance', () => {
		it('handles bulk deposit operations efficiently', async () => {
			const startTime = Date.now();
			for (let i = 0; i < 100; i++) await LedgerService.processDeposit(1001, 10, `TX_${i}`, 'juno1addr');
			expect(Date.now() - startTime).toBeLessThan(5000);
			expect(await LedgerService.getUserBalance(1001)).toBe(1000);
		});

		it('handles large transaction history queries', async () => {
			for (let i = 0; i < 50; i++) await LedgerService.processDeposit(1001, 10, `TX_${i}`, 'juno1addr');
			const startTime = Date.now();
			const txs = await LedgerService.getUserTransactions(1001, 50) as unknown as DbTransaction[];
			expect(txs).toHaveLength(50);
			expect(Date.now() - startTime).toBeLessThan(100);
		});
	});

	describe('System Wallet Management', () => {
		it('initializes system wallets', () => {
			const wallets = LedgerService.getSystemWallets();
			expect(wallets.treasury).toBe('juno1testtreasuryaddress');
			expect(wallets.userFunds).toBe('juno1testuserfundsaddress');
		});
	});
});
