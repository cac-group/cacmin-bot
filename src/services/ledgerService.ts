import { config } from "../config";
import { execute, get, query } from "../database";
import { logger } from "../utils/logger";

// Transaction types
export enum TransactionType {
	DEPOSIT = "deposit",
	WITHDRAWAL = "withdrawal",
	TRANSFER = "transfer",
	FINE = "fine",
	BAIL = "bail",
	GIVEAWAY = "giveaway",
	REFUND = "refund",
	GAMBLING = "gambling",
}

// Transaction status
export enum TransactionStatus {
	PENDING = "pending",
	COMPLETED = "completed",
	FAILED = "failed",
}

interface UserBalance {
	userId: number;
	balance: number;
	lastUpdated: number;
	createdAt: number;
}

interface Transaction {
	id?: number;
	transactionType: TransactionType;
	fromUserId?: number;
	toUserId?: number;
	amount: number;
	balanceAfter?: number;
	description?: string;
	txHash?: string;
	externalAddress?: string;
	status: TransactionStatus;
	createdAt?: number;
	metadata?: string;
}

export class LedgerService {
	private static botTreasuryAddress: string;
	private static userFundsAddress: string;
	private static apiEndpoint: string;

	/**
	 * Initialize the ledger service
	 */
	static initialize(): void {
		LedgerService.apiEndpoint =
			config.junoApiUrl || "https://api.juno.basementnodes.ca";

		// Get or set system wallet addresses
		LedgerService.botTreasuryAddress = config.botTreasuryAddress || "";
		LedgerService.userFundsAddress = config.userFundsAddress || "";

		if (!LedgerService.botTreasuryAddress || !LedgerService.userFundsAddress) {
			logger.warn("System wallet addresses not fully configured");
		}

		// Store system wallets in database
		LedgerService.initializeSystemWallets();

		logger.info("Ledger service initialized", {
			treasury: LedgerService.botTreasuryAddress,
			userFunds: LedgerService.userFundsAddress,
		});
	}

	/**
	 * Initialize system wallets in database
	 */
	private static initializeSystemWallets(): void {
		if (LedgerService.botTreasuryAddress) {
			execute(
				"INSERT OR REPLACE INTO system_wallets (id, address, description) VALUES (?, ?, ?)",
				[
					"treasury",
					LedgerService.botTreasuryAddress,
					"Bot treasury wallet for fines and giveaways",
				],
			);
		}

		if (LedgerService.userFundsAddress) {
			execute(
				"INSERT OR REPLACE INTO system_wallets (id, address, description) VALUES (?, ?, ?)",
				[
					"user_funds",
					LedgerService.userFundsAddress,
					"Collective user funds wallet",
				],
			);
		}
	}

	/**
	 * Get user's current balance from internal ledger
	 */
	static async getUserBalance(userId: number): Promise<number> {
		const balance = get<UserBalance>(
			"SELECT * FROM user_balances WHERE user_id = ?",
			[userId],
		);

		return balance?.balance || 0;
	}

	/**
	 * Get or create user balance entry
	 */
	static async ensureUserBalance(userId: number): Promise<UserBalance> {
		let balance = get<UserBalance>(
			"SELECT * FROM user_balances WHERE user_id = ?",
			[userId],
		);

		if (!balance) {
			const now = Math.floor(Date.now() / 1000);
			execute(
				"INSERT INTO user_balances (user_id, balance, last_updated, created_at) VALUES (?, 0, ?, ?)",
				[userId, now, now],
			);

			balance = {
				userId,
				balance: 0,
				lastUpdated: now,
				createdAt: now,
			};
		}

		return balance;
	}

	/**
	 * Update user balance (internal use only, use transaction methods for actual operations)
	 */
	private static async updateBalance(
		userId: number,
		newBalance: number,
	): Promise<void> {
		const now = Math.floor(Date.now() / 1000);
		execute(
			"UPDATE user_balances SET balance = ?, last_updated = ? WHERE user_id = ?",
			[newBalance, now, userId],
		);
	}

