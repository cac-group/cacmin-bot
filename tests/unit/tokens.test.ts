import { describe, expect, it } from "vitest";
import {
	CAC_DENOM,
	DEFAULT_TOKEN,
	JUNO_DENOM,
	resolveToken,
	tokenByDenom,
} from "../../src/tokens";

describe("token registry", () => {
	it("defaults to JUNO and resolves symbols case-insensitively", () => {
		expect(resolveToken()).toBe(DEFAULT_TOKEN);
		expect(resolveToken("juno")?.denom).toBe(JUNO_DENOM);
		expect(resolveToken("CaC")?.denom).toBe(CAC_DENOM);
		expect(tokenByDenom(CAC_DENOM)?.symbol).toBe("CAC");
	});

	it("rejects unknown symbols and preserves the exact denom", () => {
		expect(resolveToken("nope")).toBeUndefined();
		expect(resolveToken(CAC_DENOM)?.symbol).toBe("CAC");
	});
});
