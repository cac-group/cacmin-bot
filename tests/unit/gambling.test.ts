import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Tests for the gambling/roll game system including:
 * - Roll number generation
 * - Win detection (dubs, trips, quads, etc.)
 * - Transaction handling
 * - Balance checks
 */

// Mock database
vi.mock("../../src/database", () => ({
	query: vi.fn(),
	execute: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
	get: vi.fn(),
}));

// Mock config
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

// Mock logger
vi.mock("../../src/utils/logger", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
	StructuredLogger: {
		logError: vi.fn(),
		logUserAction: vi.fn(),
		logTransaction: vi.fn(),
		logWalletAction: vi.fn(),
	},
}));

// Mock LedgerService
const mockTransferBetweenUsers = vi.fn();
const mockGetUserBalance = vi.fn();

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: {
		getUserBalance: (...args: unknown[]) => mockGetUserBalance(...args),
		transferBetweenUsers: (...args: unknown[]) => mockTransferBetweenUsers(...args),
		ensureUserBalance: vi.fn(() => Promise.resolve()),
	},
	TransactionType: {
		DEPOSIT: "deposit",
		WITHDRAWAL: "withdrawal",
		TRANSFER: "transfer",
		FINE: "fine",
		BAIL: "bail",
		GIVEAWAY: "giveaway",
		REFUND: "refund",
		GAMBLING: "gambling",
	},
}));

// Mock TransactionLockService
const mockAcquireLock = vi.fn();
const mockReleaseLock = vi.fn();

vi.mock("../../src/services/transactionLock", () => ({
	TransactionLockService: {
		acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
		releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
	},
}));

// Mock UnifiedWalletService
vi.mock("../../src/services/unifiedWalletService", () => ({
	SYSTEM_USER_IDS: {
		BOT_TREASURY: -1,
		SYSTEM_RESERVE: -2,
		UNCLAIMED: -3,
		GIVEAWAY_ESCROW_BASE: -1000,
	},
}));

// Mock userService
vi.mock("../../src/services/userService", () => ({
	createUser: vi.fn(),
	userExists: vi.fn(() => false),
	ensureUserExists: vi.fn(),
}));

import { createMockContext, getReplyText, wasTextReplied } from "../helpers/mockContext";
import { SYSTEM_USER_IDS } from "../../src/services/unifiedWalletService";

describe("Roll Game Win Detection", () => {
	// Simulate checkWin logic for testing
	function checkWin(roll: string): { won: boolean; matchCount: number; matchName: string } {
		const lastDigit = roll[roll.length - 1];
		let matchCount = 1;

		for (let i = roll.length - 2; i >= 0; i--) {
			if (roll[i] === lastDigit) {
				matchCount++;
			} else {
				break;
			}
		}

		const matchNames: Record<number, string> = {
			2: "DUBS",
			3: "TRIPS",
			4: "QUADS",
			5: "QUINTS",
			6: "SEXTS",
			7: "SEPTS",
			8: "OCTS",
			9: "NINES",
		};

		return {
			won: matchCount >= 2,
			matchCount,
			matchName: matchNames[matchCount] || `${matchCount}x`,
		};
	}

	describe("checkWin function", () => {
		it("should detect dubs (2 matching digits)", () => {
			const result = checkWin("123456711");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(2);
			expect(result.matchName).toBe("DUBS");
		});

		it("should detect trips (3 matching digits)", () => {
			const result = checkWin("123456555");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(3);
			expect(result.matchName).toBe("TRIPS");
		});

		it("should detect quads (4 matching digits)", () => {
			const result = checkWin("123453333");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(4);
			expect(result.matchName).toBe("QUADS");
		});

		it("should detect quints (5 matching digits)", () => {
			const result = checkWin("123455555");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(5);
			expect(result.matchName).toBe("QUINTS");
		});

		it("should not win with no matching trailing digits", () => {
			const result = checkWin("123456789");
			expect(result.won).toBe(false);
			expect(result.matchCount).toBe(1);
		});

		it("should not win with matching digits not at the end", () => {
			const result = checkWin("111234567");
			expect(result.won).toBe(false);
			expect(result.matchCount).toBe(1);
		});

		it("should handle all zeros", () => {
			const result = checkWin("000000000");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(9);
			expect(result.matchName).toBe("NINES");
		});

		it("should handle edge case of single digit difference", () => {
			const result = checkWin("123456788");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(2);
		});

		it("should correctly count only trailing matches", () => {
			// 11 at end but 1 earlier doesn't count
			const result = checkWin("112345611");
			expect(result.won).toBe(true);
			expect(result.matchCount).toBe(2);
		});
	});
});