	/**
	 * Record a transaction in the ledger
	 */
	private static async recordTransaction(
		transaction: Transaction,
	): Promise<number> {
		const result = execute(
			`INSERT INTO transactions (
        transaction_type, from_user_id, to_user_id, amount, balance_after,
        description, tx_hash, external_address, status, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				transaction.transactionType,
				transaction.fromUserId || null,
				transaction.toUserId || null,
				transaction.amount,
				transaction.balanceAfter || null,
				transaction.description || null,
				transaction.txHash || null,
				transaction.externalAddress || null,
				transaction.status,
				transaction.metadata || null,
			],
		);

		return result.lastInsertRowid as number;
	}

	/**
	 * Process a deposit from an external wallet
	 */
	static async processDeposit(
		userId: number,
		amount: number,
		txHash: string,
		fromAddress: string,
		description?: string,
	): Promise<{ success: boolean; newBalance: number; error?: string }> {
		try {
			// Ensure user has a balance entry
			await LedgerService.ensureUserBalance(userId);

			// Get current balance
			const currentBalance = await LedgerService.getUserBalance(userId);
			const newBalance = currentBalance + amount;

			// Update balance
			await LedgerService.updateBalance(userId, newBalance);

			// Record transaction
			await LedgerService.recordTransaction({
				transactionType: TransactionType.DEPOSIT,
				toUserId: userId,
				amount,
				balanceAfter: newBalance,
				description: description || `Deposit from ${fromAddress}`,
				txHash,
				externalAddress: fromAddress,
				status: TransactionStatus.COMPLETED,
			});

			logger.info("Deposit processed", {
				userId,
				amount,
				newBalance,
				txHash,
			});

			return { success: true, newBalance };
		} catch (error) {
			logger.error("Failed to process deposit", { userId, amount, error });
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(userId),
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Process a withdrawal to an external wallet
	 */
	static async processWithdrawal(
		userId: number,
		amount: number,
		toAddress: string,
		txHash?: string,
		description?: string,
	): Promise<{
		success: boolean;
		newBalance: number;
		transactionId?: number;
		error?: string;
	}> {
		try {
			// Check balance
			const currentBalance = await LedgerService.getUserBalance(userId);
			if (currentBalance < amount) {
				return {
					success: false,
					newBalance: currentBalance,
					error: "Insufficient balance",
				};
			}

			const newBalance = currentBalance - amount;

			// Record as pending if no txHash yet
			const status = txHash
				? TransactionStatus.COMPLETED
				: TransactionStatus.PENDING;

			// Update balance
			await LedgerService.updateBalance(userId, newBalance);

			// Record transaction
			const transactionId = await LedgerService.recordTransaction({
				transactionType: TransactionType.WITHDRAWAL,
				fromUserId: userId,
				amount,
				balanceAfter: newBalance,
				description: description || `Withdrawal to ${toAddress}`,
				txHash,
				externalAddress: toAddress,
				status,
			});

			logger.info("Withdrawal processed", {
				userId,
				amount,
				newBalance,
				toAddress,
				txHash,
				transactionId,
			});

			return { success: true, newBalance, transactionId };
		} catch (error) {
			logger.error("Failed to process withdrawal", { userId, amount, error });
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(userId),
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Transfer tokens between users (internal ledger only)
	 */
	static async transferBetweenUsers(
		fromUserId: number,
		toUserId: number,
		amount: number,
		description?: string,
	): Promise<{
		success: boolean;
		fromBalance: number;
		toBalance: number;
		error?: string;
	}> {
		try {
			// Ensure both users have balance entries
			await LedgerService.ensureUserBalance(fromUserId);
			await LedgerService.ensureUserBalance(toUserId);

			// Check sender balance
			const fromBalance = await LedgerService.getUserBalance(fromUserId);
			if (fromBalance < amount) {
				return {
					success: false,
					fromBalance,
					toBalance: await LedgerService.getUserBalance(toUserId),
					error: "Insufficient balance",
				};
			}

			const toBalance = await LedgerService.getUserBalance(toUserId);

			// Update balances
			const newFromBalance = fromBalance - amount;
			const newToBalance = toBalance + amount;

			await LedgerService.updateBalance(fromUserId, newFromBalance);
			await LedgerService.updateBalance(toUserId, newToBalance);

			// Record transaction
			await LedgerService.recordTransaction({
				transactionType: TransactionType.TRANSFER,
				fromUserId,
				toUserId,
				amount,
				balanceAfter: newFromBalance,
				description: description || `Transfer to user ${toUserId}`,
				status: TransactionStatus.COMPLETED,
			});

			logger.info("Internal transfer completed", {
				fromUserId,
				toUserId,
				amount,
				newFromBalance,
				newToBalance,
			});

			return {
				success: true,
				fromBalance: newFromBalance,
				toBalance: newToBalance,
			};
		} catch (error) {
			logger.error("Failed to process transfer", {
				fromUserId,
				toUserId,
				amount,
				error,
			});
			return {
				success: false,
				fromBalance: await LedgerService.getUserBalance(fromUserId),
				toBalance: await LedgerService.getUserBalance(toUserId),
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Process a fine payment
	 */
	static async processFine(
		userId: number,
		amount: number,
		violationId?: number,
		description?: string,
	): Promise<{ success: boolean; newBalance: number; error?: string }> {
		try {
			// Check balance
			const currentBalance = await LedgerService.getUserBalance(userId);
			if (currentBalance < amount) {
				return {
					success: false,
					newBalance: currentBalance,
					error: "Insufficient balance for fine payment",
				};
			}

			const newBalance = currentBalance - amount;

			// Update balance
			await LedgerService.updateBalance(userId, newBalance);

			// Record transaction
			await LedgerService.recordTransaction({
				transactionType: TransactionType.FINE,
				fromUserId: userId,
				amount,
				balanceAfter: newBalance,
				description:
					description ||
					`Fine payment${violationId ? ` for violation #${violationId}` : ""}`,
				status: TransactionStatus.COMPLETED,
				metadata: violationId ? JSON.stringify({ violationId }) : undefined,
			});

			logger.info("Fine processed", {
				userId,
				amount,
				newBalance,
				violationId,
			});

			return { success: true, newBalance };
		} catch (error) {
			logger.error("Failed to process fine", { userId, amount, error });
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(userId),
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Process a bail payment
	 */
	static async processBail(
		paidByUserId: number,
		bailedUserId: number,
		amount: number,
		description?: string,
	): Promise<{ success: boolean; newBalance: number; error?: string }> {
		try {
			// Check payer balance
			const payerBalance = await LedgerService.getUserBalance(paidByUserId);
			if (payerBalance < amount) {
				return {
					success: false,
					newBalance: payerBalance,
					error: "Insufficient balance for bail payment",
				};
			}

			const newBalance = payerBalance - amount;

			// Update payer balance
			await LedgerService.updateBalance(paidByUserId, newBalance);

			// Record transaction
			await LedgerService.recordTransaction({
				transactionType: TransactionType.BAIL,
				fromUserId: paidByUserId,
				toUserId: bailedUserId, // Track who was bailed
				amount,
				balanceAfter: newBalance,
				description: description || `Bail payment for user ${bailedUserId}`,
				status: TransactionStatus.COMPLETED,
			});

			logger.info("Bail processed", {
				paidByUserId,
				bailedUserId,
				amount,
				newBalance,
			});

			return { success: true, newBalance };
		} catch (error) {
			logger.error("Failed to process bail", {
				paidByUserId,
				bailedUserId,
				amount,
				error,
			});
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(paidByUserId),
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Process a giveaway/airdrop
	 */
	static async processGiveaway(
		userId: number,
		amount: number,
		description?: string,
	): Promise<{ success: boolean; newBalance: number }> {
		try {
			await LedgerService.ensureUserBalance(userId);
			const currentBalance = await LedgerService.getUserBalance(userId);
			const newBalance = currentBalance + amount;

			// Update balance
			await LedgerService.updateBalance(userId, newBalance);

			// Record transaction
			await LedgerService.recordTransaction({
				transactionType: TransactionType.GIVEAWAY,
				toUserId: userId,
				amount,
				balanceAfter: newBalance,
				description: description || "Giveaway/Airdrop",
				status: TransactionStatus.COMPLETED,
			});

			logger.info("Giveaway processed", {
				userId,
				amount,
				newBalance,
			});

			return { success: true, newBalance };
		} catch (error) {
			logger.error("Failed to process giveaway", { userId, amount, error });
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(userId),
			};
		}
	}

	/**
	 * Get transaction history for a user
	 */
	static async getUserTransactions(
		userId: number,
		limit: number = 10,
		offset: number = 0,
	): Promise<Transaction[]> {
		return query<Transaction>(
			`SELECT * FROM transactions
       WHERE from_user_id = ? OR to_user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
			[userId, userId, limit, offset],
		);
	}

