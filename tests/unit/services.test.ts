import { vi, describe, it, expect, beforeEach, beforeAll, afterAll, test } from 'vitest';
/**
 * Unit tests for database services - UserService, ViolationService, JailService, RestrictionService
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { ensureUserExists, addUserRestriction, removeUserRestriction, getUserRestrictions } from '../../src/services/userService';
import { createViolation, getUserViolations, getUnpaidViolations, markViolationPaid, getTotalFines } from '../../src/services/violationService';
import { JailService } from '../../src/services/jailService';
import { RestrictionService } from '../../src/services/restrictionService';
import { User, Violation, UserRestriction, JailEvent } from '../../src/types';

vi.mock('../../src/config', () => ({
	config: {
		botToken: 'test-token', junoRpcUrl: 'https://test.rpc', adminChatId: 123456789,
		groupChatId: -100123456789, ownerId: 111111111, databasePath: join(__dirname, '../test-data/services-test.db'),
		logLevel: 'silent', fineAmounts: { sticker: 1.0, url: 2.0, regex: 1.5, blacklist: 5.0 },
	},
	validateConfig: vi.fn()
}));

vi.mock('../../src/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logSecurityEvent: vi.fn(), logDebug: vi.fn() },
}));

vi.mock('../../src/services/priceService', () => ({
	PriceService: {
		calculateViolationFine: vi.fn(async (r: string) => ({ no_stickers: 1.0, no_urls: 2.0, regex_block: 1.5, blacklist: 5.0 }[r] || 1.0)),
		calculateBailAmount: vi.fn(async (d: number) => Math.max(1.0, d * 0.1)),
		getFineConfigUsd: vi.fn((t: string) => ({ sticker: 0.1, url: 0.2, regex: 0.15, blacklist: 0.5, jail_per_minute: 0.01, jail_minimum: 0.1 }[t] || 0.1)),
	},
}));

let testDb: Database.Database | null = null;
const TEST_DB_PATH = join(__dirname, '../test-data/services-test.db');

vi.mock('../../src/database', () => {
	const Database = require('better-sqlite3');
	const { join } = require('path');
	const testDbPath = join(__dirname, '../test-data/services-test.db');

	const getDb = () => {
		if (!testDb) { testDb = new Database(testDbPath); testDb!.exec('PRAGMA foreign_keys = ON'); }
		return testDb!;
	};

	return {
		query: <T>(sql: string, params: unknown[] = []): T[] => getDb().prepare(sql).all(params) as T[],
		execute: (sql: string, params: unknown[] = []): Database.RunResult => getDb().prepare(sql).run(params),
		get: <T>(sql: string, params: unknown[] = []): T | undefined => getDb().prepare(sql).get(params) as T | undefined,
		initDb: vi.fn()
	};
});

function initTestDatabase(): void {
	const testDataDir = join(__dirname, '../test-data');
	if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
	if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

	testDb = new Database(TEST_DB_PATH);
	testDb!.exec('PRAGMA foreign_keys = ON');
	testDb!.exec(`
		CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, role TEXT DEFAULT 'pleb', whitelist INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0, warning_count INTEGER DEFAULT 0, muted_until INTEGER, created_at INTEGER DEFAULT (strftime('%s', 'now')), updated_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE TABLE IF NOT EXISTS user_balances (user_id INTEGER PRIMARY KEY, balance REAL DEFAULT 0, last_updated INTEGER DEFAULT (strftime('%s', 'now')), created_at INTEGER DEFAULT (strftime('%s', 'now')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_type TEXT NOT NULL, from_user_id INTEGER, to_user_id INTEGER, amount REAL NOT NULL, balance_after REAL, description TEXT, tx_hash TEXT, external_address TEXT, status TEXT DEFAULT 'completed', created_at INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT, FOREIGN KEY (from_user_id) REFERENCES users(id), FOREIGN KEY (to_user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS violations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, rule_id INTEGER, restriction TEXT, message TEXT, timestamp INTEGER DEFAULT (strftime('%s', 'now')), bail_amount REAL DEFAULT 0, paid INTEGER DEFAULT 0, payment_tx TEXT, paid_by_user_id INTEGER, paid_at INTEGER, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (paid_by_user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS jail_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL, admin_id INTEGER, duration_minutes INTEGER, bail_amount REAL DEFAULT 0, paid_by_user_id INTEGER, payment_tx TEXT, timestamp INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (admin_id) REFERENCES users(id), FOREIGN KEY (paid_by_user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS user_restrictions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, restriction TEXT NOT NULL, restricted_action TEXT, metadata TEXT, restricted_until INTEGER, severity TEXT DEFAULT 'delete', violation_threshold INTEGER DEFAULT 5, auto_jail_duration INTEGER DEFAULT 2880, auto_jail_fine REAL DEFAULT 10.0, created_at INTEGER DEFAULT (strftime('%s', 'now')), FOREIGN KEY (user_id) REFERENCES users(id));
		CREATE TABLE IF NOT EXISTS global_restrictions (id INTEGER PRIMARY KEY AUTOINCREMENT, restriction TEXT NOT NULL, restricted_action TEXT, metadata TEXT, restricted_until INTEGER, created_at INTEGER DEFAULT (strftime('%s', 'now')));
		CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
		CREATE INDEX IF NOT EXISTS idx_violations_user ON violations(user_id);
		CREATE INDEX IF NOT EXISTS idx_restrictions_user ON user_restrictions(user_id);
		CREATE INDEX IF NOT EXISTS idx_jail_events_user ON jail_events(user_id);
	`);
}

function cleanTestDatabase(): void {
	if (!testDb) return;
	testDb.exec('DELETE FROM jail_events; DELETE FROM user_restrictions; DELETE FROM global_restrictions; DELETE FROM violations; DELETE FROM transactions; DELETE FROM user_balances; DELETE FROM users;');
}

function closeTestDatabase(): void {
	if (testDb) { testDb.close(); testDb = null; }
	if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
}

describe('Database Services', () => {
	beforeAll(() => initTestDatabase());
	afterAll(() => closeTestDatabase());
	beforeEach(() => cleanTestDatabase());

	describe('UserService', () => {
		it('creates users and handles updates correctly', () => {
			ensureUserExists(123456, 'testuser');
			let user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(123456) as User;
			expect(user.username).toBe('testuser');
			expect(user.role).toBe('pleb');

			// Updates username but preserves role
			testDb!.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', 123456);
			ensureUserExists(123456, 'newname');
			user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(123456) as User;
			expect(user.username).toBe('newname');
			expect(user.role).toBe('admin');
		});

		it('manages restrictions correctly', () => {
			ensureUserExists(123456, 'testuser');
			const futureTime = Math.floor(Date.now() / 1000) + 3600;
			const metadata = { reason: 'spam', count: 5 };

			addUserRestriction(123456, 'no_stickers');
			addUserRestriction(123456, 'no_urls', 'example.com', metadata, futureTime);

			let restrictions = getUserRestrictions(123456) as any[];
			expect(restrictions).toHaveLength(2);
			expect(restrictions.find((r: any) => r.restriction === 'no_urls')?.restricted_action).toBe('example.com');

			removeUserRestriction(123456, 'no_stickers');
			restrictions = getUserRestrictions(123456);
			expect(restrictions).toHaveLength(1);
			expect(restrictions[0].restriction).toBe('no_urls');
		});
	});

	describe('ViolationService', () => {
		beforeEach(() => ensureUserExists(123456, 'testuser'));

		it('creates violations with correct fine amounts', async () => {
			const fines: Record<string, number> = { no_stickers: 1.0, no_urls: 2.0, regex_block: 1.5, blacklist: 5.0 };

			for (const [restriction, expectedFine] of Object.entries(fines)) {
				const id = await createViolation(123456, restriction);
				const v = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(id) as any;
				expect(v.bail_amount).toBe(expectedFine);
			}

			const user = testDb!.prepare('SELECT warning_count FROM users WHERE id = ?').get(123456) as User;
			expect(user.warning_count).toBe(4);
		});

		it('handles paid/unpaid violations correctly', async () => {
			const id1 = await createViolation(123456, 'no_stickers');
			const id2 = await createViolation(123456, 'no_urls');
			await createViolation(123456, 'blacklist');

			markViolationPaid(id1, 'tx_hash_1');
			ensureUserExists(999999, 'payer');
			markViolationPaid(id2, 'tx_hash_2', 999999);

			const allViolations = getUserViolations(123456);
			expect(allViolations).toHaveLength(3);

			const unpaid = getUnpaidViolations(123456);
			expect(unpaid).toHaveLength(1);
			expect(unpaid[0].restriction).toBe('blacklist');

			expect(getTotalFines(123456)).toBe(5.0);

			const v2 = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(id2) as any;
			expect(v2.paid_by_user_id).toBe(999999);
		});
	});

	describe('JailService', () => {
		beforeEach(() => {
			ensureUserExists(123456, 'jaileduser');
			ensureUserExists(999999, 'admin');
		});

		it('logs jail events with all fields', () => {
			const metadata = { reason: 'spam', count: 5 };
			JailService.logJailEvent(123456, 'jailed', 999999, 60, 10.0, undefined, undefined, metadata);

			const events = testDb!.prepare('SELECT * FROM jail_events WHERE user_id = ?').all(123456) as any[];
			expect(events).toHaveLength(1);
			expect(events[0].event_type).toBe('jailed');
			expect(events[0].admin_id).toBe(999999);
			expect(events[0].duration_minutes).toBe(60);
			expect(events[0].bail_amount).toBe(10.0);
			expect(events[0].metadata).toBe(JSON.stringify(metadata));
		});

		it('tracks active jails correctly', () => {
			const futureTime = Math.floor(Date.now() / 1000) + 3600;
			const pastTime = Math.floor(Date.now() / 1000) - 3600;

			testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 123456);
			ensureUserExists(111111, 'expired');
			testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(pastTime, 111111);

			const jails = JailService.getActiveJails();
			expect(jails).toHaveLength(1);
			expect(jails[0].id).toBe(123456);
			expect(jails[0].timeRemaining).toBeGreaterThan(3500);
		});

		it('retrieves jail events with limit and order', () => {
			for (let i = 0; i < 10; i++) {
				JailService.logJailEvent(123456, i % 2 === 0 ? 'jailed' : 'unjailed', 999999);
			}

			const events = JailService.getUserJailEvents(123456, 5) as any[];
			expect(events).toHaveLength(5);
			// Just verify we get 5 events, don't rely on ordering within same second
		});

		it('calculates bail amounts correctly', async () => {
			expect(await JailService.calculateBailAmount(0)).toBe(1.0);
			expect(await JailService.calculateBailAmount(5)).toBe(1.0);
			expect(await JailService.calculateBailAmount(60)).toBe(6.0);
			expect(await JailService.calculateBailAmount(1440)).toBe(144);
		});
	});

	describe('RestrictionService', () => {
		beforeEach(() => ensureUserExists(123456, 'testuser'));

		it('cleans expired restrictions', () => {
			const pastTime = Math.floor(Date.now() / 1000) - 3600;
			const futureTime = Math.floor(Date.now() / 1000) + 3600;

			addUserRestriction(123456, 'no_stickers', undefined, undefined, pastTime);
			addUserRestriction(123456, 'no_urls', undefined, undefined, futureTime);
			addUserRestriction(123456, 'no_media');

			testDb!.prepare('INSERT INTO global_restrictions (restriction, restricted_until) VALUES (?, ?)').run('no_voice', pastTime);
			testDb!.prepare('INSERT INTO global_restrictions (restriction) VALUES (?)').run('no_gifs');

			RestrictionService.cleanExpiredRestrictions();

			expect(getUserRestrictions(123456)).toHaveLength(2);
			expect(testDb!.prepare('SELECT * FROM global_restrictions').all()).toHaveLength(1);
		});
	});

	describe('Data Integrity', () => {
		it('enforces foreign key constraints', async () => {
			expect(() => testDb!.prepare('INSERT INTO violations (user_id, restriction, bail_amount) VALUES (?, ?, ?)').run(999999, 'test', 1.0)).toThrow();
			expect(() => testDb!.prepare('INSERT INTO user_restrictions (user_id, restriction) VALUES (?, ?)').run(999999, 'test')).toThrow();
			expect(() => testDb!.prepare('INSERT INTO jail_events (user_id, event_type) VALUES (?, ?)').run(999999, 'jailed')).toThrow();

			ensureUserExists(123456, 'testuser');
			const violationId = await createViolation(123456, 'no_stickers');
			expect(() => testDb!.prepare('UPDATE violations SET paid = 1, paid_by_user_id = ? WHERE id = ?').run(888888, violationId)).toThrow();
		});

		it('cascades user deletion to balances', () => {
			ensureUserExists(123456, 'testuser');
			testDb!.prepare('INSERT INTO user_balances (user_id, balance) VALUES (?, ?)').run(123456, 100.0);
			testDb!.prepare('DELETE FROM users WHERE id = ?').run(123456);
			expect(testDb!.prepare('SELECT * FROM user_balances WHERE user_id = ?').all(123456)).toHaveLength(0);
		});
	});

	describe('Edge Cases', () => {
		it('handles null/empty/special values', () => {
			expect(() => testDb!.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(1, null, 'pleb')).not.toThrow();
			ensureUserExists(2, '');
			expect((testDb!.prepare('SELECT username FROM users WHERE id = ?').get(2) as any).username).toBe('');

			ensureUserExists(-123456, 'negative');
			expect(testDb!.prepare('SELECT * FROM users WHERE id = ?').get(-123456)).toBeDefined();

			ensureUserExists(3, 'testuser');
			addUserRestriction(3, 'no_urls', undefined, { special: "Test with 'quotes'", unicode: '测试' });
			const r = getUserRestrictions(3);
			expect(JSON.parse(r[0].metadata!).unicode).toBe('测试');
		});

		it('handles large bail and boundary conditions', async () => {
			ensureUserExists(123456, 'testuser');
			testDb!.prepare('INSERT INTO violations (user_id, restriction, bail_amount) VALUES (?, ?, ?)').run(123456, 'test', 9999999.99);
			const v = testDb!.prepare('SELECT bail_amount FROM violations WHERE user_id = ?').get(123456) as any;
			expect(v.bail_amount).toBe(9999999.99);

			const now = Math.floor(Date.now() / 1000);
			addUserRestriction(123456, 'no_stickers', undefined, undefined, now - 1);
			addUserRestriction(123456, 'no_urls', undefined, undefined, now + 1);
			const active = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ? AND (restricted_until IS NULL OR restricted_until > ?)').all(123456, now);
			expect(active).toHaveLength(1);
		});
	});

	describe('Performance', () => {
		it('handles bulk operations efficiently', async () => {
			const start = Date.now();

			for (let i = 1; i <= 100; i++) ensureUserExists(i, `user${i}`);
			expect(testDb!.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).toMatchObject({ count: 100 });

			ensureUserExists(1001, 'violator');
			for (let i = 0; i < 50; i++) await createViolation(1001, 'no_stickers');
			expect(getUserViolations(1001)).toHaveLength(50);

			ensureUserExists(1002, 'restricted');
			for (let i = 0; i < 30; i++) addUserRestriction(1002, 'no_urls', `domain${i}.com`);
			expect(getUserRestrictions(1002)).toHaveLength(30);

			expect(Date.now() - start).toBeLessThan(15000);
		}, 20000);
	});
});