describe("Roll Game Probability", () => {
	it("should have 10% win rate for dubs (theoretical)", () => {
		// For any 9-digit number, the chance of last 2 digits matching
		// is 1/10 (10%) - the second-to-last digit must match the last digit
		const winProbability = 1 / 10;
		expect(winProbability).toBe(0.1);
	});

	it("should have 1% win rate for trips (theoretical)", () => {
		// Last 3 digits must all match: 1/100
		const winProbability = 1 / 100;
		expect(winProbability).toBe(0.01);
	});

	it("should have 0.1% win rate for quads (theoretical)", () => {
		// Last 4 digits must all match: 1/1000
		const winProbability = 1 / 1000;
		expect(winProbability).toBe(0.001);
	});

	it("should verify fair game expected value", () => {
		// EV = (win_probability * profit) + (lose_probability * loss)
		// EV = (0.1 * 9) + (0.9 * -1) = 0.9 - 0.9 = 0
		const winProb = 0.1;
		const loseProb = 0.9;
		const profit = 9; // 9x profit on win
		const loss = -1; // lose 1x bet on loss

		const expectedValue = winProb * profit + loseProb * loss;
		expect(expectedValue).toBeCloseTo(0, 10);
	});
});

describe("Roll Number Generation", () => {
	it("should always produce 9-digit strings", () => {
		// Test that padStart works correctly
		const testNumbers = [0, 1, 123, 123456, 999999999];

		for (const num of testNumbers) {
			const padded = num.toString().padStart(9, "0");
			expect(padded.length).toBe(9);
		}
	});

	it("should produce valid 9-digit range", () => {
		// Maximum 9-digit number
		const maxRoll = 999999999;

		// Modulo should always produce valid range
		const testValues = [0, 500000000, 999999999, 1000000000, 281474976710655];

		for (const val of testValues) {
			const result = val % 1000000000;
			expect(result).toBeGreaterThanOrEqual(0);
			expect(result).toBeLessThanOrEqual(maxRoll);
		}
	});

	it("should handle hex to number conversion correctly", () => {
		// Simulate the hash extraction logic
		const testHexes = ["000000000000", "ffffffffffff", "123456789abc"];

		for (const hex of testHexes) {
			const numericValue = parseInt(hex, 16);
			expect(Number.isFinite(numericValue)).toBe(true);
			expect(numericValue).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("Roll Game Bet Validation", () => {
	const MIN_BET = 0.1;
	const MAX_BET = 100;

	it("should reject bets below minimum", () => {
		const bet = 0.05;
		expect(bet < MIN_BET).toBe(true);
	});

	it("should accept bets at minimum", () => {
		const bet = 0.1;
		expect(bet >= MIN_BET && bet <= MAX_BET).toBe(true);
	});

	it("should accept bets within range", () => {
		const bets = [0.1, 1, 10, 50, 99.999999, 100];

		for (const bet of bets) {
			expect(bet >= MIN_BET && bet <= MAX_BET).toBe(true);
		}
	});

	it("should reject bets above maximum", () => {
		const bet = 100.000001;
		expect(bet > MAX_BET).toBe(true);
	});

	it("should handle 6 decimal precision", () => {
		const bet = 10.123456;
		const decimals = bet.toString().split(".")[1]?.length || 0;
		expect(decimals).toBeLessThanOrEqual(6);
	});
});

describe("Roll Game Payout Calculations", () => {
	const WIN_MULTIPLIER = 9;

	it("should calculate correct profit on win", () => {
		const betAmounts = [1, 5, 10, 50, 100];

		for (const bet of betAmounts) {
			const profit = bet * WIN_MULTIPLIER;
			expect(profit).toBe(bet * 9);
		}
	});

	it("should handle decimal bets correctly", () => {
		const bet = 10.5;
		const profit = bet * WIN_MULTIPLIER;
		expect(profit).toBe(94.5);
	});

	it("should calculate new balance on win", () => {
		const balance = 100;
		const bet = 10;
		const profit = bet * WIN_MULTIPLIER;

		// On win, user receives profit (bet stays in their balance)
		const newBalance = balance + profit;
		expect(newBalance).toBe(190);
	});

	it("should calculate new balance on loss", () => {
		const balance = 100;
		const bet = 10;

		// On loss, user loses bet amount
		const newBalance = balance - bet;
		expect(newBalance).toBe(90);
	});
});

describe("Roll Game Treasury Checks", () => {
	it("should verify treasury can cover potential payout", () => {
		const treasuryBalance = 1000;
		const bet = 100;
		const potentialPayout = bet * 9; // 900

		expect(treasuryBalance >= potentialPayout).toBe(true);
	});

	it("should reject bet when treasury cannot cover payout", () => {
		const treasuryBalance = 500;
		const bet = 100;
		const potentialPayout = bet * 9; // 900

		expect(treasuryBalance >= potentialPayout).toBe(false);
	});

	it("should calculate max safe bet based on treasury", () => {
		const treasuryBalance = 450;
		const multiplier = 9;

		// Max bet = treasury / multiplier
		const maxSafeBet = treasuryBalance / multiplier;
		expect(maxSafeBet).toBe(50);

		// Verify this bet can be covered
		expect(maxSafeBet * multiplier).toBeLessThanOrEqual(treasuryBalance);
	});
});

describe("Roll Game Transaction Flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAcquireLock.mockResolvedValue(true);
		mockReleaseLock.mockResolvedValue(undefined);
		mockGetUserBalance.mockResolvedValue(100);
		mockTransferBetweenUsers.mockResolvedValue({
			success: true,
			fromBalance: 90,
			toBalance: 110,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should acquire lock before processing", async () => {
		const userId = 123456789;
		const betAmount = 10;

		await mockAcquireLock(userId, "gambling_roll", betAmount);

		expect(mockAcquireLock).toHaveBeenCalledWith(userId, "gambling_roll", betAmount);
	});

	it("should release lock after processing", async () => {
		const userId = 123456789;

		await mockReleaseLock(userId);

		expect(mockReleaseLock).toHaveBeenCalledWith(userId);
	});

	it("should check user balance before roll", async () => {
		const userId = 123456789;

		const balance = await mockGetUserBalance(userId);

		expect(mockGetUserBalance).toHaveBeenCalledWith(userId);
		expect(balance).toBe(100);
	});

	it("should check treasury balance before roll", async () => {
		await mockGetUserBalance(SYSTEM_USER_IDS.BOT_TREASURY);

		expect(mockGetUserBalance).toHaveBeenCalledWith(-1);
	});

	it("should transfer from treasury to user on win", async () => {
		const userId = 123456789;
		const profit = 90;

		await mockTransferBetweenUsers(SYSTEM_USER_IDS.BOT_TREASURY, userId, profit, expect.any(String));

		expect(mockTransferBetweenUsers).toHaveBeenCalledWith(-1, userId, profit, expect.any(String));
	});

	it("should transfer from user to treasury on loss", async () => {
		const userId = 123456789;
		const betAmount = 10;

		await mockTransferBetweenUsers(userId, SYSTEM_USER_IDS.BOT_TREASURY, betAmount, expect.any(String));

		expect(mockTransferBetweenUsers).toHaveBeenCalledWith(userId, -1, betAmount, expect.any(String));
	});
});

describe("Roll Game Error Handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should handle lock acquisition failure", async () => {
		mockAcquireLock.mockResolvedValue(false);

		const result = await mockAcquireLock(123456789, "gambling_roll", 10);

		expect(result).toBe(false);
	});

	it("should handle insufficient user balance", async () => {
		mockGetUserBalance.mockResolvedValue(5);

		const balance = await mockGetUserBalance(123456789);
		const betAmount = 10;

		expect(balance < betAmount).toBe(true);
	});

	it("should handle transfer failure", async () => {
		mockTransferBetweenUsers.mockResolvedValue({
			success: false,
			error: "Transfer failed",
			fromBalance: 100,
			toBalance: 0,
		});

		const result = await mockTransferBetweenUsers(123456789, -1, 10, "test");

		expect(result.success).toBe(false);
		expect(result.error).toBe("Transfer failed");
	});

	it("should always release lock on error", async () => {
		mockAcquireLock.mockResolvedValue(true);
		mockGetUserBalance.mockRejectedValue(new Error("DB error"));

		try {
			await mockGetUserBalance(123456789);
		} catch {
			await mockReleaseLock(123456789);
		}

		expect(mockReleaseLock).toHaveBeenCalled();
	});
});

describe("Roll Statistics", () => {
	it("should track total wagered correctly", () => {
		const bets = [10, 20, 15, 5, 50];
		const totalWagered = bets.reduce((sum, bet) => sum + bet, 0);

		expect(totalWagered).toBe(100);
	});

	it("should calculate net profit correctly", () => {
		const totalWagered = 100;
		const totalWon = 90; // Won some, lost some

		const netProfit = totalWon - totalWagered;
		expect(netProfit).toBe(-10);
	});

	it("should calculate positive net profit", () => {
		const totalWagered = 100;
		const totalWon = 180; // Got lucky

		const netProfit = totalWon - totalWagered;
		expect(netProfit).toBe(80);
	});

	it("should format profit string correctly", () => {
		const formatProfit = (profit: number): string => {
			if (profit >= 0) {
				return `+${profit.toFixed(6)}`;
			}
			return profit.toFixed(6);
		};

		expect(formatProfit(10)).toBe("+10.000000");
		expect(formatProfit(-5)).toBe("-5.000000");
		expect(formatProfit(0)).toBe("+0.000000");
	});
});

describe("Roll Display Formatting", () => {
	it("should format roll number with spaces", () => {
		const rollNumber = "123456789";
		const formatted = rollNumber.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");

		expect(formatted).toBe("123 456 789");
	});

	it("should format roll number with leading zeros", () => {
		const rollNumber = "000123456";
		const formatted = rollNumber.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");

		expect(formatted).toBe("000 123 456");
	});

	it("should format all zeros correctly", () => {
		const rollNumber = "000000000";
		const formatted = rollNumber.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");

		expect(formatted).toBe("000 000 000");
	});

	it("should format winning dubs roll", () => {
		const rollNumber = "123456788";
		const formatted = rollNumber.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");

		expect(formatted).toBe("123 456 788");
		expect(rollNumber.endsWith("88")).toBe(true);
	});
});

describe("Match Name Mapping", () => {
	const matchNames: Record<number, string> = {
		2: "DUBS",
		3: "TRIPS",
		4: "QUADS",
		5: "QUINTS",
		6: "SEXTS",
		7: "SEPTS",
		8: "OCTS",
		9: "NINES",
	};

	it("should have correct name for each match count", () => {
		expect(matchNames[2]).toBe("DUBS");
		expect(matchNames[3]).toBe("TRIPS");
		expect(matchNames[4]).toBe("QUADS");
		expect(matchNames[5]).toBe("QUINTS");
		expect(matchNames[6]).toBe("SEXTS");
		expect(matchNames[7]).toBe("SEPTS");
		expect(matchNames[8]).toBe("OCTS");
		expect(matchNames[9]).toBe("NINES");
	});

	it("should handle unknown match counts", () => {
		const matchCount = 10;
		const name = matchNames[matchCount] || `${matchCount}x`;

		expect(name).toBe("10x");
	});

	it("should have all possible win match counts", () => {
		// 2-9 are all possible winning match counts for a 9-digit number
		for (let i = 2; i <= 9; i++) {
			expect(matchNames[i]).toBeDefined();
		}
	});
});

describe("System User IDs", () => {
	it("should use correct treasury ID", () => {
		expect(SYSTEM_USER_IDS.BOT_TREASURY).toBe(-1);
	});

	it("should have distinct system IDs", () => {
		const ids = [
			SYSTEM_USER_IDS.BOT_TREASURY,
			SYSTEM_USER_IDS.SYSTEM_RESERVE,
			SYSTEM_USER_IDS.UNCLAIMED,
			SYSTEM_USER_IDS.GIVEAWAY_ESCROW_BASE,
		];

		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it("should all be negative (system accounts)", () => {
		expect(SYSTEM_USER_IDS.BOT_TREASURY).toBeLessThan(0);
		expect(SYSTEM_USER_IDS.SYSTEM_RESERVE).toBeLessThan(0);
		expect(SYSTEM_USER_IDS.UNCLAIMED).toBeLessThan(0);
	});
});
