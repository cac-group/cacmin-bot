import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDuelCommands } from "../../src/commands/duel";
import { DuelService } from "../../src/services/duelService";
import { LedgerService } from "../../src/services/ledgerService";
import { createMockContext, getReplyText } from "../helpers/mockContext";

vi.mock("../../src/services/duelService", () => ({
	DEFAULT_CONSEQUENCE_DURATIONS: {
		none: 0,
		jail: 60,
		muted: 30,
		no_stickers: 60,
		no_media: 60,
		no_gifs: 60,
		no_forwarding: 60,
	},
	DuelService: {
		initialize: vi.fn(),
		getRecentDuels: vi.fn(),
	},
	MAX_WAGER: 50,
	MIN_WAGER: 0.1,
}));

vi.mock("../../src/utils/userResolver", () => ({
	formatUserIdDisplay: vi.fn((userId: number) => `user_${userId}`),
	resolveUserId: vi.fn(),
}));

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: {
		getUserBalance: vi.fn(),
	},
}));

describe("duel commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function createCommandRegistry() {
		const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
		const bot = {
			command: vi.fn((name: string, ...handlers: any[]) => {
				commands.set(name, handlers[handlers.length - 1]);
			}),
			action: vi.fn(),
		};

		registerDuelCommands(bot as any);
		return commands;
	}

	it("labels the caller's roll clearly in duel history when they were the opponent", async () => {
		const commands = createCommandRegistry();
		const handler = commands.get("duelhistory");
		const ctx = createMockContext({
			userId: 999,
			username: "opponent",
			messageText: "/duelhistory 3",
		});

		vi.mocked(DuelService.getRecentDuels).mockReturnValue([
			{
				id: 7,
				challengerId: 111,
				opponentId: 999,
				wagerAmount: 5,
				loserConsequence: "no_media",
				consequenceDuration: 60,
				status: "completed",
				winnerId: 999,
				loserId: 111,
				rollChallenger: "111111111",
				rollOpponent: "222222222",
				chatId: -100,
				createdAt: 1_700_000_000,
				expiresAt: 1_700_000_300,
				resolvedAt: 1_700_000_100,
			},
		] as any);

		await handler?.(ctx as any);

		expect(getReplyText(ctx)).toContain("Rolls: You 222222222 vs Opponent 111111111");
	});

	it("shows the explicit username-or-userId syntax in duel help", async () => {
		const commands = createCommandRegistry();
		const handler = commands.get("duel");
		const ctx = createMockContext({
			userId: 999,
			username: "challenger",
			messageText: "/duel",
		});

		vi.mocked(LedgerService.getUserBalance).mockResolvedValue(12.5);

		await handler?.(ctx as any);

		expect(getReplyText(ctx)).toContain("/duel <@username|userId> <amount>");
	});
});
