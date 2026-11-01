import type { FmtString } from "telegraf/format";
import { config } from "../config";
import { execute, get, query } from "../database";
import { CAC_DENOM, DEFAULT_TOKEN, JUNO_DENOM, tokenByDenom } from "../tokens";
import { looksLikeJailingId } from "../utils/jailingId";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { normalizeTxHash } from "../utils/txHash";
import { DepositInstructionService } from "./depositInstructions";
import { JailService } from "./jailService";
import { JunoGrpcService } from "./junoGrpcService";
import { LedgerService, TransactionStatus } from "./ledgerService";
import { OsmosisGrpcService } from "./osmosisGrpcService";
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

interface DepositCheck {
	txHash: string;
	userId?: number | null;
	amount: number;
	denom: string;
	network: "juno" | "osmosis";
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
	private static walletAddress: string;
	private static osmosisAddress: string;
	private static depositCheckInterval: NodeJS.Timeout | null = null;
	private static depositCheckRunning = false;
	private static lastCheckedHeight: number = 0;
	private static osmosisLastCheckedHeight: number = 0;

	/**
	 * Initialize the unified wallet service
	 */
	static async initialize(): Promise<void> {
		// Both chains are gRPC-only. The configured address is authoritative;
		// the mnemonic-derived signer is checked inside each client.
		await JunoGrpcService.initialize();
		await OsmosisGrpcService.initialize();

		UnifiedWalletService.walletAddress =
			JunoGrpcService.getAddress() || config.userFundsAddress || "";
		UnifiedWalletService.osmosisAddress = OsmosisGrpcService.getAddress();

		if (!UnifiedWalletService.walletAddress) {
			logger.error("Wallet address not configured");
			return;
		}

		// Initialize system users in the ledger
		await UnifiedWalletService.initSysUsers();

		// Last checked height is per network: Juno and Osmosis heights are
		// unrelated, so they must never share a watermark.
		const lastJuno = get<{ height: number }>(
			"SELECT MAX(height) as height FROM processed_deposits WHERE network = 'juno'",
		);
		const lastOsmosis = get<{ height: number }>(
			"SELECT MAX(height) as height FROM processed_deposits WHERE network = 'osmosis'",
		);
		UnifiedWalletService.lastCheckedHeight = lastJuno?.height || 0;
		UnifiedWalletService.osmosisLastCheckedHeight = lastOsmosis?.height || 0;

		await UnifiedWalletService.ensureWatermarksSeeded();

		logger.info("Unified wallet service initialized", {
			address: UnifiedWalletService.walletAddress,
			osmosisAddress: UnifiedWalletService.osmosisAddress || "(unset)",
			lastCheckedHeight: UnifiedWalletService.lastCheckedHeight,
			osmosisLastCheckedHeight: UnifiedWalletService.osmosisLastCheckedHeight,
		});

		// Resolve withdrawals left pending by an earlier process exit.
		await UnifiedWalletService.reconcilePendingWithdrawals();

		// Start deposit monitoring (the initial scan catches deposits missed
		// while the bot was down).
		UnifiedWalletService.startDepositMonitoring();
	}

