import { beforeEach, describe, expect, it } from "vitest";
import { execute, get, initDb } from "../../src/database";
import { RateLimitService } from "../../src/services/rateLimitService";

describe("RateLimitService", () => {
	beforeEach(() => {
		initDb();
		execute("DELETE FROM user_rate_limit_usage");
		execute("DELETE FROM user_rate_limits");
		execute("INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)", [
			99101,
			"limited",
		]);
		RateLimitService.setLimits(99101, 10);
	});

	it("admits inclusive limits and rejects the next character", () => {
		expect(RateLimitService.admitMessage(99101, 1, 10, 1).allowed).toBe(true);
		const rejected = RateLimitService.admitMessage(99101, 2, 1, 2);
		expect(rejected.allowed).toBe(false);
		expect(rejected.violated).toContain("15m");
	});

	it("applies all active windows cumulatively", () => {
		RateLimitService.setLimits(99101, 10);
		const status = RateLimitService.getStatus(99101);
		expect(status?.limits).toEqual({ "15m": 10, "1h": 40, "24h": 960 });
	});

	it("clears a selected window and its overlapping shorter usage", () => {
		RateLimitService.admitMessage(99101, 1, 10, 1);
		RateLimitService.admitMessage(99101, 2, 10, 2);
		RateLimitService.resetWindow(99101, "24h", 3);
		expect(
			get<{ total: number }>(
				"SELECT COALESCE(SUM(characters), 0) AS total FROM user_rate_limit_usage WHERE user_id = ?",
				[99101],
			)?.total,
		).toBe(0);
	});

	it("weights emoji as two and stickers as five characters", () => {
		expect(RateLimitService.countMessageCharacters({ text: "a😀" })).toBe(3);
		expect(RateLimitService.countMessageCharacters({ sticker: {} })).toBe(5);
	});
});