	/**
	 * Update transaction status (e.g., after blockchain confirmation)
	 */
	static async updateTransactionStatus(
		transactionId: number,
		status: TransactionStatus,
		txHash?: string,
	): Promise<void> {
		const updates: string[] = ["status = ?"];
		const params: any[] = [status];

		if (txHash) {
			updates.push("tx_hash = ?");
			params.push(txHash);
		}

		params.push(transactionId);

		execute(
			`UPDATE transactions SET ${updates.join(", ")} WHERE id = ?`,
			params,
		);

		logger.info("Transaction status updated", {
			transactionId,
			status,
			txHash,
		});
	}

	/**
	 * Get system wallet addresses
	 */
	static getSystemWallets(): { treasury: string; userFunds: string } {
		return {
			treasury: LedgerService.botTreasuryAddress,
			userFunds: LedgerService.userFundsAddress,
		};
	}

	/**
	 * Get total balance across all users (for reconciliation)
	 */
	static async getTotalUserBalance(): Promise<number> {
		const result = get<{ total: number }>(
			"SELECT SUM(balance) as total FROM user_balances",
		);
		return result?.total || 0;
	}

	/** Get on-chain balance of system wallets */
	static async getSysBalance(
		walletType: "treasury" | "user_funds",
	): Promise<number> {
		const address =
			walletType === "treasury"
				? LedgerService.botTreasuryAddress
				: LedgerService.userFundsAddress;

		if (!address) {
			logger.warn(`${walletType} wallet address not configured`);
			return 0;
		}

		try {
			const response = await fetch(
				`${LedgerService.apiEndpoint}/cosmos/bank/v1beta1/balances/${address}`,
			);

			if (!response.ok) {
				logger.error(`Failed to query ${walletType} wallet balance`, {
					address,
				});
				return 0;
			}

			const data = (await response.json()) as any;
			const junoBalance = data.balances?.find((b: any) => b.denom === "ujuno");

			return junoBalance ? parseFloat(junoBalance.amount) / 1_000_000 : 0;
		} catch (error) {
			logger.error(`Error querying ${walletType} wallet balance`, { error });
			return 0;
		}
	}

