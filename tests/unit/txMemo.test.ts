import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { describe, expect, it } from "vitest";
import { decodeMemo } from "../../src/utils/txMemo";

/** Build a base64 TxRaw carrying `memo`, as the RPC `tx` field does. */
const encode = (memo: string): string => {
	const bodyBytes = TxBody.encode(TxBody.fromPartial({ memo })).finish();
	const raw = TxRaw.encode(
		TxRaw.fromPartial({
			bodyBytes,
			authInfoBytes: new Uint8Array(),
			signatures: [],
		}),
	).finish();
	return Buffer.from(raw).toString("base64");
};

describe("decodeMemo", () => {
	it("decodes the memo from a base64 TxRaw", () => {
		expect(decodeMemo(encode("123456"))).toBe("123456");
	});

	it("returns undefined for an empty memo", () => {
		expect(decodeMemo(encode(""))).toBeUndefined();
	});

	it("returns undefined for malformed input", () => {
		expect(decodeMemo("!!!not-base64!!!")).toBeUndefined();
	});
});
