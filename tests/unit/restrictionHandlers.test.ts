import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerRestrictionHandlers } from "../../src/handlers/restrictions";
import {
	removeAllUserRestrictions,
	removeUserRestriction,
} from "../../src/services/userService";
import { createAdminContext, wasTextReplied } from "../helpers/mockContext";

const { resolveTargetUserMock, getRemainingArgsMock } = vi.hoisted(() => ({
	resolveTargetUserMock: vi.fn(),
	getRemainingArgsMock: vi.fn(),
}));

vi.mock("../../src/middleware", () => ({
	adminOrHigher: vi.fn(),
	elevatedOrHigher: vi.fn(),
}));

vi.mock("../../src/services/userService", () => ({
	addUserRestriction: vi.fn(),
	getUserRestrictions: vi.fn(() => []),
	removeUserRestriction: vi.fn(),
	removeAllUserRestrictions: vi.fn(),
}));

vi.mock("../../src/utils/userResolver", () => ({
	resolveTargetUser: resolveTargetUserMock,
	getRemainingArgs: getRemainingArgsMock,
}));

vi.mock("../../src/utils/roles", () => ({
	isImmuneToModeration: vi.fn(() => false),
}));

vi.mock("../../src/utils/logger", () => ({
	StructuredLogger: {
		logSecurityEvent: vi.fn(),
		logError: vi.fn(),
		logUserAction: vi.fn(),
	},
}));

describe("restriction removal handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function createCommandRegistry() {
		const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
		const bot = {
			command: vi.fn((name: string, ...handlers: any[]) => {
				commands.set(name, handlers[handlers.length - 1]);
			}),
		};

		registerRestrictionHandlers(bot as any);
		return commands;
	}

	it("should remove all restrictions when /removerestriction is called without a type", async () => {
		const commands = createCommandRegistry();
		const handler = commands.get("removerestriction");
		const ctx = createAdminContext({
			messageText: "/removerestriction @SithLOrdX",
		});

		resolveTargetUserMock.mockReturnValue({
			userId: 123456,
			username: "SithLOrdX",
		});
		getRemainingArgsMock.mockReturnValue([]);
		vi.mocked(removeAllUserRestrictions).mockReturnValue(3);

		await handler?.(ctx as any);

		expect(removeAllUserRestrictions).toHaveBeenCalledWith(123456);
		expect(removeUserRestriction).not.toHaveBeenCalled();
		expect(wasTextReplied(ctx, "Removed 3 restriction(s)")).toBe(true);
	});

	it("should remove all restrictions when /clearrestrictions is used", async () => {
		const commands = createCommandRegistry();
		const handler = commands.get("clearrestrictions");
		const ctx = createAdminContext({
			messageText: "/clearrestrictions @SithLOrdX",
		});

		resolveTargetUserMock.mockReturnValue({
			userId: 123456,
			username: "SithLOrdX",
		});
		getRemainingArgsMock.mockReturnValue([]);
		vi.mocked(removeAllUserRestrictions).mockReturnValue(2);

		await handler?.(ctx as any);

		expect(removeAllUserRestrictions).toHaveBeenCalledWith(123456);
		expect(wasTextReplied(ctx, "Removed 2 restriction(s)")).toBe(true);
	});

	it("should still remove a specific restriction when a type is provided", async () => {
		const commands = createCommandRegistry();
		const handler = commands.get("removerestriction");
		const ctx = createAdminContext({
			messageText: "/removerestriction @SithLOrdX random_delete",
		});

		resolveTargetUserMock.mockReturnValue({
			userId: 123456,
			username: "SithLOrdX",
		});
		getRemainingArgsMock.mockReturnValue(["random_delete"]);
		vi.mocked(removeUserRestriction).mockReturnValue(1);

		await handler?.(ctx as any);

		expect(removeUserRestriction).toHaveBeenCalledWith(
			123456,
			"random_delete",
		);
		expect(removeAllUserRestrictions).not.toHaveBeenCalled();
		expect(wasTextReplied(ctx, "Restriction 'random_delete' removed")).toBe(
			true,
		);
	});
});
