import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, executeMock, listMock, recordProfileMock, updateUsernameMock } =
	vi.hoisted(() => ({
		getMock: vi.fn(),
		executeMock: vi.fn(),
		listMock: vi.fn(),
		recordProfileMock: vi.fn(),
		updateUsernameMock: vi.fn(),
	}));

vi.mock("../../src/database", () => ({
	get: getMock,
	execute: executeMock,
}));

vi.mock("../../src/config", () => ({
	config: { groupChatId: -100123456789 },
}));

vi.mock("../../src/services/chatInteractionIndexerService", () => ({
	ChatInteractionIndexerService: {
		listUsersMissingUsername: listMock,
		recordProfile: recordProfileMock,
	},
}));

vi.mock("../../src/services/userService", () => ({
	updateExistingUserUsername: updateUsernameMock,
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	StructuredLogger: { logError: vi.fn(), logDebug: vi.fn() },
}));

import { IdentityCrawlService } from "../../src/services/identityCrawlService";

function fakeBot(getChatMember: (chatId: number, userId: number) => unknown) {
	return { telegram: { getChatMember } } as never;
}

function writes(): string[] {
	return executeMock.mock.calls.map((call) => String(call[1]?.[1]));
}

describe("IdentityCrawlService rate limiting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getMock.mockImplementation((_sql: string, params: unknown[]) => {
			if (params?.[0] === "identity_crawl_cursor") return { value: "0" };
			return undefined;
		});
	});

	it("honors a 429 retry_after and retries the same user", async () => {
		listMock.mockReturnValue([111]);
		const getChatMember = vi
			.fn()
			.mockRejectedValueOnce({ code: 429, parameters: { retry_after: 0 } })
			.mockResolvedValueOnce({
				user: { id: 111, username: "alice", first_name: "A" },
			});

		const result = await IdentityCrawlService.runBatch(fakeBot(getChatMember), 10);

		expect(getChatMember).toHaveBeenCalledTimes(2);
		expect(result.filled).toBe(1);
		expect(result.unavailable).toBe(0);
		expect(updateUsernameMock).toHaveBeenCalledWith(111, "alice");
	});

	it("pauses without advancing the cursor when 429 persists", async () => {
		listMock.mockReturnValue([222]);
		const getChatMember = vi
			.fn()
			.mockRejectedValue({ code: 429, parameters: { retry_after: 0 } });

		const result = await IdentityCrawlService.runBatch(fakeBot(getChatMember), 10);

		expect(result.error).toMatch(/rate limited/i);
		expect(result.filled).toBe(0);
		expect(getChatMember.mock.calls.length).toBeGreaterThan(1);
		// Cursor stays at the last fully resolved id (the starting cursor, 0).
		expect(writes()).toContain("0");
	});

	it("skips definitive failures and advances past them", async () => {
		listMock.mockReturnValue([333]);
		const getChatMember = vi
			.fn()
			.mockRejectedValue({ code: 400, description: "user not found" });

		const result = await IdentityCrawlService.runBatch(fakeBot(getChatMember), 10);

		expect(getChatMember).toHaveBeenCalledTimes(1);
		expect(result.unavailable).toBe(1);
		expect(writes()).toContain("333");
	});
});
