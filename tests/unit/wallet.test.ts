import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Core wallet functionality tests
 * Tests essential wallet operations: balance, deposit, withdraw, transfer
 */

import {
	createPlebContext,
	getReplyText,
	getAllReplies,
} from "../helpers/mockContext";

// Mock database
vi.mock("../../src/database", () => ({
	query: vi.fn(() => []),
	execute: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
	get: vi.fn(() => undefined),
	initDb: vi.fn(),
}));

// Mock config
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

// Mock services
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
	LedgerService: {
		getUserBalance: vi.fn(),
	},
}));

vi.mock("../../src/services/transactionLock");
vi.mock("../../src/utils/roles", () => ({
	checkIsElevated: vi.fn(),
}));
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

	describe("/balance", () => {
		it("should show user balance", async () => {
			const ctx = createPlebContext({ messageText: "/balance" });
			(UnifiedWalletService.getBalance as any).mockResolvedValue(100.5);

			await walletHandlers.handleBalance(ctx as any);

			expect(UnifiedWalletService.getBalance).toHaveBeenCalledWith(444444444);
			expect(getReplyText(ctx)).toContain("100.5");
		});

		it("should show zero balance for new user", async () => {
			const ctx = createPlebContext({ messageText: "/balance" });
			(UnifiedWalletService.getBalance as any).mockResolvedValue(0);

			await walletHandlers.handleBalance(ctx as any);

			expect(getReplyText(ctx)).toContain("0");
		});
	});

	describe("/deposit", () => {
		it("should show deposit instructions with memo", async () => {
			const ctx = createPlebContext({ messageText: "/deposit" });
			(UnifiedWalletService.getDepositInstructions as any).mockReturnValue({
				address: "juno1testuserfundsaddress",
				memo: "444444444",
			});

			await walletHandlers.handleDeposit(ctx as any);

			const replies = getAllReplies(ctx);
			const allText = replies.join(" ");
			expect(allText).toContain("juno1testuserfundsaddress");
			expect(allText).toContain("444444444");
		});
	});

	describe("/withdraw", () => {
		it("should process valid withdrawal", async () => {
			const ctx = createPlebContext({
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
		});

		it("should reject withdrawal with invalid amount", async () => {
			const ctx = createPlebContext({
				messageText: "/withdraw -10 juno1validaddress",
			});

			await walletHandlers.handleWithdraw(ctx as any);

			expect(UnifiedWalletService.processWithdrawal).not.toHaveBeenCalled();
			expect(getReplyText(ctx)).toContain("Invalid amount");
		});

		it("should show usage when missing arguments", async () => {
			const ctx = createPlebContext({ messageText: "/withdraw" });

			await walletHandlers.handleWithdraw(ctx as any);

			expect(getReplyText(ctx)).toContain("Usage");
		});
	});

	describe("/send", () => {
		it("should transfer to another user by ID", async () => {
			const ctx = createPlebContext({ messageText: "/send 50 555555555" });
			(UnifiedWalletService.getBalance as any).mockResolvedValue(100);
			(UnifiedWalletService.transferToUser as any).mockResolvedValue({
				success: true,
				fromBalance: 50,
			});

			await walletHandlers.handleSend(ctx as any);

			expect(UnifiedWalletService.transferToUser).toHaveBeenCalled();
		});

		it("should reject sending to self", async () => {
			const ctx = createPlebContext({ messageText: "/send 50 444444444" });
			(UnifiedWalletService.getBalance as any).mockResolvedValue(100);

			await walletHandlers.handleSend(ctx as any);

			expect(getReplyText(ctx)).toContain("cannot send tokens to yourself");
		});

		it("should show usage when missing arguments", async () => {
			const ctx = createPlebContext({ messageText: "/send" });

			await walletHandlers.handleSend(ctx as any);

			expect(getReplyText(ctx)).toContain("Usage");
		});
	});
});
