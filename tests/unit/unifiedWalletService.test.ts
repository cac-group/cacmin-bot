import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendTokensMock, connectWithSignerMock } = vi.hoisted(() => ({
	sendTokensMock: vi.fn(),
	connectWithSignerMock: vi.fn(),
}));

vi.mock("@cosmjs/proto-signing", () => ({
	DirectSecp256k1HdWallet: {
		fromMnemonic: vi.fn(),
	},
}));

vi.mock("@cosmjs/stargate", () => ({
	GasPrice: {
		fromString: vi.fn((value: string) => value),
	},
	SigningStargateClient: {
		connectWithSigner: connectWithSignerMock,
	},
}));

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
		userFundsAddress: "juno1testuserfundsaddress000000000000000",
		junoRpcUrl: "https://rpc.example.com",
		junoApiUrl: "https://api.example.com",
	},
}));

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: {
		getUserBalanceMicro: vi.fn(),
		getUserBalance: vi.fn(),
		processWithdrawal: vi.fn(),
		processFee: vi.fn(),
		processGiveaway: vi.fn(),
		processAdjustment: vi.fn(),
		updateTransactionStatus: vi.fn(),
	},
}));

vi.mock("../../src/services/transactionLock", () => ({
	TransactionLockService: {
		lockWithdrawal: vi.fn(),
		releaseWithdrawalLock: vi.fn(),
		updateLockWithTxHash: vi.fn(),
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { LedgerService } from "../../src/services/ledgerService";
import {
	getWithdrawalNetworkFee,
	UnifiedWalletService,
} from "../../src/services/unifiedWalletService";
import { TransactionLockService } from "../../src/services/transactionLock";

describe("UnifiedWalletService withdrawal accounting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		connectWithSignerMock.mockResolvedValue({
			sendTokens: sendTokensMock,
		});
		sendTokensMock.mockResolvedValue({
			code: 0,
			transactionHash: "TX-123",
			rawLog: "",
		});

		(TransactionLockService.lockWithdrawal as any).mockResolvedValue({
			success: true,
			lockId: "wd-lock",
		});
		(TransactionLockService.updateLockWithTxHash as any).mockResolvedValue(
			undefined,
		);
		(TransactionLockService.releaseWithdrawalLock as any).mockResolvedValue({
			released: true,
		});

		(LedgerService.processWithdrawal as any).mockResolvedValue({
			success: true,
			newBalance: 5,
			transactionId: 7,
		});
		(LedgerService.processFee as any).mockResolvedValue({
			success: true,
			newBalance: 4.99025,
		});
		(LedgerService.processGiveaway as any).mockResolvedValue({
			success: true,
			newBalance: 15,
		});
		(LedgerService.updateTransactionStatus as any).mockResolvedValue(undefined);
		(LedgerService.getUserBalance as any).mockResolvedValue(4.99025);

		(UnifiedWalletService as any).wallet = {
			getAccounts: vi.fn().mockResolvedValue([
				{ address: `juno1${"s".repeat(38)}` },
			]),
		};
		(UnifiedWalletService as any).rpcEndpoint = "https://rpc.example.com";
	});

	it("charges the withdrawing user the fixed network fee instead of treasury", async () => {
		const fee = getWithdrawalNetworkFee();
		const totalMicro = 15_000_000;
		const recipientAddress = `juno1${"r".repeat(38)}`;

		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(totalMicro);

		const result = await UnifiedWalletService.processWithdrawal(12345, recipientAddress, 10);

		expect(result.success).toBe(true);
		expect(LedgerService.processWithdrawal).toHaveBeenCalledWith(
			12345,
			10,
			recipientAddress,
			undefined,
			`Withdrawal to ${recipientAddress}`,
		);
		expect(LedgerService.processFee).toHaveBeenCalledWith(
			12345,
			fee,
			`Network fee for withdrawal to ${recipientAddress}`,
		);
		expect(LedgerService.processAdjustment).not.toHaveBeenCalled();
		expect(sendTokensMock).toHaveBeenCalledOnce();

		const feeArg = sendTokensMock.mock.calls[0][3];
		expect(feeArg).toEqual({
			amount: [{ denom: "ujuno", amount: "9750" }],
			gas: "130000",
		});
	});

	it("requires enough balance to cover the withdrawal amount plus the network fee", async () => {
		const fee = getWithdrawalNetworkFee();
		const insufficientMicro = 10_000_000 + Math.round((fee - 0.000001) * 1_000_000);
		const recipientAddress = `juno1${"r".repeat(38)}`;

		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(insufficientMicro);

		const result = await UnifiedWalletService.processWithdrawal(12345, recipientAddress, 10);

		expect(result.success).toBe(false);
		expect(result.error).toContain("network fee");
		expect(LedgerService.processWithdrawal).not.toHaveBeenCalled();
		expect(LedgerService.processFee).not.toHaveBeenCalled();
		expect(sendTokensMock).not.toHaveBeenCalled();
	});

	it("refunds only the transfer amount when the withdrawal tx is rejected on-chain", async () => {
		const fee = getWithdrawalNetworkFee();
		const recipientAddress = `juno1${"r".repeat(38)}`;

		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(15_000_000);
		(LedgerService.getUserBalance as any).mockResolvedValue(4.99025);
		sendTokensMock.mockResolvedValue({
			code: 5,
			transactionHash: "TX-FAILED",
			rawLog: "insufficient fee",
		});

		const result = await UnifiedWalletService.processWithdrawal(
			12345,
			recipientAddress,
			10,
		);

		expect(result.success).toBe(false);
		expect(LedgerService.processFee).toHaveBeenCalledWith(
			12345,
			fee,
			`Network fee for withdrawal to ${recipientAddress}`,
		);
		expect(LedgerService.processGiveaway).toHaveBeenCalledWith(
			12345,
			10,
			"Withdrawal refund - transaction rejected",
		);
		expect(TransactionLockService.releaseWithdrawalLock).toHaveBeenCalledWith(
			12345,
			"TX-FAILED",
			true,
		);
	});
});
