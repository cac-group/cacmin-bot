import { vi, describe, it, expect, beforeEach } from "vitest";
/**
 * Tests for the duel game system
 */

vi.mock("../../src/database", () => ({ query: vi.fn(), execute: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })), get: vi.fn() }));
vi.mock("../../src/config", () => ({ config: { databasePath: ":memory:", botToken: "test-token", groupChatId: "-100123456789", botTreasuryAddress: "juno1testtreasuryaddress", adminChatId: "123456789", junoRpcUrl: "https://rpc.juno.example.com" } }));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }, StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logWalletAction: vi.fn(), logSecurityEvent: vi.fn() } }));

const mockTransferBetweenUsers = vi.fn();
const mockGetUserBalance = vi.fn();
vi.mock("../../src/services/ledgerService", () => ({
	LedgerService: { getUserBalance: (...args: unknown[]) => mockGetUserBalance(...args), transferBetweenUsers: (...args: unknown[]) => mockTransferBetweenUsers(...args), ensureUserBalance: vi.fn(() => Promise.resolve()) },
	TransactionType: { DEPOSIT: "deposit", WITHDRAWAL: "withdrawal", TRANSFER: "transfer", FINE: "fine", BAIL: "bail", GIVEAWAY: "giveaway", REFUND: "refund", GAMBLING: "gambling" }
}));

const mockAcquireLock = vi.fn();
const mockReleaseLock = vi.fn();
vi.mock("../../src/services/transactionLock", () => ({ TransactionLockService: { acquireLock: (...args: unknown[]) => mockAcquireLock(...args), releaseLock: (...args: unknown[]) => mockReleaseLock(...args) } }));
vi.mock("../../src/services/jailService", () => ({ JailService: { logJailEvent: vi.fn(), initialize: vi.fn() } }));
vi.mock("../../src/services/userService", () => ({ createUser: vi.fn(), userExists: vi.fn(() => false), ensureUserExists: vi.fn(), addUserRestriction: vi.fn() }));
vi.mock("../../src/utils/precision", () => ({ AmountPrecision: { format: (n: number) => n.toFixed(6), parseUserInput: (s: string) => parseFloat(s), validateAmount: (n: number) => n, isGreaterOrEqual: (a: number, b: number) => a >= b } }));

import { get, execute, query } from "../../src/database";
import { DuelService, DUEL_TIMEOUT_SECONDS, MIN_WAGER, MAX_WAGER, DEFAULT_CONSEQUENCE_DURATIONS } from "../../src/services/duelService";

