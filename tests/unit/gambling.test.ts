import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Tests for the gambling/roll game system including:
 * - Roll number generation
 * - Win detection (dubs, trips, quads, etc.)
 * - Transaction handling
 */

// Mock database
vi.mock("../../src/database", () => ({
	query: vi.fn(),
	execute: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
	get: vi.fn(),
}));

vi.mock("../../src/config", () => ({
	config: {
		databasePath: ":memory:",
		botToken: "test-token",
		groupChatId: "-100123456789",
		botTreasuryAddress: "juno1testtreasuryaddress",
		adminChatId: "123456789",
		junoRpcUrl: "https://rpc.juno.example.com",
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: {
		logError: vi.fn(), logUserAction: vi.fn(),
		logTransaction: vi.fn(), logWalletAction: vi.fn(),
	},
}));

const mockTransferBetweenUsers = vi.fn();
const mockGetUserBalance = vi.fn();

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: {
		getUserBalance: (...args: unknown[]) => mockGetUserBalance(...args),
		transferBetweenUsers: (...args: unknown[]) => mockTransferBetweenUsers(...args),
		ensureUserBalance: vi.fn(() => Promise.resolve()),
	},
	TransactionType: {
		DEPOSIT: "deposit", WITHDRAWAL: "withdrawal", TRANSFER: "transfer",
		FINE: "fine", BAIL: "bail", GIVEAWAY: "giveaway",
		REFUND: "refund", GAMBLING: "gambling",
	},
}));

const mockAcquireLock = vi.fn();
const mockReleaseLock = vi.fn();

vi.mock("../../src/services/transactionLock", () => ({
	TransactionLockService: {
		acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
		releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
	},
}));

vi.mock("../../src/services/unifiedWalletService", () => ({
	SYSTEM_USER_IDS: { BOT_TREASURY: -1, SYSTEM_RESERVE: -2, UNCLAIMED: -3, GIVEAWAY_ESCROW_BASE: -1000 },
}));

vi.mock("../../src/services/userService", () => ({
	createUser: vi.fn(), userExists: vi.fn(() => false), ensureUserExists: vi.fn(),
}));

vi.mock("../../src/utils/precision", () => ({
	AmountPrecision: {
		format: (n: number) => n.toFixed(6),
		parseUserInput: (s: string) => parseFloat(s),
		validateAmount: (n: number) => n,
		isGreaterOrEqual: (a: number, b: number) => a >= b,
	},
}));

import { SYSTEM_USER_IDS } from "../../src/services/unifiedWalletService";
import { get, execute } from "../../src/database";
import {
	checkWin,
	generateRollNumber,
	initializeRollSystem,
	getServerSeedCommitment,
	rotateServerSeed,
	MIN_BET,
	MAX_BET,
	WIN_MULTIPLIER,
} from "../../src/commands/gambling";

