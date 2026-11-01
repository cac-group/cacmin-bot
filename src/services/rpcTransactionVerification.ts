/**
 * Explicit-hash transaction verification.
 *
 * JUNO transactions come from the Polkachu Juno gRPC service and CAC from the
 * Polkachu Osmosis gRPC service. No REST or Tendermint-RPC path exists.
 *
 * @module services/rpcTransactionVerification
 */

import { JUNO_DENOM } from "../tokens";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { normalizeTxHash } from "../utils/txHash";
import { JunoGrpcService } from "./junoGrpcService";
import { OsmosisGrpcService } from "./osmosisGrpcService";

interface ParsedTransaction {
	hash: string;
	status: number; // 0 = success
	height: number;
	memo?: string;
	transfers: Array<{
		sender: string;
		recipient: string;
		amount: number; // In display units (not micro)
		denom?: string;
	}>;
}

export class RPCTransactionVerification {
	/** Fetch and verify a JUNO transaction through gRPC. */
	static async fetchTransaction(txHash: string): Promise<{
		success: boolean;
		data?: ParsedTransaction;
		error?: string;
	}> {
		try {
			const tx = await JunoGrpcService.fetchTransaction(txHash);
			if (!tx) {
				return { success: false, error: "Transaction not found" };
			}

			return {
				success: true,
				data: {
					hash: tx.hash,
					status: tx.code,
					height: tx.height,
					memo: tx.memo,
					transfers: tx.transfers.map((transfer) => ({
						sender: transfer.from,
						recipient: transfer.to,
						amount: AmountPrecision.fromDbMicro(transfer.amountMicro),
						denom: transfer.denom,
					})),
				},
			};
		} catch (error) {
			logger.error("Failed to fetch transaction via gRPC", {
				txHash,
				error,
			});
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch transaction",
			};
		}
	}

	/**
	 * Fetch a transaction through the transport for its token's chain:
	 * Juno gRPC for JUNO, Osmosis gRPC for CAC.
	 */
	static async fetchTokenTransaction(
		txHash: string,
		denom: string = JUNO_DENOM,
	): Promise<{
		success: boolean;
		data?: ParsedTransaction;
		error?: string;
	}> {
		if (denom === JUNO_DENOM) {
			return RPCTransactionVerification.fetchTransaction(txHash);
		}

		const tx = await OsmosisGrpcService.fetchTransaction(txHash);
		if (!tx) {
			return { success: false, error: "Transaction not found" };
		}

		return {
			success: true,
			data: {
				hash: tx.hash,
				status: tx.code,
				height: tx.height,
				memo: tx.memo,
				transfers: tx.transfers
					.filter((transfer) => transfer.denom === denom)
					.map((transfer) => ({
						sender: transfer.from,
						recipient: transfer.to,
						amount: AmountPrecision.fromDbMicro(transfer.amountMicro),
						denom: transfer.denom,
					})),
			},
		};
	}

	/** Verify a deposit transaction against the expected address and memo. */
	static async verifyDeposit(
		txHash: string,
		expectedRecipient: string,
		expectedUserId: number,
		denom: string = JUNO_DENOM,
	): Promise<{
		valid: boolean;
		amount?: number;
		memo?: string;
		sender?: string;
		error?: string;
	}> {
		const result = await RPCTransactionVerification.fetchTokenTransaction(
			txHash,
			denom,
		);

		if (!result.success || !result.data) {
			return {
				valid: false,
				error: result.error || "Failed to fetch transaction",
			};
		}

		const tx = result.data;

		if (tx.status !== 0) {
			return {
				valid: false,
				error: `Transaction failed with code ${tx.status}`,
			};
		}

		const expectedMemo = expectedUserId.toString();
		if (tx.memo !== expectedMemo) {
			logger.warn("Deposit memo mismatch", {
				expected: expectedMemo,
				actual: tx.memo,
				txHash: normalizeTxHash(txHash),
			});

			return {
				valid: false,
				memo: tx.memo,
				error: `Invalid memo. Expected: ${expectedMemo}, Got: ${tx.memo || "none"}`,
			};
		}

		let totalReceived = 0;
		let sender = "";

		for (const transfer of tx.transfers) {
			const transferDenom = transfer.denom ?? JUNO_DENOM;
			if (transfer.recipient === expectedRecipient && transferDenom === denom) {
				totalReceived = AmountPrecision.add(totalReceived, transfer.amount);
				sender = transfer.sender;
			}
		}

		if (totalReceived === 0) {
			return {
				valid: false,
				error: `No transfer found to wallet ${expectedRecipient}`,
			};
		}

		logger.info("Deposit verified", {
			txHash: normalizeTxHash(txHash),
			sender,
			amount: AmountPrecision.format(totalReceived),
			memo: tx.memo,
		});

		return {
			valid: true,
			amount: totalReceived,
			memo: tx.memo,
			sender,
		};
	}
}
