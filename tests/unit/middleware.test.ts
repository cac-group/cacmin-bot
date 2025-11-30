import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, Mock } from 'vitest';
/**
 * Comprehensive Unit Tests for Middleware and Utilities
 *
 * Tests cover:
 * - src/middleware/index.ts - All middleware functions
 * - src/middleware/messageFilter.ts - Message filtering middleware
 * - src/middleware/lockCheck.ts - Financial lock checking
 * - src/utils/roles.ts - Role utility functions
 * - src/utils/logger.ts - Logger functionality
 * - src/utils/adminNotify.ts - Admin notification system
 */

import { Context } from 'telegraf';
import { Telegraf } from 'telegraf';
import {
  userManagementMiddleware,
  ownerOnly,
  adminOrHigher,
  elevatedOrHigher,
  isElevated,
  elevatedUserOnly,
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
  getReplyText,
  wasTextReplied,
} from '../helpers/mockContext';
import {
  initTestDatabase,
  cleanTestDatabase,
  closeTestDatabase,
  getTestDatabase,
  createTestUser,
  createTestUsers,
  createTestRestriction,
  addTestBalance,
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

// Mock services
vi.mock('../../src/services/userService');
vi.mock('../../src/services/restrictionService');
vi.mock('../../src/services/ledgerService', () => ({
  LedgerService: {
    ensureUserBalance: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Middleware and Utilities Test Suite', () => {
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

  describe('src/middleware/index.ts - User Management Middleware', () => {
    describe('userManagementMiddleware', () => {
      it('should ensure user exists and load restrictions', async () => {
        const ctx = createMockContext({ userId: 999999999, username: 'newuser' });
        const next = vi.fn();
        const mockRestrictions = [
          { id: 1, userId: 999999999, restriction: 'no_stickers', createdAt: Date.now() },
        ];

        (userService.ensureUserExists as Mock).mockReturnValue(undefined);
        (userService.getUserRestrictions as Mock).mockReturnValue(mockRestrictions);

        await userManagementMiddleware(ctx as Context, next);

        expect(userService.ensureUserExists).toHaveBeenCalledWith(999999999, 'newuser');
        expect(userService.getUserRestrictions).toHaveBeenCalledWith(999999999);
        expect(ctx.state?.restrictions).toEqual(mockRestrictions);
        expect(next).toHaveBeenCalled();
      });

      it('should skip if no user information is available', async () => {
        const ctx = createMockContext();
        const ctxMutable = ctx as any;
        ctxMutable.from = undefined;
        const next = vi.fn();

        await userManagementMiddleware(ctx as Context, next);

        expect(userService.ensureUserExists).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
      });

      it('should handle errors gracefully and reply to user', async () => {
        const ctx = createMockContext({ userId: 123456, username: 'erroruser' });
        const next = vi.fn();

        (userService.ensureUserExists as Mock).mockImplementation(() => {
          throw new Error('Database error');
        });

        await userManagementMiddleware(ctx as Context, next);

        expect(ctx.reply).toHaveBeenCalledWith(
          'Error processing request'
        );
        expect(next).toHaveBeenCalled();
      });

      it('should handle users without username', async () => {
        const ctx = createMockContext({ userId: 888888888 });
        ctx.from!.username = undefined;
        const next = vi.fn();

        (userService.ensureUserExists as Mock).mockReturnValue(undefined);
        (userService.getUserRestrictions as Mock).mockReturnValue([]);

        await userManagementMiddleware(ctx as Context, next);

        expect(userService.ensureUserExists).toHaveBeenCalledWith(888888888, 'unknown');
        expect(next).toHaveBeenCalled();
      });
    });

    describe('ownerOnly middleware', () => {
      it('should allow owner to proceed', async () => {
        const ctx = createOwnerContext();
        const next = vi.fn();

        await ownerOnly(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should deny non-owner access', async () => {
        const ctx = createAdminContext();
        const next = vi.fn();

        await ownerOnly(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'Only owners can use this command')).toBe(true);
      });

      it('should deny pleb access', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        await ownerOnly(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'Only owners can use this command')).toBe(true);
      });

      it('should handle missing user ID', async () => {
        const ctx = createMockContext();
        const ctxMutable = ctx as any;
        ctxMutable.from = undefined;
        const next = vi.fn();

        await ownerOnly(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'User ID not found')).toBe(true);
      });
    });

    describe('adminOrHigher middleware', () => {
      it('should allow owner to proceed', async () => {
        const ctx = createOwnerContext();
        const next = vi.fn();

        await adminOrHigher(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should allow admin to proceed', async () => {
        const ctx = createAdminContext();
        const next = vi.fn();

        await adminOrHigher(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should deny elevated user access', async () => {
        const ctx = createElevatedContext();
        const next = vi.fn();

        await adminOrHigher(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'You do not have permission to use this command')).toBe(true);
      });

      it('should deny pleb access', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        await adminOrHigher(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'You do not have permission')).toBe(true);
      });
    });

    describe('elevatedOrHigher middleware', () => {
      it('should allow owner to proceed', async () => {
        const ctx = createOwnerContext();
        const next = vi.fn();

        await elevatedOrHigher(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should allow admin to proceed', async () => {
        const ctx = createAdminContext();
        const next = vi.fn();

        await elevatedOrHigher(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should allow elevated user to proceed', async () => {
        const ctx = createElevatedContext();
        const next = vi.fn();

        await elevatedOrHigher(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should deny pleb access', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        await elevatedOrHigher(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'You do not have permission')).toBe(true);
      });
    });

    describe('Legacy middleware aliases', () => {
      it.skip('isElevated should be alias for elevatedOrHigher', () => {
        // Alias removed from implementation
        expect(isElevated).toBe(elevatedOrHigher);
      });

      it.skip('elevatedUserOnly should be alias for elevatedOrHigher', () => {
        // Alias removed from implementation
        expect(elevatedUserOnly).toBe(elevatedOrHigher);
      });

      it('elevatedAdminOnly should be alias for elevatedOrHigher', () => {
        expect(elevatedAdminOnly).toBe(elevatedOrHigher);
      });
    });
  });

  describe('src/middleware/messageFilter.ts - Message Filter Middleware', () => {
    beforeEach(() => {
      (userService.ensureUserExists as Mock).mockResolvedValue(undefined);
    });

    describe('messageFilterMiddleware', () => {
      it('should skip if no message', async () => {
        const ctx = createMockContext();
        const ctxMutable = ctx as any;
        ctxMutable.message = undefined;
        const next = vi.fn();

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(userService.ensureUserExists).not.toHaveBeenCalled();
      });

      it('should skip if no user (from)', async () => {
        const ctx = createMockContext();
        const ctxMutable = ctx as any;
        ctxMutable.from = undefined;
        const next = vi.fn();

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(userService.ensureUserExists).not.toHaveBeenCalled();
      });

      it('should skip filtering for whitelisted users', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();

        // Update existing user to be whitelisted
        const db = getTestDatabase();
        db.prepare('UPDATE users SET whitelist = 1 WHERE id = ?').run(444444444);

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(restrictionService.RestrictionService.checkMessage).not.toHaveBeenCalled();
      });

      it('should skip filtering for owners', async () => {
        const ctx = createOwnerContext({ chatType: 'supergroup' });
        const next = vi.fn();

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(restrictionService.RestrictionService.checkMessage).not.toHaveBeenCalled();
      });

      it('should skip filtering for admins', async () => {
        const ctx = createAdminContext({ chatType: 'supergroup' });
        const next = vi.fn();

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(restrictionService.RestrictionService.checkMessage).not.toHaveBeenCalled();
      });

      it('should delete messages from jailed users in group chats', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();

        // Jail the user
        const db = getTestDatabase();
        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 444444444);

        await messageFilterMiddleware(ctx as Context, next);

        expect(ctx.deleteMessage).toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
      });

      it('should not delete messages from jailed users in private chats', async () => {
        const ctx = createPlebContext({ chatType: 'private' });
        const next = vi.fn();

        // Jail the user
        const db = getTestDatabase();
        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 444444444);

        await messageFilterMiddleware(ctx as Context, next);

        expect(ctx.deleteMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
      });

      it('should allow messages from users whose jail time expired', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();

        // Set expired jail time
        const db = getTestDatabase();
        const pastTime = Math.floor(Date.now() / 1000) - 3600;
        db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(pastTime, 444444444);

        (restrictionService.RestrictionService.checkMessage as Mock).mockResolvedValue(false);

        await messageFilterMiddleware(ctx as Context, next);

        expect(ctx.deleteMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
      });

      it('should check restrictions in group chats', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();

        (restrictionService.RestrictionService.checkMessage as Mock).mockResolvedValue(false);

        await messageFilterMiddleware(ctx as Context, next);

        expect(restrictionService.RestrictionService.checkMessage).toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
      });

      it('should not proceed if message violates restrictions', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();

        (restrictionService.RestrictionService.checkMessage as Mock).mockResolvedValue(true);

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
      });

      it('should skip restriction checks in private chats', async () => {
        const ctx = createPlebContext({ chatType: 'private' });
        const next = vi.fn();

        await messageFilterMiddleware(ctx as Context, next);

        expect(restrictionService.RestrictionService.checkMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
      });

      it('should continue on error to avoid blocking', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();

        (userService.ensureUserExists as Mock).mockImplementation(() => {
          throw new Error('DB error');
        });

        await messageFilterMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
      });

      it('should handle failed message deletion gracefully', async () => {
        const ctx = createPlebContext({ chatType: 'supergroup' });
        const next = vi.fn();
        (ctx.deleteMessage as Mock).mockRejectedValue(new Error('No permission'));

        // Jail the user
        const db = getTestDatabase();
        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 444444444);

        await messageFilterMiddleware(ctx as Context, next);

        expect(ctx.deleteMessage).toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
      });
    });
  });

  describe('src/middleware/lockCheck.ts - Lock Check Middleware', () => {
    beforeEach(() => {
      // Initialize lock service
      TransactionLockService.initialize();
    });

    describe('lockCheckMiddleware', () => {
      it('should allow command if user is not locked', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        vi.spyOn(TransactionLockService, 'getActiveLock').mockResolvedValue(null);

        await lockCheckMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should block command if user is locked', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        const now = Math.floor(Date.now() / 1000);
        vi.spyOn(TransactionLockService, 'getActiveLock').mockResolvedValue({
          userId: 444444444,
          lockType: 'withdrawal',
          amount: 100,
          lockedAt: now,
          status: 'pending',
        });

        await lockCheckMiddleware(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'Transaction in Progress')).toBe(true);
        expect(wasTextReplied(ctx, 'withdrawal')).toBe(true);
      });

      it('should show remaining seconds in lock message', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        const now = Math.floor(Date.now() / 1000);
        vi.spyOn(TransactionLockService, 'getActiveLock').mockResolvedValue({
          userId: 444444444,
          lockType: 'withdrawal',
          amount: 100,
          lockedAt: now - 75, // 75 seconds ago, so 120-75=45 seconds remaining
          status: 'pending',
        });

        await lockCheckMiddleware(ctx as Context, next);

        expect(wasTextReplied(ctx, '45 seconds')).toBe(true);
      });

      it('should allow command if no user ID', async () => {
        const ctx = createMockContext();
        const ctxMutable = ctx as any;
        ctxMutable.from = undefined;
        const next = vi.fn();

        await lockCheckMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
      });

      it('should allow command on error', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        vi.spyOn(TransactionLockService, 'getActiveLock').mockRejectedValue(new Error('DB error'));

        await lockCheckMiddleware(ctx as Context, next);

        expect(next).toHaveBeenCalled();
      });
    });

    describe('financialLockCheck', () => {
      it('should allow non-financial commands without checking lock', async () => {
        const ctx = createPlebContext({ messageText: '/balance' });
        const next = vi.fn();

        vi.spyOn(TransactionLockService, 'hasLock').mockResolvedValue(true);

        await financialLockCheck(ctx as Context, next);

        expect(next).toHaveBeenCalled();
        expect(TransactionLockService.hasLock).not.toHaveBeenCalled();
      });

      it('should check lock for /withdraw command', async () => {
        const ctx = createPlebContext({ messageText: '/withdraw 100' });
        const next = vi.fn();

        vi.spyOn(TransactionLockService, 'hasLock').mockResolvedValue(false);

        await financialLockCheck(ctx as Context, next);

        expect(TransactionLockService.hasLock).toHaveBeenCalledWith(444444444);
        expect(next).toHaveBeenCalled();
      });

      it('should block locked user from financial commands', async () => {
        const ctx = createPlebContext({ messageText: '/withdraw 100' });
        const next = vi.fn();

        vi.spyOn(TransactionLockService, 'hasLock').mockResolvedValue(true);

        await financialLockCheck(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(wasTextReplied(ctx, 'transaction in progress')).toBe(true);
      });

      it('should check lock for all financial commands', async () => {
        const financialCommands = ['/withdraw', '/send', '/transfer', '/pay', '/bail', '/paybail'];

        for (const command of financialCommands) {
          const ctx = createPlebContext({ messageText: `${command} 100` });
          const next = vi.fn();

          vi.spyOn(TransactionLockService, 'hasLock').mockResolvedValue(false);

          await financialLockCheck(ctx as Context, next);

          expect(TransactionLockService.hasLock).toHaveBeenCalled();
          vi.clearAllMocks();
        }
      });

      it('should allow command if no user ID', async () => {
        const ctx = createMockContext({ messageText: '/withdraw 100' });
        const ctxMutable = ctx as any;
        ctxMutable.from = undefined;
        const next = vi.fn();

        await financialLockCheck(ctx as Context, next);

        expect(next).toHaveBeenCalled();
      });

      it('should allow command on error', async () => {
        const ctx = createPlebContext({ messageText: '/withdraw 100' });
        const next = vi.fn();

        vi.spyOn(TransactionLockService, 'isUserLocked').mockRejectedValue(new Error('DB error'));

        await financialLockCheck(ctx as Context, next);

        expect(next).toHaveBeenCalled();
      });
    });
  });

  describe('src/utils/roles.ts - Role Utility Functions', () => {
    describe('isGroupOwner', () => {
      it('should return true if user is owner', () => {
        expect(isGroupOwner(123456, 123456)).toBe(true);
      });

      it('should return false if user is not owner', () => {
        expect(isGroupOwner(123456, 654321)).toBe(false);
      });

      it('should handle different number types', () => {
        expect(isGroupOwner(999999999, 999999999)).toBe(true);
        expect(isGroupOwner(0, 0)).toBe(true);
      });
    });

    describe('hasRole', () => {
      it('should return true for owner role', () => {
        expect(hasRole(111111111, 'owner')).toBe(true);
      });

      it('should return true for admin role', () => {
        expect(hasRole(222222222, 'admin')).toBe(true);
      });

      it('should return true for elevated role', () => {
        expect(hasRole(333333333, 'elevated')).toBe(true);
      });

      it('should return true for pleb role', () => {
        expect(hasRole(444444444, 'pleb' as any)).toBe(true);
      });

      it('should return false for incorrect role', () => {
        expect(hasRole(111111111, 'admin')).toBe(false);
        expect(hasRole(444444444, 'owner')).toBe(false);
      });

      it('should return false for non-existent user', () => {
        expect(hasRole(999999999, 'owner')).toBe(false);
      });
    });

    describe('checkIsElevated', () => {
      it('should return true for owner', () => {
        expect(checkIsElevated(111111111)).toBe(true);
      });

      it('should return true for admin', () => {
        expect(checkIsElevated(222222222)).toBe(true);
      });

      it('should return true for elevated user', () => {
        expect(checkIsElevated(333333333)).toBe(true);
      });

      it('should return false for pleb', () => {
        expect(checkIsElevated(444444444)).toBe(false);
      });

      it('should return false for non-existent user', () => {
        expect(checkIsElevated(999999999)).toBe(false);
      });
    });
  });

  describe('src/utils/logger.ts - Logger Functionality', () => {
    it('should export logger instance', () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should have proper log methods', () => {
      expect(() => logger.info('test message')).not.toThrow();
      expect(() => logger.error('error message')).not.toThrow();
      expect(() => logger.warn('warning message')).not.toThrow();
      expect(() => logger.debug('debug message')).not.toThrow();
    });

    it('should handle log with metadata', () => {
      expect(() => logger.info('test', { key: 'value', number: 123 })).not.toThrow();
    });

    it('should handle log with error object', () => {
      const error = new Error('Test error');
      expect(() => logger.error('Error occurred', { error })).not.toThrow();
    });

    it('should have logStream for middleware integration', () => {
      expect(logStream).toBeDefined();
      expect(typeof logStream.write).toBe('function');
      expect(() => logStream.write('Stream message\n')).not.toThrow();
    });
  });

  describe('src/utils/adminNotify.ts - Admin Notification System', () => {
    let mockBot: Telegraf;

    beforeEach(() => {
      mockBot = {
        telegram: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        },
      } as any;
    });

    describe('setBotInstance', () => {
      it('should set bot instance', () => {
        expect(() => setBotInstance(mockBot)).not.toThrow();
      });
    });

    describe('notifyAdmin', () => {
      it('should send notification to admin chat', async () => {
        setBotInstance(mockBot);

        await notifyAdmin('Test notification');

        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
          config.adminChatId,
          expect.stringContaining('Admin Alert'),
          { parse_mode: 'MarkdownV2' }
        );
        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
          config.adminChatId,
          expect.stringContaining('Test notification'),
          { parse_mode: 'MarkdownV2' }
        );
      });

      it('should handle error if bot instance not set', async () => {
        setBotInstance(null as any);

        await expect(notifyAdmin('Test')).resolves.not.toThrow();
      });

      it('should handle error if admin chat ID not configured', async () => {
        setBotInstance(mockBot);
        const originalAdminChatId = config.adminChatId;
        config.adminChatId = undefined as any;

        await expect(notifyAdmin('Test')).resolves.not.toThrow();

        config.adminChatId = originalAdminChatId;
      });

      it('should handle send message failure', async () => {
        setBotInstance(mockBot);
        (mockBot.telegram.sendMessage as Mock).mockRejectedValue(new Error('Send failed'));

        await expect(notifyAdmin('Test')).resolves.not.toThrow();
      });

      it('should format message with markdown', async () => {
        setBotInstance(mockBot);

        await notifyAdmin('Critical error occurred');

        const calls = (mockBot.telegram.sendMessage as Mock).mock.calls;
        expect(calls[0][1]).toContain('*Admin Alert*');
        expect(calls[0][1]).toContain('Critical error occurred');
        expect(calls[0][2]).toEqual({ parse_mode: 'MarkdownV2' });
      });
    });
  });

  describe('Middleware Integration Tests', () => {
    describe('Middleware call order and next() propagation', () => {
      it('should call middleware in sequence', async () => {
        const ctx = createOwnerContext();
        const callOrder: string[] = [];

        const middleware1 = vi.fn(async (ctx: Context, next: () => Promise<void>) => {
          callOrder.push('middleware1-before');
          await next();
          callOrder.push('middleware1-after');
        });

        const middleware2 = vi.fn(async (ctx: Context, next: () => Promise<void>) => {
          callOrder.push('middleware2-before');
          await next();
          callOrder.push('middleware2-after');
        });

        const middleware3 = vi.fn(async (ctx: Context, next: () => Promise<void>) => {
          callOrder.push('middleware3');
        });

        await middleware1(ctx as Context, async () => {
          await middleware2(ctx as Context, async () => {
            await middleware3(ctx as Context, async () => {});
          });
        });

        expect(callOrder).toEqual([
          'middleware1-before',
          'middleware2-before',
          'middleware3',
          'middleware2-after',
          'middleware1-after',
        ]);
      });

      it('should stop propagation when middleware does not call next', async () => {
        const ctx = createPlebContext();
        const callOrder: string[] = [];

        const middleware1 = vi.fn(async (ctx: Context, next: () => Promise<void>) => {
          callOrder.push('middleware1');
          await next();
        });

        const middleware2 = vi.fn(async (ctx: Context, next: () => Promise<void>) => {
          callOrder.push('middleware2');
          // Does not call next()
        });

        const middleware3 = vi.fn(async (ctx: Context, next: () => Promise<void>) => {
          callOrder.push('middleware3');
        });

        await middleware1(ctx as Context, async () => {
          await middleware2(ctx as Context, async () => {
            await middleware3(ctx as Context, async () => {});
          });
        });

        expect(callOrder).toEqual(['middleware1', 'middleware2']);
        expect(callOrder).not.toContain('middleware3');
      });
    });

    describe('State management in context', () => {
      it('should preserve state across middleware', async () => {
        const ctx = createMockContext();
        const next = vi.fn();

        (userService.ensureUserExists as Mock).mockReturnValue(undefined);
        (userService.getUserRestrictions as Mock).mockReturnValue([
          { id: 1, restriction: 'no_urls' },
        ]);

        await userManagementMiddleware(ctx as Context, next);

        expect(ctx.state?.restrictions).toBeDefined();
        expect(ctx.state?.restrictions).toHaveLength(1);
        expect(ctx.state?.restrictions[0].restriction).toBe('no_urls');
      });

      it('should allow middleware to modify state', async () => {
        const ctx = createMockContext();
        const ctxMutable = ctx as any;
        ctxMutable.state = {};

        const middleware1 = async (ctx: Context, next: () => Promise<void>) => {
          (ctx as any).state.value1 = 'test1';
          await next();
        };

        const middleware2 = async (ctx: Context, next: () => Promise<void>) => {
          (ctx as any).state.value2 = 'test2';
          await next();
        };

        await middleware1(ctx as Context, async () => {
          await middleware2(ctx as Context, async () => {});
        });

        expect((ctx as any).state.value1).toBe('test1');
        expect((ctx as any).state.value2).toBe('test2');
      });
    });

    describe('Permission denial integration', () => {
      it('should deny pleb from using owner-only command', async () => {
        const ctx = createPlebContext();
        const next = vi.fn();

        await ownerOnly(ctx as Context, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalled();
      });

      it('should allow elevated user through elevatedOrHigher but not adminOrHigher', async () => {
        const ctx = createElevatedContext();
        const next1 = vi.fn();
        const next2 = vi.fn();

        await elevatedOrHigher(ctx as Context, next1);
        await adminOrHigher(ctx as Context, next2);

        expect(next1).toHaveBeenCalled();
        expect(next2).not.toHaveBeenCalled();
      });
    });
  });
});
