import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Tests for the duel game system including:
 * - Duel creation and validation
 * - Accept/reject/cancel flows
 * - Winner determination
 * - Consequence application
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
		logSecurityEvent: vi.fn(),
	},
}));

// Mock LedgerService
const mockTransferBetweenUsers = vi.fn();
const mockGetUserBalance = vi.fn();

vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: {
		getUserBalance: (...args: unknown[]) => mockGetUserBalance(...args),
		transferBetweenUsers: (...args: unknown[]) =>
			mockTransferBetweenUsers(...args),
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

// Mock JailService
vi.mock("../../src/services/jailService", () => ({
	JailService: {
		logJailEvent: vi.fn(),
		initialize: vi.fn(),
	},
}));

// Mock userService
vi.mock("../../src/services/userService", () => ({
	createUser: vi.fn(),
	userExists: vi.fn(() => false),
	ensureUserExists: vi.fn(),
	addUserRestriction: vi.fn(),
}));

// Mock precision module
vi.mock("../../src/utils/precision", () => ({
	AmountPrecision: {
		format: (n: number) => n.toFixed(6),
		parseUserInput: (s: string) => parseFloat(s),
		validateAmount: (n: number) => n,
		isGreaterOrEqual: (a: number, b: number) => a >= b,
	},
}));

import { get, execute, query } from "../../src/database";
import {
	DuelService,
	DUEL_TIMEOUT_SECONDS,
	MIN_WAGER,
	MAX_WAGER,
	DEFAULT_CONSEQUENCE_DURATIONS,
} from "../../src/services/duelService";

describe("Duel Game Configuration", () => {
	it("should have correct timeout value (5 minutes)", () => {
		expect(DUEL_TIMEOUT_SECONDS).toBe(300);
	});

	it("should have valid wager limits", () => {
		expect(MIN_WAGER).toBe(0.1);
		expect(MAX_WAGER).toBe(50);
		expect(MIN_WAGER).toBeLessThan(MAX_WAGER);
	});

	it("should have default consequence durations", () => {
		expect(DEFAULT_CONSEQUENCE_DURATIONS.none).toBe(0);
		expect(DEFAULT_CONSEQUENCE_DURATIONS.jail).toBe(60);
		expect(DEFAULT_CONSEQUENCE_DURATIONS.muted).toBe(30);
		expect(DEFAULT_CONSEQUENCE_DURATIONS.no_stickers).toBe(60);
		expect(DEFAULT_CONSEQUENCE_DURATIONS.no_media).toBe(60);
		expect(DEFAULT_CONSEQUENCE_DURATIONS.no_gifs).toBe(60);
		expect(DEFAULT_CONSEQUENCE_DURATIONS.no_forwarding).toBe(60);
	});
});

describe("Duel Pending Check Functions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should detect no outgoing duel when none exists", () => {
		vi.mocked(get).mockReturnValue({ count: 0 });
		expect(DuelService.hasOutgoingDuel(123)).toBe(false);
	});

	it("should detect outgoing duel when one exists", () => {
		vi.mocked(get).mockReturnValue({ count: 1 });
		expect(DuelService.hasOutgoingDuel(123)).toBe(true);
	});

	it("should detect no incoming duel when none exists", () => {
		vi.mocked(get).mockReturnValue({ count: 0 });
		expect(DuelService.hasIncomingDuel(123)).toBe(false);
	});

	it("should detect incoming duel when one exists", () => {
		vi.mocked(get).mockReturnValue({ count: 1 });
		expect(DuelService.hasIncomingDuel(123)).toBe(true);
	});
});

