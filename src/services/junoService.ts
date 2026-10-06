/**
 * JUNO payment verification and treasury balance reads, on top of the shared
 * Cosmos REST client. Used by the explicit-hash backup paths (`/verifybail`,
 * `/verifyratelimitreset`, `/checkdeposit`); the automated deposit listener is
 * separate.
 *
 * @module services/junoService
 */

import { config } from "../config";
import { StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { CosmosRestService } from "./cosmosRestService";

export class JunoService {
	/** Configured bot treasury address for display, or a placeholder. */
	static getPaymentAddress(): string {
		return config.botTreasuryAddress || "not_configured";
	}

	/**
	 * Verify an exact-micro JUNO payment to the configured treasury.
	 * Reads signed `MsgSend` messages (not emitted events).
	 */
	static async verifyPayment(
		txHash: string,
		expectedAmount: number,
	): Promise<boolean> {
		StructuredLogger.logTransaction("Verifying payment", {
			txHash,
			amount: expectedAmount.toString(),
			operation: "verify_payment",
		});

		const tx = await CosmosRestService.fetchTransaction(txHash);
		if (!tx || tx.code !== 0) {
			StructuredLogger.logTransaction("Transaction failed or not found", {
				txHash,
				operation: "verify_failed",
			});
			return false;
		}

		const treasury = config.botTreasuryAddress;
		const expectedMicro = AmountPrecision.toDbMicro(expectedAmount);
		const transfer = treasury
			? CosmosRestService.findMsgSend(tx, treasury, expectedMicro)
			: null;
		if (!transfer) {
			StructuredLogger.logTransaction("No valid payment found", {
				txHash,
				operation: "verify_not_found",
			});
			return false;
		}

		StructuredLogger.logTransaction("Payment verified", {
			txHash,
			amount: AmountPrecision.fromDbMicro(transfer.amountMicro).toString(),
			operation: "verify_success",
		});
		return true;
	}

	/**
	 * Inspect a transaction for its first `ujuno` `MsgSend` and memo. Explicit-hash
	 * backup for `/checkdeposit`; does not assert an amount or recipient.
	 */
	static async inspectTransaction(txHash: string): Promise<{
		verified: boolean;
		amount?: number;
		from?: string;
		to?: string;
		memo?: string;
	}> {
		const tx = await CosmosRestService.fetchTransaction(txHash);
		if (!tx || tx.code !== 0) return { verified: false };

		const transfer = CosmosRestService.findMsgSend(tx);
		if (!transfer) return { verified: false };

		return {
			verified: true,
			amount: AmountPrecision.fromDbMicro(transfer.amountMicro),
			from: transfer.from,
			to: transfer.to,
			memo: tx.memo ?? "",
		};
	}

	/** On-chain treasury balance in JUNO, or `null` when unavailable. */
	static async getBalance(): Promise<number | null> {
		if (!config.botTreasuryAddress) return null;

		const micro = await CosmosRestService.fetchBalanceMicro(
			config.botTreasuryAddress,
		);
		return micro === null ? null : AmountPrecision.fromDbMicro(micro);
	}
}
