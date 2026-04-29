import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestrictionService } from "../../src/services/restrictionService";
import { createViolation } from "../../src/services/violationService";
import { createMockContext, wasTextReplied } from "../helpers/mockContext";

const { executeMock, queryMock } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	executeMock: vi.fn(),
}));

vi.mock("../../src/database", () => ({
	query: queryMock,
	execute: executeMock,
}));

vi.mock("../../src/services/violationService", () => ({
	createViolation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/jailService", () => ({
	JailService: {
		logJailEvent: vi.fn(),
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

describe("RestrictionService random_delete", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	it("should create a violation and delete a message when random_delete triggers", async () => {
		const ctx = createMockContext({
			userId: 123456789,
			messageText: "one two three four five six seven",
		});
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.01);

		queryMock.mockImplementation((sql: string) => {
			if (sql.includes("FROM user_restrictions")) {
				return [
					{
						id: 1,
						userId: 123456789,
						restriction: "random_delete",
						restrictedAction: "100%",
						metadata: null,
						restrictedUntil: null,
						severity: "delete",
						violationThreshold: 5,
						autoJailDuration: 2880,
						autoJailFine: 10,
						fineAmount: 0,
						customMessage: null,
						createdAt: 0,
					},
				];
			}

			if (sql.includes("FROM violations")) {
				return [{ id: 1 }];
			}

			return [];
		});

		const violated = await RestrictionService.checkMessage(
			ctx as any,
			(ctx as any).message,
			{ role: "pleb" } as any,
		);

		expect(violated).toBe(true);
		expect(createViolation).toHaveBeenCalledWith(
			123456789,
			"random_delete",
			"one two three four five six seven",
		);
		expect((ctx.deleteMessage as any).mock.calls.length).toBe(1);
		expect(wasTextReplied(ctx as any, "random_delete")).toBe(true);

		randomSpy.mockRestore();
	});

	it("should ignore random_delete when the message is too short", async () => {
		const ctx = createMockContext({
			userId: 123456789,
			messageText: "one two three four five",
		});
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.01);

		queryMock.mockImplementation((sql: string) => {
			if (sql.includes("FROM user_restrictions")) {
				return [
					{
						id: 1,
						userId: 123456789,
						restriction: "random_delete",
						restrictedAction: "100%",
						metadata: null,
						restrictedUntil: null,
						severity: "delete",
						violationThreshold: 5,
						autoJailDuration: 2880,
						autoJailFine: 10,
						fineAmount: 0,
						customMessage: null,
						createdAt: 0,
					},
				];
			}

			return [];
		});

		const violated = await RestrictionService.checkMessage(
			ctx as any,
			(ctx as any).message,
			{ role: "pleb" } as any,
		);

		expect(violated).toBe(false);
		expect(createViolation).not.toHaveBeenCalled();
		expect((ctx.deleteMessage as any).mock.calls.length).toBe(0);

		randomSpy.mockRestore();
	});
});
