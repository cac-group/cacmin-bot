import { vi, Mock } from 'vitest';
/**
 * Test database utilities
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';

let testDb: Database.Database | null = null;
let testDbPath: string | null = null;

/**
 * Initialize test database with schema
 * Uses unique path per invocation to avoid conflicts
 */
export function initTestDatabase(): Database.Database {
  // Create test-data directory if it doesn't exist
  const testDataDir = join(__dirname, '../test-data');
  if (!existsSync(testDataDir)) {
    mkdirSync(testDataDir, { recursive: true });
  }

  // Generate unique path using process id and timestamp
  testDbPath = join(testDataDir, `test-${process.pid}-${Date.now()}.db`);

  // Remove existing test database if any
  if (existsSync(testDbPath)) {
    unlinkSync(testDbPath);
  }

  // Create new database
  testDb = new Database(testDbPath);

  // Create schema
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      rule_id INTEGER,
      restriction TEXT,
      message TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      bail_amount REAL DEFAULT 0,
      paid INTEGER DEFAULT 0,
      payment_tx TEXT,
      paid_by_user_id INTEGER,
      paid_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (paid_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_restrictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      restriction TEXT NOT NULL,
      restricted_action TEXT,
      metadata TEXT,
      restricted_until INTEGER,
      severity TEXT DEFAULT 'delete',
      violation_threshold INTEGER DEFAULT 5,
      auto_jail_duration INTEGER DEFAULT 2880,
      auto_jail_fine REAL DEFAULT 10.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS global_restrictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restriction TEXT NOT NULL UNIQUE,
      restricted_action TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      user_id INTEGER PRIMARY KEY,
      reason TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id INTEGER PRIMARY KEY,
      balance REAL DEFAULT 0,
      last_updated INTEGER DEFAULT (strftime('%s', 'now')),
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
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

    CREATE TABLE IF NOT EXISTS system_wallets (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS processed_deposits (
      tx_hash TEXT PRIMARY KEY,
      user_id INTEGER,
      amount REAL,
      from_address TEXT,
      memo TEXT,
      height INTEGER,
      processed INTEGER DEFAULT 0,
      error TEXT,
      processed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_locks (
      user_id INTEGER PRIMARY KEY,
      lock_type TEXT NOT NULL,
      locked_at INTEGER DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_violations_user_id ON violations(user_id);
    CREATE INDEX IF NOT EXISTS idx_restrictions_user_id ON user_restrictions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_balances_balance ON user_balances(balance);
    CREATE INDEX IF NOT EXISTS idx_transactions_from_user ON transactions(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_to_user ON transactions(to_user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions(tx_hash);
    CREATE INDEX IF NOT EXISTS idx_user_locks_expires ON user_locks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_processed_deposits_time ON processed_deposits(processed_at);

    CREATE TABLE IF NOT EXISTS jail_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      admin_id INTEGER,
      duration_minutes INTEGER,
      bail_amount REAL DEFAULT 0,
      paid_by_user_id INTEGER,
      payment_tx TEXT,
      metadata TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (admin_id) REFERENCES users(id),
      FOREIGN KEY (paid_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      processed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transaction_locks (
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

    CREATE INDEX IF NOT EXISTS idx_transaction_locks_status ON transaction_locks(status);
    CREATE INDEX IF NOT EXISTS idx_transaction_locks_locked_at ON transaction_locks(locked_at);

    CREATE TABLE IF NOT EXISTS jail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      jailed_by INTEGER NOT NULL,
      reason TEXT,
      bail_amount REAL DEFAULT 0,
      release_time INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (jailed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price_usd REAL NOT NULL,
      timestamp INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS fine_config (
      fine_type TEXT PRIMARY KEY,
      amount_usd REAL NOT NULL,
      description TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_by INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp);

    CREATE TABLE IF NOT EXISTS shared_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      balance REAL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS shared_account_members (
      account_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member',
      added_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (account_id, user_id),
      FOREIGN KEY (account_id) REFERENCES shared_accounts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  return testDb;
}

/**
 * Get test database instance
 */
export function getTestDatabase(): Database.Database {
  if (!testDb) {
    throw new Error('Test database not initialized. Call initTestDatabase() first.');
  }
  return testDb;
}

/**
 * Clean test database (truncate all tables)
 */
export function cleanTestDatabase(): void {
  if (!testDb) return;

  testDb.exec(`
    DELETE FROM transaction_locks;
    DELETE FROM user_locks;
    DELETE FROM processed_deposits;
    DELETE FROM transactions;
    DELETE FROM user_balances;
    DELETE FROM system_wallets;
    DELETE FROM jail_events;
    DELETE FROM jail;
    DELETE FROM violations;
    DELETE FROM user_restrictions;
    DELETE FROM global_restrictions;
    DELETE FROM blacklist;
    DELETE FROM system_state;
    DELETE FROM users;
  `);
}

/**
 * Close test database
 */
export function closeTestDatabase(): void {
  if (testDb) {
    testDb.close();
    testDb = null;
  }

  // Clean up test database file
  if (testDbPath && existsSync(testDbPath)) {
    try {
      unlinkSync(testDbPath);
    } catch {
      // Ignore cleanup errors
    }
    testDbPath = null;
  }
}

/**
 * Create test user
 */
export function createTestUser(userId: number, username: string, role: string = 'pleb'): void {
  const db = getTestDatabase();
  db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(userId, username, role);
}

/**
 * Create multiple test users
 */
export function createTestUsers(): void {
  createTestUser(111111111, 'owner', 'owner');
  createTestUser(222222222, 'admin', 'admin');
  createTestUser(333333333, 'elevated', 'elevated');
  createTestUser(444444444, 'pleb', 'pleb');
  createTestUser(555555555, 'testuser', 'pleb');
}

/**
 * Add balance for test user
 */
export function addTestBalance(userId: number, amount: number): void {
  const db = getTestDatabase();

  // Get current balance
  const result = db.prepare(`
    SELECT balance FROM user_balances WHERE user_id = ?
  `).get(userId) as { balance: number } | undefined;

  const currentBalance = result?.balance || 0;
  const newBalance = currentBalance + amount;

  // Upsert balance
  db.prepare(`
    INSERT INTO user_balances (user_id, balance)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      balance = ?,
      last_updated = strftime('%s', 'now')
  `).run(userId, newBalance, newBalance);

  // Add transaction entry
  db.prepare(`
    INSERT INTO transactions (transaction_type, to_user_id, amount, balance_after, description, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('giveaway', userId, amount, newBalance, 'Test balance addition', 'completed');
}

/**
 * Get user balance
 */
export function getTestBalance(userId: number): number {
  const db = getTestDatabase();
  const result = db.prepare(`
    SELECT balance FROM user_balances WHERE user_id = ?
  `).get(userId) as { balance: number } | undefined;

  return result?.balance || 0;
}

/**
 * Get transaction count for user
 */
export function getTransactionCount(userId: number): number {
  const db = getTestDatabase();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM transactions
    WHERE from_user_id = ? OR to_user_id = ?
  `).get(userId, userId) as { count: number };

  return result.count;
}

/**
 * Create test system wallet
 */
export function createTestSystemWallet(id: string, address: string): void {
  const db = getTestDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO system_wallets (id, address, description)
    VALUES (?, ?, ?)
  `).run(id, address, `Test ${id} wallet`);
}

/**
 * Create test violation
 */
export function createTestViolation(
  userId: number,
  restriction: string,
  bailAmount: number = 100,
  paid: number = 0,
  message?: string
): number {
  const db = getTestDatabase();
  const result = db.prepare(`
    INSERT INTO violations (user_id, restriction, message, bail_amount, paid)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, restriction, message || `Test violation: ${restriction}`, bailAmount, paid);

  return Number(result.lastInsertRowid);
}

/**
 * Create test restriction
 */
export function createTestRestriction(
  userId: number,
  restriction: string,
  restrictedAction?: string,
  restrictedUntil?: number
): number {
  const db = getTestDatabase();
  const result = db.prepare(`
    INSERT INTO user_restrictions (user_id, restriction, restricted_action, restricted_until)
    VALUES (?, ?, ?, ?)
  `).run(userId, restriction, restrictedAction || null, restrictedUntil || null);

  return Number(result.lastInsertRowid);
}

/**
 * Add user to blacklist
 */
export function addTestBlacklist(userId: number, reason: string = 'Test blacklist'): void {
  const db = getTestDatabase();
  db.prepare('INSERT INTO blacklist (user_id, reason) VALUES (?, ?)').run(userId, reason);
}

/**
 * Jail test user
 */
export function jailTestUser(
  userId: number,
  jailedBy: number,
  bailAmount: number = 100,
  releaseTime?: number
): void {
  const db = getTestDatabase();

  // Set muted_until in users table (this is the actual jail state)
  const mutedUntil = releaseTime || Math.floor(Date.now() / 1000) + 3600;
  db.prepare(`
    UPDATE users SET muted_until = ? WHERE id = ?
  `).run(mutedUntil, userId);

  // Also insert into jail table for historical records
  db.prepare(`
    INSERT INTO jail (user_id, jailed_by, reason, bail_amount, release_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, jailedBy, 'Test jail', bailAmount, mutedUntil);
}