describe("Duel Creation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetUserBalance.mockResolvedValue(100);
		vi.mocked(get).mockReturnValue({ count: 0 });
		vi.mocked(execute).mockReturnValue({ lastInsertRowid: 1, changes: 1 });
	});

	it("should prevent self-duel", async () => {
		const result = await DuelService.createDuel(123, 123, 10, -100);
		expect(result.success).toBe(false);
		expect(result.error).toContain("cannot duel yourself");
	});

	it("should reject wager below minimum", async () => {
		const result = await DuelService.createDuel(123, 456, 0.01, -100);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Minimum wager");
	});

	it("should reject wager above maximum", async () => {
		const result = await DuelService.createDuel(123, 456, 100, -100);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Maximum wager");
	});

	it("should prevent duel when challenger has existing outgoing duel", async () => {
		vi.mocked(get).mockImplementation((sql: string) => {
			if (sql.includes("challenger_id")) {
				return { count: 1 }; // Has outgoing duel
			}
			return { count: 0 };
		});

		const result = await DuelService.createDuel(123, 456, 10, -100);
		expect(result.success).toBe(false);
		expect(result.error).toContain("already have a pending duel");
	});

	it("should prevent duel when opponent has existing incoming duel", async () => {
		vi.mocked(get).mockImplementation((sql: string) => {
			if (sql.includes("opponent_id")) {
				return { count: 1 }; // Opponent has incoming duel
			}
			return { count: 0 };
		});

		const result = await DuelService.createDuel(123, 456, 10, -100);
		expect(result.success).toBe(false);
		expect(result.error).toContain("already has a pending duel");
	});

	it("should reject when challenger has insufficient balance", async () => {
		vi.mocked(get).mockReturnValue({ count: 0 });
		mockGetUserBalance.mockResolvedValue(5);

		const result = await DuelService.createDuel(123, 456, 10, -100);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Insufficient balance");
	});

	it("should create duel successfully with valid parameters", async () => {
		vi.mocked(get).mockImplementation((sql: string) => {
			if (sql.includes("COUNT(*)")) {
				return { count: 0 };
			}
			// Return a mock duel row after creation
			return {
				id: 1,
				challenger_id: 123,
				opponent_id: 456,
				wager_amount: 10,
				loser_consequence: "none",
				status: "pending",
				chat_id: -100,
				created_at: Math.floor(Date.now() / 1000),
				expires_at: Math.floor(Date.now() / 1000) + DUEL_TIMEOUT_SECONDS,
			};
		});
		mockGetUserBalance.mockResolvedValue(100);

		const result = await DuelService.createDuel(123, 456, 10, -100);
		expect(result.success).toBe(true);
		expect(result.duel).toBeDefined();
	});

	it("should set default consequence duration", async () => {
		vi.mocked(get).mockImplementation((sql: string) => {
			if (sql.includes("COUNT(*)")) {
				return { count: 0 };
			}
			return {
				id: 1,
				challenger_id: 123,
				opponent_id: 456,
				wager_amount: 10,
				loser_consequence: "jail",
				consequence_duration: 60,
				status: "pending",
				chat_id: -100,
				created_at: Math.floor(Date.now() / 1000),
				expires_at: Math.floor(Date.now() / 1000) + DUEL_TIMEOUT_SECONDS,
			};
		});
		mockGetUserBalance.mockResolvedValue(100);

		const result = await DuelService.createDuel(123, 456, 10, -100, "jail");
		expect(result.success).toBe(true);
		expect(result.duel?.loserConsequence).toBe("jail");
	});
});

describe("Duel Cancel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should only allow challenger to cancel", () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			status: "pending",
		});

		const result = DuelService.cancelDuel(1, 456);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Only the challenger");
	});

	it("should allow challenger to cancel pending duel", () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			status: "pending",
		});
		vi.mocked(execute).mockReturnValue({ changes: 1, lastInsertRowid: 0 });

		const result = DuelService.cancelDuel(1, 123);
		expect(result.success).toBe(true);
	});

	it("should not allow cancel of non-pending duel", () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			status: "completed",
		});

		const result = DuelService.cancelDuel(1, 123);
		expect(result.success).toBe(false);
		expect(result.error).toContain("no longer pending");
	});

	it("should return error for non-existent duel", () => {
		vi.mocked(get).mockReturnValue(undefined);

		const result = DuelService.cancelDuel(999, 123);
		expect(result.success).toBe(false);
		expect(result.error).toContain("not found");
	});
});

describe("Duel Reject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should only allow opponent to reject", () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			status: "pending",
		});

		const result = DuelService.rejectDuel(1, 123);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Only the challenged user");
	});

	it("should allow opponent to reject pending duel", () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			status: "pending",
		});
		vi.mocked(execute).mockReturnValue({ changes: 1, lastInsertRowid: 0 });

		const result = DuelService.rejectDuel(1, 456);
		expect(result.success).toBe(true);
	});

	it("should not allow reject of non-pending duel", () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			status: "cancelled",
		});

		const result = DuelService.rejectDuel(1, 456);
		expect(result.success).toBe(false);
		expect(result.error).toContain("no longer pending");
	});
});

