import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { DuelService } from "../../src/services/duelService";
import { LedgerService } from "../../src/services/ledgerService";
import { getDuelEscrowId } from "../../src/services/unifiedWalletService";

const INTEGRATION_DB_PATH = join(__dirname, "../test-data/integration-duels.db");
let db: Database.Database;

const dbHelpers = {
	query: <T>(sql: string, params: unknown[] = []): T[] =>
		db.prepare(sql).all(params) as T[],
	execute: (sql: string, params: unknown[] = []): Database.RunResult =>
		db.prepare(sql).run(params),
	get: <T>(sql: string, params: unknown[] = []): T | undefined =>
		db.prepare(sql).get(params) as T | undefined,
};

function initIntegrationDb(): void {
	const testDataDir = join(__dirname, "../test-data");
	if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
	if (existsSync(INTEGRATION_DB_PATH)) unlinkSync(INTEGRATION_DB_PATH);

	db = new Database(INTEGRATION_DB_PATH);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			username TEXT,
			role TEXT DEFAULT 'pleb',
			whitelist INTEGER DEFAULT 0,
			blacklist INTEGER DEFAULT 0,
			warning_count INTEGER DEFAULT 0,
			muted_until INTEGER,
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			updated_at INTEGER DEFAULT (strftime('%s', 'now'))
		);
		CREATE TABLE user_balances (
			user_id INTEGER PRIMARY KEY,
			balance REAL DEFAULT 0,
			last_updated INTEGER DEFAULT (strftime('%s', 'now')),
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE TABLE transactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			transaction_type TEXT NOT NULL,
			from_user_id INTEGER,
			to_user_id INTEGER,
			amount REAL NOT NULL,
			balance_after REAL,
			description TEXT,
			tx_hash TEXT,
			external_address TEXT,
			status TEXT DEFAULT 'completed',
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			metadata TEXT,
			FOREIGN KEY (from_user_id) REFERENCES users(id),
			FOREIGN KEY (to_user_id) REFERENCES users(id)
		);
		CREATE TABLE system_wallets (
			id TEXT PRIMARY KEY,
			address TEXT NOT NULL UNIQUE,
			description TEXT,
			created_at INTEGER DEFAULT (strftime('%s', 'now'))
		);
		CREATE TABLE transaction_locks (
			user_id INTEGER PRIMARY KEY,
			lock_type TEXT NOT NULL,
			amount REAL DEFAULT 0,
			target_address TEXT,
			tx_hash TEXT,
			status TEXT DEFAULT 'pending',
			metadata TEXT,
			locked_at INTEGER DEFAULT (strftime('%s', 'now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE TABLE duels (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			challenger_id INTEGER NOT NULL,
			opponent_id INTEGER NOT NULL,
			wager_amount REAL NOT NULL,
			loser_consequence TEXT NOT NULL DEFAULT 'none',
			consequence_duration INTEGER,
			consequence_action TEXT,
			status TEXT DEFAULT 'pending',
			winner_id INTEGER,
			loser_id INTEGER,
			roll_challenger TEXT,
			roll_opponent TEXT,
			roll_id_challenger INTEGER,
			roll_id_opponent INTEGER,
			chat_id INTEGER NOT NULL,
			message_id INTEGER,
			created_at INTEGER DEFAULT (strftime('%s', 'now')),
			expires_at INTEGER NOT NULL,
			resolved_at INTEGER,
			FOREIGN KEY (challenger_id) REFERENCES users(id),
			FOREIGN KEY (opponent_id) REFERENCES users(id),
			FOREIGN KEY (winner_id) REFERENCES users(id),
			FOREIGN KEY (loser_id) REFERENCES users(id)
		);
	`);
}

function cleanTestData(): void {
	if (!db) return;
	db.exec(`
		DELETE FROM transaction_locks;
		DELETE FROM transactions;
		DELETE FROM user_balances;
		DELETE FROM duels;
		DELETE FROM system_wallets;
		DELETE FROM users;
	`);
}

function createTestUsers(): void {
	for (const user of [
		{ id: 1001, username: "alice" },
		{ id: 1002, username: "bob" },
	]) {
		dbHelpers.execute("INSERT INTO users (id, username, role) VALUES (?, ?, 'pleb')", [
			user.id,
			user.username,
		]);
	}
}

vi.mock("../../src/database", () => ({
	query: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.query(sql, params)),
	execute: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.execute(sql, params)),
	get: vi.fn((sql: string, params: unknown[] = []) => dbHelpers.get(sql, params)),
	initDb: vi.fn(),
}));

vi.mock("../../src/config", () => ({
	config: {
		databasePath: ":memory:",
		botToken: "test-token",
		groupChatId: "-100123456789",
		botTreasuryAddress: "juno1testtreasuryaddress",
		userFundsAddress: "juno1testuserfundsaddress",
	},
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	StructuredLogger: {
		logError: vi.fn(),
		logUserAction: vi.fn(),
		logTransaction: vi.fn(),
		logWalletAction: vi.fn(),
		logSecurityEvent: vi.fn(),
	},
}));

describe("DuelService integration", () => {
	beforeAll(() => {
		initIntegrationDb();
		LedgerService.initialize();
	});

	beforeEach(async () => {
		cleanTestData();
		createTestUsers();
		await LedgerService.processDeposit(1001, 100, "TX-A", "juno1fund");
		await LedgerService.processDeposit(1002, 100, "TX-B", "juno1fund");
	});

	afterAll(() => {
		if (db) db.close();
		if (existsSync(INTEGRATION_DB_PATH)) unlinkSync(INTEGRATION_DB_PATH);
	});

	it("reserves the challenger's wager in escrow and refunds it on cancel", async () => {
		const createResult = await DuelService.createDuel(
			1001,
			1002,
			10,
			123,
			"none",
		);

		expect(createResult.success).toBe(true);
		expect(createResult.duel).toBeDefined();

		const duelId = createResult.duel?.id || 0;
		const escrowId = getDuelEscrowId(duelId);

		expect(await LedgerService.getUserBalance(1001)).toBe(90);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(10);

		const cancelResult = await DuelService.cancelDuel(duelId, 1001);

		expect(cancelResult.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(0);
		expect(DuelService.getDuel(duelId)?.status).toBe("cancelled");
	});

	it("refunds the challenger from escrow when the opponent rejects", async () => {
		const createResult = await DuelService.createDuel(
			1001,
			1002,
			12,
			123,
			"none",
		);

		expect(createResult.success).toBe(true);
		expect(createResult.duel).toBeDefined();

		const duelId = createResult.duel?.id || 0;
		const escrowId = getDuelEscrowId(duelId);

		expect(await LedgerService.getUserBalance(1001)).toBe(88);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(12);

		const rejectResult = await DuelService.rejectDuel(duelId, 1002);

		expect(rejectResult.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
		expect(await LedgerService.getUserBalance(1002)).toBe(100);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(0);
		expect(DuelService.getDuel(duelId)?.status).toBe("rejected");
	});

	it("resolves legacy pending duel rejection even when no escrow was funded yet", async () => {
		const now = Math.floor(Date.now() / 1000);
		const insertResult = dbHelpers.execute(
			`INSERT INTO duels (
				challenger_id, opponent_id, wager_amount, loser_consequence,
				consequence_duration, chat_id, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[1001, 1002, 12_000_000, "none", 0, 123, now + 300],
		);
		const duelId = insertResult.lastInsertRowid as number;
		const escrowId = getDuelEscrowId(duelId);

		const rejectResult = await DuelService.rejectDuel(duelId, 1002);

		expect(rejectResult.success).toBe(true);
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
		expect(await LedgerService.getUserBalance(1002)).toBe(100);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(0);
		expect(DuelService.getDuel(duelId)?.status).toBe("rejected");
	});

	it("escrows the opponent wager on accept and pays the winner from the duel escrow", async () => {
		const createResult = await DuelService.createDuel(
			1001,
			1002,
			10,
			123,
			"none",
		);
		const duel = createResult.duel;

		expect(duel).toBeDefined();

		const acceptResult = await DuelService.acceptAndExecuteDuel(
			duel?.id || 0,
			1002,
			(_, rollUserId) =>
				rollUserId === 1001
					? {
							rollNumber: "999999999",
							rollId: 1,
							verificationHash: "winner",
						}
					: {
							rollNumber: "111111111",
							rollId: 2,
							verificationHash: "loser",
						},
		);

		expect(acceptResult.success).toBe(true);
		expect(DuelService.getDuel(duel?.id || 0)?.status).toBe("completed");
		expect(await LedgerService.getUserBalance(1001)).toBe(110);
		expect(await LedgerService.getUserBalance(1002)).toBe(90);
		expect(await LedgerService.getUserBalance(getDuelEscrowId(duel?.id || 0))).toBe(
			0,
		);
	});

	it("backfills challenger escrow before accepting a legacy pending duel", async () => {
		const now = Math.floor(Date.now() / 1000);
		const insertResult = dbHelpers.execute(
			`INSERT INTO duels (
				challenger_id, opponent_id, wager_amount, loser_consequence,
				consequence_duration, chat_id, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[1001, 1002, 8_000_000, "none", 0, 123, now + 300],
		);
		const duelId = insertResult.lastInsertRowid as number;
		const escrowId = getDuelEscrowId(duelId);

		const acceptResult = await DuelService.acceptAndExecuteDuel(
			duelId,
			1002,
			(_, rollUserId) =>
				rollUserId === 1001
					? {
							rollNumber: "999999999",
							rollId: 1,
							verificationHash: "winner",
						}
					: {
							rollNumber: "111111111",
							rollId: 2,
							verificationHash: "loser",
						},
		);

		expect(acceptResult.success).toBe(true);
		expect(DuelService.getDuel(duelId)?.status).toBe("completed");
		expect(await LedgerService.getUserBalance(1001)).toBe(108);
		expect(await LedgerService.getUserBalance(1002)).toBe(92);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(0);
	});

	it("keeps the duel settled when a consequence fails after payout", async () => {
		const createResult = await DuelService.createDuel(
			1001,
			1002,
			6,
			123,
			"no_media",
		);
		const duelId = createResult.duel?.id || 0;
		const escrowId = getDuelEscrowId(duelId);
		const consequenceSpy = vi
			.spyOn(DuelService as never, "applyConsequence" as never)
			.mockRejectedValueOnce(new Error("Simulated consequence failure"));

		const acceptResult = await DuelService.acceptAndExecuteDuel(
			duelId,
			1002,
			(_, rollUserId) =>
				rollUserId === 1001
					? {
							rollNumber: "999999999",
							rollId: 1,
							verificationHash: "winner",
						}
					: {
							rollNumber: "111111111",
							rollId: 2,
							verificationHash: "loser",
						},
		);

		consequenceSpy.mockRestore();

		expect(acceptResult.success).toBe(true);
		expect(DuelService.getDuel(duelId)?.status).toBe("completed");
		expect(await LedgerService.getUserBalance(1001)).toBe(106);
		expect(await LedgerService.getUserBalance(1002)).toBe(94);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(0);
	});

	it("rolls back both escrowed wagers if payout fails after the opponent accepts", async () => {
		const createResult = await DuelService.createDuel(
			1001,
			1002,
			9,
			123,
			"none",
		);
		const duelId = createResult.duel?.id || 0;
		const escrowId = getDuelEscrowId(duelId);

		const transferBetweenUsers = LedgerService.transferBetweenUsers.bind(
			LedgerService,
		);
		let transferCallCount = 0;
		const transferSpy = vi
			.spyOn(LedgerService, "transferBetweenUsers")
			.mockImplementation(async (...args) => {
				transferCallCount += 1;
				if (transferCallCount === 2) {
					return { success: false, error: "Simulated payout failure" };
				}
				return transferBetweenUsers(...args);
			});

		const acceptResult = await DuelService.acceptAndExecuteDuel(
			duelId,
			1002,
			(_, rollUserId) =>
				rollUserId === 1001
					? {
							rollNumber: "999999999",
							rollId: 1,
							verificationHash: "winner",
						}
					: {
							rollNumber: "111111111",
							rollId: 2,
							verificationHash: "loser",
						},
		);

		transferSpy.mockRestore();

		expect(acceptResult.success).toBe(false);
		expect(acceptResult.error).toBe("Duel execution failed");
		expect(DuelService.getDuel(duelId)?.status).toBe("cancelled");
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
		expect(await LedgerService.getUserBalance(1002)).toBe(100);
		expect(await LedgerService.getUserBalance(escrowId)).toBe(0);
	});

	it("refunds expired duel escrows during cleanup", async () => {
		const createResult = await DuelService.createDuel(
			1001,
			1002,
			7,
			123,
			"none",
		);
		const duelId = createResult.duel?.id || 0;

		dbHelpers.execute("UPDATE duels SET expires_at = ? WHERE id = ?", [
			Math.floor(Date.now() / 1000) - 1,
			duelId,
		]);

		const cleanedCount = await DuelService.cleanExpiredDuels();

		expect(cleanedCount).toBe(1);
		expect(DuelService.getDuel(duelId)?.status).toBe("expired");
		expect(await LedgerService.getUserBalance(1001)).toBe(100);
		expect(await LedgerService.getUserBalance(getDuelEscrowId(duelId))).toBe(0);
	});
});
