/**
 * Thin Cosmos REST client shared by the explicit-hash payment-verification and
 * balance-read paths. The automated deposit listener uses RPC `tx_search` and is
 * deliberately separate, as are `/verifydeposit` and `/claimdeposit`, which go
 * through `RPCTransactionVerification`.
 *
 * @module services/cosmosRestService
 */

import { config } from "../config";
import { logger } from "../utils/logger";

/** A `MsgSend` as it appears in `tx_response.tx.body.messages`. */
export interface RestMsgSend {
	"@type": string;
	from_address?: string;
	to_address?: string;
	amount?: Array<{ denom: string; amount: string }>;
}

/** The parts of a REST transaction response the bot relies on. */
export interface RestTransaction {
	/** 0 = success. */
	code: number;
	messages: RestMsgSend[];
	/** Memo (the deposit/allocation key). */
	memo?: string;
}

export class CosmosRestService {
	/** Fetch and shape a transaction; `null` when missing or unreachable. */
	static async fetchTransaction(
		txHash: string,
	): Promise<RestTransaction | null> {
		try {
			const response = await fetch(
				`${config.junoApiUrl}/cosmos/tx/v1beta1/txs/${txHash}`,
			);
			if (!response.ok) return null;

			const data = (await response.json()) as {
				tx_response?: {
					code?: number;
					tx?: { body?: { messages?: RestMsgSend[]; memo?: string } };
				};
			};
			const tx = data.tx_response;
			if (!tx) return null;

			return {
				// Fail closed: a missing code is not success (matches the old check).
				code: tx.code ?? -1,
				messages: tx.tx?.body?.messages ?? [],
				memo: tx.tx?.body?.memo,
			};
		} catch (error) {
			logger.error("Failed to fetch transaction via REST", { txHash, error });
			return null;
		}
	}

	/**
	 * First `MsgSend` carrying `ujuno`, optionally restricted to a recipient and
	 * an exact amount (micro-units). Scans all messages, so a transaction with
	 * several sends still matches the intended one.
	 */
	static findMsgSend(
		tx: RestTransaction,
		toAddress?: string,
		amountMicro?: number,
	): { amountMicro: number; from: string; to: string } | null {
		for (const msg of tx.messages) {
			if (msg["@type"] !== "/cosmos.bank.v1beta1.MsgSend") continue;
			if (toAddress && msg.to_address !== toAddress) continue;

			const juno = msg.amount?.find((a) => a.denom === "ujuno");
			if (!juno) continue;

			const micro = Number(juno.amount);
			if (!Number.isSafeInteger(micro)) continue;
			if (amountMicro !== undefined && micro !== amountMicro) continue;

			return {
				amountMicro: micro,
				from: msg.from_address ?? "",
				to: msg.to_address ?? "",
			};
		}
		return null;
	}

	/** On-chain balance in micro-units (integer), or `null` on failure. */
	static async fetchBalanceMicro(address: string): Promise<number | null> {
		try {
			const response = await fetch(
				`${config.junoApiUrl}/cosmos/bank/v1beta1/balances/${address}`,
			);
			if (!response.ok) return null;

			const data = (await response.json()) as {
				balances?: Array<{ denom: string; amount: string }>;
			};
			const juno = data.balances?.find((b) => b.denom === "ujuno");
			return juno ? Math.round(Number(juno.amount)) : 0;
		} catch (error) {
			logger.error("Failed to query on-chain balance", { address, error });
			return null;
		}
	}
}