describe("Duel Execution", () => {
	const mockGenerateRollFn = vi.fn();

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

	it("should only allow opponent to accept", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			status: "pending",
		});

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			123,
			mockGenerateRollFn,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Only the challenged user");
	});

	it("should reject if opponent has insufficient balance", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			status: "pending",
		});
		mockGetUserBalance.mockResolvedValue(5);

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			456,
			mockGenerateRollFn,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Insufficient balance");
	});

	it("should cancel if challenger no longer has funds", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			status: "pending",
		});
		// First call for opponent check, second for challenger re-check
		mockGetUserBalance
			.mockResolvedValueOnce(100) // Opponent has funds
			.mockResolvedValueOnce(5); // Challenger lost funds

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			456,
			mockGenerateRollFn,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Challenger no longer has sufficient");
	});

	it("should fail if lock acquisition fails for challenger", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			status: "pending",
		});
		mockGetUserBalance.mockResolvedValue(100);
		mockAcquireLock.mockResolvedValueOnce(false);

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			456,
			mockGenerateRollFn,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Challenger has a pending transaction");
	});

	it("should fail if lock acquisition fails for opponent", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			status: "pending",
		});
		mockGetUserBalance.mockResolvedValue(100);
		mockAcquireLock
			.mockResolvedValueOnce(true) // Challenger lock succeeds
			.mockResolvedValueOnce(false); // Opponent lock fails

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			456,
			mockGenerateRollFn,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("You have a pending transaction");
	});

	it("should determine winner by higher roll", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			loser_consequence: "none",
			status: "pending",
			chat_id: -100,
		});
		mockGetUserBalance.mockResolvedValue(100);
		mockAcquireLock.mockResolvedValue(true);

		// Challenger rolls higher
		mockGenerateRollFn
			.mockReturnValueOnce({
				rollNumber: "500000000",
				rollId: 1,
				verificationHash: "abc123",
			})
			.mockReturnValueOnce({
				rollNumber: "300000000",
				rollId: 2,
				verificationHash: "def456",
			});

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			456,
			mockGenerateRollFn,
		);

		expect(result.success).toBe(true);
		// Winner should be challenger (123) with higher roll
		expect(mockTransferBetweenUsers).toHaveBeenCalledWith(
			456,
			123,
			10,
			expect.any(String),
		);
	});

	it("should give ties to challenger", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			loser_consequence: "none",
			status: "pending",
			chat_id: -100,
		});
		mockGetUserBalance.mockResolvedValue(100);
		mockAcquireLock.mockResolvedValue(true);

		// Both roll same number
		mockGenerateRollFn.mockReturnValue({
			rollNumber: "500000000",
			rollId: 1,
			verificationHash: "abc123",
		});

		const result = await DuelService.acceptAndExecuteDuel(
			1,
			456,
			mockGenerateRollFn,
		);

		expect(result.success).toBe(true);
		// Winner should be challenger (123) on tie
		expect(mockTransferBetweenUsers).toHaveBeenCalledWith(
			456, // loser
			123, // winner (challenger wins ties)
			10,
			expect.any(String),
		);
	});

	it("should release both locks after execution", async () => {
		vi.mocked(get).mockReturnValue({
			id: 1,
			challenger_id: 123,
			opponent_id: 456,
			wager_amount: 10,
			loser_consequence: "none",
			status: "pending",
			chat_id: -100,
		});
		mockGetUserBalance.mockResolvedValue(100);
		mockAcquireLock.mockResolvedValue(true);
		mockGenerateRollFn.mockReturnValue({
			rollNumber: "500000000",
			rollId: 1,
			verificationHash: "abc123",
		});

		await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn);

		expect(mockReleaseLock).toHaveBeenCalledWith(123);
		expect(mockReleaseLock).toHaveBeenCalledWith(456);
	});
});

describe("Duel Expiration Cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should mark expired duels", async () => {
		vi.mocked(execute).mockReturnValue({ changes: 3, lastInsertRowid: 0 });

		const count = await DuelService.cleanExpiredDuels();
		expect(count).toBe(3);
		expect(execute).toHaveBeenCalledWith(
			expect.stringContaining("UPDATE duels SET status = 'expired'"),
			expect.any(Array),
		);
	});

	it("should return 0 when no duels expired", async () => {
		vi.mocked(execute).mockReturnValue({ changes: 0, lastInsertRowid: 0 });

		const count = await DuelService.cleanExpiredDuels();
		expect(count).toBe(0);
	});
});

