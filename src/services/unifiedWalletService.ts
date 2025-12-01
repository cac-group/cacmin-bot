import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import type { FmtString } from "telegraf/format";
import { config } from "../config";
import { execute, get, query } from "../database";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { DepositInstructionService } from "./depositInstructions";
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
};

/** Get escrow user ID for a specific giveaway */
export function getGiveawayEscrowId(giveawayId: number): number {
	return SYSTEM_USER_IDS.GIVEAWAY_ESCROW_BASE - giveawayId;
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
	private static apiEndpoint: string;
	private static depositCheckInterval: NodeJS.Timeout | null = null;
	private static lastCheckedHeight: number = 0;

	/**
	 * Initialize the unified wallet service
	 */
	static async initialize(): Promise<void> {
		UnifiedWalletService.rpcEndpoint =
			config.junoRpcUrl || "https://rpc.juno.basementnodes.ca";
		UnifiedWalletService.apiEndpoint =
			config.junoApiUrl || "https://api.juno.basementnodes.ca";

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
	}

	/**
	 * Reconcile deposits on startup - catch any that were missed
	 */
	private static async reconcileStartupDeposits(): Promise<void> {
		try {
			logger.info("Running startup deposit reconciliation...");

			// Fetch all deposits from blockchain
			const query = `transfer.recipient='${UnifiedWalletService.walletAddress}'`;
			const url = `${UnifiedWalletService.rpcEndpoint}/tx_search?query="${encodeURIComponent(query)}"&prove=false&per_page=100`;

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

				// Extract deposit info
				let amount = 0;
				let fromAddress = "";

				for (const event of tx.tx_result.events) {
					if (event.type === "transfer") {
						const recipient = event.attributes.find(
							(a: any) => a.key === "recipient",
						)?.value;
						const amountStr = event.attributes.find(
							(a: any) => a.key === "amount",
						)?.value;
						const sender = event.attributes.find(
							(a: any) => a.key === "sender",
						)?.value;

						if (recipient === UnifiedWalletService.walletAddress && amountStr) {
							const match = amountStr.match(/^(\d+)ujuno$/);
							if (match) {
								amount = parseFloat(match[1]) / 1_000_000;
								fromAddress = sender || "";
							}
						}
					}
				}

				if (amount === 0) continue;

				// Extract memo
				const memo = UnifiedWalletService.parseMemo(tx.tx, amount);
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

		// Check for deposits every 30 seconds
		UnifiedWalletService.depositCheckInterval = setInterval(() => {
			UnifiedWalletService.checkForDeposits().catch((error) => {
				logger.error("Error checking for deposits", error);
			});
		}, 30000);

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
			// Use RPC tx_search instead of REST API
			const query = `transfer.recipient='${UnifiedWalletService.walletAddress}'`;
			const url = `${UnifiedWalletService.rpcEndpoint}/tx_search?query="${encodeURIComponent(query)}"&prove=false&per_page=20`;

			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`RPC request failed: ${response.status}`);
			}

			const data = (await response.json()) as any;
			const deposits: DepositCheck[] = [];

			for (const tx of data.result?.txs || []) {
				const height = parseInt(tx.height, 10);

				// Skip if already processed
				if (height <= UnifiedWalletService.lastCheckedHeight) {
					continue;
				}

				// Skip failed transactions
				if (tx.tx_result.code !== 0) {
					logger.debug("Skipping failed transaction", {
						txHash: tx.hash,
						code: tx.tx_result.code,
					});
					continue;
				}

				// Extract amount and sender from events (already decoded JSON)
				let amount = 0;
				let fromAddress = "";

				for (const event of tx.tx_result.events) {
					if (event.type === "transfer") {
						const recipient = event.attributes.find(
							(a: any) => a.key === "recipient",
						)?.value;
						const amountStr = event.attributes.find(
							(a: any) => a.key === "amount",
						)?.value;
						const sender = event.attributes.find(
							(a: any) => a.key === "sender",
						)?.value;

						if (recipient === UnifiedWalletService.walletAddress && amountStr) {
							// Parse amount (format: "1000000ujuno")
							const match = amountStr.match(/^(\d+)ujuno$/);
							if (match) {
								amount = parseFloat(match[1]) / 1_000_000;
								fromAddress = sender || "";
							}
						}
					}
				}

				if (amount === 0) {
					continue; // No valid transfer to our address
				}

				// Extract memo from protobuf using structural position
				const memo = UnifiedWalletService.parseMemo(tx.tx, amount);
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

	/** Extract memo from protobuf tx by structural position (after amount) */
	private static parseMemo(base64Tx: string, amount: number): string {
		try {
			const buffer = Buffer.from(base64Tx, "base64");
			const amountInUjuno = (amount * 1_000_000).toString();

			interface StringPosition {
				str: string;
				position: number;
			}

			const strings: StringPosition[] = [];

			// Scan buffer for printable ASCII strings with their positions
			for (let i = 0; i < buffer.length; i++) {
				const strStart = i;
				let strLength = 0;

				// Find sequences of printable ASCII (0x20-0x7E)
				while (i < buffer.length && buffer[i] >= 0x20 && buffer[i] <= 0x7e) {
					strLength++;
					i++;
				}

				if (strLength >= 1) {
					const str = buffer
						.slice(strStart, strStart + strLength)
						.toString("utf8");
					strings.push({ str, position: strStart });
				}
			}

			// Find position of the amount in the buffer
			const amountPos =
				strings.find((s) => s.str === amountInUjuno)?.position || -1;

			// Memo is the first numeric string (5-12 digits) that appears AFTER the amount
			const numericMemo = strings.find((s) => {
				if (!/^\d{5,12}$/.test(s.str)) return false;
				if (s.str === amountInUjuno) return false; // Skip the amount itself
				if (amountPos !== -1 && s.position < amountPos) return false; // Must come after amount
				return true;
			});

			if (numericMemo) {
				return numericMemo.str;
			}

			// Priority 2: Alphanumeric memo after amount position (for non-numeric memos)
			const alphanumericMemo = strings.find((s) => {
				// Must be at least 2 characters
				if (s.str.length < 2) return false;

				// Must come after amount if we found it
				if (amountPos !== -1 && s.position < amountPos) return false;

				// Exclude message types
				if (s.str.startsWith("/cosmos.") || s.str.startsWith("/cosmwasm."))
					return false;

				// Exclude addresses (bech32 format)
				if (s.str.match(/^(juno|cosmos|osmo|neutron|sei|terra)[a-z0-9]{38,}/))
					return false;

				// Exclude addresses with length prefix
				if (s.str.startsWith("+")) return false;

				// Exclude denominations
				if (s.str.match(/^u(atom|juno|osmo|sei|axl|cre|akt)/)) return false;

				// Exclude crypto key types
				if (s.str.includes("PubKey") || s.str.includes("crypto")) return false;

				// Exclude large numbers
				if (s.str.match(/^\d+$/) && parseInt(s.str, 10) > 10000000)
					return false;

				// Exclude binary garbage
				const alphanumericRatio =
					(s.str.match(/[a-zA-Z0-9]/g) || []).length / s.str.length;
				if (alphanumericRatio < 0.5) return false;

				return true;
			});

			return alphanumericMemo?.str || "";
		} catch (error) {
			logger.error("Failed to extract memo from protobuf", error);
			return "";
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

		// Determine target user FIRST (before inserting into processed_deposits)
		// This ensures the user exists before we reference them with a foreign key
		let targetUserId = deposit.userId;

		if (!targetUserId) {
			// No valid userId in memo - send to unclaimed account
			targetUserId = SYSTEM_USER_IDS.UNCLAIMED;
			logger.info(
				"Deposit without valid userId in memo, sending to unclaimed",
				{
					txHash: deposit.txHash,
					memo: deposit.memo,
					amount: deposit.amount,
					fromAddress: deposit.fromAddress,
				},
			);
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
	private static parseUserId(memo: string): number | null {
		if (!memo) return null;

		// Try direct number parsing
		const parsed = parseInt(memo.trim(), 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			return parsed;
		}

		// Try extracting from patterns like "userId:123" or "user 123"
		const match = memo.match(/(?:user[Id]*[:\s]+)?(\d+)/i);
		if (match?.[1]) {
			const id = parseInt(match[1], 10);
			if (!Number.isNaN(id) && id > 0) {
				return id;
			}
		}

		return null;
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

		// Check balance before acquiring lock
		const balance = await LedgerService.getUserBalance(userId);
		if (!AmountPrecision.isGreaterOrEqual(balance, validatedAmount)) {
			return {
				success: false,
				error: `Insufficient balance. You have ${AmountPrecision.format(balance)} JUNO`,
				newBalance: balance,
			};
		}

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

			// Execute on-chain transaction
			if (!UnifiedWalletService.wallet) {
				// Refund if we can't sign
				await LedgerService.processGiveaway(
					userId,
					validatedAmount,
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
				{ gasPrice: GasPrice.fromString("0.075ujuno") },
			);

			const [account] = await UnifiedWalletService.wallet.getAccounts();
			const amountInUjuno = AmountPrecision.toMicroJuno(validatedAmount);

			let result: Awaited<ReturnType<typeof client.sendTokens>>;
			try {
				result = await client.sendTokens(
					account.address,
					toAddress,
					[{ denom: "ujuno", amount: amountInUjuno.toString() }],
					"auto",
					`Withdrawal for user ${userId}`,
				);
			} catch (txError) {
				// Transaction failed - refund and release lock
				logger.error("On-chain transaction failed", { userId, error: txError });

				await LedgerService.processGiveaway(
					userId,
					amount,
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
				// Transaction failed on-chain - refund and release lock
				await LedgerService.processGiveaway(
					userId,
					amount,
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

			// Record gas fee in ledger to keep internal total accurate
			// Gas is paid from the on-chain wallet but not yet tracked in ledger
			if (result.gasUsed) {
				const gasUsedNum = Number(result.gasUsed);
				const gasFeeUjuno = gasUsedNum * 0.075; // gas price is 0.075ujuno
				const gasFeeJuno = gasFeeUjuno / 1_000_000;
				if (gasFeeJuno > 0.000001) {
					// Debit from SYSTEM_RESERVE to track the gas cost
					await LedgerService.processAdjustment(
						SYSTEM_USER_IDS.SYSTEM_RESERVE,
						-gasFeeJuno,
						`Gas fee for withdrawal ${result.transactionHash.slice(0, 16)}...`,
					);
					logger.info("Gas fee recorded in ledger", {
						userId,
						txHash: result.transactionHash,
						gasUsed: gasUsedNum,
						gasFeeJuno,
					});
				}
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
				userId,
				toAddress,
				amount,
				txHash: result.transactionHash,
				lockReleased: releaseResult.released,
			});

			return {
				success: true,
				txHash: result.transactionHash,
				newBalance: withdrawalResult.newBalance,
			};
		} catch (error) {
			// Unexpected error - ensure lock is released and user is refunded
			logger.error("Unexpected error during withdrawal", { userId, error });

			try {
				await LedgerService.processGiveaway(
					userId,
					amount,
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
	 * Pay fine (internal transfer to bot treasury)
	 */
	static async payFine(
		userId: number,
		amount: number,
		reason?: string,
	): Promise<{ success: boolean; error?: string; newBalance?: number }> {
		// Use internal transfer to bot treasury
		const result = await LedgerService.transferBetweenUsers(
			userId,
			SYSTEM_USER_IDS.BOT_TREASURY,
			amount,
			reason || "Fine payment",
		);

		if (result.success) {
			logger.info("Fine paid", {
				userId,
				amount,
				newBalance: result.fromBalance,
				botBalance: result.toBalance,
			});
		}

		return {
			success: result.success,
			error: result.error,
			newBalance: result.fromBalance,
		};
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
	 * Verify transaction on blockchain
	 */
	static async verifyTransaction(txHash: string): Promise<{
		verified: boolean;
		amount?: number;
		from?: string;
		to?: string;
		memo?: string;
	}> {
		try {
			const response = await fetch(
				`${UnifiedWalletService.apiEndpoint}/cosmos/tx/v1beta1/txs/${txHash}`,
			);

			if (!response.ok) {
				return { verified: false };
			}

			const data = (await response.json()) as any;
			const tx = data.tx_response;

			if (tx.code !== 0) {
				return { verified: false };
			}

			// Find transfer to our wallet
			for (const msg of tx.tx?.body?.messages || []) {
				if (msg["@type"] === "/cosmos.bank.v1beta1.MsgSend") {
					const junoAmount = msg.amount?.find((a: any) => a.denom === "ujuno");

					if (junoAmount) {
						return {
							verified: true,
							amount: parseFloat(junoAmount.amount) / 1_000_000,
							from: msg.from_address,
							to: msg.to_address,
							memo: tx.tx?.body?.memo || "",
						};
					}
				}
			}

			return { verified: false };
		} catch (error) {
			logger.error("Failed to verify transaction", { txHash, error });
			return { verified: false };
		}
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
		try {
			const response = await fetch(
				`${UnifiedWalletService.apiEndpoint}/cosmos/bank/v1beta1/balances/${UnifiedWalletService.walletAddress}`,
			);

			if (response.ok) {
				const data = (await response.json()) as any;
				const junoBalance = data.balances?.find(
					(b: any) => b.denom === "ujuno",
				);
				onChainBalance = junoBalance
					? parseFloat(junoBalance.amount) / 1_000_000
					: 0;
			}
		} catch (error) {
			logger.error("Failed to get on-chain balance", error);
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
	 * Claim unclaimed deposit
	 */
	static async claimUnclaimedDeposit(
		txHash: string,
		userId: number,
	): Promise<{ success: boolean; error?: string; amount?: number }> {
		// Check if deposit exists and is unclaimed
		const deposit = get<any>(
			"SELECT * FROM processed_deposits WHERE tx_hash = ? AND user_id = ?",
			[txHash, SYSTEM_USER_IDS.UNCLAIMED],
		);

		if (!deposit) {
			return {
				success: false,
				error: "Deposit not found or not unclaimed",
			};
		}

		// SAFEGUARD: Check if this deposit was already claimed (transfer from UNCLAIMED exists)
		const existingClaim = get<any>(
			`SELECT * FROM transactions
			 WHERE transaction_type = 'transfer'
			 AND from_user_id = ?
			 AND description LIKE ?`,
			[SYSTEM_USER_IDS.UNCLAIMED, `%${txHash}%`],
		);

		if (existingClaim) {
			logger.warn("Deposit already claimed, preventing duplicate claim", {
				txHash,
				previousClaimUserId: existingClaim.to_user_id,
				attemptedUserId: userId,
			});
			return {
				success: false,
				error: `Deposit already claimed by user ${existingClaim.to_user_id}`,
			};
		}

		// Transfer from unclaimed to user
		const result = await LedgerService.transferBetweenUsers(
			SYSTEM_USER_IDS.UNCLAIMED,
			userId,
			deposit.amount,
			`Claimed deposit ${txHash}`,
		);

		if (result.success) {
			// Update deposit record
			execute("UPDATE processed_deposits SET user_id = ? WHERE tx_hash = ?", [
				userId,
				txHash,
			]);

			logger.info("Unclaimed deposit claimed", {
				txHash,
				userId,
				amount: deposit.amount,
			});

			return {
				success: true,
				amount: deposit.amount,
			};
		}

		return {
			success: false,
			error: result.error,
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
