import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
/**
 * Unit tests for restriction and blacklist handlers
 */

vi.mock('../../src/database', () => ({
	query: vi.fn(),
	execute: vi.fn(),
	get: vi.fn(),
	initDb: vi.fn(),
}));

vi.mock('../../src/config', () => ({
	config: { databasePath: ':memory:', botToken: 'test-token', groupChatId: '-100123456789' },
}));

import { Context } from 'telegraf';
import { createMockContext, createPlebContext, createElevatedContext } from '../helpers';
import * as database from '../../src/database';
import { addUserRestriction, removeUserRestriction, getUserRestrictions } from '../../src/services/userService';
import { RestrictionService } from '../../src/services/restrictionService';
import { UserRestriction } from '../../src/types';

const mockQuery = database.query as Mock;
const mockExecute = database.execute as Mock;

vi.mock('../../src/utils/roles', () => ({
	hasRole: vi.fn((userId: number, role: string) => {
		if (role === 'owner') return userId === 111111111;
		if (role === 'admin') return userId === 222222222;
		if (role === 'elevated') return userId === 333333333;
		return false;
	}),
	checkIsElevated: vi.fn((userId: number) => [111111111, 222222222, 333333333].includes(userId)),
}));

vi.mock('../../src/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logWalletAction: vi.fn(), logSecurityEvent: vi.fn() },
}));

vi.mock('../../src/services/violationService', () => ({ createViolation: vi.fn().mockResolvedValue(1) }));
vi.mock('../../src/utils/safeRegex', () => ({
	createPatternObject: vi.fn((pattern: string) => pattern === '[invalid(regex' ? null : { regex: new RegExp(pattern, 'i') }),
	testPatternSafely: vi.fn(async (regex: RegExp, text: string) => regex.test(text)),
}));
vi.mock('../../src/services/jailService', () => ({ JailService: { jail: vi.fn() } }));

