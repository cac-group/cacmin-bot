/** JUNO blockchain REST API verification service */

import { config } from "../config";
import { logger, StructuredLogger } from "../utils/logger";

export class JunoService {
	private static apiEndpoint =
		config.junoApiUrl || "https://api.juno.basementnodes.ca";

	/** Verify payment tx sent to treasury with expected amount (0.01 JUNO tolerance) */
	static async verifyPayment(
		txHash: string,
		expectedAmount: number,
	): Promise<boolean> {
		try {
			StructuredLogger.logTransaction("Verifying payment", {
				txHash,
				amount: expectedAmount.toString(),
				operation: "verify_payment",
			});

			// Query using the REST API endpoint
			const apiEndpoint =
				config.junoApiUrl || "https://api.juno.basementnodes.ca";
			const response = await fetch(
				`${apiEndpoint}/cosmos/tx/v1beta1/txs/${txHash}`,
			);

			if (!response.ok) {
				logger.warn("Transaction not found on chain", { txHash });
				return false;
			}

			const data = (await response.json()) as any;
			const tx = data.tx_response;

			// Check if transaction was successful
			if (tx.code !== 0) {
				StructuredLogger.logTransaction("Transaction failed", {
					txHash,
					operation: "verify_failed",
				});
				return false;
			}

			// Parse messages to find transfer to our treasury
			const messages = tx.tx.body.messages;
			const treasuryAddress = config.botTreasuryAddress;

			if (!treasuryAddress) {
				StructuredLogger.logError("Treasury not configured", {
					operation: "verify_payment",
				});
				return false;
			}

			for (const message of messages) {
				if (message["@type"] === "/cosmos.bank.v1beta1.MsgSend") {
					// Check if recipient is our treasury
					if (message.to_address === treasuryAddress) {
						// Find JUNO amount
						const junoAmount = message.amount?.find(
							(a: any) => a.denom === "ujuno",
						);

						if (junoAmount) {
							const amount = parseFloat(junoAmount.amount) / 1_000_000;

							// Allow small difference for rounding (0.01 JUNO tolerance)
							const difference = Math.abs(amount - expectedAmount);

							if (difference < 0.01) {
								StructuredLogger.logTransaction("Payment verified", {
									txHash,
									amount: amount.toString(),
									operation: "verify_success",
								});
								return true;
							} else {
								StructuredLogger.logTransaction("Amount mismatch", {
									txHash,
									amount: amount.toString(),
									operation: "verify_mismatch",
								});
							}
						}
					}
				}
			}

			StructuredLogger.logTransaction("No valid payment found", {
				txHash,
				operation: "verify_not_found",
			});
			return false;
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				txHash,
				operation: "verify_payment",
			});
			return false;
		}
	}

	/** Get configured bot treasury address */
	static getPaymentAddress(): string {
		return config.botTreasuryAddress || "not_configured";
	}

	/** Query bot treasury balance in JUNO */
	static async getBalance(): Promise<number | null> {
		if (!config.botTreasuryAddress) {
			return null;
		}

		try {
			const response = await fetch(
				`${JunoService.apiEndpoint}/cosmos/bank/v1beta1/balances/${config.botTreasuryAddress}`,
			);

			if (!response.ok) {
				StructuredLogger.logError("Failed to query balance", {
					operation: "get_balance",
					status: response.status.toString(),
				});
				return null;
			}

			const data = (await response.json()) as any;
			const junoBalance = data.balances?.find((b: any) => b.denom === "ujuno");

			return junoBalance ? parseFloat(junoBalance.amount) / 1_000_000 : 0;
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				operation: "get_balance",
			});
			return null;
		}
	}
}
