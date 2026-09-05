import { beforeAll, describe, expect, it } from "vitest";
import { execute } from "../../src/database";
import {
	calculateRolloverCapacity,
	RateLimitService,
} from "../../src/services/rateLimitService";

beforeAll(() => {
	// Create the tables the service needs so the test is independent of the
	// shared database schema state (a fresh CI checkout has none).
	execute(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY,
			username TEXT,
			role TEXT DEFAULT 'pleb',
			whitelist INTEGER DEFAULT 0,
			blacklist INTEGER DEFAULT 0,
			warning_count INTEGER DEFAULT 0,
			muted_until INTEGER,
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			updated_at INTEGER DEFAULT (strftime('%s', 'now'))
		)
	`);
	execute(`
		CREATE TABLE IF NOT EXISTS user_rate_limits (
			user_id INTEGER PRIMARY KEY,
			limit_15m INTEGER NOT NULL,
			limit_1h INTEGER NOT NULL,
			limit_24h INTEGER NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
			updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`);
	execute(`
		CREATE TABLE IF NOT EXISTS user_rate_limit_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			message_id INTEGER NOT NULL,
			characters INTEGER NOT NULL CHECK (characters >= 0),
			created_at INTEGER NOT NULL,
			UNIQUE (user_id, message_id),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`);
	execute(`
		CREATE TABLE IF NOT EXISTS user_rate_limit_mutes (
			user_id INTEGER PRIMARY KEY,
			muted_until INTEGER NOT NULL,
			limiting_window TEXT NOT NULL,
			permission_snapshot TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`);
});

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
