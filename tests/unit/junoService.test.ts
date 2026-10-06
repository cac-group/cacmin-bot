import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config", () => ({
	config: {
		botTreasuryAddress: "juno1testtreasuryaddress",
		junoApiUrl: "https://api.example.com",
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: {
		logError: vi.fn(),
		logTransaction: vi.fn(),
	},
}));

import { JunoService } from "../../src/services/junoService";

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

const msgSend = (from: string, to: string, amountMicro: number) => ({
	"@type": "/cosmos.bank.v1beta1.MsgSend",
	from_address: from,
	to_address: to,
	amount: [{ denom: "ujuno", amount: String(amountMicro) }],
});

const txResponse = (
	messages: unknown[],
	{ memo = "", code = 0 }: { memo?: string; code?: number } = {},
) => ({
	ok: true,
	json: vi.fn().mockResolvedValue({
		tx_response: { code, tx: { body: { messages, memo } } },
	}),
});

describe("JunoService.getBalance", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("uses the API endpoint to fetch the treasury balance", async () => {
		fetchMock().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				balances: [{ denom: "ujuno", amount: "12345000" }],
			}),
		});

		const balance = await JunoService.getBalance();

		expect(fetchMock()).toHaveBeenCalledWith(
			"https://api.example.com/cosmos/bank/v1beta1/balances/juno1testtreasuryaddress",
		);
		expect(balance).toBe(12.345);
	});

	it("returns null when the balance query fails", async () => {
		fetchMock().mockResolvedValue({ ok: false, status: 503, json: vi.fn() });
		expect(await JunoService.getBalance()).toBeNull();
	});
});

describe("JunoService.verifyPayment", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("accepts an exact micro-unit transfer to the treasury", async () => {
		fetchMock().mockResolvedValue(
			txResponse([
				msgSend("juno1sender", "juno1testtreasuryaddress", 69_420_000),
			]),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(true);
	});

	it("rejects an amount mismatch", async () => {
		fetchMock().mockResolvedValue(
			txResponse([
				msgSend("juno1sender", "juno1testtreasuryaddress", 1_000_000),
			]),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(false);
	});

	it("rejects a transfer to a different recipient", async () => {
		fetchMock().mockResolvedValue(
			txResponse([msgSend("juno1sender", "juno1someoneelse", 69_420_000)]),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(false);
	});

	it("rejects a failed transaction", async () => {
		fetchMock().mockResolvedValue(
			txResponse(
				[msgSend("juno1sender", "juno1testtreasuryaddress", 69_420_000)],
				{
					code: 5,
				},
			),
		);
		expect(await JunoService.verifyPayment("ABC", 69.42)).toBe(false);
	});
});

describe("JunoService.inspectTransaction", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("returns the transfer details and memo", async () => {
		fetchMock().mockResolvedValue(
			txResponse(
				[msgSend("juno1sender", "juno1testtreasuryaddress", 5_000_000)],
				{
					memo: "123456",
				},
			),
		);

		expect(await JunoService.inspectTransaction("ABC")).toEqual({
			verified: true,
			amount: 5,
			from: "juno1sender",
			to: "juno1testtreasuryaddress",
			memo: "123456",
		});
	});

	it("returns unverified when the transaction failed", async () => {
		fetchMock().mockResolvedValue(
			txResponse([msgSend("a", "b", 1_000_000)], { code: 1 }),
		);
		expect(await JunoService.inspectTransaction("ABC")).toEqual({
			verified: false,
		});
	});
});
