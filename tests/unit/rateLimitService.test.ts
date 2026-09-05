import { describe, expect, it } from "vitest";
import { execute } from "../../src/database";
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
});