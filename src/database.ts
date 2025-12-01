/**
 * Database module for the CAC Admin Bot.
 * Provides SQLite database connection, typed query functions, and schema initialization.
 * Uses better-sqlite3 for synchronous database operations with high performance.
 *
 * @module database
 */

import Database from "better-sqlite3";
import { config } from "./config";
import { logger } from "./utils/logger";

/**
 * SQLite database instance.
 * Configured with foreign key enforcement enabled.
 */
const db = new Database(config.databasePath);

// Enable foreign keys for referential integrity
db.exec("PRAGMA foreign_keys = ON");

/**
 * Executes a SELECT query and returns all matching rows as typed objects.
 *
 * @template T - The type of objects expected in the result set
 * @param sql - The SQL query string (supports parameterized queries)
 * @param params - Array of parameters to bind to the query (prevents SQL injection)
 * @returns Array of typed result objects
 * @throws {Error} If the query fails to execute
 *
 * @example
 * ```typescript
 * const users = query<User>('SELECT * FROM users WHERE role = ?', ['admin']);
 * const singleUser = query<User>('SELECT * FROM users WHERE id = ?', [123])[0];
 * ```
 */
export const query = <T>(sql: string, params: unknown[] = []): T[] => {
	try {
		const stmt = db.prepare(sql);
		return stmt.all(params) as T[];
	} catch (error) {
		logger.error(`Database query failed: ${sql}`, error);
		throw error;
	}
};

/**
 * Executes an INSERT, UPDATE, or DELETE statement.
 *
 * @param sql - The SQL statement string (supports parameterized statements)
 * @param params - Array of parameters to bind to the statement (prevents SQL injection)
 * @returns RunResult object containing changes count and lastInsertRowid
 * @throws {Error} If the statement fails to execute
 *
 * @example
 * ```typescript
 * const result = execute('INSERT INTO users (id, username) VALUES (?, ?)', [123, 'alice']);
 * console.log(`Inserted row ID: ${result.lastInsertRowid}`);
 *
 * const updateResult = execute('UPDATE users SET role = ? WHERE id = ?', ['admin', 123]);
 * console.log(`Updated ${updateResult.changes} rows`);
 * ```
 */
export const execute = (
	sql: string,
	params: unknown[] = [],
): Database.RunResult => {
	try {
		const stmt = db.prepare(sql);
		return stmt.run(params);
	} catch (error) {
		logger.error(`Database execution failed: ${sql}`, error);
		throw error;
	}
};

/**
 * Executes a SELECT query and returns a single row as a typed object.
 * Returns undefined if no rows match.
 *
 * @template T - The type of object expected in the result
 * @param sql - The SQL query string (supports parameterized queries)
 * @param params - Array of parameters to bind to the query (prevents SQL injection)
 * @returns Single typed result object or undefined if no match
 * @throws {Error} If the query fails to execute
 *
 * @example
 * ```typescript
 * const user = get<User>('SELECT * FROM users WHERE id = ?', [123]);
 * if (user) {
 *   console.log(`Found user: ${user.username}`);
 * }
 * ```
 */
export const get = <T>(sql: string, params: unknown[] = []): T | undefined => {
	try {
		const stmt = db.prepare(sql);
		return stmt.get(params) as T | undefined;
	} catch (error) {
		logger.error(`Database get failed: ${sql}`, error);
		throw error;
	}
};

/**
 * Initializes the database schema by creating all required tables and indexes.
 *
 * Creates the following tables:
 * - users: User profiles with roles and restriction flags
 * - user_balances: Internal ledger for user token balances
 * - transactions: Complete audit trail of all financial transactions
 * - system_wallets: Configuration for system wallet addresses
 * - rules: Violation rule definitions
 * - violations: Tracked user violations with bail amounts
 * - jail_events: Log of jail/unjail events
 * - user_restrictions: Per-user message restrictions (stickers, URLs, etc.)
 * - global_restrictions: Restrictions applied to all users
 * - processed_deposits: Tracking for blockchain deposit transactions
 * - transaction_locks: Prevents double-spending during concurrent operations
 *
 * Also creates performance indexes on commonly queried columns.
 * Safe to call multiple times - uses IF NOT EXISTS clauses.
 *
 * @throws {Error} If table creation fails
 *
 * @example
 * ```typescript
 * // Called once at bot startup
 * initDb();
 * ```
 */