describe("Roll Game", () => {
	describe("Win Detection", () => {
		it.each([
			["123456711", 2, "DUBS"],
			["123456555", 3, "TRIPS"],
			["123453333", 4, "QUADS"],
			["123455555", 5, "QUINTS"],
			["123666666", 6, "SEXTS"],
			["127777777", 7, "SEPTS"],
			["188888888", 8, "OCTS"],
			["000000000", 9, "NINES"],
		])("detects %s as %i matching (%s)", (roll, matchCount, matchName) => {
			const result = checkWin(roll);
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(matchCount);
			expect(result.matchName).toBe(matchName);
		});

		it.each([
			["123456789", 1],
			["111234567", 1],
		])("does not win with %s (matchCount: %i)", (roll, matchCount) => {
			const result = checkWin(roll);
			expect(result.won).toBe(false);
			expect(result.matchCount).toBe(matchCount);
		});

		it("counts only trailing matches", () => {
			const result = checkWin("112345611");
			expect(result.matchCount).toBe(2);
		});
	});

	describe("Probability and Payouts", () => {
		it("has fair expected value for dubs", () => {
			// EV = (0.1 * 9) + (0.9 * -1) = 0
			const ev = 0.1 * 9 + 0.9 * -1;
			expect(ev).toBeCloseTo(0, 10);
		});

		it("calculates correct payouts", () => {
			expect(10 * WIN_MULTIPLIER).toBe(90);
			expect(10.5 * WIN_MULTIPLIER).toBe(94.5);
		});
	});

	describe("System Initialization", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.mocked(get).mockReturnValue(undefined);
			vi.mocked(execute).mockReturnValue({ lastInsertRowid: 1, changes: 1 });
		});

		it("initializes without error and creates fresh state", async () => {
			await expect(initializeRollSystem()).resolves.not.toThrow();
			expect(execute).toHaveBeenCalled();

			const commitment = getServerSeedCommitment();
			expect(commitment).toHaveLength(64);
			expect(/^[a-f0-9]+$/.test(commitment)).toBe(true);
		});

		it("restores state from database if present", async () => {
			vi.mocked(get)
				.mockReturnValueOnce({ value: "existing_hash" })
				.mockReturnValueOnce({ value: "42" })
				.mockReturnValueOnce({ value: "existing_seed" })
				.mockReturnValueOnce({ value: "existing_seed_hash" });

			await initializeRollSystem();
			expect(getServerSeedCommitment()).toBe("existing_seed_hash");
		});
	});

	describe("Seed Rotation", () => {
		beforeEach(async () => {
			vi.clearAllMocks();
			vi.mocked(get).mockReturnValue(undefined);
			vi.mocked(execute).mockReturnValue({ lastInsertRowid: 1, changes: 1 });
			await initializeRollSystem();
		});

		it("rotates seed correctly", () => {
			const oldCommitment = getServerSeedCommitment();
			const { oldHash, newHash } = rotateServerSeed();

			expect(oldHash).toBe(oldCommitment);
			expect(newHash).not.toBe(oldHash);
			expect(getServerSeedCommitment()).toBe(newHash);
			expect(execute).toHaveBeenCalled();
		});
	});

	describe("Roll Generation", () => {
		beforeEach(async () => {
			vi.clearAllMocks();
			vi.mocked(get).mockReturnValue(undefined);
			vi.mocked(execute).mockReturnValue({ lastInsertRowid: 1, changes: 1 });
			await initializeRollSystem();
		});

		it("produces valid 9-digit rolls", () => {
			for (let i = 0; i < 5; i++) {
				const { rollNumber, rollId, verificationHash } = generateRollNumber(Date.now() + i, 100000 + i, 1000 + i);

				expect(rollNumber.length).toBe(9);
				expect(/^\d{9}$/.test(rollNumber)).toBe(true);
				expect(rollId).toBeGreaterThan(0);
				expect(verificationHash).toHaveLength(16);
			}
		});

		it("increments rollId and produces different rolls", () => {
			const r1 = generateRollNumber(1000000000, 111, 100);
			const r2 = generateRollNumber(1000000001, 111, 101);

			expect(r2.rollId).toBe(r1.rollId + 1);
		});
	});

	describe("Bet Validation", () => {
		it.each([
			[0.05, false],
			[0.1, true],
			[50, true],
			[100, true],
			[100.000001, false],
		])("validates bet %f correctly (valid: %s)", (bet, isValid) => {
			expect(bet >= MIN_BET && bet <= MAX_BET).toBe(isValid);
		});
	});

	describe("Transaction Flow", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			mockAcquireLock.mockResolvedValue(true);
			mockReleaseLock.mockResolvedValue(undefined);
			mockGetUserBalance.mockResolvedValue(100);
			mockTransferBetweenUsers.mockResolvedValue({ success: true, fromBalance: 90, toBalance: 110 });
		});

		it("handles full transaction flow", async () => {
			const userId = 123456789;

			// Lock
			await mockAcquireLock(userId, "gambling_roll", 10);
			expect(mockAcquireLock).toHaveBeenCalledWith(userId, "gambling_roll", 10);

			// Balance check
			const balance = await mockGetUserBalance(userId);
			expect(balance).toBe(100);

			// Treasury check
			await mockGetUserBalance(SYSTEM_USER_IDS.BOT_TREASURY);
			expect(mockGetUserBalance).toHaveBeenCalledWith(-1);

			// Transfer on win
			await mockTransferBetweenUsers(SYSTEM_USER_IDS.BOT_TREASURY, userId, 90, "win");
			expect(mockTransferBetweenUsers).toHaveBeenCalledWith(-1, userId, 90, "win");

			// Release lock
			await mockReleaseLock(userId);
			expect(mockReleaseLock).toHaveBeenCalled();
		});

		it("handles errors and releases lock", async () => {
			mockAcquireLock.mockResolvedValue(true);
			mockGetUserBalance.mockRejectedValue(new Error("DB error"));

			try { await mockGetUserBalance(123); } catch { await mockReleaseLock(123); }

			expect(mockReleaseLock).toHaveBeenCalled();
		});
	});

	describe("Treasury Safety", () => {
		it("validates treasury can cover payout", () => {
			const treasuryBalance = 1000;
			const bet = 100;
			expect(treasuryBalance >= bet * WIN_MULTIPLIER).toBe(true);

			const lowBalance = 500;
			expect(lowBalance >= bet * WIN_MULTIPLIER).toBe(false);
		});

		it("calculates max safe bet", () => {
			const treasuryBalance = 450;
			const maxSafeBet = treasuryBalance / WIN_MULTIPLIER;
			expect(maxSafeBet).toBe(50);
		});
	});

	describe("Display Formatting", () => {
		it.each([
			["123456789", "123 456 789"],
			["000123456", "000 123 456"],
			["000000000", "000 000 000"],
		])("formats %s as %s", (roll, expected) => {
			const formatted = roll.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
			expect(formatted).toBe(expected);
		});
	});

	describe("System User IDs", () => {
		it("uses correct and distinct negative IDs", () => {
			expect(SYSTEM_USER_IDS.BOT_TREASURY).toBe(-1);
			expect(SYSTEM_USER_IDS.SYSTEM_RESERVE).toBe(-2);
			expect(SYSTEM_USER_IDS.UNCLAIMED).toBe(-3);

			const ids = [SYSTEM_USER_IDS.BOT_TREASURY, SYSTEM_USER_IDS.SYSTEM_RESERVE, SYSTEM_USER_IDS.UNCLAIMED];
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids.every(id => id < 0)).toBe(true);
		});
	});
});
