import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config", () => ({
	config: { junoRpcUrl: "https://rpc.example.com" },
}));

import { RPCTransactionVerification } from "../../src/services/rpcTransactionVerification";

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

const transferEvent = (pairs: Array<[string, string]>) => ({
	type: "transfer",
	attributes: pairs.map(([key, value]) => ({ key, value, index: false })),
});

const rpcResponse = (events: unknown[], code = 0) => ({
	ok: true,
	json: vi.fn().mockResolvedValue({
		result: {
			hash: "ABC",
			height: "1",
			index: 0,
			tx_result: {
				code,
				data: "",
				log: "",
				info: "",
				gas_wanted: "1",
				gas_used: "1",
				events,
				codespace: "",
			},
			tx: Buffer.from("").toString("base64"),
		},
	}),
});

describe("RPCTransactionVerification.fetchTransaction", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("pairs repeating transfer attributes by index, not first-match", async () => {
		fetchMock().mockResolvedValue(
			rpcResponse([
				transferEvent([
					["sender", "A"],
					["recipient", "B"],
					["amount", "1000000ujuno"],
					["sender", "C"],
					["recipient", "D"],
					["amount", "2000000ujuno"],
				]),
			]),
		);

		const result = await RPCTransactionVerification.fetchTransaction("ABC");

		expect(result.success).toBe(true);
		expect(result.data?.transfers).toEqual([
			{ sender: "A", recipient: "B", amount: 1 },
			{ sender: "C", recipient: "D", amount: 2 },
		]);
	});

	it("handles the SDK's recipient-first attribute order", async () => {
		fetchMock().mockResolvedValue(
			rpcResponse([
				transferEvent([
					["recipient", "B"],
					["sender", "A"],
					["amount", "3000000ujuno"],
				]),
			]),
		);

		const result = await RPCTransactionVerification.fetchTransaction("ABC");

		expect(result.data?.transfers).toEqual([
			{ sender: "A", recipient: "B", amount: 3 },
		]);
	});

	it("parses a single transfer unchanged", async () => {
		fetchMock().mockResolvedValue(
			rpcResponse([
				transferEvent([
					["sender", "A"],
					["recipient", "B"],
					["amount", "500000ujuno"],
				]),
			]),
		);

		const result = await RPCTransactionVerification.fetchTransaction("ABC");

		expect(result.data?.transfers).toEqual([
			{ sender: "A", recipient: "B", amount: 0.5 },
		]);
	});

	it("reports failure when the RPC call is not ok", async () => {
		fetchMock().mockResolvedValue({ ok: false, status: 500, json: vi.fn() });
		const result = await RPCTransactionVerification.fetchTransaction("ABC");
		expect(result.success).toBe(false);
	});
});
