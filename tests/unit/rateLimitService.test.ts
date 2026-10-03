import type { Telegram } from "telegraf";
import { describe, expect, it } from "vitest";
import { execute, query } from "../../src/database";
import {
	calculateRolloverCapacity,
	RateLimitService,
} from "../../src/services/rateLimitService";

describe("RateLimitService", () => {
	it("calculates one-period rollover without compounding", () => {
		expect(calculateRolloverCapacity(10, 0, 0)).toEqual({
			limit: 20,
			rollover: 10,
		});
		expect(calculateRolloverCapacity(10, 5, 15)).toEqual({
			limit: 15,
			rollover: 0,
		});
		expect(calculateRolloverCapacity(10, 0, 5)).toEqual({
			limit: 20,
			rollover: 10,
		});
	});

	it("weights emoji as two and stickers as five characters", () => {
		expect(RateLimitService.countMessageCharacters({ text: "a😀" })).toBe(3);
		expect(RateLimitService.countMessageCharacters({ sticker: {} })).toBe(5);
	});

	it("counts a shared image as twenty-five characters", () => {
		expect(RateLimitService.countMessageCharacters({ photo: {} })).toBe(25);
		expect(RateLimitService.countMessageCharacters({ document: {} })).toBe(25);
		expect(
			RateLimitService.countMessageCharacters({ photo: {}, caption: "a😀" }),
		).toBe(28);
	});

	it("clears usage and the active mute without altering configured limits", () => {
		const userId = 99002;
		execute(
			"INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'pleb')",
			[userId, `user_${userId}`],
		);
		RateLimitService.setLimits(userId, 10);
		RateLimitService.admitMessage(userId, 1, 5);
		RateLimitService.clearUsage(userId);
		const status = RateLimitService.getStatus(userId);
		expect(status).not.toBeNull();
		expect(status!.usage["15m"]).toBe(0);
		expect(status!.baseLimits["15m"]).toBe(10);
	});

	it("mutes through the Telegram client with deny-all permissions", async () => {
		const userId = 99003;
		execute(
			"INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'pleb')",
			[userId, `user_${userId}`],
		);
		RateLimitService.setLimits(userId, 10);
		const calls: Array<{
			permissions: Record<string, boolean>;
			until_date: number;
		}> = [];
		const telegram = {
			getChatMember: async () => ({ status: "member" }),
			restrictChatMember: async (
				_chatId: number,
				_userId: number,
				params: { permissions: Record<string, boolean>; until_date: number },
			) => {
				calls.push(params);
			},
		};
		const until = Math.floor(Date.now() / 1000) + 600;
		await RateLimitService.muteUser(
			telegram as unknown as Telegram,
			-100123,
			userId,
			until,
			"15m",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].permissions.can_send_messages).toBe(false);
		expect(calls[0].until_date).toBe(until);
		const mute = query<{ muted_until: number }>(
			"SELECT muted_until FROM user_rate_limit_mutes WHERE user_id = ?",
			[userId],
		)[0];
		expect(mute?.muted_until).toBe(until);
	});

	it("restores captured permissions when a rate-limit mute expires", async () => {
		const userId = 99005;
		execute(
			"INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'pleb')",
			[userId, `user_${userId}`],
		);
		RateLimitService.setLimits(userId, 10);
		const captures: Array<{ permissions: Record<string, boolean> }> = [];
		const telegram = {
			getChatMember: async () => ({ status: "member" }),
			restrictChatMember: async (
				_chatId: number,
				_userId: number,
				params: { permissions: Record<string, boolean> },
			) => {
				captures.push(params);
			},
			sendMessage: async () => ({}),
		};
		await RateLimitService.muteUser(
			telegram as unknown as Telegram,
			-100123,
			userId,
			Math.floor(Date.now() / 1000) - 1,
			"15m",
		);
		// Force the row to look expired regardless of the clamp.
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ?",
			[userId],
		);
		await RateLimitService.cleanExpiredMutes(
			{ telegram } as unknown as Parameters<
				typeof RateLimitService.cleanExpiredMutes
			>[0],
			-100123,
		);
		const restored = captures[captures.length - 1].permissions;
		expect(restored.can_send_messages).toBe(true);
		expect(restored.can_send_media_messages).toBeUndefined();
		expect(
			query("SELECT user_id FROM user_rate_limit_mutes WHERE user_id = ?", [
				userId,
			]),
		).toHaveLength(0);
	});

	it("does not lift a jail restriction when releasing a rate-limit mute", async () => {
		const userId = 99006;
		execute(
			"INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'pleb')",
			[userId, `user_${userId}`],
		);
		RateLimitService.setLimits(userId, 10);
		const captures: unknown[] = [];
		const telegram = {
			getChatMember: async () => ({ status: "member" }),
			restrictChatMember: async (
				_chatId: number,
				_userId: number,
				params: unknown,
			) => {
				captures.push(params);
			},
			sendMessage: async () => ({}),
		};
		await RateLimitService.muteUser(
			telegram as unknown as Telegram,
			-100123,
			userId,
			Math.floor(Date.now() / 1000) + 600,
			"15m",
		);
		captures.length = 0;
		execute("UPDATE users SET muted_until = ? WHERE id = ?", [
			Math.floor(Date.now() / 1000) + 3600,
			userId,
		]);
		await RateLimitService.releaseMuteIfAllowed(
			{ telegram } as unknown as Parameters<
				typeof RateLimitService.releaseMuteIfAllowed
			>[0],
			-100123,
			userId,
		);
		expect(captures).toHaveLength(0);
		expect(
			query("SELECT user_id FROM user_rate_limit_mutes WHERE user_id = ?", [
				userId,
			]),
		).toHaveLength(0);
	});

	it("clamps a near-expiry mute so Telegram does not make it permanent", async () => {
		const userId = 99004;
		execute(
			"INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'pleb')",
			[userId, `user_${userId}`],
		);
		RateLimitService.setLimits(userId, 10);
		const calls: Array<{ until_date: number }> = [];
		const telegram = {
			getChatMember: async () => ({ status: "member" }),
			restrictChatMember: async (
				_chatId: number,
				_userId: number,
				params: { until_date: number },
			) => {
				calls.push(params);
			},
		};
		await RateLimitService.muteUser(
			telegram as unknown as Telegram,
			-100123,
			userId,
			Math.floor(Date.now() / 1000) + 5,
			"15m",
		);
		expect(calls[0].until_date).toBeGreaterThanOrEqual(
			Math.floor(Date.now() / 1000) + 30,
		);
	});
});
