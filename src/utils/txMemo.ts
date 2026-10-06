/**
 * Decode the memo from a base64-encoded `TxRaw`.
 *
 * The memo is the allocation key: it tells the bot whether a deposit credits a
 * user's internal balance, a fine, etc. Decode the transaction with cosmjs
 * (`decodeTxRaw`) rather than scanning bytes, so the memo is read exactly as
 * signed. Returns `undefined` when the transaction cannot be decoded.
 *
 * @module utils/txMemo
 */

import { decodeTxRaw } from "@cosmjs/proto-signing";
import { logger } from "./logger";

export function decodeMemo(base64Tx: string): string | undefined {
	try {
		const { body } = decodeTxRaw(Buffer.from(base64Tx, "base64"));
		return body.memo || undefined;
	} catch (error) {
		logger.warn("Failed to decode transaction memo", { error });
		return undefined;
	}
}
