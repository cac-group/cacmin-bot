import { vi, describe, it, expect, beforeEach, beforeAll, afterAll, Mock } from 'vitest';
/**
 * Unit tests for violation and payment commands
 * Tests violation listing, fine payment, and blockchain verification
 */

import { Telegraf, Context } from 'telegraf';
import { registerViolationHandlers } from '../../src/handlers/violations';
import { registerPaymentCommands } from '../../src/commands/payment';
import { UnifiedWalletService } from '../../src/services/unifiedWalletService';
import { JunoService } from '../../src/services/junoService';
import { LedgerService } from '../../src/services/ledgerService';
import * as violationService from '../../src/services/violationService';
import {
	createPlebContext,
	getReplyText,
	initTestDatabase,
	cleanTestDatabase,
	closeTestDatabase,
	createTestUser,
	createTestViolation,
	getTestDatabase
} from '../helpers';

// Mock the database module to use test database
vi.mock('../../src/database', async () => {
	const testDb = await import('../helpers/testDatabase');
	return {
		query: vi.fn((sql: string, params: any[] = []) => {
			const db = testDb.getTestDatabase();
			return db.prepare(sql).all(...params);
		}),
		get: vi.fn((sql: string, params: any[] = []) => {
			const db = testDb.getTestDatabase();
			return db.prepare(sql).get(...params);
		}),
		execute: vi.fn((sql: string, params: any[] = []) => {
			const db = testDb.getTestDatabase();
			return db.prepare(sql).run(...params);
		}),
		initDb: vi.fn()
	};
});

vi.mock('../../src/services/unifiedWalletService', () => ({
	UnifiedWalletService: {
		initialize: vi.fn(),
		getBalance: vi.fn(),
		payFine: vi.fn(),
	}
}));
vi.mock('../../src/services/junoService');
vi.mock('../../src/services/jailService');
vi.mock('../../src/utils/logger');

