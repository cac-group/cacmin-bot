/**
 * JUNO payment verification and treasury balance reads over gRPC.
 *
 * @module services/junoService
 */

import { config } from "../config";
import { JUNO_DENOM } from "../tokens";
import { StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { JunoGrpcService } from "./junoGrpcService";

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

		const tx = await JunoGrpcService.fetchTransaction(txHash);
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
			? tx.transfers.find(
					(candidate) =>
						candidate.denom === JUNO_DENOM &&
						candidate.to === treasury &&
						candidate.amountMicro === expectedMicro,
				)
			: undefined;
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

	/** On-chain treasury balance in JUNO, or `null` when unavailable. */
	static async getBalance(): Promise<number | null> {
		if (!config.botTreasuryAddress) return null;

		const micro = await JunoGrpcService.getBalanceMicro(
			config.botTreasuryAddress,
			JUNO_DENOM,
		);
		return micro === null ? null : AmountPrecision.fromDbMicro(micro);
	}
}
