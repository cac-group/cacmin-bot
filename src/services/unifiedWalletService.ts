import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import type { FmtString } from "telegraf/format";
import { config } from "../config";
import { execute, get, query } from "../database";
import { looksLikeJailingId } from "../utils/jailingId";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { decodeMemo } from "../utils/txMemo";
import { CosmosRestService } from "./cosmosRestService";
import { DepositInstructionService } from "./depositInstructions";
import { JailService } from "./jailService";
import { LedgerService } from "./ledgerService";
import { TransactionLockService } from "./transactionLock";

// Special user IDs for system accounts
export const SYSTEM_USER_IDS = {
	BOT_TREASURY: -1, // Bot treasury account in internal ledger
	SYSTEM_RESERVE: -2, // System reserve for discrepancies
	UNCLAIMED: -3, // Unclaimed deposits (no memo/invalid userId)
	// Giveaway escrow accounts use IDs: -1000 - giveawayId
	// e.g., giveaway 1 = -1001, giveaway 2 = -1002, etc.
	GIVEAWAY_ESCROW_BASE: -1000,
	// Duel escrow accounts use IDs: -1000000 - duelId
	DUEL_ESCROW_BASE: -1_000_000,
};

/** Get escrow user ID for a specific giveaway */
export function getGiveawayEscrowId(giveawayId: number): number {
	return SYSTEM_USER_IDS.GIVEAWAY_ESCROW_BASE - giveawayId;
}

/** Get escrow user ID for a specific duel */
export function getDuelEscrowId(duelId: number): number {
	return SYSTEM_USER_IDS.DUEL_ESCROW_BASE - duelId;
}

const WITHDRAWAL_GAS_PRICE = config.chain.withdrawalGasPrice;
const WITHDRAWAL_GAS_LIMIT = config.chain.withdrawalGasLimit;
const WITHDRAWAL_FEE_UJUNO = Math.ceil(
	WITHDRAWAL_GAS_LIMIT * Number.parseFloat(WITHDRAWAL_GAS_PRICE),
);
const WITHDRAWAL_NETWORK_FEE =
	AmountPrecision.fromDbMicro(WITHDRAWAL_FEE_UJUNO);

export function getWithdrawalNetworkFee(): number {
	return WITHDRAWAL_NETWORK_FEE;
}

interface User {
	id: number;
	username?: string;
}

interface DepositCheck {
	txHash: string;
	userId?: number | null;
	amount: number;
	fromAddress: string;
	memo: string;
	height: number;
	timestamp: number;
}

/**
 * Unified Wallet Service
 * Single wallet system with bot as internal ledger user
 */
export class UnifiedWalletService {
	private static wallet: DirectSecp256k1HdWallet | null = null;
	private static walletAddress: string;
	private static rpcEndpoint: string;
	private static depositCheckInterval: NodeJS.Timeout | null = null;
	private static lastCheckedHeight: number = 0;

	/**
	 * Initialize the unified wallet service
	 */
	static async initialize(): Promise<void> {
		UnifiedWalletService.rpcEndpoint = config.junoRpcUrl;

		// Get wallet address from config (single wallet for all users)
		UnifiedWalletService.walletAddress = config.userFundsAddress || "";

		if (!UnifiedWalletService.walletAddress) {
			logger.error("Wallet address not configured");
			return;
		}

		// Initialize wallet signer if mnemonic is provided
		if (config.userFundsMnemonic) {
			try {
				UnifiedWalletService.wallet =
					await DirectSecp256k1HdWallet.fromMnemonic(config.userFundsMnemonic, {
						prefix: "juno",
					});

				const [account] = await UnifiedWalletService.wallet.getAccounts();

				if (account.address !== UnifiedWalletService.walletAddress) {
					logger.warn("Wallet address mismatch", {
						configured: UnifiedWalletService.walletAddress,
						derived: account.address,
					});
				}
			} catch (error) {
				logger.error("Failed to initialize wallet from mnemonic", error);
			}
		}

		// Initialize system users in the ledger
		await UnifiedWalletService.initSysUsers();

		// Get last checked height for deposits
		const lastProcessed = get<{ height: number }>(
			"SELECT MAX(height) as height FROM processed_deposits",
		);
		UnifiedWalletService.lastCheckedHeight = lastProcessed?.height || 0;

		logger.info("Unified wallet service initialized", {
			address: UnifiedWalletService.walletAddress,
			hasSigningCapability: !!UnifiedWalletService.wallet,
			lastCheckedHeight: UnifiedWalletService.lastCheckedHeight,
		});

		// Run startup reconciliation to catch any missed deposits
		await UnifiedWalletService.reconcileStartupDeposits();

		// Start deposit monitoring
		UnifiedWalletService.startDepositMonitoring();
	}

