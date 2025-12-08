import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, Mock } from 'vitest';
/**
 * Comprehensive Unit Tests for Middleware and Utilities
 * Tests middleware functions, message filtering, lock checking, and utility functions
 */

import { Context } from 'telegraf';
import { Telegraf } from 'telegraf';
import {
	userManagementMiddleware,
	ownerOnly,
	adminOrHigher,
	elevatedOrHigher,
	elevatedAdminOnly,
} from '../../src/middleware/index';
import { messageFilterMiddleware } from '../../src/middleware/messageFilter';
import {
	lockCheckMiddleware,
	financialLockCheck,
} from '../../src/middleware/lockCheck';
import {
	isGroupOwner,
	hasRole,
	checkIsElevated,
} from '../../src/utils/roles';
import { logger, logStream } from '../../src/utils/logger';
import { setBotInstance, notifyAdmin } from '../../src/utils/adminNotify';
import {
	createMockContext,
	createOwnerContext,
	createAdminContext,
	createElevatedContext,
	createPlebContext,
	wasTextReplied,
} from '../helpers/mockContext';
import {
	initTestDatabase,
	cleanTestDatabase,
	closeTestDatabase,
	getTestDatabase,
	createTestUsers,
} from '../helpers/testDatabase';
import * as userService from '../../src/services/userService';
import * as restrictionService from '../../src/services/restrictionService';
import { TransactionLockService } from '../../src/services/transactionLock';
import { config } from '../../src/config';

// Mock database module
vi.mock('../../src/database', async () => {
	const testDb = await import('../helpers/testDatabase');
	return {
		query: vi.fn((sql: string, params: any[]) => {
			const db = testDb.getTestDatabase();
			return db.prepare(sql).all(...params);
		}),
		execute: vi.fn((sql: string, params?: any[]) => {
			const db = testDb.getTestDatabase();
			if (params) {
				return db.prepare(sql).run(...params);
			}
			return db.exec(sql);
		}),
		get: vi.fn((sql: string, params?: any[]) => {
			const db = testDb.getTestDatabase();
			if (params) {
				return db.prepare(sql).get(...params);
			}
			return db.prepare(sql).get();
		}),
	};
});

vi.mock('../../src/services/userService');
vi.mock('../../src/services/restrictionService');
vi.mock('../../src/services/ledgerService', () => ({
	LedgerService: {
		ensureUserBalance: vi.fn().mockResolvedValue(undefined),
	},
}));

