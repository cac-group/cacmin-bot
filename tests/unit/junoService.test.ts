import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config", () => ({
	config: {
		botTreasuryAddress: "juno1testtreasuryaddress",
		juno: {
			grpcUrl: "juno-grpc.example.com:12690",
			chainId: "juno-1",
			confirmTimeoutMs: 1000,
		},
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: {
		logError: vi.fn(),
		logTransaction: vi.fn(),
	},
}));

vi.mock("../../src/services/junoGrpcService", () => ({
	JunoGrpcService: {
		fetchTransaction: vi.fn(),
		getBalanceMicro: vi.fn(),
	},
}));

import { JunoGrpcService } from "../../src/services/junoGrpcService";
import { JunoService } from "../../src/services/junoService";

const tx = (
	transfers: Array<{ from: string; to: string; amountMicro: number }>,
	{ memo = "", code = 0 }: { memo?: string; code?: number } = {},
) => ({
	hash: "abc",
	code,
	height: 1,
	memo,
	transfers: transfers.map((transfer) => ({
		denom: "ujuno",
		...transfer,
	})),
});

describe("JunoService.getBalance", () => {
	beforeEach(() => vi.clearAllMocks());

	it("reads the treasury balance through gRPC", async () => {
		(JunoGrpcService.getBalanceMicro as any).mockResolvedValue(12_345_000);
		expect(await JunoService.getBalance()).toBe(12.345);
		expect(JunoGrpcService.getBalanceMicro).toHaveBeenCalledWith(
			"juno1testtreasuryaddress",
			"ujuno",
		);
	});

	it("returns null when the balance query fails", async () => {
		(JunoGrpcService.getBalanceMicro as any).mockResolvedValue(null);
		expect(await JunoService.getBalance()).toBeNull();
	});
});

describe("JunoService.verifyPayment", () => {
	beforeEach(() => vi.clearAllMocks());

	it("accepts an exact micro-unit transfer to the treasury", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(
			tx([
				{
					from: "juno1sender",
					to: "juno1testtreasuryaddress",
					amountMicro: 69_420_000,
				},
			]),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(true);
	});

	it("rejects an amount mismatch", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(
			tx([
				{
					from: "juno1sender",
					to: "juno1testtreasuryaddress",
					amountMicro: 1_000_000,
				},
			]),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(false);
	});

	it("rejects a transfer to a different recipient", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(
			tx([
				{
					from: "juno1sender",
					to: "juno1someoneelse",
					amountMicro: 69_420_000,
				},
			]),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(false);
	});

	it("rejects a failed transaction", async () => {
		(JunoGrpcService.fetchTransaction as any).mockResolvedValue(
			tx(
				[
					{
						from: "juno1sender",
						to: "juno1testtreasuryaddress",
						amountMicro: 69_420_000,
					},
				],
				{ code: 5 },
			),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(false);
	});
});