describe("Duel Game", () => {
	describe("Configuration", () => {
		it("has correct config values", () => {
			expect(DUEL_TIMEOUT_SECONDS).toBe(300);
			expect(MIN_WAGER).toBe(0.1);
			expect(MAX_WAGER).toBe(50);
			expect(MIN_WAGER).toBeLessThan(MAX_WAGER);
			expect(DEFAULT_CONSEQUENCE_DURATIONS.none).toBe(0);
			expect(DEFAULT_CONSEQUENCE_DURATIONS.jail).toBe(60);
		});
	});

	describe("Pending Checks", () => {
		beforeEach(() => vi.clearAllMocks());

		it.each([
			["outgoing", "challenger_id", "hasOutgoingDuel"],
			["incoming", "opponent_id", "hasIncomingDuel"],
		])("detects %s duel correctly", (_, field, method) => {
			vi.mocked(get).mockReturnValue({ count: 0 });
			expect((DuelService as any)[method](123)).toBe(false);
			vi.mocked(get).mockReturnValue({ count: 1 });
			expect((DuelService as any)[method](123)).toBe(true);
		});
	});

	describe("Creation", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			mockGetUserBalance.mockResolvedValue(100);
			vi.mocked(get).mockReturnValue({ count: 0 });
			vi.mocked(execute).mockReturnValue({ lastInsertRowid: 1, changes: 1 });
		});

		it("validates creation parameters", async () => {
			// Self-duel
			expect((await DuelService.createDuel(123, 123, 10, -100)).error).toContain("cannot duel yourself");
			// Below minimum
			expect((await DuelService.createDuel(123, 456, 0.01, -100)).error).toContain("Minimum wager");
			// Above maximum
			expect((await DuelService.createDuel(123, 456, 100, -100)).error).toContain("Maximum wager");
		});

		it("checks for existing duels", async () => {
			vi.mocked(get).mockImplementation((sql: string) => ({ count: sql.includes("challenger_id") ? 1 : 0 }));
			expect((await DuelService.createDuel(123, 456, 10, -100)).error).toContain("already have a pending duel");

			vi.mocked(get).mockImplementation((sql: string) => ({ count: sql.includes("opponent_id") ? 1 : 0 }));
			expect((await DuelService.createDuel(123, 456, 10, -100)).error).toContain("already has a pending duel");
		});

		it("checks balance and creates successfully", async () => {
			vi.mocked(get).mockReturnValue({ count: 0 });
			mockGetUserBalance.mockResolvedValue(5);
			expect((await DuelService.createDuel(123, 456, 10, -100)).error).toContain("Insufficient balance");

			mockGetUserBalance.mockResolvedValue(100);
			vi.mocked(get).mockImplementation((sql: string) => sql.includes("COUNT(*)") ? { count: 0 } : { id: 1, challenger_id: 123, opponent_id: 456, wager_amount: 10, loser_consequence: "none", status: "pending", chat_id: -100, created_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + DUEL_TIMEOUT_SECONDS });
			const result = await DuelService.createDuel(123, 456, 10, -100);
			expect(result.success).toBe(true);
			expect(result.duel).toBeDefined();
		});
	});

	describe("Cancel/Reject", () => {
		beforeEach(() => vi.clearAllMocks());

		it("only allows challenger to cancel", () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, status: "pending" });
			expect(DuelService.cancelDuel(1, 456).error).toContain("Only the challenger");
			vi.mocked(execute).mockReturnValue({ changes: 1, lastInsertRowid: 0 });
			expect(DuelService.cancelDuel(1, 123).success).toBe(true);
		});

		it("only allows opponent to reject", () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, status: "pending" });
			expect(DuelService.rejectDuel(1, 123).error).toContain("Only the challenged user");
			vi.mocked(execute).mockReturnValue({ changes: 1, lastInsertRowid: 0 });
			expect(DuelService.rejectDuel(1, 456).success).toBe(true);
		});

		it("prevents action on non-pending duels", () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, status: "completed" });
			expect(DuelService.cancelDuel(1, 123).error).toContain("no longer pending");
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, status: "cancelled" });
			expect(DuelService.rejectDuel(1, 456).error).toContain("no longer pending");
		});

		it("handles non-existent duel", () => {
			vi.mocked(get).mockReturnValue(undefined);
			expect(DuelService.cancelDuel(999, 123).error).toContain("not found");
		});
	});

	describe("Execution", () => {
		const mockGenerateRollFn = vi.fn();

		beforeEach(() => {
			vi.clearAllMocks();
			mockAcquireLock.mockResolvedValue(true);
			mockReleaseLock.mockResolvedValue(undefined);
			mockGetUserBalance.mockResolvedValue(100);
			mockTransferBetweenUsers.mockResolvedValue({ success: true, fromBalance: 90, toBalance: 110 });
		});

		it("validates acceptance requirements", async () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, wager_amount: 10, status: "pending" });

			// Only opponent can accept
			expect((await DuelService.acceptAndExecuteDuel(1, 123, mockGenerateRollFn)).error).toContain("Only the challenged user");

			// Insufficient balance
			mockGetUserBalance.mockResolvedValue(5);
			expect((await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn)).error).toContain("Insufficient balance");

			// Challenger lost funds
			mockGetUserBalance.mockResolvedValueOnce(100).mockResolvedValueOnce(5);
			expect((await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn)).error).toContain("Challenger no longer has sufficient");
		});

		it("handles lock failures", async () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, wager_amount: 10, status: "pending" });
			mockGetUserBalance.mockResolvedValue(100);

			mockAcquireLock.mockResolvedValueOnce(false);
			expect((await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn)).error).toContain("Challenger has a pending transaction");

			mockAcquireLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
			expect((await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn)).error).toContain("You have a pending transaction");
		});

		it("determines winner correctly and releases locks", async () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, wager_amount: 10, loser_consequence: "none", status: "pending", chat_id: -100 });
			mockGetUserBalance.mockResolvedValue(100);
			mockAcquireLock.mockResolvedValue(true);

			// Challenger wins
			mockGenerateRollFn.mockReturnValueOnce({ rollNumber: "500000000", rollId: 1, verificationHash: "abc123" })
				.mockReturnValueOnce({ rollNumber: "300000000", rollId: 2, verificationHash: "def456" });

			const result = await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn);
			expect(result.success).toBe(true);
			expect(mockTransferBetweenUsers).toHaveBeenCalledWith(456, 123, 10, expect.any(String));
			expect(mockReleaseLock).toHaveBeenCalledWith(123);
			expect(mockReleaseLock).toHaveBeenCalledWith(456);
		});

		it("gives ties to challenger", async () => {
			vi.mocked(get).mockReturnValue({ id: 1, challenger_id: 123, opponent_id: 456, wager_amount: 10, loser_consequence: "none", status: "pending", chat_id: -100 });
			mockGetUserBalance.mockResolvedValue(100);
			mockAcquireLock.mockResolvedValue(true);
			mockGenerateRollFn.mockReturnValue({ rollNumber: "500000000", rollId: 1, verificationHash: "abc123" });

			await DuelService.acceptAndExecuteDuel(1, 456, mockGenerateRollFn);
			expect(mockTransferBetweenUsers).toHaveBeenCalledWith(456, 123, 10, expect.any(String));
		});
	});

	describe("Expiration", () => {
		it("cleans expired duels", async () => {
			vi.mocked(execute).mockReturnValue({ changes: 3, lastInsertRowid: 0 });
			expect(await DuelService.cleanExpiredDuels()).toBe(3);

			vi.mocked(execute).mockReturnValue({ changes: 0, lastInsertRowid: 0 });
			expect(await DuelService.cleanExpiredDuels()).toBe(0);
		});
	});

	describe("Statistics", () => {
		beforeEach(() => vi.clearAllMocks());

		it("calculates user stats correctly", () => {
			vi.mocked(get).mockReturnValueOnce({ total: 10, wins: 6, losses: 4 })
				.mockReturnValueOnce({ total: 100 }).mockReturnValueOnce({ total: 80 }).mockReturnValueOnce({ total: 40 });

			const stats = DuelService.getUserDuelStats(123);
			expect(stats.totalDuels).toBe(10);
			expect(stats.wins).toBe(6);
			expect(stats.losses).toBe(4);
			expect(stats.totalWagered).toBe(100);
			expect(stats.totalWon).toBe(80);
			expect(stats.netProfit).toBe(40);
		});

		it("handles user with no duels", () => {
			vi.mocked(get).mockReturnValue(undefined);
			const stats = DuelService.getUserDuelStats(123);
			expect(stats.totalDuels).toBe(0);
			expect(stats.wins).toBe(0);
			expect(stats.netProfit).toBe(0);
		});
	});

	describe("History", () => {
		it("returns recent completed duels", () => {
			vi.mocked(query).mockReturnValue([
				{ id: 3, challenger_id: 123, opponent_id: 456, wager_amount: 10, loser_consequence: "none", status: "completed", winner_id: 123, loser_id: 456, chat_id: -100, created_at: 1000, expires_at: 1300, resolved_at: 1100 },
				{ id: 2, challenger_id: 789, opponent_id: 123, wager_amount: 5, loser_consequence: "jail", status: "completed", winner_id: 789, loser_id: 123, chat_id: -100, created_at: 900, expires_at: 1200, resolved_at: 1000 }
			]);

			const duels = DuelService.getRecentDuels(123, 5);
			expect(duels).toHaveLength(2);
			expect(duels[0].id).toBe(3);
		});

		it("returns empty array for user with no duels", () => {
			vi.mocked(query).mockReturnValue([]);
			expect(DuelService.getRecentDuels(123, 5)).toHaveLength(0);
		});
	});
});