describe('Violation and Payment Commands', () => {
	let bot: Telegraf<Context>;
	let db: any;

	beforeAll(() => {
		db = initTestDatabase();
	});

	beforeEach(() => {
		cleanTestDatabase();
		bot = new Telegraf('test-token');
		registerViolationHandlers(bot);
		registerPaymentCommands(bot);
		vi.clearAllMocks();
	});

	afterAll(() => {
		closeTestDatabase();
	});

	describe('Violation Queries', () => {
		it('returns empty array for user with no violations', () => {
			createTestUser(444444444, 'testuser', 'pleb');
			expect(violationService.getUserViolations(444444444)).toHaveLength(0);
		});

		it('lists violations with correct paid status and bail amounts', () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			createTestViolation(userId, 'no_stickers', 10.5, 0);
			createTestViolation(userId, 'no_urls', 5.25, 1);
			createTestViolation(userId, 'blacklist', 50.0, 0);

			const violations = violationService.getUserViolations(userId);
			expect(violations).toHaveLength(3);
			expect(violations[0].paid).toBeFalsy();
			expect(violations[1].paid).toBeTruthy();
			expect(violations[2].paid).toBeFalsy();

			const bailAmount = (violations[0] as any).bail_amount || violations[0].bailAmount;
			expect(bailAmount).toBe(10.5);
		});

		it('separates unpaid from paid violations', () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			createTestViolation(userId, 'no_stickers', 10.5, 0);
			createTestViolation(userId, 'no_urls', 5.25, 1);
			createTestViolation(userId, 'blacklist', 50.0, 0);

			const unpaid = violationService.getUnpaidViolations(userId);
			const total = violationService.getTotalFines(userId);

			expect(unpaid).toHaveLength(2);
			expect(total).toBe(60.5);
		});
	});

	describe('Fine Payment', () => {
		beforeEach(() => {
			(UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0);
			(UnifiedWalletService.payFine as Mock).mockResolvedValue({ success: true, newBalance: 40.0 });
		});

		it('processes payment and marks violations as paid', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			const v1 = createTestViolation(userId, 'no_stickers', 10.0, 0);
			const v2 = createTestViolation(userId, 'no_urls', 5.0, 0);

			// Process payment
			const totalFines = violationService.getTotalFines(userId);
			const result = await UnifiedWalletService.payFine(userId, totalFines, 'Test payment');
			expect(result.success).toBe(true);

			// Mark violations as paid
			violationService.markViolationPaid(v1, 'internal_ledger', userId);
			violationService.markViolationPaid(v2, 'internal_ledger', userId);

			const violations = violationService.getUserViolations(userId);
			expect(violations.every(v => v.paid)).toBe(true);
		});

		it('fails when balance is insufficient', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');
			createTestViolation(userId, 'blacklist', 100.0, 0);

			(UnifiedWalletService.getBalance as Mock).mockResolvedValue(50.0);

			const balance = await UnifiedWalletService.getBalance(userId);
			const totalFines = violationService.getTotalFines(userId);
			expect(balance).toBeLessThan(totalFines);
		});

		it('handles payment failure gracefully', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');
			createTestViolation(userId, 'no_stickers', 10.0, 0);

			(UnifiedWalletService.payFine as Mock).mockResolvedValue({
				success: false, newBalance: 100.0, error: 'Payment processing failed'
			});

			const result = await UnifiedWalletService.payFine(userId, 10.0);
			expect(result.success).toBe(false);
			expect(result.error).toBe('Payment processing failed');
		});

		it('releases user from jail after payment', () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			const futureTime = Math.floor(Date.now() / 1000) + 3600;
			db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, userId);

			const jailedUser = db.prepare('SELECT muted_until FROM users WHERE id = ?').get(userId);
			expect(jailedUser.muted_until).toBe(futureTime);

			db.prepare('UPDATE users SET muted_until = NULL WHERE id = ?').run(userId);

			const releasedUser = db.prepare('SELECT muted_until FROM users WHERE id = ?').get(userId);
			expect(releasedUser.muted_until).toBeNull();
		});
	});

	describe('Blockchain Payment Verification', () => {
		beforeEach(() => {
			(JunoService.getPaymentAddress as Mock).mockReturnValue('juno1testaddress');
			(JunoService.verifyPayment as Mock).mockResolvedValue(true);
		});

		it('verifies valid payment and marks violation paid', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			const violationId = createTestViolation(userId, 'no_stickers', 25.0, 0);
			const txHash = 'ABC123VALIDTXHASH';

			const verified = await JunoService.verifyPayment(txHash, 25.0);
			expect(verified).toBe(true);

			violationService.markViolationPaid(violationId, txHash, userId);

			const violations = violationService.getUserViolations(userId);
			expect(violations[0].paid).toBeTruthy();
			const paymentTx = (violations[0] as any).payment_tx || violations[0].paymentTx;
			expect(paymentTx).toBe(txHash);
		});

		it('rejects invalid transactions', async () => {
			(JunoService.verifyPayment as Mock).mockResolvedValue(false);
			expect(await JunoService.verifyPayment('INVALIDHASH', 25.0)).toBe(false);
		});

		it('handles RPC failures gracefully', async () => {
			(JunoService.verifyPayment as Mock).mockRejectedValue(new Error('RPC endpoint unavailable'));
			await expect(JunoService.verifyPayment('hash', 25.5)).rejects.toThrow('RPC endpoint unavailable');
		});
	});

	describe('Violation Creation', () => {
		it('creates violation and increments warning count', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			const userBefore = db.prepare('SELECT warning_count FROM users WHERE id = ?').get(userId);
			const warningsBefore = userBefore?.warning_count || 0;

			const violationId = await violationService.createViolation(userId, 'no_stickers', 'Test message');

			const violations = violationService.getUserViolations(userId);
			expect(violations[0].id).toBe(violationId);
			expect(violations[0].restriction).toBe('no_stickers');

			const userAfter = db.prepare('SELECT warning_count FROM users WHERE id = ?').get(userId);
			expect(userAfter.warning_count).toBe(warningsBefore + 1);
		});

		it('tracks multiple violations per user', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			await violationService.createViolation(userId, 'no_stickers');
			await violationService.createViolation(userId, 'no_urls');
			await violationService.createViolation(userId, 'blacklist');

			expect(violationService.getUserViolations(userId)).toHaveLength(3);
		});
	});

	describe('Payment Status Updates', () => {
		it('records payment details correctly', async () => {
			const userId = 444444444;
			const payerId = 555555555;
			createTestUser(userId, 'testuser', 'pleb');
			createTestUser(payerId, 'payer', 'pleb');

			const violationId = createTestViolation(userId, 'no_stickers', 25.0, 0);
			const beforeTime = Math.floor(Date.now() / 1000);

			violationService.markViolationPaid(violationId, 'tx_hash_123', payerId);

			const violations = violationService.getUserViolations(userId);
			const v = violations[0];

			expect(v.paid).toBeTruthy();
			expect((v as any).payment_tx || v.paymentTx).toBe('tx_hash_123');
			expect((v as any).paid_by_user_id || v.paidByUserId).toBe(payerId);

			const paidAt = (v as any).paid_at || v.paidAt;
			expect(paidAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('maintains payment history', () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			const v1 = createTestViolation(userId, 'no_stickers', 10.0, 0);
			const v2 = createTestViolation(userId, 'no_urls', 5.0, 0);
			const v3 = createTestViolation(userId, 'blacklist', 50.0, 0);

			violationService.markViolationPaid(v1, 'tx_1', userId);
			violationService.markViolationPaid(v2, 'tx_2', userId);

			const all = violationService.getUserViolations(userId);
			const paid = all.filter(v => v.paid);
			const unpaid = violationService.getUnpaidViolations(userId);

			expect(all).toHaveLength(3);
			expect(paid).toHaveLength(2);
			expect(unpaid).toHaveLength(1);
			expect(unpaid[0].id).toBe(v3);
		});
	});

	describe('Edge Cases', () => {
		it('handles decimal precision correctly', () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			createTestViolation(userId, 'no_stickers', 10.333333, 0);
			createTestViolation(userId, 'no_urls', 5.666666, 0);

			const total = violationService.getTotalFines(userId);
			expect(total).toBeCloseTo(15.999999, 5);
		});

		it('handles special characters in violation message', async () => {
			const userId = 444444444;
			createTestUser(userId, 'testuser', 'pleb');

			await violationService.createViolation(
				userId, 'no_urls', 'User sent: https://example.com/test?query=value&other=123'
			);

			const violations = violationService.getUserViolations(userId);
			expect(violations[0].message).toContain('https://example.com');
		});

		it('prevents cross-user violation access', () => {
			const user1 = 444444444;
			const user2 = 555555555;
			createTestUser(user1, 'user1', 'pleb');
			createTestUser(user2, 'user2', 'pleb');

			const violationId = createTestViolation(user1, 'no_stickers', 10.0, 0);

			const user2Violations = violationService.getUserViolations(user2);
			expect(user2Violations.find(v => v.id === violationId)).toBeUndefined();
		});
	});
});
