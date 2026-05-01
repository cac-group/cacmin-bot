import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSharedAccountCommands } from "../../src/commands/sharedAccounts";
import { SharedAccountService } from "../../src/services/sharedAccountService";
import { UnifiedWalletService } from "../../src/services/unifiedWalletService";
import {
	createElevatedContext,
	wasTextReplied,
} from "../helpers/mockContext";

vi.mock("../../src/middleware", () => ({
	elevatedAdminOnly: vi.fn(),
}));

vi.mock("../../src/services/sharedAccountService", () => ({
	SharedAccountService: {
		createSharedAccount: vi.fn(),
		getSharedAccountByName: vi.fn(),
	},
}));

vi.mock("../../src/services/unifiedWalletService", () => ({
	UnifiedWalletService: {
		getSharedBalance: vi.fn(),
	},
}));

vi.mock("../../src/utils/userResolver", () => ({
	resolveUserId: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
	logger: {
		error: vi.fn(),
	},
	StructuredLogger: {
		logTransaction: vi.fn(),
	},
}));

describe("shared account commands", () => {
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

		registerSharedAccountCommands(bot as any);
		return commands;
	}

	it("preserves quoted display names and descriptions when creating a shared account", async () => {
		const commands = createCommandRegistry();
		const handler = commands.get("createshared");
		const ctx = createElevatedContext({
			messageText:
				'/createshared admin_pool "Admin Pool" "Shared treasury for admins"',
		});

		vi.mocked(SharedAccountService.createSharedAccount).mockResolvedValue(42);
		vi.mocked(UnifiedWalletService.getSharedBalance).mockResolvedValue(0);

		await handler?.(ctx as any);

		expect(SharedAccountService.createSharedAccount).toHaveBeenCalledWith(
			"admin_pool",
			"Admin Pool",
			"Shared treasury for admins",
			333333333,
		);
		expect(wasTextReplied(ctx, "Shared Account Created")).toBe(true);
	});
});