	/** Initialize system users in ledger */
	private static async initSysUsers(): Promise<void> {
		const { createUser, userExists } = await import("./userService");

		// Ensure bot treasury user exists
		if (!userExists(SYSTEM_USER_IDS.BOT_TREASURY)) {
			createUser(
				SYSTEM_USER_IDS.BOT_TREASURY,
				"BOT_TREASURY",
				"system",
				"system_initialization",
			);
			await LedgerService.ensureUserBalance(SYSTEM_USER_IDS.BOT_TREASURY);
			logger.info("Created bot treasury user in ledger");
		}

		// Ensure system reserve user exists (for reconciliation adjustments)
		if (!userExists(SYSTEM_USER_IDS.SYSTEM_RESERVE)) {
			createUser(
				SYSTEM_USER_IDS.SYSTEM_RESERVE,
				"SYSTEM_RESERVE",
				"system",
				"system_initialization",
			);
			await LedgerService.ensureUserBalance(SYSTEM_USER_IDS.SYSTEM_RESERVE);
			logger.info("Created system reserve user in ledger");
		}

		// Ensure unclaimed deposits user exists
		if (!userExists(SYSTEM_USER_IDS.UNCLAIMED)) {
			createUser(
				SYSTEM_USER_IDS.UNCLAIMED,
				"UNCLAIMED_DEPOSITS",
				"system",
				"system_initialization",
			);
			await LedgerService.ensureUserBalance(SYSTEM_USER_IDS.UNCLAIMED);
			logger.info("Created unclaimed deposits user in ledger");
		}

		// One-time migration: transfer any SYSTEM_RESERVE deficit to BOT_TREASURY.
		// Gas fees and adjustments were incorrectly debited from SYSTEM_RESERVE
		// (which was never funded), creating an impossible negative balance.
		// Gated by a marker: later operational debits (e.g. admin bail payments)
		// must stay on the reserve and never be swept onto the game treasury.
		const reserveMigrationKey = "system_reserve_deficit_migrated";
		const reserveMigrationDone = get<{ value: string }>(
			"SELECT value FROM system_state WHERE key = ?",
			[reserveMigrationKey],
		);
		if (!reserveMigrationDone) {
			const reserveMicro = await LedgerService.getUserBalanceMicro(
				SYSTEM_USER_IDS.SYSTEM_RESERVE,
			);
			if (reserveMicro < 0) {
				const deficitJuno = AmountPrecision.fromDbMicro(Math.abs(reserveMicro));
				logger.info("Migrating SYSTEM_RESERVE deficit to BOT_TREASURY", {
					reserveBalanceMicro: reserveMicro,
					deficitJuno,
				});
				// Credit SYSTEM_RESERVE back to zero
				await LedgerService.processAdjustment(
					SYSTEM_USER_IDS.SYSTEM_RESERVE,
					deficitJuno,
					"Migration: zeroing SYSTEM_RESERVE deficit",
				);
				// Debit the same amount from BOT_TREASURY
				await LedgerService.processAdjustment(
					SYSTEM_USER_IDS.BOT_TREASURY,
					-deficitJuno,
					"Migration: absorbing SYSTEM_RESERVE deficit as gas/adjustment costs",
				);
				logger.info("SYSTEM_RESERVE deficit migrated to BOT_TREASURY");
			}
			execute(
				`INSERT OR REPLACE INTO system_state (key, value, updated_at)
				 VALUES (?, 'completed', strftime('%s', 'now'))`,
				[reserveMigrationKey],
			);
		}
	}

	/**
	 * Reconcile deposits on startup - catch any that were missed
	 */
	private static async reconcileStartupDeposits(): Promise<void> {
		try {
			logger.info("Running startup deposit reconciliation...");

			// Fetch all deposits from blockchain
			const query = `transfer.recipient='${UnifiedWalletService.walletAddress}'`;
			const url = `${UnifiedWalletService.rpcEndpoint}/tx_search?query="${encodeURIComponent(query)}"&prove=false&per_page=100&order_by=%22desc%22`;

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`RPC request failed: ${response.status}`);
			}

			const data = (await response.json()) as any;
			const txs = data.result?.txs || [];

			let processedCount = 0;
			let skippedCount = 0;

			for (const tx of txs) {
				// Skip failed transactions
				if (tx.tx_result.code !== 0) continue;

				// Check if already in database
				const existing = get<any>(
					"SELECT * FROM processed_deposits WHERE tx_hash = ?",
					[tx.hash],
				);
				if (existing) {
					skippedCount++;
					continue;
				}

				// Extract the first transfer paying our wallet (attributes paired by index)
				const transfer = UnifiedWalletService.findTransferTo(
					tx.tx_result.events,
					UnifiedWalletService.walletAddress,
				);
				if (!transfer) continue;
				const { amount, from: fromAddress } = transfer;

				// Extract memo
				const memo = decodeMemo(tx.tx) ?? "";
				const userId = UnifiedWalletService.parseUserId(memo);

				// Process this missed deposit
				await UnifiedWalletService.processDeposit({
					txHash: tx.hash,
					userId,
					amount,
					fromAddress,
					memo,
					height: parseInt(tx.height, 10),
					timestamp: Math.floor(Date.now() / 1000),
				});

				processedCount++;

				logger.info("Processed missed deposit during reconciliation", {
					txHash: tx.hash,
					amount,
					userId: userId || "unclaimed",
					memo,
				});
			}

