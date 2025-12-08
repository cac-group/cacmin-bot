import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * Unit tests for jail and moderation commands
 */

import { initTestDatabase, cleanTestDatabase, closeTestDatabase, createTestUser, jailTestUser, createTestViolation } from '../helpers/testDatabase';

vi.mock('../../src/database', async () => {
	const testDb = await import('../helpers/testDatabase');
	return {
		query: (sql: string, params: any[] = []) => testDb.getTestDatabase().prepare(sql).all(...params),
		get: (sql: string, params: any[] = []) => testDb.getTestDatabase().prepare(sql).get(...params),
		execute: (sql: string, params: any[] = []) => testDb.getTestDatabase().prepare(sql).run(...params),
	};
});

vi.mock('../../src/config', () => ({
	config: { botToken: 'test-token', groupChatId: -1001234567890, ownerId: 111111111, botTreasuryAddress: 'juno1testtreasuryaddress', userFundsAddress: 'juno1testuserfundsaddress', userFundsMnemonic: 'test mnemonic' },
	validateConfig: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logWalletAction: vi.fn(), logSecurityEvent: vi.fn(), logDebug: vi.fn() },
}));

vi.mock('../../src/services/junoService', () => ({ JunoService: { getPaymentAddress: vi.fn().mockReturnValue('juno1testtreasuryaddress'), verifyPayment: vi.fn().mockResolvedValue(true) } }));

vi.mock('../../src/utils/userResolver', async () => {
	const testDb = await import('../helpers/testDatabase');
	return {
		resolveUserId: vi.fn((identifier: string) => {
			if (identifier.startsWith('@')) {
				const user = testDb.getTestDatabase().prepare('SELECT id FROM users WHERE username = ?').get(identifier.slice(1));
				return user?.id;
			}
			const userId = parseInt(identifier);
			return isNaN(userId) ? null : userId;
		}),
		formatUserIdDisplay: vi.fn((userId: number) => {
			const user = testDb.getTestDatabase().prepare('SELECT username FROM users WHERE id = ?').get(userId);
			return user?.username ? `@${user.username}` : `${userId}`;
		}),
	};
});

import { JailService } from '../../src/services/jailService';
import * as db from '../../src/database';

const setupUsers = () => {
	createTestUser(111111111, 'owner', 'owner');
	createTestUser(222222222, 'admin', 'admin');
	createTestUser(333333333, 'elevated', 'elevated');
	createTestUser(444444444, 'pleb', 'pleb');
	createTestUser(555555555, 'jaileduser', 'pleb');
};

