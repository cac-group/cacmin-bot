import { describe, expect, it } from "vitest";
import { normalizeTxHash } from "../../src/utils/txHash";

describe("normalizeTxHash", () => {
	it("lowercases, trims, and strips a 0x prefix", () => {
		expect(normalizeTxHash(" 0xABCdef0123 ")).toBe("abcdef0123");
		expect(normalizeTxHash("A0A01D01FB7A")).toBe("a0a01d01fb7a");
	});
});
