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

describe("JunoService.getBalance", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("uses the API endpoint to fetch the treasury balance", async () => {
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				balances: [{ denom: "ujuno", amount: "12345000" }],
			}),
		});

		const balance = await JunoService.getBalance();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.example.com/cosmos/bank/v1beta1/balances/juno1testtreasuryaddress",
		);
		expect(balance).toBe(12.345);
	});

	it("returns null when the balance query fails", async () => {
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: false,
			status: 503,
			json: vi.fn(),
		});

		const balance = await JunoService.getBalance();

		expect(balance).toBeNull();
	});
});
