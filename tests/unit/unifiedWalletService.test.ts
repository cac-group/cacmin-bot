import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	junoSendTokensMock,
	junoWaitForTransactionMock,
	osmosisSendTokensMock,
	osmosisWaitForTransactionMock,
} = vi.hoisted(() => ({
	junoSendTokensMock: vi.fn(),
	junoWaitForTransactionMock: vi.fn(),
	osmosisSendTokensMock: vi.fn(),
	osmosisWaitForTransactionMock: vi.fn(),
}));

vi.mock("../../src/database", () => ({
	query: vi.fn(() => []),
	execute: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
	get: vi.fn(() => undefined),
	initDb: vi.fn(),
}));

vi.mock("../../src/config", () => ({
	config: {
		juno: {
			grpcUrl: "juno-grpc.example.com:12690",
			chainId: "juno-1",
			confirmTimeoutMs: 1000,
		},
		databasePath: ":memory:",
		botToken: "test-token",
		groupChatId: "-100123456789",
		botTreasuryAddress: "juno1testtreasuryaddress",
		userFundsAddress: "juno1testuserfundsaddress000000000000000",
		chain: { withdrawalGasPrice: "0.075ujuno", withdrawalGasLimit: 130000 },
	},
}));

vi.mock("../../src/services/ledgerService", () => ({
	TransactionStatus: {
		PENDING: "pending",
		COMPLETED: "completed",
		FAILED: "failed",
	},
	LedgerService: {
		getUserBalanceMicro: vi.fn(),
		getUserBalance: vi.fn(),
		processWithdrawal: vi.fn(),
		processFee: vi.fn(),
		processRefund: vi.fn(),
		processAdjustment: vi.fn(),
		updateTransactionStatus: vi.fn(),
	},
}));

vi.mock("../../src/services/junoGrpcService", () => ({
	JunoGrpcService: {
		sendTokens: junoSendTokensMock,
		waitForTransaction: junoWaitForTransactionMock,
	},
}));