describe('Restrictions', () => {
	beforeEach(() => vi.clearAllMocks());

	describe('User Restrictions CRUD', () => {
		it('adds restrictions with all parameter variants', () => {
			mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 1 });

			// With all params
			addUserRestriction(444444444, 'no_stickers', 'pack123', undefined, 1700000000);
			expect(mockExecute).toHaveBeenCalledWith(
				expect.stringContaining('INSERT INTO user_restrictions'),
				[444444444, 'no_stickers', 'pack123', null, 1700000000, 'delete', 5, 2880, 10.0]
			);

			// Without optional params
			addUserRestriction(444444444, 'no_urls');
			expect(mockExecute).toHaveBeenCalledWith(
				expect.stringContaining('INSERT INTO user_restrictions'),
				[444444444, 'no_urls', null, null, null, 'delete', 5, 2880, 10.0]
			);

			// With metadata
			const metadata = { reason: 'spam' };
			addUserRestriction(444444444, 'regex_block', 'spam.*pattern', metadata);
			expect(mockExecute).toHaveBeenCalledWith(
				expect.stringContaining('INSERT INTO user_restrictions'),
				[444444444, 'regex_block', 'spam.*pattern', JSON.stringify(metadata), null, 'delete', 5, 2880, 10.0]
			);
		});

		it('removes restrictions', () => {
			mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 0 });
			removeUserRestriction(444444444, 'no_stickers');
			expect(mockExecute).toHaveBeenCalledWith(
				'DELETE FROM user_restrictions WHERE user_id = ? AND restriction = ?',
				[444444444, 'no_stickers']
			);
		});

		it('lists user restrictions', () => {
			const mockRestrictions: UserRestriction[] = [
				{ id: 1, userId: 444444444, restriction: 'no_stickers', restrictedAction: 'pack123', createdAt: 1700000000 },
				{ id: 2, userId: 444444444, restriction: 'no_urls', restrictedUntil: 1700001000, createdAt: 1700000000 },
			];
			mockQuery.mockReturnValue(mockRestrictions);

			const restrictions = getUserRestrictions(444444444);
			expect(restrictions).toHaveLength(2);
			expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM user_restrictions WHERE user_id = ?', [444444444]);
		});
	});

	describe('RestrictionService.checkMessage', () => {
		const restrictionTypes = [
			{ type: 'no_stickers', message: { sticker: { file_id: 'test', set_name: 'pack' } } },
			{ type: 'no_urls', message: { text: 'https://example.com' } },
			{ type: 'no_media', message: { photo: [{ file_id: 'photo' }] } },
			{ type: 'no_gifs', message: { animation: { file_id: 'gif' } } },
			{ type: 'no_voice', message: { voice: { file_id: 'voice' } } },
			{ type: 'no_forwarding', message: { forward_from: { id: 999 } } },
			{ type: 'muted', message: { text: 'Any message' } },
		];

		it.each(restrictionTypes)('detects $type violation', async ({ type, message }) => {
			const ctx = createMockContext() as Context;
			mockQuery.mockReturnValue([{ id: 1, userId: 123456789, restriction: type, createdAt: 1700000000 }]);

			const violated = await RestrictionService.checkMessage(ctx, message as any);
			expect(violated).toBe(true);
		});

		it('allows content from different source when specific target restricted', async () => {
			const ctx = createMockContext() as Context;
			mockQuery.mockReturnValueOnce([{ id: 1, userId: 123456789, restriction: 'no_stickers', restrictedAction: 'banned_pack', createdAt: 1700000000 }]);
			mockQuery.mockReturnValueOnce([]);

			const violated = await RestrictionService.checkMessage(ctx, { sticker: { file_id: 'test', set_name: 'allowed_pack' } } as any);
			expect(violated).toBe(false);
		});

		it('detects regex_block violation', async () => {
			const ctx = createMockContext() as Context;
			mockQuery.mockReturnValue([{ id: 1, userId: 123456789, restriction: 'regex_block', restrictedAction: 'buy.*crypto', createdAt: 1700000000 }]);

			const violated = await RestrictionService.checkMessage(ctx, { text: 'Buy crypto now!' } as any);
			expect(violated).toBe(true);
		});

		it('handles invalid regex gracefully', async () => {
			const ctx = createMockContext() as Context;
			mockQuery.mockReturnValueOnce([{ id: 1, userId: 123456789, restriction: 'regex_block', restrictedAction: '[invalid(regex', createdAt: 1700000000 }]);
			mockQuery.mockReturnValueOnce([]);

			const violated = await RestrictionService.checkMessage(ctx, { text: 'Some message' } as any);
			expect(violated).toBe(false);
		});

		it('applies global restrictions to plebs but not elevated', async () => {
			const plebCtx = createPlebContext() as Context;
			mockQuery.mockReturnValueOnce([]).mockReturnValueOnce([{ id: 1, restriction: 'no_stickers', createdAt: 1700000000 }]);

			expect(await RestrictionService.checkMessage(plebCtx, { sticker: { file_id: 'test', set_name: 'pack' } } as any)).toBe(true);

			const elevatedCtx = createElevatedContext() as Context;
			mockQuery.mockReturnValueOnce([]);
			const elevatedUser = { id: 333333333, username: 'elevated', role: 'elevated', whitelist: false, blacklist: false, warning_count: 0, created_at: 1700000000, updated_at: 1700000000 };

			expect(await RestrictionService.checkMessage(elevatedCtx, { sticker: { file_id: 'test', set_name: 'pack' } } as any, elevatedUser)).toBe(false);
		});

		it('respects expiration - expired not enforced, active enforced', async () => {
			const ctx = createMockContext() as Context;

			// Expired
			mockQuery.mockReturnValue([]);
			expect(await RestrictionService.checkMessage(ctx, { text: 'test' } as any)).toBe(false);

			// Active
			const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
			mockQuery.mockReturnValue([{ id: 1, userId: 123456789, restriction: 'muted', restrictedUntil: futureTimestamp, createdAt: 1700000000 }]);
			expect(await RestrictionService.checkMessage(ctx, { text: 'test' } as any)).toBe(true);
		});
	});

	describe('cleanExpiredRestrictions', () => {
		it('cleans both user and global restrictions', () => {
			mockExecute.mockReturnValue({ changes: 2, lastInsertRowid: 0 });
			RestrictionService.cleanExpiredRestrictions();
			expect(mockExecute).toHaveBeenCalledTimes(2);
			expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM user_restrictions'), expect.any(Array));
			expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM global_restrictions'), expect.any(Array));
		});
	});

	describe('Permission Validation', () => {
		it('validates role-based access correctly', async () => {
			const { hasRole, checkIsElevated } = await import('../../src/utils/roles');
			expect(hasRole(333333333, 'elevated')).toBe(true);
			expect(hasRole(222222222, 'admin')).toBe(true);
			expect(hasRole(444444444, 'elevated')).toBe(false);
			expect(checkIsElevated(111111111)).toBe(true);
			expect(checkIsElevated(444444444)).toBe(false);
		});
	});

	describe('Full Restriction Lifecycle', () => {
		it('handles add, list, remove workflow', () => {
			mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 1 });

			addUserRestriction(444444444, 'no_stickers', 'pack123');
			expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('INSERT'), expect.arrayContaining([444444444, 'no_stickers', 'pack123']));

			const mockRestrictions = [{ id: 1, userId: 444444444, restriction: 'no_stickers', restrictedAction: 'pack123', createdAt: 1700000000 }];
			mockQuery.mockReturnValue(mockRestrictions);
			expect(getUserRestrictions(444444444)).toHaveLength(1);

			removeUserRestriction(444444444, 'no_stickers');
			expect(mockExecute).toHaveBeenCalledWith('DELETE FROM user_restrictions WHERE user_id = ? AND restriction = ?', [444444444, 'no_stickers']);
		});
	});
});