	/** Seed an empty deposit watermark to the chain tip, once per chain. */
	private static async ensureWatermarksSeeded(): Promise<void> {
		if (UnifiedWalletService.lastCheckedHeight === 0) {
			const stored = get<{ value: string }>(
				"SELECT value FROM system_state WHERE key = 'juno_deposit_start_height'",
			);
			const storedHeight = stored ? Number.parseInt(stored.value, 10) : 0;
			if (storedHeight > 0) {
				UnifiedWalletService.lastCheckedHeight = storedHeight;
			} else {
				const tip = await JunoGrpcService.getLatestHeight();
				if (tip) {
					UnifiedWalletService.lastCheckedHeight = tip;
					execute(
						`INSERT OR REPLACE INTO system_state (key, value, updated_at)
						 VALUES ('juno_deposit_start_height', ?, strftime('%s', 'now'))`,
						[tip.toString()],
					);
					logger.warn(
						"Seeded JUNO deposit watermark to chain tip; earlier deposits require /processdeposit",
						{ height: tip },
					);
				}
			}
		}

		if (UnifiedWalletService.osmosisLastCheckedHeight === 0) {
			const stored = get<{ value: string }>(
				"SELECT value FROM system_state WHERE key = 'osmosis_deposit_start_height'",
			);
			const storedHeight = stored ? Number.parseInt(stored.value, 10) : 0;
			if (storedHeight > 0) {
				UnifiedWalletService.osmosisLastCheckedHeight = storedHeight;
			} else {
				const tip = await OsmosisGrpcService.getLatestHeight();
				if (tip) {
					UnifiedWalletService.osmosisLastCheckedHeight = tip;
					execute(
						`INSERT OR REPLACE INTO system_state (key, value, updated_at)
						 VALUES ('osmosis_deposit_start_height', ?, strftime('%s', 'now'))`,
						[tip.toString()],
					);
					logger.warn(
						"Seeded CAC deposit watermark to chain tip; earlier deposits require /processdeposit",
						{ height: tip },
					);
				}
			}
		}
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
		if (UnifiedWalletService.depositCheckRunning) {
			logger.debug("Skipping deposit check: previous scan still running");
			return;
		}
		UnifiedWalletService.depositCheckRunning = true;

		try {
			await UnifiedWalletService.ensureWatermarksSeeded();
			const junoScan = await UnifiedWalletService.fetchRecentDeposits();
			for (const deposit of junoScan.deposits) {
				await UnifiedWalletService.processDeposit(deposit);
			}
			UnifiedWalletService.lastCheckedHeight = junoScan.nextHeight;

			const osmosisScan =
				await UnifiedWalletService.fetchRecentOsmosisDeposits();
			for (const deposit of osmosisScan.deposits) {
				await UnifiedWalletService.processDeposit(deposit);
			}
			// Advance only to the scan's safe resume height, never to the newest
			// credited row: a page-capped scan must leave older rows rescanable.
			UnifiedWalletService.osmosisLastCheckedHeight = osmosisScan.nextHeight;
		} catch (error) {
			logger.error("Failed to check deposits", error);
		} finally {
			UnifiedWalletService.depositCheckRunning = false;
		}
	}

	/** Complete or refund withdrawals whose broadcast never got a final status. */
	static async reconcilePendingWithdrawals(): Promise<void> {
		const pending = query<{
			id: number;
			from_user_id: number | null;
			amount: number;
			denom: string;
			tx_hash: string | null;
			created_at: number;
		}>(
			`SELECT id, from_user_id, amount, denom, tx_hash, created_at
			 FROM transactions
			 WHERE transaction_type = 'withdrawal' AND status = 'pending' AND tx_hash IS NOT NULL`,
		);

		for (const row of pending) {
			if (!row.from_user_id || !row.tx_hash) continue;
			const chain =
				row.denom === JUNO_DENOM ? JunoGrpcService : OsmosisGrpcService;
			const tx = await chain.fetchTransaction(row.tx_hash);

			if (tx && tx.code === 0) {
				await LedgerService.updateTransactionStatus(
					row.id,
					TransactionStatus.COMPLETED,
					row.tx_hash,
				);
				await TransactionLockService.releaseWithdrawalLock(
					row.from_user_id,
					row.tx_hash,
					true,
				);
				logger.info("Pending withdrawal confirmed", {
					userId: row.from_user_id,
					txHash: row.tx_hash,
					denom: row.denom,
				});
				continue;
			}

			if (tx && tx.code !== 0) {
				await LedgerService.processRefund(
					row.from_user_id,
					AmountPrecision.fromDbMicro(row.amount),
					`Withdrawal refund - reconciled failed transaction ${row.tx_hash}`,
					row.denom,
				);
				await LedgerService.updateTransactionStatus(
					row.id,
					TransactionStatus.FAILED,
					row.tx_hash,
				);
				await TransactionLockService.releaseWithdrawalLock(
					row.from_user_id,
					row.tx_hash,
					true,
				);
				logger.warn("Pending withdrawal failed on chain and was refunded", {
					userId: row.from_user_id,
					txHash: row.tx_hash,
					denom: row.denom,
				});
				continue;
			}

			const ageMinutes = Math.floor((Date.now() / 1000 - row.created_at) / 60);
			if (ageMinutes >= 30) {
				logger.warn("Withdrawal still pending and unindexed", {
					userId: row.from_user_id,
					txHash: row.tx_hash,
					denom: row.denom,
					ageMinutes,
				});
			}
		}
	}