			logger.info("Startup reconciliation complete", {
				totalScanned: txs.length,
				alreadyProcessed: skippedCount,
				newlyProcessed: processedCount,
			});
		} catch (error) {
			logger.error("Startup deposit reconciliation failed", error);
		}
	}

	/**
	 * Start monitoring for deposits
	 */
	private static startDepositMonitoring(): void {
		if (UnifiedWalletService.depositCheckInterval) {
			return;
		}

		// Poll at a conservative cadence to avoid hammering the archive node.
		UnifiedWalletService.depositCheckInterval = setInterval(() => {
			UnifiedWalletService.checkForDeposits().catch((error) => {
				logger.error("Error checking for deposits", error);
			});
		}, config.intervals.depositCheckMs);

		// Do initial check
		UnifiedWalletService.checkForDeposits().catch((error) => {
			logger.error("Initial deposit check failed", error);
		});

		logger.info("Deposit monitoring started");
	}

	/**
	 * Check for new deposits
	 */
	private static async checkForDeposits(): Promise<void> {
		try {
			const deposits = await UnifiedWalletService.fetchRecentDeposits();

			for (const deposit of deposits) {
				await UnifiedWalletService.processDeposit(deposit);
			}
		} catch (error) {
			logger.error("Failed to check deposits", error);
		}
	}

	/**
	 * First `transfer` event entry paying `recipient`, with repeating
	 * sender/recipient/amount attributes paired by index (Cosmos merges same-type
	 * events into one event with repeated attributes).
	 */
	private static findTransferTo(
		events: Array<{
			type: string;
			attributes: Array<{ key: string; value: string }>;
		}>,
		recipient: string,
	): { amount: number; from: string } | null {
		for (const event of events) {
			if (event.type !== "transfer") continue;

			const senders: string[] = [];
			const recipients: string[] = [];
			const amounts: string[] = [];
			for (const attr of event.attributes) {
				if (attr.key === "sender") senders.push(attr.value);
				else if (attr.key === "recipient") recipients.push(attr.value);
				else if (attr.key === "amount") amounts.push(attr.value);
			}

			for (let i = 0; i < amounts.length; i++) {
				if (recipients[i] !== recipient) continue;
				const match = amounts[i].match(/^(\d+)ujuno$/);
				if (!match) continue;
				return {
					amount: parseFloat(match[1]) / 1_000_000,
					from: senders[i] ?? "",
				};
			}
		}
		return null;
	}

	/**
	 * Fetch recent deposits from blockchain via Cosmos REST API.
	 *
	 * This function queries the blockchain for transactions sent to the bot's wallet address,
	 * verifies they are valid JUNO transfers, and extracts the userId from the memo field.
	 *
	 * **Critical:** Only processes transactions with:
	 * 1. Successful status (code === 0)
	 * 2. Denomination === 'ujuno' (base denom for JUNO)
	 * 3. Valid memo containing a numeric userId
	 *
	 * **Amount Conversion:** JUNO uses 6 decimals, so:
	 * - 1 JUNO = 1,000,000 ujuno
	 * - Amount in ujuno is divided by 1,000,000 to get JUNO
	 *
	 * @returns Array of deposits to process
	 *
	 * @example
	 * On-chain transaction:
	 * - Amount: 100000000 ujuno
	 * - Memo: "123456"
	 * - Converted: 100.000000 JUNO credited to user 123456
	 */
	private static async fetchRecentDeposits(): Promise<DepositCheck[]> {
		try {
			// Targeted query: newest transfers to our wallet first, then stop at the
			// last height we already processed (no re-scanning old history).
			const query = `transfer.recipient='${UnifiedWalletService.walletAddress}'`;
			const url = `${UnifiedWalletService.rpcEndpoint}/tx_search?query="${encodeURIComponent(query)}"&prove=false&per_page=20&order_by=%22desc%22`;

			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`RPC request failed: ${response.status}`);
			}

			const data = (await response.json()) as any;
			const deposits: DepositCheck[] = [];

			for (const tx of data.result?.txs || []) {
				const height = parseInt(tx.height, 10);

				// Descending order: once we reach already-processed history, stop.
				if (height <= UnifiedWalletService.lastCheckedHeight) {
					break;
				}

				// Skip failed transactions
				if (tx.tx_result.code !== 0) {
					logger.debug("Skipping failed transaction", {
						txHash: tx.hash,
						code: tx.tx_result.code,
					});
					continue;
				}

				// Extract the first transfer paying our wallet (attributes paired by index)
				const transfer = UnifiedWalletService.findTransferTo(
					tx.tx_result.events,
					UnifiedWalletService.walletAddress,
				);
				if (!transfer) {
					continue; // No valid transfer to our address
				}
				const { amount, from: fromAddress } = transfer;

				// Decode the signed memo (the deposit allocation key)
				const memo = decodeMemo(tx.tx) ?? "";
				const userId = UnifiedWalletService.parseUserId(memo);

				deposits.push({
					txHash: tx.hash,
					userId,
					amount,
					fromAddress,
					memo,
					height,
					timestamp: Math.floor(Date.now() / 1000), // RPC doesn't provide timestamp
				});

				logger.debug("Deposit detected", {
					txHash: tx.hash,
					amount: `${amount} JUNO`,
					memo,
					userId: userId || "invalid",
					fromAddress,
				});
			}

			return deposits;
		} catch (error) {
			logger.error("Failed to fetch deposits", error);
			return [];
		}
	}

	/**
	 * Process a single deposit.
	 *
	 * This function handles deposit credits after blockchain confirmation.
	 *
	 * **Pre-Funded Account Creation:**
	 * If a deposit comes in for a userId that doesn't exist in the database yet,
	 * we create a "pre-funded" account for them. When they first interact with the bot,
	 * they'll automatically have access to these deposited funds.
	 *
	 * **Flow:**
	 * 1. Check if already processed (prevent duplicates)
	 * 2. Record deposit as processing
	 * 3. Validate userId from memo
	 * 4. If userId valid but user doesn't exist → create pre-funded account
	 * 5. If userId invalid/missing → send to UNCLAIMED (admin can manually assign)
	 * 6. Credit the deposit to ledger
	 * 7. Mark as processed
	 *
	 * @param deposit - Deposit information from blockchain
	 *
	 * @example
	 * Scenario 1: User 123456 deposits 100 JUNO but hasn't interacted with bot yet
	 * - Creates user with ID 123456, username "user_123456"
	 * - Credits 100 JUNO to their balance
	 * - When they use /balance later, they see 100 JUNO
	 *
	 * Scenario 2: Deposit with memo "abc" (invalid userId)
	 * - Credits to UNCLAIMED account (ID: -3)
	 * - Admin can manually assign with /claimdeposit
	 */
	private static async processDeposit(deposit: DepositCheck): Promise<void> {
		const { createUser, userExists } = await import("./userService");

		// Check if already processed in processed_deposits table
		const existing = get<any>(
			"SELECT * FROM processed_deposits WHERE tx_hash = ?",
			[deposit.txHash],
		);

		if (existing) {
			return;
		}

		// SAFEGUARD: Also check transactions table for this tx_hash
		// This prevents double-crediting if processed_deposits was missing an entry
		const existingTx = get<any>(
			"SELECT * FROM transactions WHERE tx_hash = ? AND transaction_type = 'deposit'",
			[deposit.txHash],
		);

		if (existingTx) {
			logger.warn(
				"Deposit tx_hash already exists in transactions table, skipping to prevent duplicate credit",
				{
					txHash: deposit.txHash,
					existingToUser: existingTx.to_user_id,
					existingAmount: existingTx.amount,
					attemptedUserId: deposit.userId,
					attemptedAmount: deposit.amount,
				},
			);
			// Add to processed_deposits to prevent future attempts
			execute(
				`INSERT OR IGNORE INTO processed_deposits (
					tx_hash, user_id, amount, from_address, memo, height, processed, created_at, error
				) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				[
					deposit.txHash,
					existingTx.to_user_id,
					existingTx.amount,
					deposit.fromAddress,
					deposit.memo,
					deposit.height,
					Math.floor(Date.now() / 1000),
					"Retroactively added - tx already in ledger",
				],
			);
			return;
		}

		// Bail payment: the memo carries a jailing id (alphanumeric, leading letter),
		// which is not a user id. Allocate to that jailing and release the user.
		const memoText = deposit.memo ?? "";
		if (looksLikeJailingId(memoText)) {
			// Bail memo: this tx is a bail payment, never a deposit. Allocate it or
			// record it as unallocated, but never fall through to deposit crediting.
			const jailing = JailService.getJailingByPublicId(memoText);
			let error = "bail memo did not match an open jailing";
			if (jailing) {
				if (deposit.amount !== jailing.bailAmount) {
					error = "bail amount mismatch";
					logger.warn("Bail memo found but amount mismatch", {
						txHash: deposit.txHash,
						jailingId: jailing.jailingId,
						expected: jailing.bailAmount,
						got: deposit.amount,
					});
				} else {
					const payment = JailService.payJailing(
						jailing.jailingId,
						undefined,
						deposit.txHash,
					);
					if (payment.success) {
						error = "";
						await JailService.releaseJailingTelegram(jailing.userId);
						logger.info("Bail payment detected by listener", {
							txHash: deposit.txHash,
							jailingId: jailing.jailingId,
							userId: jailing.userId,
							amount: deposit.amount,
						});
					} else {
						error = payment.duplicate
							? "bail tx hash already used"
							: "bail allocation failed";
					}
				}
			}

			execute(
				`INSERT OR IGNORE INTO processed_deposits (
					tx_hash, user_id, amount, from_address, memo, height, processed, created_at, error
				) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				[
					deposit.txHash,
					jailing?.userId ?? SYSTEM_USER_IDS.UNCLAIMED,
					deposit.amount,
					deposit.fromAddress,
					memoText,
					deposit.height,
					Math.floor(Date.now() / 1000),
					error || "bail payment",
				],
			);
			return;
		}

		// Determine target user FIRST (before inserting into processed_deposits)
		// This ensures the user exists before we reference them with a foreign key
		let targetUserId = deposit.userId;

		if (!targetUserId) {
			// No memo: attribute to the sender only when this address maps to exactly
			// one user (a prior memo'd deposit or a withdrawal to it). Shared/CEX
			// addresses fall through to UNCLAIMED.
			const depositUsers = query<{ user_id: number }>(
				`SELECT DISTINCT user_id FROM processed_deposits
				 WHERE from_address = ? AND user_id > 0`,
				[deposit.fromAddress],
			).map((r) => r.user_id);
			const withdrawalUsers = query<{ from_user_id: number }>(
				`SELECT DISTINCT from_user_id FROM transactions
				 WHERE external_address = ? AND from_user_id > 0`,
				[deposit.fromAddress],
			).map((r) => r.from_user_id);
			const candidates = new Set([...depositUsers, ...withdrawalUsers]);
			targetUserId = candidates.size === 1 ? [...candidates][0] : undefined;

			if (!targetUserId) {
				targetUserId = SYSTEM_USER_IDS.UNCLAIMED;
				logger.info("Deposit without a usable memo, sending to unclaimed", {
					txHash: deposit.txHash,
					memo: deposit.memo,
					amount: deposit.amount,
					fromAddress: deposit.fromAddress,
				});
			} else {
				logger.info("Deposit without memo attributed to known sender", {
					txHash: deposit.txHash,
					fromAddress: deposit.fromAddress,
					userId: targetUserId,
					amount: deposit.amount,
				});
			}
		} else {
			// Check if user exists, create pre-funded account if not
			if (!userExists(targetUserId)) {
				// Create pre-funded account - user will have access when they first interact
				createUser(
					targetUserId,
					`user_${targetUserId}`, // Placeholder username, updated on first interaction
					"pleb",
					"deposit_pre_funding",
				);

				// Initialize balance
				await LedgerService.ensureUserBalance(targetUserId);

				logger.info("Created pre-funded account for deposit", {
					txHash: deposit.txHash,
					userId: targetUserId,
					amount: deposit.amount,
					fromAddress: deposit.fromAddress,
					memo: deposit.memo,
				});
			}
		}

		// Record deposit as processing (user now guaranteed to exist)
		execute(
			`INSERT INTO processed_deposits (
        tx_hash, user_id, amount, from_address, memo, height, processed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
			[
				deposit.txHash,
				targetUserId, // Use resolved targetUserId, not deposit.userId
				deposit.amount,
				deposit.fromAddress,
				deposit.memo,
				deposit.height,
				deposit.timestamp,
			],
		);

		// Update last checked height
		if (deposit.height > UnifiedWalletService.lastCheckedHeight) {
			UnifiedWalletService.lastCheckedHeight = deposit.height;
		}

		// Process deposit in ledger
		const result = await LedgerService.processDeposit(
			targetUserId,
			deposit.amount,
			deposit.txHash,
			deposit.fromAddress,
			`Deposit from ${deposit.fromAddress}${deposit.memo ? ` (memo: ${deposit.memo})` : ""}`,
		);

		// Update processed status - only mark as processed=1 if successful
		if (result.success) {
			execute(
				"UPDATE processed_deposits SET processed = 1, processed_at = ?, user_id = ?, error = NULL WHERE tx_hash = ?",
				[Math.floor(Date.now() / 1000), targetUserId, deposit.txHash],
			);

			logger.info("Deposit processed successfully", {
				tag: "transaction",
				subtag: "deposit",
				userId: targetUserId,
				amount: deposit.amount,
				txHash: deposit.txHash,
				newBalance: result.newBalance,
			});
		} else {
			// Leave processed=0 and record error so it can be retried
			execute(
				"UPDATE processed_deposits SET error = ?, user_id = ? WHERE tx_hash = ?",
				[
					result.error || "Ledger processing failed",
					targetUserId,
					deposit.txHash,
				],
			);

			logger.error("Failed to process deposit", {
				userId: targetUserId,
				txHash: deposit.txHash,
				error: result.error,
			});
		}
	}

	/**
	 * Parse userId from memo
	 */
	/** A memo designates a user only when it is exactly a positive integer. */
	private static parseUserId(memo: string): number | null {
		const trimmed = memo.trim();
		if (!/^\d+$/.test(trimmed)) return null;
		const parsed = Number.parseInt(trimmed, 10);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	}

	/**
	 * Get deposit instructions for a user with clear warnings
	 */
	static getDepositInstructions(userId: number): {
		address: string;
		memo: string;
		instructions: string;
		markdown: FmtString;
	} {
		const instructions = DepositInstructionService.generateInstructions(userId);

		return {
			address: instructions.walletAddress,
			memo: instructions.memo,
			instructions: instructions.text,
			markdown: instructions.markdown,
		};
	}

	/**
	 * Process user withdrawal to external wallet with secure locking
	 */
	static async processWithdrawal(
		userId: number,
		toAddress: string,
		amount: number,
	): Promise<{
		success: boolean;
		txHash?: string;
		error?: string;
		newBalance?: number;
	}> {
		// Validate address
		if (!toAddress.startsWith("juno1") || toAddress.length !== 43) {
			return {
				success: false,
				error: "Invalid Juno address format",
			};
		}

		// Validate amount precision
		let validatedAmount: number;
		try {
			validatedAmount = AmountPrecision.validateAmount(amount);
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Invalid amount precision",
			};
		}

		const balanceMicro = await LedgerService.getUserBalanceMicro(userId);
		const validatedAmountMicro = AmountPrecision.toDbMicro(validatedAmount);
		const withdrawalFee = getWithdrawalNetworkFee();
		const requiredBalanceMicro = AmountPrecision.addMicro(
			validatedAmountMicro,
			WITHDRAWAL_FEE_UJUNO,
		);

		// Check balance before acquiring lock
		if (balanceMicro < requiredBalanceMicro) {
			const balance = AmountPrecision.fromDbMicro(balanceMicro);
			const requiredBalance = AmountPrecision.fromDbMicro(requiredBalanceMicro);
			return {
				success: false,
				error: `Insufficient balance. You need ${AmountPrecision.format(requiredBalance)} JUNO including the ${AmountPrecision.format(withdrawalFee)} JUNO network fee.`,
				newBalance: balance,
			};
		}

		const balance = AmountPrecision.fromDbMicro(balanceMicro);

		// Acquire secure withdrawal lock
		const lockResult = await TransactionLockService.lockWithdrawal(
			userId,
			validatedAmount,
			toAddress,
		);

		if (!lockResult.success) {
			return {
				success: false,
				error: lockResult.error || "Failed to acquire withdrawal lock",
				newBalance: balance,
			};
		}

		try {
			const totalDebit = AmountPrecision.add(validatedAmount, withdrawalFee);

			// Create pending withdrawal in ledger (deducts from balance)
			const withdrawalResult = await LedgerService.processWithdrawal(
				userId,
				validatedAmount,
				toAddress,
				undefined,
				`Withdrawal to ${toAddress}`,
			);

			if (!withdrawalResult.success) {
				// Release lock if ledger update failed
				await TransactionLockService.releaseWithdrawalLock(userId, "", true);

				return {
					success: false,
					error: withdrawalResult.error,
					newBalance: withdrawalResult.newBalance,
				};
			}

			const feeResult = await LedgerService.processFee(
				userId,
				withdrawalFee,
				`Network fee for withdrawal to ${toAddress}`,
			);

			if (!feeResult.success) {
				await LedgerService.processGiveaway(
					userId,
					validatedAmount,
					"Withdrawal refund - fee charge failed",
				);
				await TransactionLockService.releaseWithdrawalLock(userId, "", true);

				return {
					success: false,
					error: feeResult.error || "Failed to charge withdrawal fee",
					newBalance: await LedgerService.getUserBalance(userId),
				};
			}

			// Execute on-chain transaction
			if (!UnifiedWalletService.wallet) {
				// Refund if we can't sign
				await LedgerService.processGiveaway(
					userId,
					totalDebit,
					"Withdrawal refund - signing unavailable",
				);
				await TransactionLockService.releaseWithdrawalLock(userId, "", true);

				return {
					success: false,
					error: "Withdrawal service temporarily unavailable",
					newBalance: await LedgerService.getUserBalance(userId),
				};
			}

			const client = await SigningStargateClient.connectWithSigner(
				UnifiedWalletService.rpcEndpoint,
				UnifiedWalletService.wallet,
				{ gasPrice: GasPrice.fromString(WITHDRAWAL_GAS_PRICE) },
			);

			const [account] = await UnifiedWalletService.wallet.getAccounts();
			const amountInUjuno = AmountPrecision.toMicroJuno(validatedAmount);

			let result: Awaited<ReturnType<typeof client.sendTokens>>;
			try {
				result = await client.sendTokens(
					account.address,
					toAddress,
					[{ denom: "ujuno", amount: amountInUjuno.toString() }],
					{
						amount: [
							{
								denom: "ujuno",
								amount: WITHDRAWAL_FEE_UJUNO.toString(),
							},
						],
						gas: WITHDRAWAL_GAS_LIMIT.toString(),
					},
					`Withdrawal for user ${userId}`,
				);
			} catch (txError) {
				// Transaction failed - refund and release lock
				logger.error("On-chain transaction failed", { userId, error: txError });

				await LedgerService.processGiveaway(
					userId,
					totalDebit,
					"Withdrawal refund - transaction failed",
				);
				await TransactionLockService.releaseWithdrawalLock(userId, "", true);

				return {
					success: false,
					error:
						txError instanceof Error ? txError.message : "Transaction failed",
					newBalance: await LedgerService.getUserBalance(userId),
				};
			}

			// Update lock with transaction hash
			await TransactionLockService.updateLockWithTxHash(
				userId,
				result.transactionHash,
			);

			// Verify transaction status
			if (result.code !== 0) {
				// Transaction failed on-chain after broadcast. The network fee is still
				// consumed, so refund only the transfer amount.
				await LedgerService.processGiveaway(
					userId,
					validatedAmount,
					"Withdrawal refund - transaction rejected",
				);
				await TransactionLockService.releaseWithdrawalLock(
					userId,
					result.transactionHash,
					true,
				);

				return {
					success: false,
					error: `Transaction failed: ${result.rawLog || "Unknown error"}`,
					newBalance: await LedgerService.getUserBalance(userId),
				};
			}

			// Update transaction record with hash
			if (withdrawalResult.transactionId) {
				await LedgerService.updateTransactionStatus(
					withdrawalResult.transactionId,
					"completed" as any,
					result.transactionHash,
				);
			}

			// Attempt to verify and release lock
			const releaseResult = await TransactionLockService.releaseWithdrawalLock(
				userId,
				result.transactionHash,
				false, // Don't force - verify first
			);

			if (!releaseResult.released) {
				// Lock not released - transaction needs manual verification
				logger.warn("Withdrawal lock not released after transaction", {
					userId,
					txHash: result.transactionHash,
					error: releaseResult.error,
				});
			}

			logger.info("Withdrawal completed", {
				tag: "transaction",
				subtag: "withdrawal",
				userId,
				toAddress,
				amount,
				withdrawalFee,
				txHash: result.transactionHash,
				lockReleased: releaseResult.released,
			});

			return {
				success: true,
				txHash: result.transactionHash,
				newBalance: feeResult.newBalance,
			};
		} catch (error) {
			// Unexpected error - ensure lock is released and user is refunded
			logger.error("Unexpected error during withdrawal", { userId, error });

			try {
				await LedgerService.processGiveaway(
					userId,
					AmountPrecision.add(validatedAmount, withdrawalFee),
					"Withdrawal refund - system error",
				);
			} catch (refundError) {
				logger.error("Failed to refund user after error", {
					userId,
					refundError,
				});
			}

			await TransactionLockService.releaseWithdrawalLock(userId, "", true);

			return {
				success: false,
				error:
					"System error during withdrawal. Your balance has been restored.",
				newBalance: await LedgerService.getUserBalance(userId),
			};
		}
	}

	/**
	 * Transfer between users (internal) with simple locking and exact precision
	 */
	static async transferToUser(
		fromUserId: number,
		toUserId: number,
		amount: number,
		description?: string,
	): Promise<{
		success: boolean;
		error?: string;
		fromBalance?: number;
		toBalance?: number;
	}> {
		try {
			// Validate amount precision (exactly 6 decimals)
			const validatedAmount = AmountPrecision.validateAmount(amount);

			// Acquire simple locks for both users
			const lockResult = await TransactionLockService.acquireTransferLocks(
				fromUserId,
				toUserId,
				validatedAmount,
			);

			if (!lockResult.success) {
				return {
					success: false,
					error: lockResult.error,
				};
			}

			try {
				// Perform the internal ledger transfer
				const result = await LedgerService.transferBetweenUsers(
					fromUserId,
					toUserId,
					validatedAmount,
					description,
				);

				// Release locks after ledger update
				await TransactionLockService.releaseTransferLocks(fromUserId, toUserId);

				if (result.success) {
					logger.info("Internal transfer completed", {
						fromUserId,
						toUserId,
						amount: AmountPrecision.format(validatedAmount),
						fromBalance: result.fromBalance
							? AmountPrecision.format(result.fromBalance)
							: undefined,
						toBalance: result.toBalance
							? AmountPrecision.format(result.toBalance)
							: undefined,
					});
				}

				return result;
			} catch (error) {
				// Release locks on error
				await TransactionLockService.releaseTransferLocks(fromUserId, toUserId);
				throw error;
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("precision")) {
				return {
					success: false,
					error: error.message,
				};
			}

			logger.error("Transfer failed", {
				fromUserId,
				toUserId,
				amount,
				error,
			});

			return {
				success: false,
				error: "Transfer failed",
			};
		}
	}

	/**
	 * Get user balance
	 */
	static async getBalance(userId: number): Promise<number> {
		return LedgerService.getUserBalance(userId);
	}

	/**
	 * Get bot treasury balance
	 */
	static async getBotBalance(): Promise<number> {
		return LedgerService.getUserBalance(SYSTEM_USER_IDS.BOT_TREASURY);
	}

	/**
	 * Get wallet statistics
	 */
	static async getStats(): Promise<{
		walletAddress: string;
		onChainBalance: number;
		internalTotal: number;
		botBalance: number;
		unclaimedBalance: number;
		activeUsers: number;
		pendingDeposits: number;
		reconciled: boolean;
	}> {
		// Get on-chain balance
		let onChainBalance = 0;
		const onChainMicro = await CosmosRestService.fetchBalanceMicro(
			UnifiedWalletService.walletAddress,
		);
		if (onChainMicro !== null) {
			onChainBalance = AmountPrecision.fromDbMicro(onChainMicro);
		}

		// Get internal totals
		const internalTotal = await LedgerService.getTotalUserBalance();
		const botBalance = await UnifiedWalletService.getBotBalance();
		const unclaimedBalance = await LedgerService.getUserBalance(
			SYSTEM_USER_IDS.UNCLAIMED,
		);

		// Get active users count
		const activeUsers =
			get<{ count: number }>(
				"SELECT COUNT(*) as count FROM user_balances WHERE balance > 0 AND user_id > 0",
			)?.count || 0;

		// Get pending deposits
		const pendingDeposits =
			get<{ count: number }>(
				"SELECT COUNT(*) as count FROM processed_deposits WHERE processed = 0",
			)?.count || 0;

		// Check reconciliation
		const difference = Math.abs(onChainBalance - internalTotal);
		const reconciled = difference < 0.01; // Allow 0.01 JUNO difference

		return {
			walletAddress: UnifiedWalletService.walletAddress,
			onChainBalance,
			internalTotal,
			botBalance,
			unclaimedBalance,
			activeUsers,
			pendingDeposits,
			reconciled,
		};
	}

	/**
	 * Sends funds to a user by username
	 * Resolves username to userId via database or Telegram API
	 *
	 * @param fromUserId - Sender user ID
	 * @param toUsername - Recipient username (with or without @)
	 * @param amount - Amount to send
	 * @param description - Optional transaction description
	 * @param botContext - Telegraf context for Telegram API resolution
	 * @returns Transaction result with recipient info
	 */
	static async sendToUsername(
		fromUserId: number,
		toUsername: string,
		amount: number,
		description?: string,
		botContext?: any,
	): Promise<{
		success: boolean;
		error?: string;
		recipient?: string;
		fromBalance?: number;
		toBalance?: number;
	}> {
		const { getUserIdByUsername, createUser } = await import("./userService");
		const cleanUsername = toUsername.replace(/^@/, "");

		// First, try to find userId by username in database
		let recipientId = getUserIdByUsername(cleanUsername);
		const recipientUsername = cleanUsername;

		// If not found and we have bot context, try to resolve via Telegram API
		if (!recipientId && botContext) {
			try {
				const chatInfo = await botContext.telegram.getChat(`@${cleanUsername}`);

				if (chatInfo?.id) {
					createUser(
						chatInfo.id,
						cleanUsername,
						"pleb",
						"telegram_api_resolution",
					);
					await LedgerService.ensureUserBalance(chatInfo.id);

					logger.info(
						"Created pre-funded account via Telegram username resolution",
						{
							recipientId: chatInfo.id,
							username: cleanUsername,
							amount,
							senderId: fromUserId,
							source: "telegram_api",
						},
					);

					recipientId = chatInfo.id;
				}
			} catch (error) {
				logger.warn("Failed to resolve username via Telegram API", {
					username: cleanUsername,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		if (!recipientId) {
			return {
				success: false,
				error:
					`User @${cleanUsername} not found in database. ` +
					`Either:\n` +
					`1. They need to interact with the bot first, OR\n` +
					`2. Send to their user ID directly: /send ${amount} <their_user_id>`,
			};
		}

		const result = await UnifiedWalletService.transferToUser(
			fromUserId,
			recipientId,
			amount,
			description || `Transfer to @${recipientUsername}`,
		);

		return {
			...result,
			recipient: recipientUsername,
		};
	}

	/**
	 * Pays bail for a jailed user
	 *
	 * @param payerUserId - User paying the bail
	 * @param bailedUserId - User being bailed out
	 * @param amount - Bail amount
	 * @param description - Optional description
	 * @returns Transaction result
	 */
	static async payBail(
		payerUserId: number,
		bailedUserId: number,
		amount: number,
		description?: string,
	): Promise<{ success: boolean; error?: string; newBalance?: number }> {
		try {
			const result = await LedgerService.processBail(
				payerUserId,
				bailedUserId,
				amount,
				description || `Bail payment for user ${bailedUserId}`,
			);

			if (!result.success) {
				return { success: false, error: result.error };
			}

			return {
				success: true,
				newBalance: result.newBalance,
			};
		} catch (error) {
			logger.error("Bail payment failed", {
				payerUserId,
				bailedUserId,
				amount,
				error,
			});
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Distributes giveaway to multiple users
	 *
	 * @param userIds - Array of user IDs to receive giveaway
	 * @param amountPerUser - Amount each user receives
	 * @param description - Optional description
	 * @returns Result with succeeded and failed distributions
	 */
	static async distributeGiveaway(
		userIds: number[],
		amountPerUser: number,
		description?: string,
	): Promise<{
		succeeded: number[];
		failed: Array<{ userId: number; error: string }>;
		totalDistributed: number;
	}> {
		const succeeded: number[] = [];
		const failed: Array<{ userId: number; error: string }> = [];
		let totalDistributed = 0;

		for (const userId of userIds) {
			try {
				const result = await LedgerService.processGiveaway(
					userId,
					amountPerUser,
					description || "Giveaway distribution",
				);

				if (result.success) {
					succeeded.push(userId);
					totalDistributed += amountPerUser;
				} else {
					failed.push({ userId, error: "Giveaway processing failed" });
				}
			} catch (error) {
				failed.push({
					userId,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		logger.info("Giveaway distribution completed", {
			totalUsers: userIds.length,
			succeeded: succeeded.length,
			failed: failed.length,
			amountPerUser,
			totalDistributed,
		});

		return { succeeded, failed, totalDistributed };
	}

	/** Get transaction history for a user */
	static async getTxHistory(
		userId: number,
		limit: number = 10,
	): Promise<any[]> {
		const transactions = query<any>(
			`SELECT * FROM transactions
       WHERE from_user_id = ? OR to_user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
			[userId, userId, limit],
		);

		return transactions;
	}

	/**
	 * Gets system account balances
	 *
	 * @returns Object with treasury, reserve, and unclaimed balances
	 */
	static async getSystemBalances(): Promise<{
		treasury: number;
		reserve: number;
		unclaimed: number;
	}> {
		return {
			treasury: await UnifiedWalletService.getBalance(
				SYSTEM_USER_IDS.BOT_TREASURY,
			),
			reserve: await UnifiedWalletService.getBalance(
				SYSTEM_USER_IDS.SYSTEM_RESERVE,
			),
			unclaimed: await UnifiedWalletService.getBalance(
				SYSTEM_USER_IDS.UNCLAIMED,
			),
		};
	}

	/**
	 * Reconciles internal ledger balances with on-chain wallet balance
	 *
	 * @returns Reconciliation result
	 */
	static async reconcileBalances(): Promise<{
		matched: boolean;
		internalTotal: number;
		onChainTotal: number;
		difference: number;
		onChainAvailable: boolean;
		error?: string;
	}> {
		return await LedgerService.reconcileBalances();
	}

	/**
	 * Finds a user by username
	 *
	 * @param username - Username to search for (with or without @)
	 * @returns User object or null
	 */
	static async findUserByUsername(username: string): Promise<User | null> {
		const { getUserIdByUsername } = await import("./userService");
		const cleanUsername = username.replace(/^@/, "");
		const userId = getUserIdByUsername(cleanUsername);

		if (!userId) return null;

		const user = get<any>("SELECT id, username FROM users WHERE id = ?", [
			userId,
		]);
		return user ? { id: user.id, username: user.username } : null;
	}

	/**
	 * Gets ledger statistics
	 *
	 * @returns Statistics object with totalUsers, activeUsers, totalBalance, recentDeposits, recentWithdrawals
	 */
	static async getLedgerStats(): Promise<{
		totalUsers: number;
		activeUsers: number;
		totalBalance: number;
		recentDeposits: number;
		recentWithdrawals: number;
	}> {
		const totalBalance = await LedgerService.getTotalUserBalance();

		const totalUsers =
			get<{ count: number }>(
				"SELECT COUNT(*) as count FROM user_balances WHERE user_id > 0",
				[],
			)?.count || 0;

		// Active users = users with balance > 0
		const activeUsers =
			get<{ count: number }>(
				"SELECT COUNT(*) as count FROM user_balances WHERE user_id > 0 AND balance > 0",
				[],
			)?.count || 0;

		// Recent deposits/withdrawals in last 24h
		const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

		const recentDeposits =
			get<{ count: number }>(
				`SELECT COUNT(*) as count FROM transactions
				WHERE transaction_type = 'deposit' AND created_at > ?`,
				[oneDayAgo],
			)?.count || 0;

		const recentWithdrawals =
			get<{ count: number }>(
				`SELECT COUNT(*) as count FROM transactions
				WHERE transaction_type = 'withdrawal' AND created_at > ?`,
				[oneDayAgo],
			)?.count || 0;

		return {
			totalUsers,
			activeUsers,
			totalBalance,
			recentDeposits,
			recentWithdrawals,
		};
	}

	// ============================================================================
	// SHARED ACCOUNT OPERATIONS
	// ============================================================================

	/**
	 * Gets balance of a shared account
	 *
	 * @param accountId - Shared account ID
	 * @returns Balance in JUNO
	 */
	static async getSharedBalance(accountId: number): Promise<number> {
		return await UnifiedWalletService.getBalance(accountId);
	}

	/**
	 * Sends funds from a shared account to a user
	 *
	 * @param accountId - Shared account ID
	 * @param userId - User initiating the transaction (must have spend/admin permission)
	 * @param toUserId - Recipient user ID
	 * @param amount - Amount to send
	 * @param description - Optional description
	 * @returns Transaction result
	 */
	static async sendFromShared(
		accountId: number,
		userId: number,
		toUserId: number,
		amount: number,
		description?: string,
	): Promise<{
		success: boolean;
		error?: string;
		sharedBalance?: number;
		recipientBalance?: number;
	}> {
		const { SharedAccountService } = await import("./sharedAccountService");

		try {
			// Verify shared account exists
			const account = await SharedAccountService.getSharedAccount(accountId);
			if (!account) {
				return { success: false, error: "Shared account not found." };
			}

			// Verify user has spend permission
			if (
				!(await SharedAccountService.hasPermission(accountId, userId, "spend"))
			) {
				return {
					success: false,
					error: "You do not have permission to spend from this account.",
				};
			}

			// Verify spend limit
			if (!(await SharedAccountService.canSpend(accountId, userId, amount))) {
				const permission = await SharedAccountService.getUserPermission(
					accountId,
					userId,
				);
				return {
					success: false,
					error: `Transaction exceeds your spend limit of ${permission?.spendLimit} JUNO.`,
				};
			}

			// Execute transfer
			const result = await UnifiedWalletService.transferToUser(
				accountId,
				toUserId,
				amount,
				description || `Transfer from shared account ${account.name}`,
			);

			if (!result.success) {
				return { success: false, error: result.error };
			}

			return {
				success: true,
				sharedBalance: result.fromBalance,
				recipientBalance: result.toBalance,
			};
		} catch (error) {
			logger.error("Shared account send failed", {
				accountId,
				userId,
				toUserId,
				amount,
				error,
			});
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Deposits funds from user to shared account
	 *
	 * @param accountId - Shared account ID
	 * @param fromUserId - User depositing funds
	 * @param amount - Amount to deposit
	 * @param description - Optional description
	 * @returns Transaction result
	 */
	static async depositToShared(
		accountId: number,
		fromUserId: number,
		amount: number,
		description?: string,
	): Promise<{
		success: boolean;
		error?: string;
		userBalance?: number;
		sharedBalance?: number;
	}> {
		const { SharedAccountService } = await import("./sharedAccountService");

		try {
			// Verify shared account exists
			const account = await SharedAccountService.getSharedAccount(accountId);
			if (!account) {
				return { success: false, error: "Shared account not found." };
			}

			// Execute transfer
			const result = await UnifiedWalletService.transferToUser(
				fromUserId,
				accountId,
				amount,
				description || `Deposit to shared account ${account.name}`,
			);

			if (!result.success) {
				return { success: false, error: result.error };
			}

			return {
				success: true,
				userBalance: result.fromBalance,
				sharedBalance: result.toBalance,
			};
		} catch (error) {
			logger.error("Shared account deposit failed", {
				accountId,
				fromUserId,
				amount,
				error,
			});
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Gets transaction history for a shared account
	 *
	 * @param accountId - Shared account ID
	 * @param limit - Maximum number of transactions
	 * @returns Array of transactions
	 */
	static async getSharedTransactions(
		accountId: number,
		limit: number = 20,
	): Promise<any[]> {
		return await UnifiedWalletService.getTxHistory(accountId, limit);
	}

	/**
	 * Stop deposit monitoring
	 */
	static stop(): void {
		if (UnifiedWalletService.depositCheckInterval) {
			clearInterval(UnifiedWalletService.depositCheckInterval);
			UnifiedWalletService.depositCheckInterval = null;
		}
		logger.info("Unified wallet service stopped");
	}

	/**
	 * Send funds to external wallet (alias for processWithdrawal)
	 * Provided for API consistency with test expectations
	 *
	 * @param userId - User initiating the withdrawal
	 * @param toAddress - External Juno address
	 * @param amount - Amount in JUNO
	 * @param description - Optional transaction description
	 * @returns Transaction result
	 */
	static async sendToExternalWallet(
		userId: number,
		toAddress: string,
		amount: number,
		_description?: string,
	): Promise<{
		success: boolean;
		txHash?: string;
		error?: string;
		newBalance?: number;
	}> {
		return UnifiedWalletService.processWithdrawal(userId, toAddress, amount);
	}

	/**
	 * Alias for transferToUser - send funds to another user
	 */
	static async sendToUser(
		fromUserId: number,
		toUserId: number,
		amount: number,
		description?: string,
	): Promise<{
		success: boolean;
		error?: string;
		fromBalance?: number;
		toBalance?: number;
	}> {
		return UnifiedWalletService.transferToUser(
			fromUserId,
			toUserId,
			amount,
			description,
		);
	}
}