describe('Middleware and Utilities', () => {
	beforeAll(() => {
		initTestDatabase();
	});

	beforeEach(() => {
		cleanTestDatabase();
		createTestUsers();
		vi.clearAllMocks();
	});

	afterAll(() => {
		closeTestDatabase();
	});

	describe('userManagementMiddleware', () => {
		it('should ensure user exists and load restrictions', async () => {
			const ctx = createMockContext({ userId: 999999999, username: 'newuser' });
			const next = vi.fn();
			const mockRestrictions = [{ id: 1, userId: 999999999, restriction: 'no_stickers', createdAt: Date.now() }];

			(userService.ensureUserExists as Mock).mockReturnValue(undefined);
			(userService.getUserRestrictions as Mock).mockReturnValue(mockRestrictions);

			await userManagementMiddleware(ctx as Context, next);

			expect(userService.ensureUserExists).toHaveBeenCalledWith(999999999, 'newuser');
			expect(ctx.state?.restrictions).toEqual(mockRestrictions);
			expect(next).toHaveBeenCalled();
		});

		it('should skip if no user information and handle errors gracefully', async () => {
			const ctx = createMockContext();
			(ctx as any).from = undefined;
			const next = vi.fn();

			await userManagementMiddleware(ctx as Context, next);
			expect(userService.ensureUserExists).not.toHaveBeenCalled();
			expect(next).toHaveBeenCalled();

			// Test error handling
			const ctx2 = createMockContext({ userId: 123456, username: 'erroruser' });
			(userService.ensureUserExists as Mock).mockImplementation(() => { throw new Error('DB error'); });
			await userManagementMiddleware(ctx2 as Context, next);
			expect(ctx2.reply).toHaveBeenCalledWith('Error processing request');
		});
	});

	describe('Permission Middleware', () => {
		// Test all role levels through each middleware
		const roleTests = [
			{ middleware: ownerOnly, name: 'ownerOnly', allowed: ['owner'], denied: ['admin', 'elevated', 'pleb'] },
			{ middleware: adminOrHigher, name: 'adminOrHigher', allowed: ['owner', 'admin'], denied: ['elevated', 'pleb'] },
			{ middleware: elevatedOrHigher, name: 'elevatedOrHigher', allowed: ['owner', 'admin', 'elevated'], denied: ['pleb'] },
		];

		const contextFactories: Record<string, () => ReturnType<typeof createMockContext>> = {
			owner: createOwnerContext,
			admin: createAdminContext,
			elevated: createElevatedContext,
			pleb: createPlebContext,
		};

		roleTests.forEach(({ middleware, name, allowed, denied }) => {
			it.each(allowed)(`${name} allows %s`, async (role) => {
				const ctx = contextFactories[role]();
				const next = vi.fn();
				await middleware(ctx as Context, next);
				expect(next).toHaveBeenCalled();
				expect(ctx.reply).not.toHaveBeenCalled();
			});

			it.each(denied)(`${name} denies %s`, async (role) => {
				const ctx = contextFactories[role]();
				const next = vi.fn();
				await middleware(ctx as Context, next);
				expect(next).not.toHaveBeenCalled();
				expect(ctx.reply).toHaveBeenCalled();
			});
		});

		it('handles missing user ID', async () => {
			const ctx = createMockContext();
			(ctx as any).from = undefined;
			const next = vi.fn();

			await ownerOnly(ctx as Context, next);
			expect(next).not.toHaveBeenCalled();
			expect(wasTextReplied(ctx, 'User ID not found')).toBe(true);
		});

		it('elevatedAdminOnly is alias for elevatedOrHigher', () => {
			expect(elevatedAdminOnly).toBe(elevatedOrHigher);
		});
	});

	describe('messageFilterMiddleware', () => {
		beforeEach(() => {
			(userService.ensureUserExists as Mock).mockResolvedValue(undefined);
		});

		it('skips filtering for privileged users and private chats', async () => {
			const next = vi.fn();

			// Test owner skip
			const ownerCtx = createOwnerContext({ chatType: 'supergroup' });
			await messageFilterMiddleware(ownerCtx as Context, next);
			expect(restrictionService.RestrictionService.checkMessage).not.toHaveBeenCalled();

			// Test private chat skip
			const privateCtx = createPlebContext({ chatType: 'private' });
			await messageFilterMiddleware(privateCtx as Context, next);
			expect(restrictionService.RestrictionService.checkMessage).not.toHaveBeenCalled();
		});

		it('deletes messages from jailed users in group chats', async () => {
			const ctx = createPlebContext({ chatType: 'supergroup' });
			const next = vi.fn();

			const db = getTestDatabase();
			const futureTime = Math.floor(Date.now() / 1000) + 3600;
			db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 444444444);

			await messageFilterMiddleware(ctx as Context, next);

			expect(ctx.deleteMessage).toHaveBeenCalled();
			expect(next).not.toHaveBeenCalled();
		});

		it('allows messages when jail expired and checks restrictions', async () => {
			const ctx = createPlebContext({ chatType: 'supergroup' });
			const next = vi.fn();

			const db = getTestDatabase();
			db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(
				Math.floor(Date.now() / 1000) - 3600, 444444444
			);
			(restrictionService.RestrictionService.checkMessage as Mock).mockResolvedValue(false);

			await messageFilterMiddleware(ctx as Context, next);

			expect(ctx.deleteMessage).not.toHaveBeenCalled();
			expect(restrictionService.RestrictionService.checkMessage).toHaveBeenCalled();
			expect(next).toHaveBeenCalled();
		});

		it('blocks messages that violate restrictions', async () => {
			const ctx = createPlebContext({ chatType: 'supergroup' });
			const next = vi.fn();
			(restrictionService.RestrictionService.checkMessage as Mock).mockResolvedValue(true);

			await messageFilterMiddleware(ctx as Context, next);
			expect(next).not.toHaveBeenCalled();
		});
	});

	describe('Lock Check Middleware', () => {
		beforeEach(() => {
			TransactionLockService.initialize();
		});

		it('allows commands when not locked, blocks when locked', async () => {
			const ctx = createPlebContext();
			const next = vi.fn();

			vi.spyOn(TransactionLockService, 'getActiveLock').mockResolvedValue(null);
			await lockCheckMiddleware(ctx as Context, next);
			expect(next).toHaveBeenCalled();

			vi.clearAllMocks();
			const now = Math.floor(Date.now() / 1000);
			vi.spyOn(TransactionLockService, 'getActiveLock').mockResolvedValue({
				userId: 444444444, lockType: 'withdrawal', amount: 100, lockedAt: now, status: 'pending',
			});
			await lockCheckMiddleware(ctx as Context, next);
			expect(next).not.toHaveBeenCalled();
			expect(wasTextReplied(ctx, 'Transaction in Progress')).toBe(true);
		});

		it('checks locks only for financial commands', async () => {
			const financialCmds = ['/withdraw', '/send', '/transfer', '/pay', '/bail', '/paybail'];
			const nonFinancialCmd = '/balance';

			for (const cmd of financialCmds) {
				const ctx = createPlebContext({ messageText: `${cmd} 100` });
				vi.spyOn(TransactionLockService, 'hasLock').mockResolvedValue(false);
				await financialLockCheck(ctx as Context, vi.fn());
				expect(TransactionLockService.hasLock).toHaveBeenCalled();
				vi.clearAllMocks();
			}

			const nonFinCtx = createPlebContext({ messageText: nonFinancialCmd });
			vi.spyOn(TransactionLockService, 'hasLock').mockResolvedValue(true);
			await financialLockCheck(nonFinCtx as Context, vi.fn());
			expect(TransactionLockService.hasLock).not.toHaveBeenCalled();
		});
	});

	describe('Role Utility Functions', () => {
		it('isGroupOwner correctly identifies owner', () => {
			expect(isGroupOwner(123456, 123456)).toBe(true);
			expect(isGroupOwner(123456, 654321)).toBe(false);
		});

		it.each([
			[111111111, 'owner', true],
			[222222222, 'admin', true],
			[333333333, 'elevated', true],
			[444444444, 'pleb' as any, true],
			[111111111, 'admin', false],
			[999999999, 'owner', false],
		])('hasRole(%i, %s) returns %s', (userId, role, expected) => {
			expect(hasRole(userId, role)).toBe(expected);
		});

		it.each([
			[111111111, true], // owner
			[222222222, true], // admin
			[333333333, true], // elevated
			[444444444, false], // pleb
			[999999999, false], // non-existent
		])('checkIsElevated(%i) returns %s', (userId, expected) => {
			expect(checkIsElevated(userId)).toBe(expected);
		});
	});

	describe('Logger', () => {
		it('exports logger with proper methods', () => {
			expect(logger).toBeDefined();
			expect(typeof logger.info).toBe('function');
			expect(typeof logger.error).toBe('function');
			expect(() => logger.info('test', { key: 'value' })).not.toThrow();
			expect(typeof logStream.write).toBe('function');
		});
	});

	describe('Admin Notify', () => {
		it('sends notifications and handles errors gracefully', async () => {
			const mockBot = { telegram: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } } as any;
			setBotInstance(mockBot);

			await notifyAdmin('Test notification');
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
				config.adminChatId,
				expect.stringContaining('Admin Alert'),
				{ parse_mode: 'MarkdownV2' }
			);

			// Test error handling
			setBotInstance(null as any);
			await expect(notifyAdmin('Test')).resolves.not.toThrow();
		});
	});

	describe('Middleware Integration', () => {
		it('calls middleware in sequence and stops when next not called', async () => {
			const ctx = createOwnerContext();
			const callOrder: string[] = [];

			const mw1 = async (_: Context, next: () => Promise<void>) => { callOrder.push('mw1-pre'); await next(); callOrder.push('mw1-post'); };
			const mw2 = async (_: Context, next: () => Promise<void>) => { callOrder.push('mw2'); };
			const mw3 = async (_: Context, next: () => Promise<void>) => { callOrder.push('mw3'); };

			await mw1(ctx as Context, async () => { await mw2(ctx as Context, async () => { await mw3(ctx as Context, async () => {}); }); });

			expect(callOrder).toEqual(['mw1-pre', 'mw2', 'mw1-post']);
		});

		it('preserves state across middleware', async () => {
			const ctx = createMockContext();
			const next = vi.fn();

			(userService.ensureUserExists as Mock).mockReturnValue(undefined);
			(userService.getUserRestrictions as Mock).mockReturnValue([{ id: 1, restriction: 'no_urls' }]);

			await userManagementMiddleware(ctx as Context, next);

			expect(ctx.state?.restrictions).toBeDefined();
			expect(ctx.state?.restrictions[0].restriction).toBe('no_urls');
		});
	});
});