	/** CAC deposits on Osmosis, read through the Polkachu gRPC index. */
	private static async fetchRecentOsmosisDeposits(): Promise<{
		deposits: DepositCheck[];
		nextHeight: number;
	}> {
		const address = UnifiedWalletService.osmosisAddress;
		const currentHeight = UnifiedWalletService.osmosisLastCheckedHeight;
		if (!address || currentHeight === 0) {
			return { deposits: [], nextHeight: currentHeight };
		}

		const scan = await OsmosisGrpcService.fetchRecentDeposits(
			address,
			CAC_DENOM,
			currentHeight,
		);

		return {
			nextHeight: scan.nextHeight,
			deposits: scan.deposits.map((deposit) => ({
				txHash: deposit.txHash,
				userId: UnifiedWalletService.parseUserId(deposit.memo),
				amount: AmountPrecision.fromDbMicro(deposit.amountMicro),
				denom: CAC_DENOM,
				network: "osmosis" as const,
				fromAddress: deposit.fromAddress,
				memo: deposit.memo,
				height: deposit.height,
				timestamp: Math.floor(Date.now() / 1000),
			})),
		};
	}

	/** JUNO deposits read through the Polkachu gRPC index. */
	private static async fetchRecentDeposits(): Promise<{
		deposits: DepositCheck[];
		nextHeight: number;
	}> {
		const address = UnifiedWalletService.walletAddress;
		const currentHeight = UnifiedWalletService.lastCheckedHeight;
		if (!address || currentHeight === 0) {
			return { deposits: [], nextHeight: currentHeight };
		}

		const scan = await JunoGrpcService.fetchRecentDeposits(
			address,
			JUNO_DENOM,
			currentHeight,
		);

		return {
			nextHeight: scan.nextHeight,
			deposits: scan.deposits.map((deposit) => ({
				txHash: deposit.txHash,
				userId: UnifiedWalletService.parseUserId(deposit.memo),
				amount: AmountPrecision.fromDbMicro(deposit.amountMicro),
				denom: JUNO_DENOM,
				network: "juno" as const,
				fromAddress: deposit.fromAddress,
				memo: deposit.memo,
				height: deposit.height,
				timestamp: Math.floor(Date.now() / 1000),
			})),
		};
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
					tx_hash, user_id, amount, denom, network, from_address, memo, height, processed, created_at, error
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				[
					deposit.txHash,
					existingTx.to_user_id,
					existingTx.amount,
					existingTx.denom ?? deposit.denom,
					deposit.network,
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
		if (deposit.denom === JUNO_DENOM && looksLikeJailingId(memoText)) {
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
					tx_hash, user_id, amount, denom, network, from_address, memo, height, processed, created_at, error
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				[
					deposit.txHash,
					jailing?.userId ?? SYSTEM_USER_IDS.UNCLAIMED,
					deposit.amount,
					deposit.denom,
					deposit.network,
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
				await LedgerService.ensureUserBalance(targetUserId, deposit.denom);

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
        tx_hash, user_id, amount, denom, network, from_address, memo, height, processed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
			[
				deposit.txHash,
				targetUserId, // Use resolved targetUserId, not deposit.userId
				deposit.amount,
				deposit.denom,
				deposit.network,
				deposit.fromAddress,
				deposit.memo,
				deposit.height,
				deposit.timestamp,
			],
		);

		// Watermarks are advanced from the scan result in checkForDeposits.

		// Process deposit in ledger
		const result = await LedgerService.processDeposit(
			targetUserId,
			deposit.amount,
			deposit.txHash,
			deposit.fromAddress,
			`Deposit from ${deposit.fromAddress}${deposit.memo ? ` (memo: ${deposit.memo})` : ""}`,
			deposit.denom,
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
	static getDepositInstructions(
		userId: number,
		denom: string = JUNO_DENOM,
	): {
		address: string;
		memo: string;
		instructions: string;
		markdown: FmtString;
	} {
		const instructions = DepositInstructionService.generateInstructions(
			userId,
			denom,
			UnifiedWalletService.getDepositAddress(denom),
		);

		return {
			address: instructions.walletAddress,
			memo: instructions.memo,
			instructions: instructions.text,
			markdown: instructions.markdown,
		};
	}

	/** Token-aware deposit address (JUNO or Osmosis/CAC). */
	static getDepositAddress(denom: string = JUNO_DENOM): string {
		return denom === JUNO_DENOM
			? UnifiedWalletService.walletAddress
			: UnifiedWalletService.osmosisAddress;
	}

	/**
	 * Process user withdrawal to external wallet with secure locking
	 */
	static async processWithdrawal(
		userId: number,
		toAddress: string,
		amount: number,
		denom: string = JUNO_DENOM,
	): Promise<{
		success: boolean;
		txHash?: string;
		error?: string;
		newBalance?: number;
		pending?: boolean;
	}> {
		const token = tokenByDenom(denom) ?? DEFAULT_TOKEN;
		const symbol = token.symbol;

		// Validate address against the token's chain prefix.
		if (
			!toAddress.startsWith(`${token.addressPrefix}1`) ||
			toAddress.length !== 43
		) {
			return {
				success: false,
				error: `Invalid ${symbol} address format`,
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

		const balanceMicro = await LedgerService.getUserBalanceMicro(userId, denom);
		const validatedAmountMicro = AmountPrecision.toDbMicro(validatedAmount);
		// JUNO withdrawals charge the configured JUNO network fee. CAC withdrawals
		// are charged no internal fee; the bot pays Osmosis gas in uosmo.
		const withdrawalFee = denom === JUNO_DENOM ? getWithdrawalNetworkFee() : 0;
		const feeMicro = AmountPrecision.toDbMicro(withdrawalFee);
		const requiredBalanceMicro = AmountPrecision.addMicro(
			validatedAmountMicro,
			feeMicro,
		);

		// Check balance before acquiring lock
		if (balanceMicro < requiredBalanceMicro) {
			const balance = AmountPrecision.fromDbMicro(balanceMicro);
			const requiredBalance = AmountPrecision.fromDbMicro(requiredBalanceMicro);
			return {
				success: false,
				error:
					withdrawalFee > 0
						? `Insufficient balance. You need ${AmountPrecision.format(requiredBalance)} ${symbol} including the ${AmountPrecision.format(withdrawalFee)} ${symbol} network fee.`
						: `Insufficient balance. You need ${AmountPrecision.format(requiredBalance)} ${symbol}.`,
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
				denom,
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

			let newBalance = withdrawalResult.newBalance;
			if (withdrawalFee > 0) {
				const feeResult = await LedgerService.processFee(
					userId,
					withdrawalFee,
					`Network fee for withdrawal to ${toAddress}`,
					denom,
				);

				if (!feeResult.success) {
					await LedgerService.processRefund(
						userId,
						validatedAmount,
						"Withdrawal refund - fee charge failed",
						denom,
					);
					await TransactionLockService.releaseWithdrawalLock(userId, "", true);

					return {
						success: false,
						error: feeResult.error || "Failed to charge withdrawal fee",
						newBalance: await LedgerService.getUserBalance(userId, denom),
					};
				}
				newBalance = feeResult.newBalance;
			}

			// Execute the on-chain transaction.
			const chain = denom === JUNO_DENOM ? JunoGrpcService : OsmosisGrpcService;
			let txHash = "";
			let code = 0;
			let rawLog = "";
			try {
				const result = await chain.sendTokens(
					toAddress,
					validatedAmountMicro,
					denom,
					`Withdrawal for user ${userId}`,
				);
				txHash = result.txHash;
				code = result.code;
				rawLog = result.rawLog;
			} catch (txError) {
				// Transaction failed - refund and release lock
				logger.error("On-chain transaction failed", {
					userId,
					denom,
					error: txError,
				});

				await LedgerService.processRefund(
					userId,
					totalDebit,
					"Withdrawal refund - transaction failed",
					denom,
				);
				await TransactionLockService.releaseWithdrawalLock(userId, "", true);

				return {
					success: false,
					error:
						txError instanceof Error ? txError.message : "Transaction failed",
					newBalance: await LedgerService.getUserBalance(userId, denom),
				};
			}

			txHash = normalizeTxHash(txHash);

			// Update lock with transaction hash
			await TransactionLockService.updateLockWithTxHash(userId, txHash);

			// A gRPC SYNC broadcast only reports CheckTx; wait for inclusion and
			// treat an included non-zero code as a failed transfer.
			let pending = false;
			let includedTx: Awaited<ReturnType<typeof chain.waitForTransaction>> =
				null;
			if (code === 0) {
				const included = await chain.waitForTransaction(txHash);
				includedTx = included;
				if (included && included.code !== 0) {
					code = included.code;
					rawLog = `Transaction failed on chain (code ${included.code})`;
				}
				if (!included) {
					// The tx may still be in the mempool. Keep the lock and report a
					// pending result instead of assuming success or refunding twice.
					pending = true;
					logger.warn("Withdrawal not indexed before timeout", {
						userId,
						denom,
						txHash,
					});
				}
			}

			if (pending) {
				// Keep the hash durable even though the lock will expire; otherwise
				// the only record of the broadcast disappears after cleanup.
				if (withdrawalResult.transactionId) {
					await LedgerService.updateTransactionStatus(
						withdrawalResult.transactionId,
						TransactionStatus.PENDING,
						normalizeTxHash(txHash),
					);
				}
				return {
					success: true,
					pending: true,
					txHash,
					newBalance: await LedgerService.getUserBalance(userId, denom),
				};
			}

			if (code !== 0) {
				// A CheckTx rejection never entered a block, so no gas was consumed:
				// refund the fee too. An included-but-failed tx did consume gas, so
				// only the transfer amount is refunded in that case.
				const refundAmount = includedTx ? validatedAmount : totalDebit;
				await LedgerService.processRefund(
					userId,
					refundAmount,
					"Withdrawal refund - transaction rejected",
					denom,
				);
				await TransactionLockService.releaseWithdrawalLock(
					userId,
					txHash,
					true,
				);

				return {
					success: false,
					error: `Transaction failed: ${rawLog || "Unknown error"}`,
					newBalance: await LedgerService.getUserBalance(userId, denom),
				};
			}

			// Update transaction record with hash
			if (withdrawalResult.transactionId) {
				await LedgerService.updateTransactionStatus(
					withdrawalResult.transactionId,
					TransactionStatus.COMPLETED,
					txHash,
				);
			}

			// Attempt to verify and release lock
			const releaseResult = await TransactionLockService.releaseWithdrawalLock(
				userId,
				txHash,
				// CAC was already verified through the Osmosis client above; the
				// lock verifier is JUNO-only. The hash is reconciled either way.
				denom !== JUNO_DENOM,
			);

			if (!releaseResult.released) {
				// Lock not released - transaction needs manual verification
				logger.warn("Withdrawal lock not released after transaction", {
					userId,
					txHash,
					error: releaseResult.error,
				});
			}

			logger.info("Withdrawal completed", {
				tag: "transaction",
				subtag: "withdrawal",
				userId,
				toAddress,
				amount,
				denom,
				withdrawalFee,
				txHash,
				lockReleased: releaseResult.released,
			});

			return {
				success: true,
				txHash,
				newBalance,
			};
		} catch (error) {
			// Unexpected error - ensure lock is released and user is refunded
			logger.error("Unexpected error during withdrawal", { userId, error });

			try {
				await LedgerService.processRefund(
					userId,
					AmountPrecision.add(validatedAmount, withdrawalFee),
					"Withdrawal refund - system error",
					denom,
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
				newBalance: await LedgerService.getUserBalance(userId, denom),
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
		denom: string = JUNO_DENOM,
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
					denom,
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
	static async getBalance(
		userId: number,
		denom: string = JUNO_DENOM,
	): Promise<number> {
		return LedgerService.getUserBalance(userId, denom);
	}

	/** All non-zero token balances for a user. */
	static getAllBalances(userId: number): Array<{
		denom: string;
		balanceMicro: number;
	}> {
		return LedgerService.getUserBalances(userId);
	}

	/**
	 * Get bot treasury balance
	 */
	static async getBotBalance(denom: string = JUNO_DENOM): Promise<number> {
		return LedgerService.getUserBalance(SYSTEM_USER_IDS.BOT_TREASURY, denom);
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
		const onChainMicro = await JunoGrpcService.getBalanceMicro(
			UnifiedWalletService.walletAddress,
			JUNO_DENOM,
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
				"SELECT COUNT(DISTINCT user_id) as count FROM user_balances WHERE balance > 0 AND user_id > 0",
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
		denom: string = JUNO_DENOM,
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
					await LedgerService.ensureUserBalance(chatInfo.id, denom);

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
			denom,
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
				"SELECT COUNT(DISTINCT user_id) as count FROM user_balances WHERE user_id > 0",
				[],
			)?.count || 0;

		// Active users = users with balance > 0
		const activeUsers =
			get<{ count: number }>(
				"SELECT COUNT(DISTINCT user_id) as count FROM user_balances WHERE user_id > 0 AND balance > 0",
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
}
