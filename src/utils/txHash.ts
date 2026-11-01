/**
 * Canonical transaction-hash form for ledger keys.
 *
 * Chains return uppercase hex while users often paste lowercase (or a `0x`
 * prefix). Deposit idempotency compares hashes as strings, so every path must
 * store and look up the same normalized value.
 */
export function normalizeTxHash(hash: string): string {
	return hash.trim().replace(/^0x/i, "").toLowerCase();
}
