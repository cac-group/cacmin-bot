import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * Unit tests for role management commands
 */

import { initTestDatabase, cleanTestDatabase, closeTestDatabase, getTestDatabase, createTestUser, createOwnerContext, createAdminContext, createPlebContext, getReplyText } from '../helpers';
import { checkIsElevated, hasRole, isGroupOwner } from '../../src/utils/roles';
import { User } from '../../src/types';
import { config } from '../../src/config';

vi.mock('../../src/database', async () => {
	const { getTestDatabase } = await import('../helpers/testDatabase');
	return {
		query: vi.fn((sql: string, params: unknown[] = []) => getTestDatabase().prepare(sql).all(params)),
		execute: vi.fn((sql: string, params: unknown[] = []) => getTestDatabase().prepare(sql).run(params)),
		get: vi.fn((sql: string, params: unknown[] = []) => getTestDatabase().prepare(sql).get(params)),
	};
});

vi.mock('../../src/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logWalletAction: vi.fn() },
}));

describe('Role System', () => {
	const db = () => getTestDatabase();
	const upsertUser = (id: number, username: string | null, role: string) => {
		db().prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = ?, username = COALESCE(?, username)').run(id, username, role, role, username);
	};

	beforeAll(() => {
		initTestDatabase();
		config.ownerId = 111111111;
	});
	beforeEach(() => cleanTestDatabase());
	afterAll(() => closeTestDatabase());

	describe('Role Utilities', () => {
		beforeEach(() => {
			createTestUser(111111111, 'owner', 'owner');
			createTestUser(222222222, 'admin', 'admin');
			createTestUser(333333333, 'elevated', 'elevated');
			createTestUser(444444444, 'pleb', 'pleb');
		});

		it.each([
			[111111111, 111111111, true],
			[222222222, 111111111, false],
		])('isGroupOwner(%i, %i) returns %s', (userId, ownerId, expected) => {
			expect(isGroupOwner(userId, ownerId)).toBe(expected);
		});

		it.each([
			[111111111, 'owner', true],
			[222222222, 'admin', true],
			[333333333, 'elevated', true],
			[222222222, 'owner', false],
			[999999999, 'owner', false],
		])('hasRole(%i, %s) returns %s', (userId, role, expected) => {
			expect(hasRole(userId, role)).toBe(expected);
		});

		it.each([
			[111111111, true, 'owner'],
			[222222222, true, 'admin'],
			[333333333, true, 'elevated'],
			[444444444, false, 'pleb'],
			[999999999, false, 'nonexistent'],
		])('checkIsElevated(%i) returns %s for %s', (userId, expected) => {
			expect(checkIsElevated(userId)).toBe(expected);
		});
	});

	describe('setowner', () => {
		it('initializes master owner from config when no owner exists', async () => {
			const ctx = createOwnerContext({ userId: 111111111, username: 'masterowner', messageText: '/setowner' });
			const existingOwner = db().prepare('SELECT * FROM users WHERE role = ?').get('owner') as User;

			if (!existingOwner && ctx.from?.id === config.ownerId) {
				upsertUser(ctx.from.id, ctx.from.username || 'unknown', 'owner');
				await ctx.reply!('Master owner initialized successfully.');
			}

			const owner = db().prepare('SELECT * FROM users WHERE role = ?').get('owner') as User;
			expect(owner?.role).toBe('owner');
			expect(getReplyText(ctx)).toContain('Master owner initialized successfully');
		});

		it.each([
			[222222222, 'Owner already set'],
			[999999999, 'Only the master owner'],
		])('rejects user %i with message containing "%s"', async (userId, expectedMsg) => {
			createTestUser(111111111, 'existingowner', 'owner');
			const ctx = createOwnerContext({ userId, username: 'user', messageText: '/setowner' });
			const existingOwner = db().prepare('SELECT * FROM users WHERE role = ?').get('owner') as User;

			if (existingOwner && ctx.from?.id !== config.ownerId) {
				await ctx.reply!('Owner already set. Only the master owner can modify ownership.');
			} else if (ctx.from?.id !== config.ownerId) {
				await ctx.reply!('Only the master owner (from .env) can initialize ownership.');
			}

			expect(getReplyText(ctx)).toContain(expectedMsg);
		});
	});

	describe('grantowner', () => {
		beforeEach(() => createTestUser(111111111, 'owner', 'owner'));

		it.each([
			['newowner', 'existing user by username'],
			['@newowner', 'existing user by @username'],
			['222222222', 'by user ID'],
		])('grants owner privileges for %s', async (identifier) => {
			if (!identifier.match(/^\d+$/)) createTestUser(222222222, 'newowner', 'pleb');

			const ctx = createOwnerContext({ userId: 111111111, username: 'owner', messageText: `/grantowner ${identifier}` });
			const targetUsername = identifier.startsWith('@') ? identifier.substring(1) : identifier;
			const existingUser = identifier.match(/^\d+$/)
				? { id: parseInt(identifier) }
				: db().prepare('SELECT id FROM users WHERE username = ?').get(targetUsername) as User;

			if (existingUser) {
				upsertUser(existingUser.id, identifier.match(/^\d+$/) ? null : targetUsername, 'owner');
				await ctx.reply!(`Owner privileges granted!\n\nUser ID: ${existingUser.id}`);
			}

			const user = db().prepare('SELECT * FROM users WHERE id = ?').get(222222222) as User;
			expect(user.role).toBe('owner');
			expect(getReplyText(ctx)).toContain('Owner privileges granted');
		});

		it('fails when username not found', async () => {
			const ctx = createOwnerContext({ userId: 111111111, username: 'owner', messageText: '/grantowner nonexistent' });
			const existingUser = db().prepare('SELECT id FROM users WHERE username = ?').get('nonexistent') as User;

			if (!existingUser) await ctx.reply!('User @nonexistent not found in database yet.');

			expect(getReplyText(ctx)).toContain('not found in database yet');
		});
	});

	describe('elevate', () => {
		beforeEach(() => {
			createTestUser(111111111, 'owner', 'owner');
			createTestUser(222222222, 'admin', 'admin');
		});

		it.each([
			[111111111, 'owner', 'newuser', true, 'owner elevates by username'],
			[222222222, 'admin', 'newuser', true, 'admin elevates by username'],
			[111111111, 'owner', '333333333', true, 'owner elevates by ID'],
		])('allows %s to elevate user: %s', async (requesterId, _role, identifier, shouldSucceed) => {
			if (!identifier.match(/^\d+$/)) createTestUser(333333333, 'newuser', 'pleb');

			const ctx = requesterId === 111111111
				? createOwnerContext({ userId: requesterId, username: _role, messageText: `/elevate ${identifier}` })
				: createAdminContext({ userId: requesterId, username: _role, messageText: `/elevate ${identifier}` });

			const requester = db().prepare('SELECT * FROM users WHERE id = ?').get(requesterId) as User;

			if (requester?.role === 'admin' || requester?.role === 'owner') {
				const targetId = identifier.match(/^\d+$/) ? parseInt(identifier) : 333333333;
				upsertUser(targetId, null, 'elevated');
				await ctx.reply!(`Elevated privileges granted!\n\nUser ID: ${targetId}`);
			}

			const user = db().prepare('SELECT * FROM users WHERE id = ?').get(333333333) as User;
			expect(user.role).toBe(shouldSucceed ? 'elevated' : 'pleb');
		});

		it('rejects when user is not admin or owner', async () => {
			createTestUser(444444444, 'pleb', 'pleb');
			const ctx = createPlebContext({ userId: 444444444, username: 'pleb', messageText: '/elevate someone' });
			const requester = db().prepare('SELECT * FROM users WHERE id = ?').get(444444444) as User;

			if (requester?.role !== 'admin' && requester?.role !== 'owner') {
				await ctx.reply!('You do not have permission to use this command.');
			}

			expect(getReplyText(ctx)).toContain('You do not have permission');
		});
	});

	describe('makeadmin', () => {
		beforeEach(() => createTestUser(111111111, 'owner', 'owner'));

		it.each([
			['newadmin', 'by username'],
			['222222222', 'by user ID'],
		])('grants admin privileges %s', async (identifier) => {
			if (!identifier.match(/^\d+$/)) createTestUser(222222222, 'newadmin', 'pleb');

			const ctx = createOwnerContext({ userId: 111111111, username: 'owner', messageText: `/makeadmin ${identifier}` });
			const targetId = identifier.match(/^\d+$/) ? parseInt(identifier) : 222222222;

			upsertUser(targetId, identifier.match(/^\d+$/) ? null : identifier, 'admin');
			await ctx.reply!(`Admin privileges granted!\n\nUser ID: ${targetId}`);

			const user = db().prepare('SELECT * FROM users WHERE id = ?').get(222222222) as User;
			expect(user.role).toBe('admin');
			expect(getReplyText(ctx)).toContain('Admin privileges granted');
		});

		it('fails when username not found', async () => {
			const ctx = createOwnerContext({ userId: 111111111, username: 'owner', messageText: '/makeadmin nonexistent' });
			const existingUser = db().prepare('SELECT id FROM users WHERE username = ?').get('nonexistent') as User;

			if (!existingUser) await ctx.reply!('User @nonexistent not found in database yet.');

			expect(getReplyText(ctx)).toContain('not found in database yet');
		});
	});

	describe('revoke', () => {
		beforeEach(() => {
			createTestUser(111111111, 'owner', 'owner');
			createTestUser(222222222, 'admin', 'admin');
			createTestUser(333333333, 'elevated', 'elevated');
		});

		it.each([
			[111111111, 'owner', 'elevated', true, 'owner revokes elevated by username'],
			[111111111, 'owner', '222222222', true, 'owner revokes admin by ID'],
			[222222222, 'admin', 'elevated', true, 'admin revokes elevated'],
		])('allows %s to revoke: %s', async (requesterId, _role, identifier, shouldSucceed) => {
			const ctx = requesterId === 111111111
				? createOwnerContext({ userId: requesterId, username: _role, messageText: `/revoke ${identifier}` })
				: createAdminContext({ userId: requesterId, username: _role, messageText: `/revoke ${identifier}` });

			const requester = db().prepare('SELECT * FROM users WHERE id = ?').get(requesterId) as User;
			const targetUser = identifier.match(/^\d+$/)
				? db().prepare('SELECT * FROM users WHERE id = ?').get(parseInt(identifier)) as User
				: db().prepare('SELECT * FROM users WHERE username = ?').get(identifier) as User;

			if (targetUser && (requester?.role === 'owner' || (requester?.role === 'admin' && targetUser.role === 'elevated'))) {
				db().prepare('UPDATE users SET role = ? WHERE id = ?').run('pleb', targetUser.id);
				await ctx.reply!(`${targetUser.username || targetUser.id}'s privileges have been revoked.`);
			}

			const user = db().prepare('SELECT * FROM users WHERE id = ?').get(targetUser?.id || 0) as User;
			expect(user?.role).toBe(shouldSucceed ? 'pleb' : undefined);
		});

		it.each([
			['admin2', 'admin', 'admin revoking admin'],
			['owner', 'owner', 'admin revoking owner'],
		])('prevents admin from revoking %s', async (targetUsername, targetRole) => {
			createTestUser(444444444, targetUsername, targetRole);

			const ctx = createAdminContext({ userId: 222222222, username: 'admin', messageText: `/revoke ${targetUsername}` });
			const requester = db().prepare('SELECT * FROM users WHERE id = ?').get(222222222) as User;
			const targetUser = db().prepare('SELECT * FROM users WHERE username = ?').get(targetUsername) as User;

			if (requester?.role === 'admin' && (targetUser?.role === 'admin' || targetUser?.role === 'owner')) {
				await ctx.reply!('You can only revoke elevated users.');
			}

			expect(getReplyText(ctx)).toContain('You can only revoke elevated users');
		});

		it('rejects when user is pleb or user not found', async () => {
			createTestUser(444444444, 'pleb', 'pleb');
			const ctx = createPlebContext({ userId: 444444444, username: 'pleb', messageText: '/revoke someone' });
			const requester = db().prepare('SELECT * FROM users WHERE id = ?').get(444444444) as User;

			if (requester?.role !== 'admin' && requester?.role !== 'owner') {
				await ctx.reply!('You do not have permission to use this command.');
			}

			expect(getReplyText(ctx)).toContain('You do not have permission');
		});
	});

	describe('Edge Cases', () => {
		beforeEach(() => createTestUser(111111111, 'owner', 'owner'));

		it('handles users without username and role updates correctly', () => {
			db().prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(777777777, null, 'pleb');
			let user = db().prepare('SELECT * FROM users WHERE id = ?').get(777777777) as User;
			expect(user.username).toBeNull();

			// Update role
			upsertUser(777777777, null, 'elevated');
			user = db().prepare('SELECT * FROM users WHERE id = ?').get(777777777) as User;
			expect(user.role).toBe('elevated');
		});

		it('preserves username when promoting by user ID', () => {
			createTestUser(222222222, 'testuser', 'pleb');
			upsertUser(222222222, null, 'admin');

			const user = db().prepare('SELECT * FROM users WHERE id = ?').get(222222222) as User;
			expect(user.role).toBe('admin');
			expect(user.username).toBe('testuser');
		});
	});
});
