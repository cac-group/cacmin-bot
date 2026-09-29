import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, executeMock } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	executeMock: vi.fn(),
}));

vi.mock("../../src/database", () => ({
	execute: executeMock,
	query: queryMock,
	get: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
	StructuredLogger: {
		logUserAction: vi.fn(),
		logSecurityEvent: vi.fn(),
		logTransaction: vi.fn(),
		logError: vi.fn(),
		logDebug: vi.fn(),
	},
}));

import {
	ensureUserExists,
	findUserIdByUsername,
	getUserIdByUsername,
	isPlaceholderUsername,
	normalizeUsernameForStorage,
	updateExistingUserUsername,
} from "../../src/services/userService";

describe("findUserIdByUsername", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the single matching user id", () => {
		queryMock.mockReturnValue([{ id: 42 }]);
		expect(findUserIdByUsername("@Alice")).toBe(42);
		expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
			"alice",
			"alice",
		]);
	});

	it("returns null when a username maps to multiple accounts (reused)", () => {
		queryMock.mockReturnValue([{ id: 42 }, { id: 99 }]);
		expect(findUserIdByUsername("alice")).toBeNull();
	});

	it("deduplicates the same id from current name and alias", () => {
		queryMock.mockReturnValue([{ id: 42 }, { id: 42 }]);
		expect(findUserIdByUsername("alice")).toBe(42);
	});

	it("returns null for empty input without querying", () => {
		expect(findUserIdByUsername("@")).toBeNull();
		expect(queryMock).not.toHaveBeenCalled();
	});

	it("getUserIdByUsername delegates to the same resolution", () => {
		queryMock.mockReturnValue([{ id: 7 }]);
		expect(getUserIdByUsername("bob")).toBe(7);
	});

	it("rejects generated placeholder usernames", () => {
		expect(isPlaceholderUsername("unknown")).toBe(true);
		expect(isPlaceholderUsername("@user_123")).toBe(true);
		expect(isPlaceholderUsername("alice")).toBe(false);
		expect(findUserIdByUsername("unknown")).toBeNull();
		expect(findUserIdByUsername("user_123")).toBeNull();
		expect(queryMock).not.toHaveBeenCalled();
	});
});

describe("normalizeUsernameForStorage", () => {
	it("keeps real handles and strips a leading @", () => {
		expect(normalizeUsernameForStorage("@alice")).toBe("alice");
		expect(normalizeUsernameForStorage("bob")).toBe("bob");
	});
	it("returns null for missing or placeholder values", () => {
		expect(normalizeUsernameForStorage(undefined)).toBeNull();
		expect(normalizeUsernameForStorage(null)).toBeNull();
		expect(normalizeUsernameForStorage("")).toBeNull();
		expect(normalizeUsernameForStorage("   ")).toBeNull();
		expect(normalizeUsernameForStorage("unknown")).toBeNull();
		expect(normalizeUsernameForStorage("user_123")).toBeNull();
	});
});

describe("ensureUserExists placeholder usernames", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("stores NULL (not a sentinel) when creating a user without a real handle", () => {
		queryMock.mockReturnValue([]);
		ensureUserExists(5, `user_${5}`);
		const insert = executeMock.mock.calls.find((call) =>
			String(call[0]).includes("INSERT INTO users"),
		);
		expect(insert).toBeDefined();
		expect(insert?.[1]?.[1]).toBeNull();
	});

	it("clears a legacy placeholder when the user has no real handle", () => {
		queryMock.mockReturnValue([{ id: 5, username: "unknown" }]);
		ensureUserExists(5, "unknown");
		const update = executeMock.mock.calls.find((call) =>
			String(call[0]).includes("UPDATE users SET username"),
		);
		expect(update?.[1]?.[0]).toBeNull();
	});

	it("never records a placeholder as a username alias", () => {
		queryMock.mockReturnValue([{ id: 5, username: "unknown" }]);
		ensureUserExists(5, "newname");
		const aliased = executeMock.mock.calls.some((call) =>
			String(call[0]).includes("user_aliases"),
		);
		expect(aliased).toBe(false);
	});
});

describe("updateExistingUserUsername", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("updates an existing user and keeps the old name as an alias", () => {
		queryMock.mockReturnValue([{ username: "oldname" }]);
		updateExistingUserUsername(5, "newname");
		const sqls = executeMock.mock.calls.map((call) => String(call[0]));
		expect(sqls.some((sql) => sql.includes("user_aliases"))).toBe(true);
		expect(
			executeMock.mock.calls.some((call) => call[1]?.[0] === "newname"),
		).toBe(true);
	});

	it("does nothing for a missing user or a placeholder username", () => {
		queryMock.mockReturnValue([]);
		updateExistingUserUsername(5, "newname");
		updateExistingUserUsername(5, "user_5");
		expect(executeMock).not.toHaveBeenCalled();
	});
});