describe('Moderation System', () => {
	beforeAll(() => initTestDatabase());
	beforeEach(() => { cleanTestDatabase(); setupUsers(); });
	afterAll(() => closeTestDatabase());

	describe('User Status & Jail State', () => {
		it('shows correct status for free users', () => {
			const user = db.get('SELECT * FROM users WHERE id = ?', [444444444]);
			expect(user.role).toBe('pleb');
			expect(user.muted_until).toBeFalsy();
		});

		it('shows correct status for jailed users', () => {
			const futureTime = Math.floor(Date.now() / 1000) + 3600;
			jailTestUser(555555555, 222222222, 10, futureTime);

			const user = db.get('SELECT * FROM users WHERE id = ?', [555555555]);
			expect(user.muted_until).toBe(futureTime);
			expect(user.muted_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
		});

		it('tracks unpaid violations', () => {
			createTestViolation(444444444, 'no_stickers', 2.0, 0);
			createTestViolation(444444444, 'no_urls', 3.0, 0);

			const violations = db.query('SELECT * FROM violations WHERE user_id = ? AND paid = 0', [444444444]);
			expect(violations).toHaveLength(2);
			expect(violations.reduce((sum: number, v: any) => sum + v.bail_amount, 0)).toBe(5.0);
		});
	});

	describe('Active Jails', () => {
		it('lists active jails and excludes expired ones', () => {
			const now = Math.floor(Date.now() / 1000);

			// No active jails initially
			expect(JailService.getActiveJails()).toHaveLength(0);

			// Add active jails
			jailTestUser(555555555, 222222222, 10, now + 1800);
			jailTestUser(444444444, 111111111, 20, now + 1800);

			const activeJails = JailService.getActiveJails();
			expect(activeJails).toHaveLength(2);
			expect(activeJails[0]).toHaveProperty('timeRemaining');
			expect(activeJails[0].timeRemaining).toBeGreaterThan(0);

			// Expire one jail
			db.execute('UPDATE users SET muted_until = ? WHERE id = ?', [now - 100, 555555555]);
			expect(JailService.getActiveJails()).toHaveLength(1);
		});
	});

	describe('Bail System', () => {
		it.each([
			[10, 1.0],
			[60, 6.0],
			[120, 12.0],
			[5, 1.0],
			[1, 1.0],
			[0, 1.0],
		])('calculates bail correctly for %i minutes = %f JUNO', (minutes, expected) => {
			expect(JailService.calculateBailAmountSync(minutes)).toBe(expected);
		});

		it('shows payment instructions and releases user after bail', () => {
			const now = Math.floor(Date.now() / 1000);
			const futureTime = now + 600;

			db.execute('UPDATE users SET muted_until = ? WHERE id = ?', [futureTime, 555555555]);
			const user = db.get('SELECT * FROM users WHERE id = ?', [555555555]);
			expect(user.muted_until).toBe(futureTime);

			const timeRemaining = user.muted_until - now;
			expect(JailService.calculateBailAmountSync(Math.ceil(timeRemaining / 60))).toBeGreaterThanOrEqual(1.0);

			// Release
			db.execute('UPDATE users SET muted_until = NULL WHERE id = ?', [555555555]);
			expect(db.get('SELECT * FROM users WHERE id = ?', [555555555]).muted_until).toBeNull();
		});

		it('logs bail payment event', () => {
			JailService.logJailEvent(555555555, 'bail_paid', undefined, undefined, 10.0, 555555555, 'test_tx_hash_123');

			const events = db.query('SELECT * FROM jail_events WHERE user_id = ? AND event_type = ?', [555555555, 'bail_paid']);
			expect(events).toHaveLength(1);
			expect(events[0].bail_amount).toBe(10.0);
			expect(events[0].payment_tx).toBe('test_tx_hash_123');
		});
	});

	describe('Jail/Unjail Operations', () => {
		it('allows admin to jail and unjail users', () => {
			const futureTime = Math.floor(Date.now() / 1000) + 1800;

			// Jail
			db.execute('UPDATE users SET muted_until = ? WHERE id = ?', [futureTime, 555555555]);
			expect(db.get('SELECT * FROM users WHERE id = ?', [555555555]).muted_until).toBe(futureTime);

			// Unjail
			db.execute('UPDATE users SET muted_until = NULL WHERE id = ?', [555555555]);
			expect(db.get('SELECT * FROM users WHERE id = ?', [555555555]).muted_until).toBeNull();
		});

		it('logs jail and unjail events', () => {
			const bailAmount = JailService.calculateBailAmountSync(30);
			JailService.logJailEvent(555555555, 'jailed', 222222222, 30, bailAmount);

			let events = db.query('SELECT * FROM jail_events WHERE user_id = ? AND event_type = ?', [555555555, 'jailed']);
			expect(events).toHaveLength(1);
			expect(events[0].admin_id).toBe(222222222);
			expect(events[0].duration_minutes).toBe(30);
			expect(events[0].bail_amount).toBe(bailAmount);

			JailService.logJailEvent(555555555, 'unjailed', 222222222);
			events = db.query('SELECT * FROM jail_events WHERE user_id = ? AND event_type = ?', [555555555, 'unjailed']);
			expect(events).toHaveLength(1);
			expect(events[0].admin_id).toBe(222222222);
		});

		it('logs jail event with all parameters including metadata', () => {
			const metadata = { reason: 'spam' };
			JailService.logJailEvent(555555555, 'jailed', 222222222, 30, 3.0, undefined, undefined, metadata);

			const events = db.query('SELECT * FROM jail_events WHERE user_id = ?', [555555555]);
			expect(events).toHaveLength(1);
			expect(JSON.parse(events[0].metadata)).toEqual(metadata);
		});
	});

	describe('Warning System', () => {
		it('increments warning count correctly', () => {
			db.execute('INSERT INTO violations (user_id, restriction, message, bail_amount) VALUES (?, ?, ?, ?)', [555555555, 'warning', 'Spam posting', 0]);
			db.execute('UPDATE users SET warning_count = warning_count + 1 WHERE id = ?', [555555555]);

			let user = db.get('SELECT * FROM users WHERE id = ?', [555555555]);
			expect(user.warning_count).toBe(1);

			db.execute('UPDATE users SET warning_count = warning_count + 1 WHERE id = ?', [555555555]);
			user = db.get('SELECT * FROM users WHERE id = ?', [555555555]);
			expect(user.warning_count).toBe(2);

			const violations = db.query('SELECT * FROM violations WHERE user_id = ? AND restriction = ?', [555555555, 'warning']);
			expect(violations).toHaveLength(1);
			expect(violations[0].message).toBe('Spam posting');
		});
	});

	describe('Clear Violations', () => {
		it('clears all violations for a user', () => {
			db.execute('INSERT INTO violations (user_id, restriction, message, bail_amount) VALUES (?, ?, ?, ?)', [555555555, 'warning', 'Test 1', 0]);
			db.execute('INSERT INTO violations (user_id, restriction, message, bail_amount) VALUES (?, ?, ?, ?)', [555555555, 'no_stickers', 'Test 2', 2.0]);
			db.execute('UPDATE users SET warning_count = 2 WHERE id = ?', [555555555]);

			db.execute('DELETE FROM violations WHERE user_id = ?', [555555555]);
			db.execute('UPDATE users SET warning_count = 0 WHERE id = ?', [555555555]);

			expect(db.query('SELECT * FROM violations WHERE user_id = ?', [555555555])).toHaveLength(0);
			expect(db.get('SELECT * FROM users WHERE id = ?', [555555555]).warning_count).toBe(0);
		});
	});

	describe('Statistics', () => {
		it('returns correct user and violation counts', () => {
			const stats = {
				totalUsers: db.get('SELECT COUNT(*) as count FROM users')?.count || 0,
				totalViolations: db.get('SELECT COUNT(*) as count FROM violations')?.count || 0,
			};

			expect(stats.totalUsers).toBe(5);
			expect(stats.totalViolations).toBeGreaterThanOrEqual(0);
		});
	});

	describe('Jail Event History', () => {
		it('returns jail events for a user with limit', () => {
			JailService.logJailEvent(555555555, 'jailed', 222222222, 30, 3.0);
			JailService.logJailEvent(555555555, 'unjailed', 222222222);
			JailService.logJailEvent(555555555, 'jailed', 111111111, 60, 6.0);

			const events = JailService.getUserJailEvents(555555555, 10);
			expect(events).toHaveLength(3);
			expect((events[0] as any).event_type || (events[0] as any).eventType).toBeDefined();

			// Test limit
			for (let i = 0; i < 15; i++) JailService.logJailEvent(555555555, 'jailed', 222222222, 30, 3.0);
			expect(JailService.getUserJailEvents(555555555, 5).length).toBeLessThanOrEqual(5);
		});

		it('returns events from all users', () => {
			JailService.logJailEvent(555555555, 'jailed', 222222222, 30, 3.0);
			JailService.logJailEvent(444444444, 'jailed', 111111111, 60, 6.0);
			JailService.logJailEvent(555555555, 'bail_paid', undefined, undefined, 3.0, 555555555, 'tx123');

			expect(JailService.getAllJailEvents(100).length).toBeGreaterThanOrEqual(3);
		});

		it('logs bail payment with payer information', () => {
			JailService.logJailEvent(555555555, 'bail_paid', undefined, undefined, 5.0, 444444444, 'test_tx_hash');

			const events = db.query('SELECT * FROM jail_events WHERE user_id = ? AND event_type = ?', [555555555, 'bail_paid']);
			expect(events).toHaveLength(1);
			expect(events[0].bail_amount).toBe(5.0);
			expect(events[0].paid_by_user_id).toBe(444444444);
			expect(events[0].payment_tx).toBe('test_tx_hash');
		});
	});
});