export const initDb = (): void => {
	// Enhanced users table
	db.exec(`
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
  `);

	// NOTE: user_wallets table (from old HD wallet system) has been removed
	// If migrating from an old database, that table may still exist with historical data
	// but is no longer created or used by the current code.

	// User balances table - Internal ledger system
	db.exec(`
    CREATE TABLE IF NOT EXISTS user_balances (
      user_id INTEGER PRIMARY KEY,
      balance REAL DEFAULT 0,
      last_updated INTEGER DEFAULT (strftime('%s', 'now')),
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

	// Transactions table - Complete audit trail
	db.exec(`
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
  `);

	// System wallets configuration
	db.exec(`
    CREATE TABLE IF NOT EXISTS system_wallets (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

	// Enhanced rules table
	db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      description TEXT,
      specific_action TEXT,
      severity INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

	// Enhanced violations table
	db.exec(`
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
  `);

	// Jail events log table
	db.exec(`
    CREATE TABLE IF NOT EXISTS jail_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      admin_id INTEGER,
      duration_minutes INTEGER,
      bail_amount REAL DEFAULT 0,
      paid_by_user_id INTEGER,
      payment_tx TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      metadata TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (admin_id) REFERENCES users(id),
      FOREIGN KEY (paid_by_user_id) REFERENCES users(id)
    );
  `);

	// Enhanced user_restrictions table with severity levels
	db.exec(`
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
  `);

	// Add new columns to existing user_restrictions table if they don't exist
	try {
		db.exec(
			`ALTER TABLE user_restrictions ADD COLUMN severity TEXT DEFAULT 'delete'`,
		);
	} catch (_e) {
		// Column already exists, ignore
	}
	try {
		db.exec(
			`ALTER TABLE user_restrictions ADD COLUMN violation_threshold INTEGER DEFAULT 5`,
		);
	} catch (_e) {
		// Column already exists, ignore
	}
	try {
		db.exec(
			`ALTER TABLE user_restrictions ADD COLUMN auto_jail_duration INTEGER DEFAULT 2880`,
		);
	} catch (_e) {
		// Column already exists, ignore
	}
	try {
		db.exec(
			`ALTER TABLE user_restrictions ADD COLUMN auto_jail_fine REAL DEFAULT 10.0`,
		);
	} catch (_e) {
		// Column already exists, ignore
	}

	// Enhanced global_restrictions table
	db.exec(`
    CREATE TABLE IF NOT EXISTS global_restrictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restriction TEXT NOT NULL,
      restricted_action TEXT,
      metadata TEXT,
      restricted_until INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

	// Processed deposits tracking table
	db.exec(`
    CREATE TABLE IF NOT EXISTS processed_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      amount REAL NOT NULL,
      from_address TEXT NOT NULL,
      memo TEXT,
      height INTEGER NOT NULL,
      processed INTEGER DEFAULT 0,
      processed_at INTEGER,
      error TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

	// Transaction lock table for preventing double-spending
	db.exec(`
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
  `);

	// Add new columns to existing transaction_locks table if they don't exist
	try {
		db.exec(`ALTER TABLE transaction_locks ADD COLUMN amount REAL DEFAULT 0`);
	} catch (_e) {
		// Column already exists
	}
	try {
		db.exec(`ALTER TABLE transaction_locks ADD COLUMN target_address TEXT`);
	} catch (_e) {
		// Column already exists
	}
	try {
		db.exec(`ALTER TABLE transaction_locks ADD COLUMN tx_hash TEXT`);
	} catch (_e) {
		// Column already exists
	}
	try {
		db.exec(
			`ALTER TABLE transaction_locks ADD COLUMN status TEXT DEFAULT 'pending'`,
		);
	} catch (_e) {
		// Column already exists
	}

	// Price history table for JUNO price tracking
	db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price_usd REAL NOT NULL,
      timestamp INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

	// Open giveaways table
	db.exec(`
    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_by INTEGER NOT NULL,
      funded_by INTEGER NOT NULL,
      total_amount REAL NOT NULL,
      amount_per_slot REAL NOT NULL,
      total_slots INTEGER NOT NULL,
      claimed_slots INTEGER DEFAULT 0,
      chat_id INTEGER NOT NULL,
      message_id INTEGER,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      completed_at INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (funded_by) REFERENCES users(id)
    );
  `);

	// Giveaway claims tracking table
	db.exec(`
    CREATE TABLE IF NOT EXISTS giveaway_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      claimed_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(giveaway_id, user_id),
      FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

	// Fine configuration table for USD-based fine amounts
	db.exec(`
    CREATE TABLE IF NOT EXISTS fine_config (
      fine_type TEXT PRIMARY KEY,
      amount_usd REAL NOT NULL,
      description TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_by INTEGER,
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );
  `);

	// Shared accounts table
	db.exec(`
    CREATE TABLE IF NOT EXISTS shared_accounts (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      description TEXT,
      created_by INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      metadata TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
  `);

	// Shared account permissions table
	db.exec(`
    CREATE TABLE IF NOT EXISTS shared_account_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shared_account_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      permission_level TEXT NOT NULL CHECK(permission_level IN ('view', 'spend', 'admin')),
      spend_limit REAL,
      granted_by INTEGER NOT NULL,
      granted_at INTEGER DEFAULT (strftime('%s', 'now')),
      revoked INTEGER DEFAULT 0,
      revoked_at INTEGER,
      revoked_by INTEGER,
      UNIQUE(shared_account_id, user_id),
      FOREIGN KEY (shared_account_id) REFERENCES shared_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (granted_by) REFERENCES users(id),
      FOREIGN KEY (revoked_by) REFERENCES users(id)
    );
  `);

	// System state key-value store for persisting runtime state (RNG chain, etc.)
	db.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

	// Duel challenges table - tracks pending/active/completed duels
	db.exec(`
    CREATE TABLE IF NOT EXISTS duels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger_id INTEGER NOT NULL,
      opponent_id INTEGER NOT NULL,
      wager_amount REAL NOT NULL,
      loser_consequence TEXT NOT NULL DEFAULT 'none',
      consequence_duration INTEGER,
      consequence_action TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired', 'completed')),
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

	// Create indexes for performance
	db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_blacklist ON users(blacklist);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_violations_user ON violations(user_id);
    CREATE INDEX IF NOT EXISTS idx_violations_paid ON violations(paid);
    CREATE INDEX IF NOT EXISTS idx_restrictions_user ON user_restrictions(user_id);
    CREATE INDEX IF NOT EXISTS idx_restrictions_until ON user_restrictions(restricted_until);
    CREATE INDEX IF NOT EXISTS idx_jail_events_user ON jail_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_jail_events_type ON jail_events(event_type);

    -- Ledger system indexes
    CREATE INDEX IF NOT EXISTS idx_user_balances_balance ON user_balances(balance);
    CREATE INDEX IF NOT EXISTS idx_transactions_from_user ON transactions(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_to_user ON transactions(to_user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions(tx_hash);

    -- Processed deposits indexes
    CREATE INDEX IF NOT EXISTS idx_processed_deposits_tx_hash ON processed_deposits(tx_hash);
    CREATE INDEX IF NOT EXISTS idx_processed_deposits_user ON processed_deposits(user_id);
    CREATE INDEX IF NOT EXISTS idx_processed_deposits_processed ON processed_deposits(processed);
    CREATE INDEX IF NOT EXISTS idx_processed_deposits_height ON processed_deposits(height);

    -- Shared accounts indexes
    CREATE INDEX IF NOT EXISTS idx_shared_accounts_name ON shared_accounts(name);
    CREATE INDEX IF NOT EXISTS idx_shared_permissions_account ON shared_account_permissions(shared_account_id);
    CREATE INDEX IF NOT EXISTS idx_shared_permissions_user ON shared_account_permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_shared_permissions_revoked ON shared_account_permissions(revoked);

    -- Price tracking indexes
    CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp);

    -- Giveaway indexes
    CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);
    CREATE INDEX IF NOT EXISTS idx_giveaways_chat ON giveaways(chat_id);
    CREATE INDEX IF NOT EXISTS idx_giveaway_claims_giveaway ON giveaway_claims(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_giveaway_claims_user ON giveaway_claims(user_id);

    -- Duel indexes
    CREATE INDEX IF NOT EXISTS idx_duels_challenger ON duels(challenger_id);
    CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_id);
    CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status);
    CREATE INDEX IF NOT EXISTS idx_duels_expires ON duels(expires_at);
  `);

	logger.info("Database initialized successfully");
};
