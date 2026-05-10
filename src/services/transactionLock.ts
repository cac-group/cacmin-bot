import { execute, get, query } from "../database";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { RPCTransactionVerification } from "./rpcTransactionVerification";

interface TransactionLock {
	userId: number;
	lockType: "withdrawal" | "deposit" | "transfer";
	amount: number;
	txHash?: string;
	targetAddress?: string;
	metadata?: string;
	lockedAt: number;
	status: "pending" | "processing" | "verifying" | "completed" | "failed";
}

interface VerificationResult {
	verified: boolean;
	txStatus?: number;
	actualAmount?: number;
	ledgerUpdated?: boolean;
	error?: string;
}

/**
 * Transaction lock service with proper verification
 * Locks are only released after dual verification:
 * 1. Transaction confirmed on-chain (status: 0)
 * 2. Ledger amount properly updated
 */
export class TransactionLockService {
	// Different timeouts for different operations
	private static readonly WITHDRAWAL_TIMEOUT = 120; // 2 minutes for withdrawals
	private static readonly DEPOSIT_TIMEOUT = 300; // 5 minutes for deposits
	private static readonly TRANSFER_TIMEOUT = 30; // 30 seconds for internal transfers

	/** Acquire withdrawal lock with strict verification */
	static async lockWithdrawal(
		userId: number,
		amount: number,
		targetAddress: string,
	): Promise<{ success: boolean; lockId?: string; error?: string }> {
		// Check for existing lock
		const existingLock = await TransactionLockService.getActiveLock(userId);

		if (existingLock) {
			const age = Math.floor(Date.now() / 1000) - existingLock.lockedAt;

			// Only allow override if lock is expired AND transaction verification failed
			if (age < TransactionLockService.WITHDRAWAL_TIMEOUT) {
				return {
					success: false,
					error: `Withdrawal in progress. Please wait ${TransactionLockService.WITHDRAWAL_TIMEOUT - age} seconds.`,
				};
			}

			// Check if the old transaction needs verification
			if (existingLock.txHash) {
				const verification = await TransactionLockService.verifyTxComplete(
					userId,
					existingLock.txHash,
					existingLock.amount,
				);

				if (!verification.verified && verification.ledgerUpdated) {
					// Transaction failed but ledger was updated - needs manual review
					logger.error("Inconsistent state detected", {
						userId,
						txHash: existingLock.txHash,
						verification,
					});

					return {
						success: false,
						error:
							"Previous transaction in inconsistent state. Contact support.",
					};
				}
			}

			// Safe to remove old lock
			execute("DELETE FROM transaction_locks WHERE user_id = ?", [userId]);
		}

		// Create new lock
		const lockId = `WD_${userId}_${Date.now()}`;

		try {
			execute(
				`INSERT INTO transaction_locks
         (user_id, lock_type, amount, target_address, metadata, locked_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					userId,
					"withdrawal",
					amount,
					targetAddress,
					JSON.stringify({ lockId }),
					Math.floor(Date.now() / 1000),
					"pending",
				],
			);

			logger.info("Withdrawal lock acquired", {
				userId,
				amount,
				targetAddress,
				lockId,
			});

			return { success: true, lockId };
		} catch (error) {
			logger.error("Failed to acquire withdrawal lock", {
				userId,
				amount,
				error,
			});

			return {
				success: false,
				error: "Failed to acquire transaction lock",
			};
		}
	}

	/**
	 * Update lock with transaction hash after blockchain submission
	 */
	static async updateLockWithTxHash(
		userId: number,
		txHash: string,
	): Promise<void> {
		execute(
			`UPDATE transaction_locks
       SET tx_hash = ?, status = 'processing'
       WHERE user_id = ? AND lock_type = 'withdrawal' AND status = 'pending'`,
			[txHash, userId],
		);

		logger.info("Lock updated with transaction hash", { userId, txHash });
	}

	/** Verify tx confirmed on-chain and ledger updated (dual verification) */
	static async verifyTxComplete(
		userId: number,
		txHash: string,
		expectedAmount: number,
	): Promise<VerificationResult> {
		try {
			// 1. Check blockchain transaction
			const txVerification =
				await TransactionLockService.verifyTransaction(txHash);

			if (!txVerification.verified || txVerification.txStatus !== 0) {
				return {
					verified: false,
					txStatus: txVerification.txStatus,
					error: "Transaction not confirmed or failed",
				};
			}

			// 2. Verify amount matches
			if (
				Math.abs((txVerification.actualAmount || 0) - expectedAmount) > 0.000001
			) {
				logger.error("Amount mismatch in transaction", {
					expected: expectedAmount,
					actual: txVerification.actualAmount,
					txHash,
				});

				return {
					verified: false,
					error: "Transaction amount mismatch",
				};
			}

			// 3. Check ledger update
			const ledgerVerification =
				await TransactionLockService.verifyLedgerUpdate(
					userId,
					expectedAmount,
					"withdrawal",
				);

			if (!ledgerVerification) {
				return {
					verified: false,
					txStatus: 0,
					actualAmount: txVerification.actualAmount,
					ledgerUpdated: false,
					error: "Ledger not properly updated",
				};
			}

			return {
				verified: true,
				txStatus: 0,
				actualAmount: txVerification.actualAmount,
				ledgerUpdated: true,
			};
		} catch (error) {
			logger.error("Withdrawal verification failed", {
				userId,
				txHash,
				error,
			});

			return {
				verified: false,
				error: "Verification failed",
			};
		}
	}

	/**
	 * Verify transaction on blockchain using RPC
	 */
	private static async verifyTransaction(txHash: string): Promise<{
		verified: boolean;
		txStatus?: number;
		actualAmount?: number;
	}> {
		try {
			// Use RPC verification service
			const result = await RPCTransactionVerification.fetchTransaction(txHash);

			if (!result.success || !result.data) {
				logger.warn("Transaction not found or fetch failed", { txHash });
				return { verified: false };
			}

			const tx = result.data;

			// Check transaction status (0 = success)
			if (tx.status !== 0) {
				return {
					verified: false,
					txStatus: tx.status,
				};
			}

			// Calculate total amount from all transfers
			let totalAmount = 0;
			for (const transfer of tx.transfers) {
				totalAmount = AmountPrecision.add(totalAmount, transfer.amount);
			}

			return {
				verified: true,
				txStatus: 0,
				actualAmount: totalAmount,
			};
		} catch (error) {
			logger.error("Transaction verification failed", { txHash, error });
			return { verified: false };
		}
	}

	/**
	 * Verify ledger has been properly updated
	 */
	private static async verifyLedgerUpdate(
		userId: number,
		amount: number,
		type: "withdrawal" | "deposit",
	): Promise<boolean> {
		const amountMicro = AmountPrecision.toDbMicro(amount);

		// Check recent transactions in the ledger
		const recentTx = query<any>(
			`SELECT * FROM transactions
       WHERE ${type === "withdrawal" ? "from_user_id" : "to_user_id"} = ?
       AND transaction_type = ?
       AND amount = ?
       AND created_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
			[
				userId,
				type,
				amountMicro,
				Math.floor(Date.now() / 1000) - 300, // Last 5 minutes
			],
		);

		return recentTx.length > 0;
	}

	/**
	 * Release lock only after verification
	 */
	static async releaseWithdrawalLock(
		userId: number,
		txHash: string,
		forceRelease: boolean = false,
	): Promise<{ released: boolean; error?: string }> {
		const lock = await TransactionLockService.getActiveLock(userId);

		if (!lock || lock.lockType !== "withdrawal") {
			return { released: false, error: "No withdrawal lock found" };
		}

		// Don't release without verification unless forced or timed out
		if (!forceRelease) {
			const age = Math.floor(Date.now() / 1000) - lock.lockedAt;

			if (age < TransactionLockService.WITHDRAWAL_TIMEOUT && txHash) {
				// Verify before releasing
				const verification = await TransactionLockService.verifyTxComplete(
					userId,
					txHash,
					lock.amount,
				);

				if (!verification.verified) {
					return {
						released: false,
						error: `Lock not released: ${verification.error}`,
					};
				}
			} else if (age < TransactionLockService.WITHDRAWAL_TIMEOUT) {
				return {
					released: false,
					error: "Transaction still processing",
				};
			}
		}

		// Safe to release
		execute(
			"UPDATE transaction_locks SET status = ? WHERE user_id = ? AND lock_type = ?",
			["completed", userId, "withdrawal"],
		);

		execute("DELETE FROM transaction_locks WHERE user_id = ?", [userId]);

		logger.info("Withdrawal lock released", {
			userId,
			txHash,
			forced: forceRelease,
		});

		return { released: true };
	}

	/**
	 * Simple lock for internal transfers between users
	 * Locks both sender and receiver, no complex verification needed
	 */
	static async acquireTransferLocks(
		fromUserId: number,
		toUserId: number,
		amount: number,
	): Promise<{ success: boolean; error?: string }> {
		// Check neither user has an existing lock
		const fromLock = await TransactionLockService.getActiveLock(fromUserId);
		const toLock = await TransactionLockService.getActiveLock(toUserId);

		if (fromLock || toLock) {
			return {
				success: false,
				error: "One or both users have active transactions. Please try again.",
			};
		}

		// Acquire both locks atomically
		try {
			// Lock sender
			execute(
				`INSERT INTO transaction_locks
         (user_id, lock_type, amount, metadata, locked_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
				[
					fromUserId,
					"transfer",
					amount,
					JSON.stringify({ role: "sender", counterparty: toUserId }),
					Math.floor(Date.now() / 1000),
					"processing",
				],
			);

			// Lock receiver
			execute(
				`INSERT INTO transaction_locks
         (user_id, lock_type, amount, metadata, locked_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
				[
					toUserId,
					"transfer",
					amount,
					JSON.stringify({ role: "receiver", counterparty: fromUserId }),
					Math.floor(Date.now() / 1000),
					"processing",
				],
			);

			logger.info("Transfer locks acquired", {
				fromUserId,
				toUserId,
				amount,
			});

			return { success: true };
		} catch (error) {
			// Clean up any partial locks
			execute("DELETE FROM transaction_locks WHERE user_id IN (?, ?)", [
				fromUserId,
				toUserId,
			]);

			logger.error("Failed to acquire transfer locks", {
				fromUserId,
				toUserId,
				error,
			});

			return {
				success: false,
				error: "Failed to acquire transfer locks",
			};
		}
	}

	/**
	 * Release transfer locks after ledger update
	 */
	static async releaseTransferLocks(
		fromUserId: number,
		toUserId: number,
	): Promise<void> {
		execute(
			"DELETE FROM transaction_locks WHERE user_id IN (?, ?) AND lock_type = ?",
			[fromUserId, toUserId, "transfer"],
		);

		logger.info("Transfer locks released", { fromUserId, toUserId });
	}

	/**
	 * Get active lock for a user
	 */
	static async getActiveLock(userId: number): Promise<TransactionLock | null> {
		const row = get<any>("SELECT * FROM transaction_locks WHERE user_id = ?", [
			userId,
		]);

		if (!row) return null;

		let metadata = row.metadata;
		if (metadata) {
			try {
				metadata = JSON.parse(metadata);
			} catch {}
		}

		return {
			userId: row.user_id,
			lockType: row.lock_type,
			amount: row.amount,
			txHash: row.tx_hash || undefined,
			targetAddress: row.target_address || undefined,
			metadata,
			lockedAt: row.locked_at,
			status: row.status,
		};
	}

	/**
	 * Checks if a user has an active transaction lock.
	 *
	 * @param userId - User ID to check
	 * @returns True if user has an active lock, false otherwise
	 */
	static async hasLock(userId: number): Promise<boolean> {
		const lock = await TransactionLockService.getActiveLock(userId);
		return lock !== null;
	}

	/**
	 * Alias for hasLock - checks if a user has an active transaction lock.
	 *
	 * @param userId - User ID to check
	 * @returns True if user has an active lock, false otherwise
	 */
	static async isUserLocked(userId: number): Promise<boolean> {
		return TransactionLockService.hasLock(userId);
	}

	/**
	 * Initialize the transaction lock service (no-op, provided for API consistency)
	 */
	static initialize(): void {
		// No initialization needed - service uses static methods
	}

	/**
	 * Alias for getActiveLock - get lock details for a user.
	 *
	 * @param userId - User ID to get lock for
	 * @returns Lock details or null if no active lock
	 */
	static async getUserLock(userId: number): Promise<TransactionLock | null> {
		return TransactionLockService.getActiveLock(userId);
	}

	/**
	 * Generic lock acquisition (alias for lockWithdrawal for simple locking)
	 */
	static async acquireLock(
		userId: number,
		lockType: string,
		amount?: number,
	): Promise<boolean> {
		// Check if user already has a lock
		const existingLock = await TransactionLockService.getActiveLock(userId);
		if (existingLock) {
			return false;
		}

		// Create lock
		const now = Math.floor(Date.now() / 1000);
		execute(
			`INSERT INTO transaction_locks (user_id, lock_type, locked_at, amount)
       VALUES (?, ?, ?, ?)`,
			[userId, lockType, now, amount || 0],
		);

		return true;
	}

	/**
	 * Generic lock release
	 */
	static async releaseLock(userId: number): Promise<void> {
		execute("DELETE FROM transaction_locks WHERE user_id = ?", [userId]);
	}

	/**
	 * Clean up only truly expired locks
	 */
	static async cleanExpiredLocks(): Promise<void> {
		const now = Math.floor(Date.now() / 1000);

		// Get all potentially expired locks
		const expiredLocks = query<any>(
			`SELECT * FROM transaction_locks
       WHERE (
         (lock_type = 'withdrawal' AND locked_at < ?) OR
         (lock_type = 'deposit' AND locked_at < ?) OR
         (lock_type = 'transfer' AND locked_at < ?)
       )`,
			[
				now - TransactionLockService.WITHDRAWAL_TIMEOUT,
				now - TransactionLockService.DEPOSIT_TIMEOUT,
				now - TransactionLockService.TRANSFER_TIMEOUT,
			],
		);

		for (const lock of expiredLocks) {
			// For withdrawals with tx hash, verify before cleaning
			if (lock.lock_type === "withdrawal" && lock.tx_hash) {
				const verification = await TransactionLockService.verifyTxComplete(
					lock.user_id,
					lock.tx_hash,
					lock.amount,
				);

				if (!verification.verified) {
					// Log for manual review
					logger.warn("Expired withdrawal lock with unverified transaction", {
						userId: lock.user_id,
						txHash: lock.tx_hash,
						amount: lock.amount,
						age: now - lock.locked_at,
					});
				}
			}

			// Remove the expired lock
			execute("DELETE FROM transaction_locks WHERE user_id = ?", [
				lock.user_id,
			]);

			logger.info("Expired lock removed", {
				userId: lock.user_id,
				lockType: lock.lock_type,
				age: now - lock.locked_at,
			});
		}
	}

	/**
	 * Emergency force unlock (admin only)
	 */
	static async forceUnlock(userId: number, reason: string): Promise<void> {
		const lock = await TransactionLockService.getActiveLock(userId);

		if (lock) {
			logger.warn("Force unlocking user", {
				userId,
				lockType: lock.lockType,
				amount: lock.amount,
				txHash: lock.txHash,
				reason,
			});

			execute("DELETE FROM transaction_locks WHERE user_id = ?", [userId]);
		}
	}
}
