/**
 * Supported on-chain tokens.
 *
 * The internal ledger stores every balance as integer micro-units of the
 * token's base denom, keyed by `(user_id, denom)`. JUNO remains the default so
 * every existing economy command keeps operating on JUNO unchanged.
 *
 * @module tokens
 */

/** JUNO base denom (6 decimals). */
export const JUNO_DENOM = "ujuno";

/** CAC tokenfactory denom on Osmosis (6 decimals). */
export const CAC_DENOM =
	"factory/osmo1q77cw0mmlluxu0wr29fcdd0tdnh78gzhkvhe4n6ulal9qvrtu43qtd0nh8/cac";

export type TokenChain = "juno" | "osmosis";

export interface TokenDefinition {
	/** Base denom used on chain and as the ledger key. */
	denom: string;
	/** Short ticker shown in commands. */
	symbol: string;
	/** Chain that hosts the denom. */
	chain: TokenChain;
	/** Bech32 address prefix for that chain. */
	addressPrefix: string;
}

const TOKENS: TokenDefinition[] = [
	{
		denom: JUNO_DENOM,
		symbol: "JUNO",
		chain: "juno",
		addressPrefix: "juno",
	},
	{
		denom: CAC_DENOM,
		symbol: "CAC",
		chain: "osmosis",
		addressPrefix: "osmo",
	},
];

/** Default token for commands that do not name one. */
export const DEFAULT_TOKEN = TOKENS[0];

/**
 * Resolve a user-supplied token name (case-insensitive symbol or exact denom).
 * Returns the default token when the input is empty; `undefined` when unknown.
 */
export function resolveToken(input?: string): TokenDefinition | undefined {
	const value = input?.trim();
	if (!value) return DEFAULT_TOKEN;

	const upper = value.toUpperCase();
	return (
		TOKENS.find((token) => token.symbol === upper || token.denom === value) ??
		undefined
	);
}

/** Look up a token by its base denom. */
export function tokenByDenom(denom: string): TokenDefinition | undefined {
	return TOKENS.find((token) => token.denom === denom);
}

/** All supported tokens. */
export function getTokens(): readonly TokenDefinition[] {
	return TOKENS;
}

/** Network label for a denom, used by deposit bookkeeping. */
export function networkForDenom(denom: string): TokenChain {
	return tokenByDenom(denom)?.chain ?? "juno";
}
