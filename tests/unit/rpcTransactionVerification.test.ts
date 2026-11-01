import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config", () => ({
	config: {
		juno: {
			grpcUrl: "juno-grpc.example.com:12690",
			chainId: "juno-1",
			confirmTimeoutMs: 1000,
		},
		osmosis: {
			grpcUrl: "osmosis-grpc.example.com:12590",
			chainId: "osmosis-1",
			withdrawalGasPrice: "0.025uosmo",
			withdrawalGasLimit: 200000,
			confirmTimeoutMs: 1000,
		},
		userFundsAddress: "juno1wallet",
		userFundsMnemonic: undefined,
	},
}));

vi.mock("../../src/services/junoGrpcService", () => ({
	JunoGrpcService: { fetchTransaction: vi.fn() },
}));

vi.mock("../../src/services/osmosisGrpcService", () => ({
	OsmosisGrpcService: { fetchTransaction: vi.fn() },
}));

import { JunoGrpcService } from "../../src/services/junoGrpcService";
import { OsmosisGrpcService } from "../../src/services/osmosisGrpcService";
import { RPCTransactionVerification } from "../../src/services/rpcTransactionVerification";

const junoTransfer = (
	from: string,
	to: string,
	amountMicro: number,
	denom = "ujuno",
) => ({ denom, amountMicro, from, to });

describe("RPCTransactionVerification.fetchTransaction", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps every MsgSend transfer from the gRPC transaction", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue({
			hash: "abc",
			code: 0,
			height: 1,
			memo: "",
			transfers: [
				junoTransfer("A", "B", 1_000_000),
				junoTransfer("C", "D", 2_000_000),
			],
		});

		const result = await RPCTransactionVerification.fetchTransaction("ABC");

		expect(result.success).toBe(true);
		expect(result.data?.transfers).toEqual([
			{ sender: "A", recipient: "B", amount: 1, denom: "ujuno" },
			{ sender: "C", recipient: "D", amount: 2, denom: "ujuno" },
		]);
	});

	it("reports failure when the tx is not found", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(null);
		const result = await RPCTransactionVerification.fetchTransaction("ABC");
		expect(result.success).toBe(false);
	});
});

describe("RPCTransactionVerification.verifyDeposit", () => {
	beforeEach(() => vi.clearAllMocks());

	const walletTx = (memo: string) => ({
		hash: "abc",
		code: 0,
		height: 1,
		memo,
		transfers: [junoTransfer("A", "WALLET", 5_000_000)],
	});

	it("accepts a transfer to the wallet with a matching memo", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(
			walletTx("123456"),
		);

		expect(
			await RPCTransactionVerification.verifyDeposit("ABC", "WALLET", 123456),
		).toEqual({ valid: true, amount: 5, memo: "123456", sender: "A" });
	});

	it("rejects a memo mismatch", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(
			walletTx("999"),
		);
		expect(
			(await RPCTransactionVerification.verifyDeposit("ABC", "WALLET", 123456))
				.valid,
		).toBe(false);
	});

	it("rejects a transaction with no memo", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(walletTx(""));
		expect(
			(await RPCTransactionVerification.verifyDeposit("ABC", "WALLET", 123456))
				.valid,
		).toBe(false);
	});

	it("uses the Osmosis client for CAC", async () => {
		(OsmosisGrpcService.fetchTransaction as any).mockResolvedValue({
			hash: "abc",
			code: 0,
			height: 1,
			memo: "123456",
			transfers: [
				junoTransfer("osmo1a", "osmo1wallet", 5_000_000, "factory/cac"),
			],
		});

		expect(
			await RPCTransactionVerification.fetchTokenTransaction(
				"ABC",
				"factory/cac",
			),
		).toMatchObject({ success: true });
		expect(JunoGrpcService.fetchTransaction).not.toHaveBeenCalled();
	});
});
