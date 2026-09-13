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
	findUserIdByUsername,
	getUserIdByUsername,
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
});
