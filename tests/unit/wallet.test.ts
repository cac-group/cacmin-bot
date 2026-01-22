import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Core wallet command tests
 * Tests essential user-facing wallet operations
 */

import { createPlebContext, getReplyText, getAllReplies } from "../helpers/mockContext";

vi.mock("../../src/database", () => ({
	query: vi.fn(() => []),
	execute: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
	get: vi.fn(() => undefined),
	initDb: vi.fn(),
}));

vi.mock("../../src/config", () => ({
	config: {
		databasePath: ":memory:",
		botToken: "test-token",
		groupChatId: "-100123456789",
		botTreasuryAddress: "juno1testtreasuryaddress",
		userFundsAddress: "juno1testuserfundsaddress",
		adminChatId: "123456789",
		ownerIds: [111111111],
	},
}));

vi.mock("../../src/services/unifiedWalletService", () => ({
	UnifiedWalletService: {
		getBalance: vi.fn(),
		getDepositInstructions: vi.fn(),
		processWithdrawal: vi.fn(),
		transferToUser: vi.fn(),
		sendToUsername: vi.fn(),
	},
}));

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: { getUserBalance: vi.fn() },
}));

vi.mock("../../src/services/transactionLock");
vi.mock("../../src/utils/roles", () => ({ checkIsElevated: vi.fn() }));
vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: {
		logError: vi.fn(),
		logUserAction: vi.fn(),
		logTransaction: vi.fn(),
		logWalletAction: vi.fn(),
	},
}));

import { UnifiedWalletService } from "../../src/services/unifiedWalletService";
import * as walletHandlers from "../../src/handlers/wallet";

describe("Wallet Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should handle balance and deposit commands", async () => {
		// Balance with funds
		let ctx = createPlebContext({ messageText: "/balance" });
		(UnifiedWalletService.getBalance as any).mockResolvedValue(100.5);
		await walletHandlers.handleBalance(ctx as any);
		expect(getReplyText(ctx)).toContain("100.5");

		// Balance with zero
		ctx = createPlebContext({ messageText: "/balance" });
		(UnifiedWalletService.getBalance as any).mockResolvedValue(0);
		await walletHandlers.handleBalance(ctx as any);
		expect(getReplyText(ctx)).toContain("0");

		// Deposit instructions
		ctx = createPlebContext({ messageText: "/deposit" });
		(UnifiedWalletService.getDepositInstructions as any).mockReturnValue({
			address: "juno1testuserfundsaddress",
			memo: "444444444",
		});
		await walletHandlers.handleDeposit(ctx as any);
		const allText = getAllReplies(ctx).join(" ");
		expect(allText).toContain("juno1testuserfundsaddress");
		expect(allText).toContain("444444444");
	});

	it("should handle withdraw command validation and processing", async () => {
		// Valid withdrawal
		let ctx = createPlebContext({
			messageText: "/withdraw 10 juno1validaddress123456789012345678901234567890",
		});
		(UnifiedWalletService.getBalance as any).mockResolvedValue(100);
		(UnifiedWalletService.processWithdrawal as any).mockResolvedValue({
			success: true,
			txHash: "ABC123",
			newBalance: 90,
		});
		await walletHandlers.handleWithdraw(ctx as any);
		expect(UnifiedWalletService.processWithdrawal).toHaveBeenCalled();

		// Invalid amount
		vi.clearAllMocks();
		ctx = createPlebContext({ messageText: "/withdraw -10 juno1validaddress" });
		await walletHandlers.handleWithdraw(ctx as any);
		expect(UnifiedWalletService.processWithdrawal).not.toHaveBeenCalled();
		expect(getReplyText(ctx)).toContain("Invalid amount");

		// Missing arguments
		ctx = createPlebContext({ messageText: "/withdraw" });
		await walletHandlers.handleWithdraw(ctx as any);
		expect(getReplyText(ctx)).toContain("Usage");
	});

	it("should handle send command validation and processing", async () => {
		// Valid transfer
		let ctx = createPlebContext({ messageText: "/send 50 555555555" });
		(UnifiedWalletService.getBalance as any).mockResolvedValue(100);
		(UnifiedWalletService.transferToUser as any).mockResolvedValue({
			success: true,
			fromBalance: 50,
		});
		await walletHandlers.handleSend(ctx as any);
		expect(UnifiedWalletService.transferToUser).toHaveBeenCalled();

		// Self-send rejection
		vi.clearAllMocks();
		ctx = createPlebContext({ messageText: "/send 50 444444444" });
		(UnifiedWalletService.getBalance as any).mockResolvedValue(100);
		await walletHandlers.handleSend(ctx as any);
		expect(getReplyText(ctx)).toContain("cannot send tokens to yourself");

		// Missing arguments
		ctx = createPlebContext({ messageText: "/send" });
		await walletHandlers.handleSend(ctx as any);
		expect(getReplyText(ctx)).toContain("Usage");
	});
});
