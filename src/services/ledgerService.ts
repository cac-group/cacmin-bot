import { config } from "../config";
import { execute, get, query, withTransaction } from "../database";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

// Transaction types
export enum TransactionType {
	DEPOSIT = "deposit",
	WITHDRAWAL = "withdrawal",
	FEE = "fee",
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
	balance: number; // Stored as micro-units (integer) in DB
	lastUpdated: number;
	createdAt: number;
}

// Type alias for clarity in code
type MicroAmount = number; // Integer micro-units (ujuno)
type JunoAmount = number; // Float JUNO amount for display/API

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

export interface ReconciliationResult {
	internalTotal: number;
	onChainTotal: number;
	difference: number;
	matched: boolean;
	onChainAvailable: boolean;
	error?: string;
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
	 * Returns JUNO amount (converts from micro-units stored in DB)
	 */
	static async getUserBalance(userId: number): Promise<JunoAmount> {
		const balance = get<UserBalance>(
			"SELECT * FROM user_balances WHERE user_id = ?",
			[userId],
		);

		// DB stores micro-units, convert to JUNO for API
		const microBalance = balance?.balance || 0;
		return AmountPrecision.fromDbMicro(microBalance);
	}

	/**
	 * Get user's current balance in micro-units (for internal operations)
	 */
	static async getUserBalanceMicro(userId: number): Promise<MicroAmount> {
		const balance = get<UserBalance>(
			"SELECT * FROM user_balances WHERE user_id = ?",
			[userId],
		);
		return Math.round(balance?.balance || 0);
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

	// --- Synchronous helpers for use inside withTransaction() ---
	// These mirror the async helpers above but are synchronous so the
	// read-modify-write sequence can run inside a single DB transaction,
	// preventing lost updates / double-spends under concurrent handlers.

	/**
	 * Reads a user's balance in micro-units synchronously.
	 *
	 * @param userId - The user ID
	 * @returns The current balance in micro-units (integer)
	 */
	private static getBalanceMicroSync(userId: number): MicroAmount {
		const balance = get<{ balance: number }>(
			"SELECT balance FROM user_balances WHERE user_id = ?",
			[userId],
		);
		return Math.round(balance?.balance || 0);
	}

	/**
	 * Ensures a balance row exists for the user synchronously.
	 *
	 * @param userId - The user ID
	 */
	private static ensureBalanceSync(userId: number): void {
		const existing = get<{ user_id: number }>(
			"SELECT user_id FROM user_balances WHERE user_id = ?",
			[userId],
		);
		if (!existing) {
			const now = Math.floor(Date.now() / 1000);
			execute(
				"INSERT INTO user_balances (user_id, balance, last_updated, created_at) VALUES (?, 0, ?, ?)",
				[userId, now, now],
			);
		}
	}

	/**
	 * Atomically debits a user's balance if sufficient funds exist.
	 * The conditional single-statement UPDATE prevents overspending even when
	 * concurrent operations interleave.
	 *
	 * @param userId - The user ID
	 * @param amountMicro - Amount to debit in micro-units (integer)
	 * @returns True if the debit succeeded (sufficient funds), false otherwise
	 */
	private static debitBalanceSync(
		userId: number,
		amountMicro: MicroAmount,
	): boolean {
		const now = Math.floor(Date.now() / 1000);
		const result = execute(
			"UPDATE user_balances SET balance = balance - ?, last_updated = ? WHERE user_id = ? AND balance >= ?",
			[amountMicro, now, userId, amountMicro],
		);
		return result.changes > 0;
	}

	/**
	 * Atomically credits a user's balance.
	 *
	 * @param userId - The user ID
	 * @param amountMicro - Amount to credit in micro-units (integer)
	 */
	private static creditBalanceSync(
		userId: number,
		amountMicro: MicroAmount,
	): void {
		const now = Math.floor(Date.now() / 1000);
		execute(
			"UPDATE user_balances SET balance = balance + ?, last_updated = ? WHERE user_id = ?",
			[amountMicro, now, userId],
		);
	}

	/**
	 * Sets a user's balance to an exact value synchronously.
	 * Used for adjustments that may write negative balances (e.g. SYSTEM_RESERVE).
	 *
	 * @param userId - The user ID
	 * @param newBalanceMicro - The new balance in micro-units (integer)
	 */
	private static updateBalanceSync(
		userId: number,
		newBalanceMicro: MicroAmount,
	): void {
		const now = Math.floor(Date.now() / 1000);
		execute(
			"UPDATE user_balances SET balance = ?, last_updated = ? WHERE user_id = ?",
			[Math.round(newBalanceMicro), now, userId],
		);
	}

	/**
	 * Records a ledger transaction synchronously.
	 *
	 * @param transaction - The transaction to record (amounts in micro-units)
	 * @returns The new transaction id
	 */
	private static recordTransactionSync(
		transaction: Transaction & {
			amount: MicroAmount;
			balanceAfter?: MicroAmount;
		},
	): number {
		const result = execute(
			`INSERT INTO transactions (
        transaction_type, from_user_id, to_user_id, amount, balance_after,
        description, tx_hash, external_address, status, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				transaction.transactionType,
				transaction.fromUserId || null,
				transaction.toUserId || null,
				Math.round(transaction.amount),
				transaction.balanceAfter !== undefined
					? Math.round(transaction.balanceAfter)
					: null,
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
	 * @param amount - Amount in JUNO (will be converted to micro-units for storage)
	 */
	static async processDeposit(
		userId: number,
		amount: JunoAmount,
		txHash: string,
		fromAddress: string,
		description?: string,
	): Promise<{ success: boolean; newBalance: JunoAmount; error?: string }> {
		try {
			// Convert to micro-units for integer arithmetic
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Atomically credit the balance and record the ledger entry
			const newMicro = withTransaction(() => {
				LedgerService.ensureBalanceSync(userId);
				LedgerService.creditBalanceSync(userId, amountMicro);
				const next = LedgerService.getBalanceMicroSync(userId);

				LedgerService.recordTransactionSync({
					transactionType: TransactionType.DEPOSIT,
					toUserId: userId,
					amount: amountMicro,
					balanceAfter: next,
					description: description || `Deposit from ${fromAddress}`,
					txHash,
					externalAddress: fromAddress,
					status: TransactionStatus.COMPLETED,
				});

				return next;
			});

			// Convert back to JUNO for return
			const newBalance = AmountPrecision.fromDbMicro(newMicro);

			logger.info("Deposit processed", {
				userId,
				amount,
				amountMicro,
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
	 * @param amount - Amount in JUNO
	 */
	static async processWithdrawal(
		userId: number,
		amount: JunoAmount,
		toAddress: string,
		txHash?: string,
		description?: string,
	): Promise<{
		success: boolean;
		newBalance: JunoAmount;
		transactionId?: number;
		error?: string;
	}> {
		try {
			// Convert to micro-units
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Record as pending if no txHash yet
			const status = txHash
				? TransactionStatus.COMPLETED
				: TransactionStatus.PENDING;

			// Atomically debit the balance and record the ledger entry.
			// The conditional debit returns false if funds are insufficient.
			const result = withTransaction(() => {
				const ok = LedgerService.debitBalanceSync(userId, amountMicro);
				if (!ok) return { ok: false as const };

				const next = LedgerService.getBalanceMicroSync(userId);
				const transactionId = LedgerService.recordTransactionSync({
					transactionType: TransactionType.WITHDRAWAL,
					fromUserId: userId,
					amount: amountMicro,
					balanceAfter: next,
					description: description || `Withdrawal to ${toAddress}`,
					txHash,
					externalAddress: toAddress,
					status,
				});

				return { ok: true as const, next, transactionId };
			});

			if (!result.ok) {
				const currentMicro = await LedgerService.getUserBalanceMicro(userId);
				return {
					success: false,
					newBalance: AmountPrecision.fromDbMicro(currentMicro),
					error: "Insufficient balance",
				};
			}

			const newMicro = result.next;
			const transactionId = result.transactionId;
			const newBalance = AmountPrecision.fromDbMicro(newMicro);

			logger.info("Withdrawal processed", {
				userId,
				amount,
				amountMicro,
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
	 * Charge a user a ledger-only fee such as an on-chain network fee.
	 * @param amount - Amount in JUNO
	 */
	static async processFee(
		userId: number,
		amount: JunoAmount,
		description?: string,
	): Promise<{ success: boolean; newBalance: JunoAmount; error?: string }> {
		try {
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Atomically debit the balance and record the ledger entry
			const result = withTransaction(() => {
				const ok = LedgerService.debitBalanceSync(userId, amountMicro);
				if (!ok) return { ok: false as const };

				const next = LedgerService.getBalanceMicroSync(userId);
				LedgerService.recordTransactionSync({
					transactionType: TransactionType.FEE,
					fromUserId: userId,
					amount: amountMicro,
					balanceAfter: next,
					description: description || "Network fee",
					status: TransactionStatus.COMPLETED,
				});

				return { ok: true as const, next };
			});

			if (!result.ok) {
				const currentMicro = await LedgerService.getUserBalanceMicro(userId);
				return {
					success: false,
					newBalance: AmountPrecision.fromDbMicro(currentMicro),
					error: "Insufficient balance",
				};
			}

			const newBalance = AmountPrecision.fromDbMicro(result.next);

			logger.info("Fee processed", {
				userId,
				amount,
				amountMicro,
				newBalance,
			});

			return { success: true, newBalance };
		} catch (error) {
			logger.error("Failed to process fee", { userId, amount, error });
			return {
				success: false,
				newBalance: await LedgerService.getUserBalance(userId),
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Transfer tokens between users (internal ledger only)
	 * @param amount - Amount in JUNO
	 */
	static async transferBetweenUsers(
		fromUserId: number,
		toUserId: number,
		amount: JunoAmount,
		description?: string,
	): Promise<{
		success: boolean;
		fromBalance: JunoAmount;
		toBalance: JunoAmount;
		transactionId?: number;
		error?: string;
	}> {
		try {
			// Convert to micro-units
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Atomically debit the sender and credit the recipient together.
			// The conditional debit returns false if the sender lacks funds,
			// in which case nothing is written.
			const result = withTransaction(() => {
				LedgerService.ensureBalanceSync(toUserId);

				const ok = LedgerService.debitBalanceSync(fromUserId, amountMicro);
				if (!ok) return { ok: false as const };

				LedgerService.creditBalanceSync(toUserId, amountMicro);

				const newFromMicro = LedgerService.getBalanceMicroSync(fromUserId);
				const newToMicro = LedgerService.getBalanceMicroSync(toUserId);

				const transactionId = LedgerService.recordTransactionSync({
					transactionType: TransactionType.TRANSFER,
					fromUserId,
					toUserId,
					amount: amountMicro,
					balanceAfter: newFromMicro,
					description: description || `Transfer to user ${toUserId}`,
					status: TransactionStatus.COMPLETED,
				});

				return {
					ok: true as const,
					newFromMicro,
					newToMicro,
					transactionId,
				};
			});

			if (!result.ok) {
				return {
					success: false,
					fromBalance: AmountPrecision.fromDbMicro(
						await LedgerService.getUserBalanceMicro(fromUserId),
					),
					toBalance: await LedgerService.getUserBalance(toUserId),
					error: "Insufficient balance",
				};
			}

			const { newFromMicro, newToMicro, transactionId } = result;

			// Convert back to JUNO for return
			const newFromBalance = AmountPrecision.fromDbMicro(newFromMicro);
			const newToBalance = AmountPrecision.fromDbMicro(newToMicro);

			logger.info("Internal transfer completed", {
				fromUserId,
				toUserId,
				amount,
				amountMicro,
				newFromBalance,
				newToBalance,
			});

			return {
				success: true,
				fromBalance: newFromBalance,
				toBalance: newToBalance,
				transactionId,
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
	 * @param amount - Amount in JUNO
	 */
	static async processFine(
		userId: number,
		amount: JunoAmount,
		violationId?: number,
		description?: string,
	): Promise<{ success: boolean; newBalance: JunoAmount; error?: string }> {
		try {
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Atomically debit the balance and record the ledger entry
			const result = withTransaction(() => {
				const ok = LedgerService.debitBalanceSync(userId, amountMicro);
				if (!ok) return { ok: false as const };

				const next = LedgerService.getBalanceMicroSync(userId);
				LedgerService.recordTransactionSync({
					transactionType: TransactionType.FINE,
					fromUserId: userId,
					amount: amountMicro,
					balanceAfter: next,
					description:
						description ||
						`Fine payment${violationId ? ` for violation #${violationId}` : ""}`,
					status: TransactionStatus.COMPLETED,
					metadata: violationId ? JSON.stringify({ violationId }) : undefined,
				});

				return { ok: true as const, next };
			});

			if (!result.ok) {
				const currentMicro = await LedgerService.getUserBalanceMicro(userId);
				return {
					success: false,
					newBalance: AmountPrecision.fromDbMicro(currentMicro),
					error: "Insufficient balance for fine payment",
				};
			}

			const newBalance = AmountPrecision.fromDbMicro(result.next);

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
	 * @param amount - Amount in JUNO
	 */
	static async processBail(
		paidByUserId: number,
		bailedUserId: number,
		amount: JunoAmount,
		description?: string,
	): Promise<{ success: boolean; newBalance: JunoAmount; error?: string }> {
		try {
			// Convert to micro-units
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Atomically debit the payer's balance and record the ledger entry
			const result = withTransaction(() => {
				const ok = LedgerService.debitBalanceSync(paidByUserId, amountMicro);
				if (!ok) return { ok: false as const };

				const next = LedgerService.getBalanceMicroSync(paidByUserId);
				LedgerService.recordTransactionSync({
					transactionType: TransactionType.BAIL,
					fromUserId: paidByUserId,
					toUserId: bailedUserId, // Track who was bailed
					amount: amountMicro,
					balanceAfter: next,
					description: description || `Bail payment for user ${bailedUserId}`,
					status: TransactionStatus.COMPLETED,
				});

				return { ok: true as const, next };
			});

			if (!result.ok) {
				const currentMicro =
					await LedgerService.getUserBalanceMicro(paidByUserId);
				return {
					success: false,
					newBalance: AmountPrecision.fromDbMicro(currentMicro),
					error: "Insufficient balance for bail payment",
				};
			}

			const newBalance = AmountPrecision.fromDbMicro(result.next);

			logger.info("Bail processed", {
				paidByUserId,
				bailedUserId,
				amount,
				amountMicro,
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
	 * @param amount - Amount in JUNO
	 */
	static async processGiveaway(
		userId: number,
		amount: JunoAmount,
		description?: string,
	): Promise<{ success: boolean; newBalance: JunoAmount }> {
		try {
			// Convert to micro-units
			const amountMicro = AmountPrecision.toDbMicro(amount);

			// Atomically credit the balance and record the ledger entry
			const newMicro = withTransaction(() => {
				LedgerService.ensureBalanceSync(userId);
				LedgerService.creditBalanceSync(userId, amountMicro);
				const next = LedgerService.getBalanceMicroSync(userId);

				LedgerService.recordTransactionSync({
					transactionType: TransactionType.GIVEAWAY,
					toUserId: userId,
					amount: amountMicro,
					balanceAfter: next,
					description: description || "Giveaway/Airdrop",
					status: TransactionStatus.COMPLETED,
				});

				return next;
			});

			const newBalance = AmountPrecision.fromDbMicro(newMicro);

			logger.info("Giveaway processed", {
				userId,
				amount,
				amountMicro,
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
	 * Returns amounts in JUNO (converts from micro-units in DB)
	 * Note: Returns raw DB column names (snake_case) for compatibility
	 */
	static async getUserTransactions(
		userId: number,
		limit: number = 10,
		offset: number = 0,
	): Promise<Transaction[]> {
		const rows = query<any>(
			`SELECT * FROM transactions
       WHERE from_user_id = ? OR to_user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
			[userId, userId, limit, offset],
		);

		// Convert micro-units to JUNO, keep snake_case column names
		return rows.map((row) => ({
			...row,
			amount: AmountPrecision.fromDbMicro(row.amount),
			balance_after:
				row.balance_after !== null
					? AmountPrecision.fromDbMicro(row.balance_after)
					: null,
		}));
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
	 * Returns JUNO amount (converts from micro-units in DB)
	 */
	static async getTotalUserBalance(): Promise<JunoAmount> {
		const result = get<{ total: number }>(
			"SELECT SUM(balance) as total FROM user_balances",
		);
		const totalMicro = result?.total || 0;
		return AmountPrecision.fromDbMicro(totalMicro);
	}

	/**
	 * Get the total of all user balances in microJUNO (integer).
	 * Used for reconciliation to avoid floating-point precision loss.
	 */
	static getTotalUserBalanceMicro(): MicroAmount {
		const result = get<{ total: number }>(
			"SELECT SUM(balance) as total FROM user_balances",
		);
		return Math.round(result?.total || 0);
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
	static async reconcileBalances(): Promise<ReconciliationResult> {
		// Work in microJUNO (integers) to avoid floating-point precision errors
		const internalMicro = LedgerService.getTotalUserBalanceMicro();

		// Get on-chain balance as raw ujuno integer
		let onChainMicro: number | null = null;
		let onChainError: string | undefined;
		const address = LedgerService.botTreasuryAddress;
		if (address) {
			try {
				const response = await fetch(
					`${LedgerService.apiEndpoint}/cosmos/bank/v1beta1/balances/${address}`,
				);
				if (response.ok) {
					const data = (await response.json()) as any;
					const junoBalance = data.balances?.find(
						(b: any) => b.denom === "ujuno",
					);
					if (junoBalance?.amount !== undefined) {
						onChainMicro = Math.round(Number(junoBalance.amount));
					} else {
						onChainMicro = 0;
					}
				} else {
					onChainError = `HTTP ${response.status}`;
					logger.error(
						"Failed to query treasury wallet balance for reconciliation",
						{
							address,
							status: response.status,
						},
					);
				}
			} catch (error) {
				onChainError =
					error instanceof Error
						? error.message
						: "Unknown balance query error";
				logger.error(
					"Error querying treasury wallet balance for reconciliation",
					{
						error,
					},
				);
			}
		} else {
			onChainError = "Treasury wallet address not configured";
		}

		// Integer subtraction - no floating-point noise
		const onChainAvailable = onChainMicro !== null;
		const comparisonOnChainMicro = onChainMicro ?? internalMicro;
		const differenceMicro = Math.abs(internalMicro - comparisonOnChainMicro);
		const matched = onChainAvailable && differenceMicro === 0;

		const internalTotal = AmountPrecision.fromDbMicro(internalMicro);
		const onChainTotal = AmountPrecision.fromDbMicro(comparisonOnChainMicro);
		const difference = AmountPrecision.fromDbMicro(differenceMicro);

		logger.info("Balance reconciliation", {
			internalTotal,
			onChainTotal,
			difference,
			matched,
			onChainAvailable,
			error: onChainError,
		});

		return {
			internalTotal,
			onChainTotal,
			difference,
			matched,
			onChainAvailable,
			error: onChainError,
		};
	}

	/**
	 * Reconcile balances and alert admins if mismatch detected
	 * Note: Only logs warnings, does not send admin alerts to avoid spam
	 * Admins should use /reconcile or /walletstats commands to manually check
	 */
	static async reconcileAndAlert(): Promise<ReconciliationResult> {
		const result = await LedgerService.reconcileBalances();

		if (!result.onChainAvailable) {
			logger.warn(
				"Balance reconciliation skipped: on-chain balance unavailable",
				{
					internalTotal: result.internalTotal,
					error: result.error,
				},
			);
		} else if (!result.matched && result.difference > 0.01) {
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
	 * @param amount - Positive to credit, negative to debit (in JUNO)
	 * @param description - Reason for adjustment
	 */
	static async processAdjustment(
		userId: number,
		amount: JunoAmount,
		description: string,
	): Promise<{ success: boolean; newBalance: JunoAmount }> {
		try {
			// Convert to micro-units (use absolute value, handle sign separately)
			const absAmountMicro = AmountPrecision.toDbMicro(Math.abs(amount));

			// Atomically adjust the balance and record the ledger entry.
			// Negative adjustments are allowed to go negative (SYSTEM_RESERVE).
			const { currentMicro, newMicro } = withTransaction(() => {
				LedgerService.ensureBalanceSync(userId);

				const current = LedgerService.getBalanceMicroSync(userId);
				const next: MicroAmount =
					amount >= 0
						? AmountPrecision.addMicro(current, absAmountMicro)
						: current - absAmountMicro;

				LedgerService.updateBalanceSync(userId, next);

				LedgerService.recordTransactionSync({
					transactionType:
						amount >= 0 ? TransactionType.GIVEAWAY : TransactionType.FINE,
					fromUserId: amount < 0 ? userId : undefined,
					toUserId: amount >= 0 ? userId : undefined,
					amount: absAmountMicro,
					balanceAfter: next,
					description,
					status: TransactionStatus.COMPLETED,
					metadata: JSON.stringify({
						type: "reconciliation_adjustment",
						direction: amount >= 0 ? "credit" : "debit",
						previousBalanceMicro: current,
					}),
				});

				return { currentMicro: current, newMicro: next };
			});

			const currentBalance = AmountPrecision.fromDbMicro(currentMicro);
			const newBalance = AmountPrecision.fromDbMicro(newMicro);

			logger.info("Balance adjustment processed", {
				userId,
				amount,
				absAmountMicro,
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
