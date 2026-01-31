/**
 * User resolver tests
 * Tests the resolveTargetUser function with various invocation patterns
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resolveTargetUser,
	getRemainingArgs,
	type TargetUserResult,
} from "../../src/utils/userResolver";
import type { Context } from "telegraf";

// Mock the database module
vi.mock("../../src/database", () => ({
	get: vi.fn((query: string, params: unknown[]) => {
		// Simulate user lookup - only user ID 12345 exists
		if (
			query.includes("WHERE id = ?") &&
			(params[0] === 12345 || params[0] === "12345")
		) {
			return { id: 12345, username: "existinguser", role: "pleb" };
		}
		// Username lookup
		if (query.includes("WHERE LOWER(username)")) {
			const username = (params[0] as string).toLowerCase();
			if (username === "alice") {
				return { id: 12345, username: "alice", role: "pleb" };
			}
		}
		return null;
	}),
}));

// Mock the userService module
vi.mock("../../src/services/userService", () => ({
	ensureUserExists: vi.fn(),
}));

/**
 * Create a mock context with optional reply-to message
 */
function createMockContext(
	replyToUserId?: number,
	replyToUsername?: string,
): Context {
	const mockFrom = replyToUserId
		? { id: replyToUserId, username: replyToUsername, is_bot: false }
		: undefined;

	return {
		message: {
			reply_to_message: mockFrom ? { from: mockFrom } : undefined,
		},
	} as unknown as Context;
}

describe("resolveTargetUser", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("argument-based resolution", () => {
		it("resolves @username from args", () => {
			const ctx = createMockContext();
			const result = resolveTargetUser(ctx, ["@alice"]);

			expect(result).not.toBeNull();
			expect(result?.userId).toBe(12345);
			expect(result?.source).toBe("args");
		});

		it("resolves numeric userId from args when user exists", () => {
			const ctx = createMockContext();
			const result = resolveTargetUser(ctx, ["12345"]);

			expect(result).not.toBeNull();
			expect(result?.userId).toBe(12345);
			expect(result?.source).toBe("args");
		});

		it("returns null for @username that does not exist", () => {
			const ctx = createMockContext();
			const result = resolveTargetUser(ctx, ["@nonexistent"]);

			expect(result).toBeNull();
		});

		it("returns null for username that does not exist (no @)", () => {
			const ctx = createMockContext();
			const result = resolveTargetUser(ctx, ["nonexistent"]);

			expect(result).toBeNull();
		});
	});

	describe("reply-based resolution", () => {
		it("resolves user from reply-to when no args", () => {
			const ctx = createMockContext(99999, "replieduser");
			const result = resolveTargetUser(ctx, []);

			expect(result).not.toBeNull();
			expect(result?.userId).toBe(99999);
			expect(result?.username).toBe("replieduser");
			expect(result?.source).toBe("reply");
		});

		it("returns null when no args and no reply-to", () => {
			const ctx = createMockContext();
			const result = resolveTargetUser(ctx, []);

			expect(result).toBeNull();
		});
	});

	describe("fallback to reply-to for numeric args", () => {
		it("uses reply-to when numeric arg does not match existing user", () => {
			// The key fix: /jail 1000 when replying should use reply-to user
			const ctx = createMockContext(99999, "replieduser");
			const result = resolveTargetUser(ctx, ["1000"]);

			expect(result).not.toBeNull();
			expect(result?.userId).toBe(99999);
			expect(result?.username).toBe("replieduser");
			expect(result?.source).toBe("reply");
		});

		it("uses arg when numeric arg matches existing user", () => {
			const ctx = createMockContext(99999, "replieduser");
			const result = resolveTargetUser(ctx, ["12345"]);

			// Should use args, not reply-to, because user 12345 exists
			expect(result).not.toBeNull();
			expect(result?.userId).toBe(12345);
			expect(result?.source).toBe("args");
		});

		it("returns null for numeric arg when no user exists and no reply-to", () => {
			const ctx = createMockContext();
			const result = resolveTargetUser(ctx, ["1000"]);

			expect(result).toBeNull();
		});
	});

	describe("no fallback for @username references", () => {
		it("does not fallback to reply-to when @username does not exist", () => {
			// @nonexistent should fail, not use reply-to
			const ctx = createMockContext(99999, "replieduser");
			const result = resolveTargetUser(ctx, ["@nonexistent"]);

			expect(result).toBeNull();
		});
	});
});

describe("getRemainingArgs", () => {
	it("returns all args when source is reply", () => {
		const result: TargetUserResult = {
			userId: 99999,
			username: "replieduser",
			source: "reply",
		};
		const remaining = getRemainingArgs(["1000"], result);

		expect(remaining).toEqual(["1000"]);
	});

	it("skips first arg when source is args", () => {
		const result: TargetUserResult = {
			userId: 12345,
			username: "alice",
			source: "args",
		};
		const remaining = getRemainingArgs(["@alice", "1000"], result);

		expect(remaining).toEqual(["1000"]);
	});

	it("returns all args when result is null", () => {
		const remaining = getRemainingArgs(["1000"], null);

		expect(remaining).toEqual(["1000"]);
	});
});