vi.mock("../../src/services/osmosisGrpcService", () => ({
	OsmosisGrpcService: {
		sendTokens: osmosisSendTokensMock,
		waitForTransaction: osmosisWaitForTransactionMock,
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
import { CAC_DENOM } from "../../src/tokens";

describe("UnifiedWalletService withdrawal accounting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		junoSendTokensMock.mockResolvedValue({
			code: 0,
			txHash: "TX-123",
			rawLog: "",
		});
		junoWaitForTransactionMock.mockResolvedValue({
			hash: "tx-123",
			code: 0,
			height: 1,
			memo: "",
			transfers: [],
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
		(LedgerService.processRefund as any).mockResolvedValue({
			success: true,
			newBalance: 15,
		});
		(LedgerService.updateTransactionStatus as any).mockResolvedValue(undefined);
		(LedgerService.getUserBalance as any).mockResolvedValue(4.99025);

	});

	it("charges the withdrawing user the fixed network fee instead of treasury", async () => {
		const fee = getWithdrawalNetworkFee();
		const totalMicro = 15_000_000;
		const recipientAddress = `juno1${"r".repeat(38)}`;

		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(totalMicro);

		const result = await UnifiedWalletService.processWithdrawal(
			12345,
			recipientAddress,
			10,
		);

		expect(result.success).toBe(true);
		expect(LedgerService.processWithdrawal).toHaveBeenCalledWith(
			12345,
			10,
			recipientAddress,
			undefined,
			`Withdrawal to ${recipientAddress}`,
			"ujuno",
		);
		expect(LedgerService.processFee).toHaveBeenCalledWith(
			12345,
			fee,
			`Network fee for withdrawal to ${recipientAddress}`,
			"ujuno",
		);
		expect(LedgerService.processAdjustment).not.toHaveBeenCalled();
		expect(junoSendTokensMock).toHaveBeenCalledWith(
			recipientAddress,
			10_000_000,
			"ujuno",
			"Withdrawal for user 12345",
		);
	});

	it("requires enough balance to cover the withdrawal amount plus the network fee", async () => {
		const fee = getWithdrawalNetworkFee();
		const insufficientMicro =
			10_000_000 + Math.round((fee - 0.000001) * 1_000_000);
		const recipientAddress = `juno1${"r".repeat(38)}`;

		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(
			insufficientMicro,
		);

		const result = await UnifiedWalletService.processWithdrawal(
			12345,
			recipientAddress,
			10,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("network fee");
		expect(LedgerService.processWithdrawal).not.toHaveBeenCalled();
		expect(LedgerService.processFee).not.toHaveBeenCalled();
		expect(junoSendTokensMock).not.toHaveBeenCalled();
	});

	it("routes CAC withdrawals through the Osmosis gRPC broadcaster", async () => {
		const recipientAddress = `osmo1${"r".repeat(38)}`;
		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(15_000_000);
		(LedgerService.getUserBalance as any).mockResolvedValue(5);
		osmosisSendTokensMock.mockResolvedValue({
			txHash: "CAC-TX",
			code: 0,
			rawLog: "",
		});
		osmosisWaitForTransactionMock.mockResolvedValue({
			hash: "CAC-TX",
			code: 0,
			height: 1,
			memo: "",
			transfers: [],
		});

		const result = await UnifiedWalletService.processWithdrawal(
			12345,
			recipientAddress,
			10,
			CAC_DENOM,
		);

		expect(result.success).toBe(true);
		expect(result.pending).toBeUndefined();
		expect(junoSendTokensMock).not.toHaveBeenCalled();
		expect(osmosisSendTokensMock).toHaveBeenCalledWith(
			recipientAddress,
			10_000_000,
			CAC_DENOM,
			"Withdrawal for user 12345",
		);
		expect(LedgerService.processFee).not.toHaveBeenCalled();
	});

	it("refunds the transfer and fee when CheckTx rejects the withdrawal", async () => {
		const fee = getWithdrawalNetworkFee();
		const recipientAddress = `juno1${"r".repeat(38)}`;

		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(15_000_000);
		(LedgerService.getUserBalance as any).mockResolvedValue(4.99025);
		junoSendTokensMock.mockResolvedValue({
			code: 5,
			txHash: "TX-FAILED",
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
			"ujuno",
		);
		expect(LedgerService.processRefund).toHaveBeenCalledWith(
			12345,
			10 + fee,
			"Withdrawal refund - transaction rejected",
			"ujuno",
		);
		expect(junoWaitForTransactionMock).not.toHaveBeenCalled();
	});

	it("refunds only the transfer amount when an included tx fails", async () => {
		const recipientAddress = `juno1${"r".repeat(38)}`;
		(LedgerService.getUserBalanceMicro as any).mockResolvedValue(15_000_000);
		(LedgerService.getUserBalance as any).mockResolvedValue(4.99025);
		junoSendTokensMock.mockResolvedValue({
			code: 0,
			txHash: "TX-FAILED",
			rawLog: "",
		});
		junoWaitForTransactionMock.mockResolvedValue({
			hash: "tx-failed",
			code: 5,
			height: 1,
			memo: "",
			transfers: [],
		});

		const result = await UnifiedWalletService.processWithdrawal(
			12345,
			recipientAddress,
			10,
		);

		expect(result.success).toBe(false);
		expect(LedgerService.processRefund).toHaveBeenCalledWith(
			12345,
			10,
			"Withdrawal refund - transaction rejected",
			"ujuno",
		);
		expect(TransactionLockService.releaseWithdrawalLock).toHaveBeenCalledWith(
			12345,
			"tx-failed",
			true,
		);
	});
});

describe("UnifiedWalletService.parseUserId", () => {
	it("does not treat an alphanumeric jailing-id memo as a user id", () => {
		const parse = (UnifiedWalletService as any).parseUserId.bind(
			UnifiedWalletService,
		);
		expect(parse("JAIL12AB")).toBeNull();
		expect(parse("user:123")).toBeNull();
		expect(parse("123456")).toBe(123456);
	});
});