	/**
	 * Reconcile internal ledger with on-chain balances
	 */
	static async reconcileBalances(): Promise<{
		internalTotal: number;
		onChainTotal: number;
		difference: number;
		matched: boolean;
	}> {
		const internalTotal = await LedgerService.getTotalUserBalance();
		const onChainBalance = await LedgerService.getSysBalance("treasury");

		const difference = Math.abs(internalTotal - onChainBalance);
		const matched = difference < 0.000001; // Allow for minor rounding differences

		logger.info("Balance reconciliation", {
			internalTotal,
			onChainTotal: onChainBalance,
			difference,
			matched,
		});

		return {
			internalTotal,
			onChainTotal: onChainBalance,
			difference,
			matched,
		};
	}

	/**
	 * Reconcile balances and alert admins if mismatch detected
	 * Note: Only logs warnings, does not send admin alerts to avoid spam
	 * Admins should use /reconcile or /walletstats commands to manually check
	 */
	static async reconcileAndAlert(): Promise<{
		internalTotal: number;
		onChainTotal: number;
		difference: number;
		matched: boolean;
	}> {
		const result = await LedgerService.reconcileBalances();

		if (!result.matched && result.difference > 0.01) {
			logger.warn("Balance mismatch detected during periodic reconciliation", {
				internalTotal: result.internalTotal,
				onChainTotal: result.onChainTotal,
				difference: result.difference,
				note: "Admins should manually verify with /reconcile or /walletstats",
			});
		}

		return result;
	}

	/**
	 * Process a balance adjustment for reconciliation purposes.
	 * Used to correct discrepancies between internal ledger and on-chain balance.
	 * Typically applied to SYSTEM_RESERVE account.
	 *
	 * @param userId - Target user ID (usually SYSTEM_RESERVE = -2)
	 * @param amount - Positive to credit, negative to debit
	 * @param description - Reason for adjustment
	 */
	static async processAdjustment(
		userId: number,
		amount: number,
		description: string,
	): Promise<{ success: boolean; newBalance: number }> {
		try {
			await LedgerService.ensureUserBalance(userId);
			const currentBalance = await LedgerService.getUserBalance(userId);
			const newBalance = currentBalance + amount;

			// Update balance (can go negative for SYSTEM_RESERVE to represent deficit)
			await LedgerService.updateBalance(userId, newBalance);

			// Record transaction with special adjustment type
			await LedgerService.recordTransaction({
				transactionType:
					amount >= 0 ? TransactionType.GIVEAWAY : TransactionType.FINE,
				fromUserId: amount < 0 ? userId : undefined,
				toUserId: amount >= 0 ? userId : undefined,
				amount: Math.abs(amount),
				balanceAfter: newBalance,
				description,
				status: TransactionStatus.COMPLETED,
				metadata: JSON.stringify({
					type: "reconciliation_adjustment",
					direction: amount >= 0 ? "credit" : "debit",
					previousBalance: currentBalance,
				}),
			});

			logger.info("Balance adjustment processed", {
				userId,
				amount,
				previousBalance: currentBalance,
				newBalance,
				description,
			});

			return { success: true, newBalance };
		} catch (error) {
			logger.error("Failed to process adjustment", { userId, amount, error });
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(userId),
			};
		}
	}
}
