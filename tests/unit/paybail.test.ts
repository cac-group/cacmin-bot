import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerJailCommands } from "../../src/commands/jail";
import { get } from "../../src/database";
import { JailService } from "../../src/services/jailService";
import { JunoService } from "../../src/services/junoService";
import { LedgerService } from "../../src/services/ledgerService";
import { SYSTEM_USER_IDS } from "../../src/services/unifiedWalletService";
import { resolveTargetUser } from "../../src/utils/userResolver";
import { createMockContext, getReplyText } from "../helpers/mockContext";

vi.mock("../../src/database", () => ({
	execute: vi.fn(),
	get: vi.fn(),
	query: vi.fn(),
}));

vi.mock("../../src/services/jailService", () => ({
	JailService: {
		getActiveJails: vi.fn(() => []),
		getActiveJailing: vi.fn(() => null),
		getCurrentBailAmount: vi.fn(),
		getJailingByPublicId: vi.fn(() => null),
		getUserJailEvents: vi.fn(() => []),
		isBailPaymentUsed: vi.fn(() => false),
		payJailing: vi.fn(() => ({ success: true, duplicate: false })),
	},
}));

vi.mock("../../src/services/junoService", () => ({
	JunoService: {
		getPaymentAddress: vi.fn(() => "juno1testaddress"),
		verifyPayment: vi.fn(() => true),
	},
}));

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: {
		processAdjustment: vi.fn(async () => ({ success: true, newBalance: 0 })),
	},
}));

vi.mock("../../src/services/unifiedWalletService", () => ({
	SYSTEM_USER_IDS: { BOT_TREASURY: -1, SYSTEM_RESERVE: -2 },
}));

vi.mock("../../src/services/chatIndexerService", () => ({
	ChatIndexerService: { getActiveTimeStats: vi.fn(() => null) },
}));

vi.mock("../../src/services/chatMuteService", () => ({
	releaseMember: vi.fn(),
}));

vi.mock("../../src/middleware/index", () => ({
	adminOrHigher: vi.fn(),
	elevatedOrHigher: vi.fn(),
}));

vi.mock("../../src/utils/autoDelete", () => ({
	autoDeleteInGroup: vi.fn(),
}));

vi.mock("../../src/utils/userResolver", () => ({
	formatUserIdDisplay: vi.fn((id: number) => `user_${id}`),
	getRemainingArgs: vi.fn(() => []),
	resolveTargetUser: vi.fn(() => null),
	resolveUserId: vi.fn(),
}));

function handlerFor(name: string): (ctx: unknown) => Promise<unknown> {
	const commands = new Map<string, (ctx: unknown) => Promise<unknown>>();
	const bot = {
		command: vi.fn((commandName: string, ...handlers: unknown[]) => {
			commands.set(commandName, handlers[handlers.length - 1] as never);
		}),
		action: vi.fn(),
	};
	registerJailCommands(bot as never);
	return commands.get(name) as (ctx: unknown) => Promise<unknown>;
}

describe("paybail", () => {
	beforeEach(() => vi.clearAllMocks());

	it("prints the payment address instead of [object Object]", async () => {
		const now = Math.floor(Date.now() / 1000);
		vi.mocked(get).mockReturnValue({
			id: 42,
			muted_until: now + 3600,
		} as never);
		vi.mocked(JailService.getCurrentBailAmount).mockReturnValue(69.42);
		vi.mocked(JailService.getActiveJailing).mockReturnValue({
			id: 1,
			jailingId: "JAIL1234",
			userId: 42,
			bailAmount: 69.42,
			paid: false,
			mutedUntil: now + 3600,
		});

		const ctx = createMockContext({
			userId: 42,
			chatType: "private",
			messageText: "/paybail",
		});

		await handlerFor("paybail")(ctx);

		const text = getReplyText(ctx);
		expect(text).toContain("juno1testaddress");
		expect(text).toContain("69.420 JUNO");
		expect(text).toContain("JAIL1234");
		expect(text).toContain("MEMO");
		expect(text).not.toContain("[object Object]");
	});
});

describe("payallfines (admin reserve bail)", () => {
	beforeEach(() => vi.clearAllMocks());

	const now = Math.floor(Date.now() / 1000);

	it("debits SYSTEM_RESERVE (never BOT_TREASURY) and releases the user", async () => {
		vi.mocked(resolveTargetUser).mockReturnValue({ userId: 7 } as never);
		vi.mocked(JailService.getActiveJailing).mockReturnValue({
			id: 1,
			jailingId: "JAIL7ABC",
			userId: 7,
			bailAmount: 69.42,
			paid: false,
			mutedUntil: now + 3600,
		});
		vi.mocked(JailService.payJailing).mockReturnValue({
			success: true,
			duplicate: false,
			userId: 7,
		});

		const ctx = createMockContext({
			userId: 999,
			chatType: "private",
			messageText: "/payallfines 7",
		});
		await handlerFor("payallfines")(ctx);

		expect(LedgerService.processAdjustment).toHaveBeenCalledWith(
			SYSTEM_USER_IDS.SYSTEM_RESERVE,
			-69.42,
			expect.any(String),
		);
		const accountIds = vi
			.mocked(LedgerService.processAdjustment)
			.mock.calls.map((call) => call[0]);
		expect(accountIds).not.toContain(SYSTEM_USER_IDS.BOT_TREASURY);
		expect(getReplyText(ctx)).toContain("Bail Paid from Reserve");
	});

	it("does not debit the reserve when the target has no active jailing", async () => {
		vi.mocked(resolveTargetUser).mockReturnValue({ userId: 7 } as never);
		vi.mocked(JailService.getActiveJailing).mockReturnValue(null);

		const ctx = createMockContext({
			userId: 999,
			chatType: "private",
			messageText: "/payallfines 7",
		});
		await handlerFor("payallfines")(ctx);

		expect(LedgerService.processAdjustment).not.toHaveBeenCalled();
	});

	it("refunds the reserve when recording the bail fails", async () => {
		vi.mocked(resolveTargetUser).mockReturnValue({ userId: 7 } as never);
		vi.mocked(JailService.getActiveJailing).mockReturnValue({
			id: 1,
			jailingId: "JAIL7ABC",
			userId: 7,
			bailAmount: 69.42,
			paid: false,
			mutedUntil: now + 3600,
		});
		vi.mocked(JailService.payJailing).mockReturnValue({
			success: false,
			duplicate: false,
		});

		const ctx = createMockContext({
			userId: 999,
			chatType: "private",
			messageText: "/payallfines 7",
		});
		await handlerFor("payallfines")(ctx);

		expect(LedgerService.processAdjustment).toHaveBeenNthCalledWith(
			1,
			SYSTEM_USER_IDS.SYSTEM_RESERVE,
			-69.42,
			expect.any(String),
		);
		expect(LedgerService.processAdjustment).toHaveBeenNthCalledWith(
			2,
			SYSTEM_USER_IDS.SYSTEM_RESERVE,
			69.42,
			expect.any(String),
		);
	});
});
