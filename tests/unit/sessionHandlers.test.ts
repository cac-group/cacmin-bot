/**
 * Session handler tests
 * Tests multi-step interactive flow session management and permission verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	getSession,
	setSession,
	clearSession,
	handleSessionText,
} from "../../src/handlers/callbacks";
import {
	createMockContext,
	createAdminContext,
	createPlebContext,
	wasTextReplied,
} from "../helpers/mockContext";

// Mock the database module
vi.mock("../../src/database", () => ({
	execute: vi.fn(),
	get: vi.fn(),
	query: vi.fn(() => []),
}));

// Mock the roles module
vi.mock("../../src/utils/roles", () => ({
	isImmuneToModeration: vi.fn((userId: number) => userId === 111111111),
	checkIsElevated: vi.fn((userId: number) => userId === 222222222),
}));

// Mock the userService module
vi.mock("../../src/services/userService", () => ({
	addUserRestriction: vi.fn(),
	setUserRole: vi.fn(),
	getUserById: vi.fn(() => ({ id: 444444444, username: "testuser" })),
	ensureUserExists: vi.fn(),
}));

// Mock the userResolver module
vi.mock("../../src/utils/userResolver", () => ({
	resolveUserId: vi.fn((input: string) => {
		if (input === "invalid") return null;
		if (input.startsWith("@")) return 444444444;
		const parsed = parseInt(input, 10);
		return isNaN(parsed) ? null : parsed;
	}),
	formatUserIdDisplay: vi.fn((userId: number) => `user_${userId}`),
}));

// Mock the jailService module
vi.mock("../../src/services/jailService", () => ({
	JailService: {
		calculateBailAmount: vi.fn(() => Promise.resolve(10.0)),
		logJailEvent: vi.fn(),
	},
}));

// Mock the logger
vi.mock("../../src/utils/logger", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
	StructuredLogger: {
		logSecurityEvent: vi.fn(),
		logTransaction: vi.fn(),
	},
}));

describe("Session handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		clearSession(123456789);
		clearSession(222222222);
		clearSession(444444444);
	});

	it("should manage session lifecycle correctly", () => {
		const userId = 123456789;

		// Create and retrieve session
		setSession(userId, "test_action", 1, { foo: "bar" });
		let session = getSession(userId);
		expect(session).not.toBeNull();
		expect(session?.action).toBe("test_action");
		expect(session?.step).toBe(1);
		expect(session?.data.foo).toBe("bar");

		// Non-existent session returns null
		expect(getSession(999999999)).toBeNull();

		// Overwrite session
		setSession(userId, "second_action", 2, { second: true });
		session = getSession(userId);
		expect(session?.action).toBe("second_action");
		expect(session?.data.second).toBe(true);

		// Clear session
		clearSession(userId);
		expect(getSession(userId)).toBeNull();

		// Clearing non-existent session doesn't throw
		expect(() => clearSession(999999999)).not.toThrow();

		// Session expiration after 5 minutes
		const now = Date.now();
		setSession(userId, "test_action", 1, {});
		const originalDateNow = Date.now;

		Date.now = () => now + 4 * 60 * 1000; // 4 minutes - not expired
		expect(getSession(userId)).not.toBeNull();

		Date.now = () => now + 6 * 60 * 1000; // 6 minutes - expired
		expect(getSession(userId)).toBeNull();

		Date.now = originalDateNow;
	});

	it("should handle edge cases in handleSessionText", async () => {
		// No session exists
		let ctx = createMockContext({ messageText: "some text" });
		expect(await handleSessionText(ctx as any)).toBe(false);

		// Message is a command (should be ignored)
		setSession(123456789, "test_action", 1, {});
		ctx = createMockContext({ userId: 123456789, messageText: "/help" });
		expect(await handleSessionText(ctx as any)).toBe(false);

		// No user ID
		ctx = createMockContext({});
		(ctx as any).from = undefined;
		expect(await handleSessionText(ctx as any)).toBe(false);
	});

	it("should reject actions when admin privileges are revoked", async () => {
		const userId = 444444444; // Not elevated (checkIsElevated returns false)

		const actionTypes = [
			{ action: "add_restriction", data: { restrictionType: "no_stickers" } },
			{ action: "jail", data: { minutes: 30 } },
			{ action: "role_admin", data: {} },
			{ action: "list_add_white", data: {} },
			{ action: "add_global_action", data: { actionType: "no_media" } },
		];

		for (const { action, data } of actionTypes) {
			setSession(userId, action, 1, data);
			const ctx = createPlebContext({
				userId,
				messageText: action === "add_global_action" ? "apply" : "@targetuser",
			});
			await handleSessionText(ctx as any);

			expect(wasTextReplied(ctx, "admin privileges have been revoked")).toBe(
				true,
			);
			expect(getSession(userId)).toBeNull();
		}
	});

	it("should handle invalid input gracefully", async () => {
		const userId = 222222222; // Elevated user

		// Invalid user in add_restriction
		setSession(userId, "add_restriction", 1, { restrictionType: "no_stickers" });
		let ctx = createAdminContext({ userId, messageText: "invalid" });
		await handleSessionText(ctx as any);
		expect(wasTextReplied(ctx, "User not found")).toBe(true);
		expect(getSession(userId)).not.toBeNull(); // Session stays for retry

		// Invalid user in jail
		clearSession(userId);
		setSession(userId, "jail", 1, { minutes: 30 });
		ctx = createAdminContext({ userId, messageText: "invalid" });
		await handleSessionText(ctx as any);
		expect(wasTextReplied(ctx, "User not found")).toBe(true);

		// Invalid duration in jail
		clearSession(userId);
		setSession(userId, "jail", 1, {});
		ctx = createAdminContext({ userId, messageText: "@user abc" });
		await handleSessionText(ctx as any);
		expect(wasTextReplied(ctx, "Invalid duration")).toBe(true);
	});
});