describe("Duel Statistics", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should calculate user duel stats", () => {
		vi.mocked(get)
			.mockReturnValueOnce({ total: 10, wins: 6, losses: 4 })
			.mockReturnValueOnce({ total: 100 }) // wagered
			.mockReturnValueOnce({ total: 80 }) // won
			.mockReturnValueOnce({ total: 40 }); // lost

		const stats = DuelService.getUserDuelStats(123);

		expect(stats.totalDuels).toBe(10);
		expect(stats.wins).toBe(6);
		expect(stats.losses).toBe(4);
		expect(stats.totalWagered).toBe(100);
		expect(stats.totalWon).toBe(80);
		expect(stats.netProfit).toBe(40); // 80 won - 40 lost
	});

	it("should handle user with no duels", () => {
		vi.mocked(get).mockReturnValue(undefined);

		const stats = DuelService.getUserDuelStats(123);

		expect(stats.totalDuels).toBe(0);
		expect(stats.wins).toBe(0);
		expect(stats.losses).toBe(0);
		expect(stats.totalWagered).toBe(0);
		expect(stats.totalWon).toBe(0);
		expect(stats.netProfit).toBe(0);
	});
});

describe("Duel Recent History", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should return recent completed duels", () => {
		vi.mocked(query).mockReturnValue([
			{
				id: 3,
				challenger_id: 123,
				opponent_id: 456,
				wager_amount: 10,
				loser_consequence: "none",
				status: "completed",
				winner_id: 123,
				loser_id: 456,
				chat_id: -100,
				created_at: 1000,
				expires_at: 1300,
				resolved_at: 1100,
			},
			{
				id: 2,
				challenger_id: 789,
				opponent_id: 123,
				wager_amount: 5,
				loser_consequence: "jail",
				status: "completed",
				winner_id: 789,
				loser_id: 123,
				chat_id: -100,
				created_at: 900,
				expires_at: 1200,
				resolved_at: 1000,
			},
		]);

		const duels = DuelService.getRecentDuels(123, 5);

		expect(duels).toHaveLength(2);
		expect(duels[0].id).toBe(3);
		expect(duels[1].id).toBe(2);
	});

	it("should return empty array for user with no duels", () => {
		vi.mocked(query).mockReturnValue([]);

		const duels = DuelService.getRecentDuels(123, 5);

		expect(duels).toHaveLength(0);
	});
});

describe("Winner Determination Logic", () => {
	it("should correctly compare roll numbers", () => {
		const rolls = [
			{
				challenger: "500000000",
				opponent: "300000000",
				expectedWinner: "challenger",
			},
			{
				challenger: "300000000",
				opponent: "500000000",
				expectedWinner: "opponent",
			},
			{
				challenger: "999999999",
				opponent: "000000001",
				expectedWinner: "challenger",
			},
			{
				challenger: "123456789",
				opponent: "123456789",
				expectedWinner: "challenger",
			}, // tie
		];

		for (const roll of rolls) {
			const challengerNum = parseInt(roll.challenger, 10);
			const opponentNum = parseInt(roll.opponent, 10);
			const winner =
				challengerNum >= opponentNum ? "challenger" : "opponent";
			expect(winner).toBe(roll.expectedWinner);
		}
	});

	it("should handle edge case of all zeros vs all nines", () => {
		const challenger = "000000000";
		const opponent = "999999999";

		const challengerNum = parseInt(challenger, 10);
		const opponentNum = parseInt(opponent, 10);

		expect(challengerNum).toBe(0);
		expect(opponentNum).toBe(999999999);
		expect(opponentNum > challengerNum).toBe(true);
	});

	it("should handle leading zeros in roll comparison", () => {
		const challenger = "000000100";
		const opponent = "000000099";

		const challengerNum = parseInt(challenger, 10);
		const opponentNum = parseInt(opponent, 10);

		expect(challengerNum).toBe(100);
		expect(opponentNum).toBe(99);
		expect(challengerNum > opponentNum).toBe(true);
	});
});
