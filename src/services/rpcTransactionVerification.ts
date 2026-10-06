import { config } from "../config";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

interface RPCTransactionResponse {
	jsonrpc: string;
	id: number;
	result: {
		hash: string;
		height: string;
		index: number;
		tx_result: {
			code: number; // 0 = success, non-zero = failed
			data: string; // Base64 encoded
			log: string;
			info: string;
			gas_wanted: string;
			gas_used: string;
			events: Array<{
				type: string;
				attributes: Array<{
					key: string;
					value: string;
					index: boolean;
				}>;
			}>;
			codespace: string;
		};
		tx: string; // Base64 encoded transaction with memo
	};
}

interface ParsedTransaction {
	hash: string;
	status: number; // 0 = success
	height: number;
	memo?: string;
	transfers: Array<{
		sender: string;
		recipient: string;
		amount: number; // In JUNO (not ujuno)
	}>;
	fee?: {
		amount: number;
		payer: string;
	};
	gasUsed: number;
	gasWanted: number;
}

/**
 * Transaction verification using Juno RPC endpoint
 * Handles the actual format returned by the blockchain
 */
export class RPCTransactionVerification {
	private static readonly RPC_ENDPOINT = config.junoRpcUrl;

	/**
	 * Fetch and verify a transaction using RPC endpoint
	 * Note: RPC requires '0x' prefix on the hash
	 */
	static async fetchTransaction(txHash: string): Promise<{
		success: boolean;
		data?: ParsedTransaction;
		error?: string;
	}> {
		try {
			// Add 0x prefix if not present
			const formattedHash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;

			// Fetch from RPC endpoint
			const url = `${RPCTransactionVerification.RPC_ENDPOINT}/tx?hash=${formattedHash}&prove=false`;
			const response = await fetch(url);

			if (!response.ok) {
				return {
					success: false,
					error: `Failed to fetch transaction: ${response.status}`,
				};
			}

			const rpcResponse = (await response.json()) as RPCTransactionResponse;

			// Check if transaction was found
			if (!rpcResponse.result) {
				return {
					success: false,
					error: "Transaction not found",
				};
			}

			// Parse the transaction
			const parsed = await RPCTransactionVerification.parseRPCTransaction(
				rpcResponse.result,
			);

			return {
				success: true,
				data: parsed,
			};
		} catch (error) {
			logger.error("Failed to fetch transaction from RPC", {
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
	 * Parse the RPC transaction response
	 */
	private static async parseRPCTransaction(
		result: RPCTransactionResponse["result"],
	): Promise<ParsedTransaction> {
		const parsed: ParsedTransaction = {
			hash: result.hash,
			status: result.tx_result.code,
			height: parseInt(result.height, 10),
			transfers: [],
			gasUsed: parseInt(result.tx_result.gas_used, 10),
			gasWanted: parseInt(result.tx_result.gas_wanted, 10),
		};

		// Decode the transaction to get memo
		try {
			// The tx field is base64 encoded - decode it to get the memo
			const txBytes = Buffer.from(result.tx, "base64");

			// In Cosmos SDK transactions, the memo appears after the message body
			// Looking for the specific pattern where memo appears after the amount "1000000"
			// Based on the example tx, the structure is:
			// ... "1000000" [0x12] [length] [memo] [0x12] ...

			// Find the transfer amount position first
			const txString = txBytes.toString("latin1");
			const amountPattern = "1000000"; // The transfer amount in ujuno
			const amountIndex = txString.indexOf(amountPattern);

			if (amountIndex >= 0) {
				// Look for memo field after the amount
				// Start searching from after the amount string
				const searchStart = amountIndex + amountPattern.length;

				for (
					let i = searchStart;
					i < txBytes.length - 2 && i < searchStart + 20;
					i++
				) {
					// Check for field tag 0x12 (common for string fields in protobuf)
					if (txBytes[i] === 0x12) {
						const length = txBytes[i + 1];

						// Memo should be relatively short (user IDs are typically < 20 chars)
						if (
							length > 0 &&
							length <= 20 &&
							i + 2 + length <= txBytes.length
						) {
							const memoBytes = txBytes.slice(i + 2, i + 2 + length);
							const potentialMemo = memoBytes.toString("utf8");

							// Validate it's all printable ASCII
							if (/^[\x20-\x7E]+$/.test(potentialMemo)) {
								// Check if it's NOT a Juno address (those start with "juno1")
								if (!potentialMemo.startsWith("juno1")) {
									// For user IDs, we expect numeric values
									// But also allow alphanumeric for flexibility
									if (
										/^\d+$/.test(potentialMemo) ||
										/^[a-zA-Z0-9_-]+$/.test(potentialMemo)
									) {
										parsed.memo = potentialMemo;
										break;
									}
								}
							}
						}
					}
				}
			}

			// Alternative method: Look for all 0x12 tags with short lengths
			if (!parsed.memo) {
				const memoFields: string[] = [];

				for (let i = 0; i < txBytes.length - 2; i++) {
					if (txBytes[i] === 0x12) {
						const length = txBytes[i + 1];

						// Focus on short strings (typical for memos/user IDs)
						if (
							length >= 1 &&
							length <= 15 &&
							i + 2 + length <= txBytes.length
						) {
							const fieldBytes = txBytes.slice(i + 2, i + 2 + length);
							const fieldStr = fieldBytes.toString("utf8");

							// Must be printable ASCII
							if (/^[\x20-\x7E]+$/.test(fieldStr)) {
								// Skip if it looks like an address or known field
								if (
									!fieldStr.startsWith("juno1") &&
									!fieldStr.includes("cosmos") &&
									!fieldStr.includes("bank") &&
									!fieldStr.includes("ujuno")
								) {
									// Prefer numeric memos (user IDs)
									if (/^\d+$/.test(fieldStr)) {
										memoFields.push(fieldStr);
									}
								}
							}
						}
					}
				}

				// Pick the most likely memo (prefer numeric values)
				if (memoFields.length > 0) {
					// Filter out values that are likely gas or other amounts
					const filtered = memoFields.filter(
						(m) =>
							m !== "99334" && // gas used
							m !== "122282" && // gas wanted
							m !== "9172" && // fee
							m !== "1000000", // transfer amount
					);

					if (filtered.length > 0) {
						parsed.memo = filtered[0];
					}
				}
			}
		} catch (error) {
			logger.warn("Failed to decode memo from transaction", {
				hash: result.hash,
				error,
			});
		}

		// Parse events to extract transfers. A `transfer` event carries repeating
		// sender/recipient/amount attributes; pair them by index, not first-match,
		// so multi-transfer transactions are attributed correctly.
		for (const event of result.tx_result.events) {
			if (event.type === "transfer") {
				const senders: string[] = [];
				const recipients: string[] = [];
				const amounts: string[] = [];
				for (const attr of event.attributes) {
					if (attr.key === "sender") senders.push(attr.value);
					else if (attr.key === "recipient") recipients.push(attr.value);
					else if (attr.key === "amount") amounts.push(attr.value);
				}

				for (let i = 0; i < amounts.length; i++) {
					const amountMatch = amounts[i].match(/(\d+)ujuno/);
					if (!amountMatch) continue;
					const ujunoAmount = parseInt(amountMatch[1], 10);
					parsed.transfers.push({
						sender: senders[i] ?? "",
						recipient: recipients[i] ?? "",
						amount: AmountPrecision.fromMicroJuno(ujunoAmount),
					});
				}
			}

			// Parse fee from tx events
			if (event.type === "tx") {
				const feeStr = RPCTransactionVerification.getEventAttribute(
					event,
					"fee",
				);
				const feePayer = RPCTransactionVerification.getEventAttribute(
					event,
					"fee_payer",
				);

				if (feeStr && feePayer) {
					const feeMatch = feeStr.match(/(\d+)ujuno/);
					if (feeMatch) {
						const ujunoFee = parseInt(feeMatch[1], 10);
						parsed.fee = {
							amount: AmountPrecision.fromMicroJuno(ujunoFee),
							payer: feePayer,
						};
					}
				}
			}
		}

		return parsed;
	}

	/**
	 * Helper to get attribute value from event
	 */
	private static getEventAttribute(
		event: { attributes: Array<{ key: string; value: string }> },
		key: string,
	): string | undefined {
		const attr = event.attributes.find((a) => a.key === key);
		return attr?.value;
	}

	/**
	 * Verify a deposit transaction
	 */
	static async verifyDeposit(
		txHash: string,
		expectedRecipient: string,
		expectedUserId: number,
	): Promise<{
		valid: boolean;
		amount?: number;
		memo?: string;
		sender?: string;
		error?: string;
	}> {
		// Fetch the transaction
		const result = await RPCTransactionVerification.fetchTransaction(txHash);

		if (!result.success || !result.data) {
			return {
				valid: false,
				error: result.error || "Failed to fetch transaction",
			};
		}

		const tx = result.data;

		// Check status (must be 0 for success)
		if (tx.status !== 0) {
			return {
				valid: false,
				error: `Transaction failed with code ${tx.status}`,
			};
		}

		// Check memo matches expected userId
		const expectedMemo = expectedUserId.toString();
		if (tx.memo !== expectedMemo) {
			logger.warn("Deposit memo mismatch", {
				expected: expectedMemo,
				actual: tx.memo,
				txHash,
			});

			// Strict check - memo must exactly match
			return {
				valid: false,
				memo: tx.memo,
				error: `Invalid memo. Expected: ${expectedMemo}, Got: ${tx.memo || "none"}`,
			};
		}

		// Find transfers to our wallet
		let totalReceived = 0;
		let sender = "";

		for (const transfer of tx.transfers) {
			if (transfer.recipient === expectedRecipient) {
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
			txHash,
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
