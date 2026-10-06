import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config", () => ({
	config: { junoApiUrl: "https://api.example.com" },
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
	CosmosRestService,
	type RestTransaction,
} from "../../src/services/cosmosRestService";

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

const tx = (messages: RestTransaction["messages"], code = 0, memo = "") => ({
	code,
	messages,
	memo,
});

const msgSend = (from: string, to: string, amount: string) => ({
	"@type": "/cosmos.bank.v1beta1.MsgSend",
	from_address: from,
	to_address: to,
	amount: [{ denom: "ujuno", amount }],
});

describe("CosmosRestService.fetchTransaction", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("shapes the REST response", async () => {
		fetchMock().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				tx_response: {
					code: 0,
					tx: {
						body: { messages: [msgSend("a", "b", "1000000")], memo: "42" },
					},
				},
			}),
		});

		const result = await CosmosRestService.fetchTransaction("ABC");
		expect(result).toEqual({
			code: 0,
			messages: [msgSend("a", "b", "1000000")],
			memo: "42",
		});
	});

	it("fails closed when the code is missing", async () => {
		fetchMock().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ tx_response: { tx: { body: {} } } }),
		});
		expect((await CosmosRestService.fetchTransaction("ABC"))?.code).toBe(-1);
	});

	it("returns null when the response has no tx_response", async () => {
		fetchMock().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({}),
		});
		expect(await CosmosRestService.fetchTransaction("ABC")).toBeNull();
	});

	it("returns null when the request throws", async () => {
		fetchMock().mockRejectedValue(new Error("network"));
		expect(await CosmosRestService.fetchTransaction("ABC")).toBeNull();
	});
});

describe("CosmosRestService.findMsgSend", () => {
	it("filters by recipient and exact amount", () => {
		const transaction = tx([
			msgSend("a", "other", "1000000"),
			msgSend("a", "treasury", "1000000"),
			msgSend("b", "treasury", "69420000"),
		]);

		expect(CosmosRestService.findMsgSend(transaction, "treasury")?.from).toBe(
			"a",
		);
		expect(
			CosmosRestService.findMsgSend(transaction, "treasury", 69_420_000)?.from,
		).toBe("b");
		expect(
			CosmosRestService.findMsgSend(transaction, "treasury", 5),
		).toBeNull();
	});

	it("skips non-ujuno and unsafe amounts", () => {
		const transaction = tx([
			{
				"@type": "/cosmos.bank.v1beta1.MsgSend",
				to_address: "treasury",
				amount: [{ denom: "uatom", amount: "5" }],
			},
			msgSend("a", "treasury", "99999999999999999999999999"),
		]);
		expect(CosmosRestService.findMsgSend(transaction, "treasury")).toBeNull();
	});

	it("returns the first ujuno send when no recipient is given", () => {
		const transaction = tx([msgSend("a", "x", "1000000")]);
		expect(CosmosRestService.findMsgSend(transaction)?.to).toBe("x");
	});
});

describe("CosmosRestService.fetchBalanceMicro", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("returns the ujuno integer", async () => {
		fetchMock().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				balances: [{ denom: "ujuno", amount: "12345000" }],
			}),
		});
		expect(await CosmosRestService.fetchBalanceMicro("juno1x")).toBe(
			12_345_000,
		);
	});

	it("returns 0 when ujuno is absent", async () => {
		fetchMock().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ balances: [] }),
		});
		expect(await CosmosRestService.fetchBalanceMicro("juno1x")).toBe(0);
	});

	it("returns null on failure", async () => {
		fetchMock().mockResolvedValue({ ok: false, status: 503, json: vi.fn() });
		expect(await CosmosRestService.fetchBalanceMicro("juno1x")).toBeNull();
	});
});
