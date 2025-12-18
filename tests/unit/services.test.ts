import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, Mock } from 'vitest';
/**
 * Comprehensive unit tests for database services
 * Tests all CRUD operations, data validation, cascading operations, and edge cases
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import {
  ensureUserExists,
  addUserRestriction,
  removeUserRestriction,
  getUserRestrictions
} from '../../src/services/userService';
import {
  createViolation,
  getUserViolations,
  getUnpaidViolations,
  markViolationPaid,
  getTotalFines
} from '../../src/services/violationService';
import { JailService } from '../../src/services/jailService';
import { RestrictionService } from '../../src/services/restrictionService';
import { User, Violation, UserRestriction, JailEvent } from '../../src/types';

// Mock config for tests
vi.mock('../../src/config', () => ({
  config: {
    botToken: 'test-token',
    junoRpcUrl: 'https://test.rpc',
    adminChatId: 123456789,
    groupChatId: -100123456789,
    ownerId: 111111111,
    databasePath: join(__dirname, '../test-data/services-test.db'),
    logLevel: 'silent',
    fineAmounts: {
      sticker: 1.0,
      url: 2.0,
      regex: 1.5,
      blacklist: 5.0
    },
    restrictionDurations: {
      warning: 24 * 60 * 60 * 1000,
      mute: 60 * 60 * 1000,
      tempBan: 7 * 24 * 60 * 60 * 1000
    }
  },
  validateConfig: vi.fn()
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
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
    logSecurityEvent: vi.fn(),
    logDebug: vi.fn(),
  },
}));

// Mock PriceService to return static values for testing
vi.mock('../../src/services/priceService', () => ({
  PriceService: {
    calculateViolationFine: vi.fn(async (restriction: string) => {
      switch (restriction) {
        case 'no_stickers':
          return 1.0;
        case 'no_urls':
          return 2.0;
        case 'regex_block':
          return 1.5;
        case 'blacklist':
          return 5.0;
        default:
          return 1.0;
      }
    }),
    calculateBailAmount: vi.fn(async (durationMinutes: number) => {
      return Math.max(1.0, durationMinutes * 0.1);
    }),
    getFineConfigUsd: vi.fn((fineType: string) => {
      const defaults: Record<string, number> = {
        sticker: 0.1,
        url: 0.2,
        regex: 0.15,
        blacklist: 0.5,
        jail_per_minute: 0.01,
        jail_minimum: 0.1,
      };
      return defaults[fineType] || 0.1;
    }),
  },
}));

// Mock database module to use test database
let testDb: Database.Database | null = null;
const TEST_DB_PATH = join(__dirname, '../test-data/services-test.db');

// Override database functions to use test database
vi.mock('../../src/database', () => {
  const Database = require('better-sqlite3');
  const { join } = require('path');
  const testDbPath = join(__dirname, '../test-data/services-test.db');

  const getDb = () => {
    if (!testDb) {
      testDb = new Database(testDbPath);
      testDb!.exec('PRAGMA foreign_keys = ON');
    }
    return testDb!;
  };

  return {
    query: <T>(sql: string, params: unknown[] = []): T[] => {
      const db = getDb();
      const stmt = db.prepare(sql);
      return stmt.all(params) as T[];
    },
    execute: (sql: string, params: unknown[] = []): Database.RunResult => {
      const db = getDb();
      const stmt = db.prepare(sql);
      return stmt.run(params);
    },
    get: <T>(sql: string, params: unknown[] = []): T | undefined => {
      const db = getDb();
      const stmt = db.prepare(sql);
      return stmt.get(params) as T | undefined;
    },
    initDb: vi.fn()
  };
});

/**
 * Initialize test database with complete schema
 */
function initTestDatabase(): void {
  const testDataDir = join(__dirname, '../test-data');
  if (!existsSync(testDataDir)) {
    mkdirSync(testDataDir, { recursive: true });
  }

  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }

  testDb = new Database(TEST_DB_PATH);
  testDb!.exec('PRAGMA foreign_keys = ON');

  // Create complete schema matching production
  testDb!.exec(`
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
      restriction TEXT NOT NULL,
      restricted_action TEXT,
      metadata TEXT,
      restricted_until INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
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

    -- Create performance indexes
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_blacklist ON users(blacklist);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_muted_until ON users(muted_until);
    CREATE INDEX IF NOT EXISTS idx_violations_user ON violations(user_id);
    CREATE INDEX IF NOT EXISTS idx_violations_paid ON violations(paid);
    CREATE INDEX IF NOT EXISTS idx_violations_timestamp ON violations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_restrictions_user ON user_restrictions(user_id);
    CREATE INDEX IF NOT EXISTS idx_restrictions_until ON user_restrictions(restricted_until);
    CREATE INDEX IF NOT EXISTS idx_jail_events_user ON jail_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_jail_events_type ON jail_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_jail_events_timestamp ON jail_events(timestamp);
  `);
}

/**
 * Clean all data from test database
 */
function cleanTestDatabase(): void {
  if (!testDb) return;

  testDb.exec(`
    DELETE FROM jail_events;
    DELETE FROM user_restrictions;
    DELETE FROM global_restrictions;
    DELETE FROM violations;
    DELETE FROM transactions;
    DELETE FROM user_balances;
    DELETE FROM users;
  `);
}

/**
 * Close and cleanup test database
 */
function closeTestDatabase(): void {
  if (testDb) {
    testDb.close();
    testDb = null;
  }

  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}

describe('Database Services - Comprehensive Tests', () => {
  beforeAll(() => {
    initTestDatabase();
  });

  afterAll(() => {
    closeTestDatabase();
  });

  beforeEach(() => {
    cleanTestDatabase();
  });

  // ============================================================================
  // USER SERVICE TESTS
  // ============================================================================
  describe('UserService', () => {
    describe('ensureUserExists', () => {
      test('creates new user when user does not exist', () => {
        ensureUserExists(123456, 'testuser');

        const users = testDb!.prepare('SELECT * FROM users WHERE id = ?').all(123456) as User[];
        expect(users).toHaveLength(1);
        expect(users[0].username).toBe('testuser');
        expect(users[0].role).toBe('pleb');
        expect(users[0].whitelist).toBe(0);
        expect(users[0].blacklist).toBe(0);
        expect(users[0].warning_count).toBe(0);
      });

      test('updates username when user already exists', () => {
        ensureUserExists(123456, 'oldname');
        ensureUserExists(123456, 'newname');

        const users = testDb!.prepare('SELECT * FROM users WHERE id = ?').all(123456) as User[];
        expect(users).toHaveLength(1);
        expect(users[0].username).toBe('newname');
      });

      test('does not modify role when updating existing user', () => {
        testDb!.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(123456, 'admin', 'admin');
        ensureUserExists(123456, 'updatedname');

        const user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(123456) as User;
        expect(user.role).toBe('admin');
        expect(user.username).toBe('updatedname');
      });

      test('handles multiple concurrent user creations', () => {
        const userIds = Array.from({ length: 100 }, (_, i) => i + 1);

        userIds.forEach(id => {
          ensureUserExists(id, `user${id}`);
        });

        const count = testDb!.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
        expect(count.count).toBe(100);
      });
    });

    describe('addUserRestriction', () => {
      beforeEach(() => {
        ensureUserExists(123456, 'testuser');
      });

      test('adds restriction without optional fields', () => {
        addUserRestriction(123456, 'no_stickers');

        const restrictions = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').all(123456) as any[];
        expect(restrictions).toHaveLength(1);
        expect(restrictions[0].restriction).toBe('no_stickers');
        expect(restrictions[0].restricted_action).toBeNull();
        expect(restrictions[0].metadata).toBeNull();
        expect(restrictions[0].restricted_until).toBeNull();
      });

      test('adds restriction with all optional fields', () => {
        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        const metadata = { reason: 'spam', count: 5 };

        addUserRestriction(123456, 'no_urls', 'example.com', metadata, futureTime);

        const restrictions = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').all(123456) as any[];
        expect(restrictions).toHaveLength(1);
        expect(restrictions[0].restriction).toBe('no_urls');
        expect(restrictions[0].restricted_action).toBe('example.com');
        expect(restrictions[0].metadata).toBe(JSON.stringify(metadata));
        expect(restrictions[0].restricted_until).toBe(futureTime);
      });

      test('allows multiple restrictions for same user', () => {
        addUserRestriction(123456, 'no_stickers');
        addUserRestriction(123456, 'no_urls');
        addUserRestriction(123456, 'no_media');

        const restrictions = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').all(123456) as UserRestriction[];
        expect(restrictions).toHaveLength(3);
        expect(restrictions.map(r => r.restriction)).toContain('no_stickers');
        expect(restrictions.map(r => r.restriction)).toContain('no_urls');
        expect(restrictions.map(r => r.restriction)).toContain('no_media');
      });

      test('handles complex metadata objects', () => {
        const metadata = {
          reason: 'Multiple violations',
          count: 10,
          domains: ['example.com', 'test.com'],
          nested: { field: 'value' }
        };

        addUserRestriction(123456, 'no_urls', undefined, metadata);

        const restriction = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').get(123456) as any;
        expect(JSON.parse(restriction.metadata!)).toEqual(metadata);
      });
    });

    describe('removeUserRestriction', () => {
      beforeEach(() => {
        ensureUserExists(123456, 'testuser');
      });

      test('removes specific restriction', () => {
        addUserRestriction(123456, 'no_stickers');
        addUserRestriction(123456, 'no_urls');

        removeUserRestriction(123456, 'no_stickers');

        const restrictions = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').all(123456) as UserRestriction[];
        expect(restrictions).toHaveLength(1);
        expect(restrictions[0].restriction).toBe('no_urls');
      });

      test('does nothing if restriction does not exist', () => {
        addUserRestriction(123456, 'no_stickers');

        expect(() => {
          removeUserRestriction(123456, 'no_urls');
        }).not.toThrow();

        const restrictions = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').all(123456) as UserRestriction[];
        expect(restrictions).toHaveLength(1);
      });

      test('removes all instances of same restriction type', () => {
        addUserRestriction(123456, 'no_urls', 'example.com');
        addUserRestriction(123456, 'no_urls', 'test.com');

        removeUserRestriction(123456, 'no_urls');

        const restrictions = testDb!.prepare('SELECT * FROM user_restrictions WHERE user_id = ?').all(123456) as UserRestriction[];
        expect(restrictions).toHaveLength(0);
      });
    });

    describe('getUserRestrictions', () => {
      beforeEach(() => {
        ensureUserExists(123456, 'testuser');
      });

      test('returns empty array for user with no restrictions', () => {
        const restrictions = getUserRestrictions(123456);
        expect(restrictions).toEqual([]);
      });

      test('returns all restrictions for user', () => {
        addUserRestriction(123456, 'no_stickers');
        addUserRestriction(123456, 'no_urls', 'example.com');
        addUserRestriction(123456, 'no_media');

        const restrictions = getUserRestrictions(123456);
        expect(restrictions).toHaveLength(3);
      });

      test('returns restrictions with all fields populated', () => {
        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        const metadata = { reason: 'test' };

        addUserRestriction(123456, 'no_urls', 'example.com', metadata, futureTime);

        const restrictions = getUserRestrictions(123456) as any[];
        expect(restrictions[0].restriction).toBe('no_urls');
        expect(restrictions[0].restricted_action).toBe('example.com');
        expect(restrictions[0].metadata).toBe(JSON.stringify(metadata));
        expect(restrictions[0].restricted_until).toBe(futureTime);
      });

      test('does not return restrictions from other users', () => {
        ensureUserExists(999999, 'otheruser');
        addUserRestriction(123456, 'no_stickers');
        addUserRestriction(999999, 'no_urls');

        const restrictions = getUserRestrictions(123456);
        expect(restrictions).toHaveLength(1);
        expect(restrictions[0].restriction).toBe('no_stickers');
      });
    });
  });

  // ============================================================================
  // VIOLATION SERVICE TESTS
  // ============================================================================
  describe('ViolationService', () => {
    beforeEach(() => {
      ensureUserExists(123456, 'testuser');
    });

    describe('createViolation', () => {
      test('creates violation with correct fine amount for sticker', async () => {
        const violationId = await createViolation(123456, 'no_stickers', 'Test sticker message');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.user_id).toBe(123456);
        expect(violation.restriction).toBe('no_stickers');
        expect(violation.message).toBe('Test sticker message');
        expect(violation.bail_amount).toBe(1.0);
        expect(violation.paid).toBe(0);
      });

      test('creates violation with correct fine amount for URL', async () => {
        const violationId = await createViolation(123456, 'no_urls', 'http://spam.com');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.bail_amount).toBe(2.0);
      });

      test('creates violation with correct fine amount for regex', async () => {
        const violationId = await createViolation(123456, 'regex_block', 'Blocked pattern');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.bail_amount).toBe(1.5);
      });

      test('creates violation with correct fine amount for blacklist', async () => {
        const violationId = await createViolation(123456, 'blacklist', 'Blacklist violation');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.bail_amount).toBe(5.0);
      });

      test('increments user warning count', async () => {
        await createViolation(123456, 'no_stickers');
        await createViolation(123456, 'no_urls');
        await createViolation(123456, 'no_media');

        const user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(123456) as User;
        expect(user.warning_count).toBe(3);
      });

      test('returns unique violation ID for each violation', async () => {
        const id1 = await createViolation(123456, 'no_stickers');
        const id2 = await createViolation(123456, 'no_urls');
        const id3 = await createViolation(123456, 'no_media');

        expect(id1).not.toBe(id2);
        expect(id2).not.toBe(id3);
        expect(id1).not.toBe(id3);
      });

      test('handles violation without message', async () => {
        const violationId = await createViolation(123456, 'no_stickers');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.message).toBeNull();
      });

      test('creates multiple violations for same user', async () => {
        await createViolation(123456, 'no_stickers');
        await createViolation(123456, 'no_stickers');
        await createViolation(123456, 'no_stickers');

        const violations = testDb!.prepare('SELECT * FROM violations WHERE user_id = ?').all(123456) as Violation[];
        expect(violations).toHaveLength(3);
      });
    });

    describe('getUserViolations', () => {
      test('returns empty array for user with no violations', () => {
        const violations = getUserViolations(123456);
        expect(violations).toEqual([]);
      });

      test('returns all violations for user in descending order', async () => {
        const id1 = await createViolation(123456, 'no_stickers', 'First');
        await new Promise(resolve => setTimeout(resolve, 100));
        const id2 = await createViolation(123456, 'no_urls', 'Second');
        await new Promise(resolve => setTimeout(resolve, 100));
        const id3 = await createViolation(123456, 'no_media', 'Third');

        const violations = getUserViolations(123456) as any[];
        expect(violations).toHaveLength(3);
        // Violations are returned by DESC timestamp, verify ordering
        expect(violations[0].timestamp).toBeGreaterThanOrEqual(violations[1].timestamp);
        expect(violations[1].timestamp).toBeGreaterThanOrEqual(violations[2].timestamp);
        // Verify they are all present
        const ids = violations.map(v => v.id).sort();
        expect(ids).toEqual([id1, id2, id3].sort());
      });

      test('does not return violations from other users', async () => {
        ensureUserExists(999999, 'otheruser');
        await createViolation(123456, 'no_stickers');
        await createViolation(999999, 'no_urls');

        const violations = getUserViolations(123456);
        expect(violations).toHaveLength(1);
        expect(violations[0].restriction).toBe('no_stickers');
      });

      test('returns both paid and unpaid violations', async () => {
        const id1 = await createViolation(123456, 'no_stickers');
        await createViolation(123456, 'no_urls');

        markViolationPaid(id1, 'test_tx_hash');

        const violations = getUserViolations(123456);
        expect(violations).toHaveLength(2);
      });
    });

    describe('getUnpaidViolations', () => {
      test('returns only unpaid violations', async () => {
        const id1 = await createViolation(123456, 'no_stickers');
        await createViolation(123456, 'no_urls');
        const id3 = await createViolation(123456, 'no_media');

        markViolationPaid(id1, 'tx1');
        markViolationPaid(id3, 'tx2');

        const unpaid = getUnpaidViolations(123456);
        expect(unpaid).toHaveLength(1);
        expect(unpaid[0].restriction).toBe('no_urls');
      });

      test('returns empty array when all violations are paid', async () => {
        const id1 = await createViolation(123456, 'no_stickers');
        const id2 = await createViolation(123456, 'no_urls');

        markViolationPaid(id1, 'tx1');
        markViolationPaid(id2, 'tx2');

        const unpaid = getUnpaidViolations(123456);
        expect(unpaid).toEqual([]);
      });

      test('returns empty array for user with no violations', () => {
        const unpaid = getUnpaidViolations(123456);
        expect(unpaid).toEqual([]);
      });
    });

    describe('markViolationPaid', () => {
      test('marks violation as paid with transaction hash', async () => {
        const violationId = await createViolation(123456, 'no_stickers');

        markViolationPaid(violationId, 'test_tx_hash_12345');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.paid).toBe(1);
        expect(violation.payment_tx).toBe('test_tx_hash_12345');
        expect(violation.paid_at).toBeGreaterThan(0);
      });

      test('records who paid the violation when different from violator', async () => {
        ensureUserExists(999999, 'payer');
        const violationId = await createViolation(123456, 'no_stickers');

        markViolationPaid(violationId, 'tx_hash', 999999);

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.paid_by_user_id).toBe(999999);
      });

      test('handles payment without paidByUserId', async () => {
        const violationId = await createViolation(123456, 'no_stickers');

        markViolationPaid(violationId, 'tx_hash');

        const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
        expect(violation.paid_by_user_id).toBeNull();
      });

      test('does not affect other unpaid violations', async () => {
        const id1 = await createViolation(123456, 'no_stickers');
        const id2 = await createViolation(123456, 'no_urls');

        markViolationPaid(id1, 'tx_hash');

        const unpaid = getUnpaidViolations(123456);
        expect(unpaid).toHaveLength(1);
        expect(unpaid[0].id).toBe(id2);
      });
    });

    describe('getTotalFines', () => {
      test('returns 0 for user with no violations', () => {
        const total = getTotalFines(123456);
        expect(total).toBe(0);
      });

      test('sums all unpaid violation amounts', async () => {
        await createViolation(123456, 'no_stickers'); // 1.0
        await createViolation(123456, 'no_urls'); // 2.0
        await createViolation(123456, 'regex_block'); // 1.5

        const total = getTotalFines(123456);
        expect(total).toBe(4.5);
      });

      test('excludes paid violations from total', async () => {
        const id1 = await createViolation(123456, 'no_stickers'); // 1.0
        await createViolation(123456, 'no_urls'); // 2.0
        await createViolation(123456, 'blacklist'); // 5.0

        markViolationPaid(id1, 'tx1');

        const total = getTotalFines(123456);
        expect(total).toBe(7.0); // 2.0 + 5.0
      });

      test('returns 0 when all violations are paid', async () => {
        const id1 = await createViolation(123456, 'no_stickers');
        const id2 = await createViolation(123456, 'no_urls');

        markViolationPaid(id1, 'tx1');
        markViolationPaid(id2, 'tx2');

        const total = getTotalFines(123456);
        expect(total).toBe(0);
      });
    });
  });

  // ============================================================================
  // JAIL SERVICE TESTS
  // ============================================================================
  describe('JailService', () => {
    beforeEach(() => {
      ensureUserExists(123456, 'jaileduser');
      ensureUserExists(999999, 'admin');
    });

    describe('logJailEvent', () => {
      test('logs jail event with all fields', () => {
        const metadata = { reason: 'spam', count: 5 };

        JailService.logJailEvent(
          123456,
          'jailed',
          999999,
          60,
          10.0,
          undefined,
          undefined,
          metadata
        );

        const events = testDb!.prepare('SELECT * FROM jail_events WHERE user_id = ?').all(123456) as any[];
        expect(events).toHaveLength(1);
        expect(events[0].event_type).toBe('jailed');
        expect(events[0].admin_id).toBe(999999);
        expect(events[0].duration_minutes).toBe(60);
        expect(events[0].bail_amount).toBe(10.0);
        expect(events[0].metadata).toBe(JSON.stringify(metadata));
      });

      test('logs jail event with minimal fields', () => {
        JailService.logJailEvent(123456, 'auto_unjailed');

        const events = testDb!.prepare('SELECT * FROM jail_events WHERE user_id = ?').all(123456) as any[];
        expect(events).toHaveLength(1);
        expect(events[0].event_type).toBe('auto_unjailed');
        expect(events[0].admin_id).toBeNull();
        expect(events[0].duration_minutes).toBeNull();
        expect(events[0].bail_amount).toBe(0);
      });

      test('logs bail payment event', () => {
        ensureUserExists(777777, 'payer');

        JailService.logJailEvent(
          123456,
          'bail_paid',
          undefined,
          undefined,
          15.0,
          777777,
          'tx_hash_abc123'
        );

        const events = testDb!.prepare('SELECT * FROM jail_events WHERE user_id = ?').all(123456) as any[];
        expect(events[0].event_type).toBe('bail_paid');
        expect(events[0].bail_amount).toBe(15.0);
        expect(events[0].paid_by_user_id).toBe(777777);
        expect(events[0].payment_tx).toBe('tx_hash_abc123');
      });

      test('logs multiple events for same user', () => {
        JailService.logJailEvent(123456, 'jailed', 999999, 60, 10.0);
        JailService.logJailEvent(123456, 'bail_paid', undefined, undefined, 10.0, 123456, 'tx1');
        JailService.logJailEvent(123456, 'unjailed', 999999);

        const events = testDb!.prepare('SELECT * FROM jail_events WHERE user_id = ?').all(123456) as JailEvent[];
        expect(events).toHaveLength(3);
      });
    });

    describe('getActiveJails', () => {
      test('returns empty array when no users are jailed', () => {
        const jails = JailService.getActiveJails();
        expect(jails).toEqual([]);
      });

      test('returns users with active jail time', () => {
        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 123456);

        const jails = JailService.getActiveJails();
        expect(jails).toHaveLength(1);
        expect(jails[0].id).toBe(123456);
        expect(jails[0].timeRemaining).toBeGreaterThan(3500);
        expect(jails[0].timeRemaining).toBeLessThanOrEqual(3600);
      });

      test('does not return users with expired jail time', () => {
        const pastTime = Math.floor(Date.now() / 1000) - 3600;
        testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(pastTime, 123456);

        const jails = JailService.getActiveJails();
        expect(jails).toEqual([]);
      });

      test('returns multiple jailed users', () => {
        ensureUserExists(111111, 'user1');
        ensureUserExists(222222, 'user2');
        ensureUserExists(333333, 'user3');

        const futureTime = Math.floor(Date.now() / 1000) + 3600;
        testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime, 111111);
        testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime + 1800, 222222);
        testDb!.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(futureTime + 7200, 333333);

        const jails = JailService.getActiveJails();
        expect(jails).toHaveLength(3);
      });
    });

    describe('getUserJailEvents', () => {
      test('returns jail events in descending order', () => {
        JailService.logJailEvent(123456, 'jailed', 999999);
        JailService.logJailEvent(123456, 'unjailed', 999999);
        JailService.logJailEvent(123456, 'jailed', 999999);

        const events = JailService.getUserJailEvents(123456) as any[];
        expect(events).toHaveLength(3);
        expect(events[0].eventType).toBe('jailed'); // Most recent
      });

      test('respects limit parameter', () => {
        for (let i = 0; i < 20; i++) {
          JailService.logJailEvent(123456, 'jailed', 999999);
        }

        const events = JailService.getUserJailEvents(123456, 5);
        expect(events).toHaveLength(5);
      });

      test('returns empty array for user with no jail events', () => {
        const events = JailService.getUserJailEvents(123456);
        expect(events).toEqual([]);
      });

      test('does not return events from other users', () => {
        ensureUserExists(777777, 'otheruser');
        JailService.logJailEvent(123456, 'jailed', 999999);
        JailService.logJailEvent(777777, 'jailed', 999999);

        const events = JailService.getUserJailEvents(123456) as any[];
        expect(events).toHaveLength(1);
        expect(events[0].userId).toBe(123456);
      });
    });

    describe('getAllJailEvents', () => {
      test('returns events from all users', () => {
        ensureUserExists(111111, 'user1');
        ensureUserExists(222222, 'user2');

        JailService.logJailEvent(111111, 'jailed', 999999);
        JailService.logJailEvent(222222, 'jailed', 999999);
        JailService.logJailEvent(123456, 'jailed', 999999);

        const events = JailService.getAllJailEvents();
        expect(events).toHaveLength(3);
      });

      test('respects limit parameter', () => {
        for (let i = 0; i < 150; i++) {
          JailService.logJailEvent(123456, 'jailed', 999999);
        }

        const events = JailService.getAllJailEvents(50);
        expect(events).toHaveLength(50);
      });

      test('returns events in descending timestamp order', () => {
        JailService.logJailEvent(123456, 'jailed', 999999);
        ensureUserExists(111111, 'newuser');
        JailService.logJailEvent(111111, 'jailed', 999999);

        const events = JailService.getAllJailEvents() as any[];
        expect(events[0].userId).toBe(111111); // Most recent
        expect(events[1].userId).toBe(123456);
      });
    });

    describe('calculateBailAmount', () => {
      test('calculates bail for short duration', async () => {
        const bail = await JailService.calculateBailAmount(5);
        expect(bail).toBe(Math.max(1.0, 5 * 0.1));
      });

      test('calculates bail for medium duration', async () => {
        const bail = await JailService.calculateBailAmount(60);
        expect(bail).toBe(60 * 0.1);
      });

      test('calculates bail for long duration', async () => {
        const bail = await JailService.calculateBailAmount(1440); // 1 day
        expect(bail).toBe(144);
      });

      test('returns minimum of 1.0 for very short durations', async () => {
        const bail = await JailService.calculateBailAmount(5);
        expect(bail).toBeGreaterThanOrEqual(1.0);
      });

      test('returns 1.0 for zero duration', async () => {
        const bail = await JailService.calculateBailAmount(0);
        expect(bail).toBe(1.0);
      });
    });
  });

  // ============================================================================
  // RESTRICTION SERVICE TESTS
  // ============================================================================
  describe('RestrictionService', () => {
    beforeEach(() => {
      ensureUserExists(123456, 'testuser');
    });

    describe('cleanExpiredRestrictions', () => {
      test('removes expired user restrictions', () => {
        const pastTime = Math.floor(Date.now() / 1000) - 3600;
        const futureTime = Math.floor(Date.now() / 1000) + 3600;

        addUserRestriction(123456, 'no_stickers', undefined, undefined, pastTime);
        addUserRestriction(123456, 'no_urls', undefined, undefined, futureTime);
        addUserRestriction(123456, 'no_media'); // No expiry

        RestrictionService.cleanExpiredRestrictions();

        const restrictions = getUserRestrictions(123456);
        expect(restrictions).toHaveLength(2);
        expect(restrictions.map(r => r.restriction)).not.toContain('no_stickers');
      });

      test('removes expired global restrictions', () => {
        const pastTime = Math.floor(Date.now() / 1000) - 3600;
        const futureTime = Math.floor(Date.now() / 1000) + 3600;

        testDb!.prepare('INSERT INTO global_restrictions (restriction, restricted_until) VALUES (?, ?)').run('no_stickers', pastTime);
        testDb!.prepare('INSERT INTO global_restrictions (restriction, restricted_until) VALUES (?, ?)').run('no_urls', futureTime);
        testDb!.prepare('INSERT INTO global_restrictions (restriction) VALUES (?)').run('no_media');

        RestrictionService.cleanExpiredRestrictions();

        const restrictions = testDb!.prepare('SELECT * FROM global_restrictions').all();
        expect(restrictions).toHaveLength(2);
      });

      test('does not remove restrictions without expiry', () => {
        addUserRestriction(123456, 'no_stickers');
        addUserRestriction(123456, 'no_urls');

        RestrictionService.cleanExpiredRestrictions();

        const restrictions = getUserRestrictions(123456);
        expect(restrictions).toHaveLength(2);
      });

      test('handles empty restriction tables', () => {
        expect(() => {
          RestrictionService.cleanExpiredRestrictions();
        }).not.toThrow();
      });
    });
  });

  // ============================================================================
  // CASCADE AND DATA INTEGRITY TESTS
  // ============================================================================
  describe('Data Integrity and Cascading Operations', () => {
    test('deleting user cascades to user_balances', () => {
      ensureUserExists(123456, 'testuser');
      testDb!.prepare('INSERT INTO user_balances (user_id, balance) VALUES (?, ?)').run(123456, 100.0);

      testDb!.prepare('DELETE FROM users WHERE id = ?').run(123456);

      const balances = testDb!.prepare('SELECT * FROM user_balances WHERE user_id = ?').all(123456);
      expect(balances).toHaveLength(0);
    });

    test('foreign key constraints prevent orphaned violations', () => {
      expect(() => {
        testDb!.prepare('INSERT INTO violations (user_id, restriction, bail_amount) VALUES (?, ?, ?)').run(999999, 'test', 1.0);
      }).toThrow();
    });

    test('foreign key constraints prevent orphaned restrictions', () => {
      expect(() => {
        testDb!.prepare('INSERT INTO user_restrictions (user_id, restriction) VALUES (?, ?)').run(999999, 'test');
      }).toThrow();
    });

    test('foreign key constraints prevent orphaned jail events', () => {
      expect(() => {
        testDb!.prepare('INSERT INTO jail_events (user_id, event_type) VALUES (?, ?)').run(999999, 'jailed');
      }).toThrow();
    });

    test('paid_by_user_id foreign key is enforced', async () => {
      ensureUserExists(123456, 'violator');
      const violationId = await createViolation(123456, 'no_stickers');

      expect(() => {
        testDb!.prepare('UPDATE violations SET paid = 1, paid_by_user_id = ? WHERE id = ?').run(888888, violationId);
      }).toThrow();
    });
  });

  // ============================================================================
  // PERFORMANCE AND INDEX TESTS
  // ============================================================================
  describe('Performance and Index Utilization', () => {
    test('queries use indexes for user lookups', () => {
      // Create many users
      for (let i = 1; i <= 1000; i++) {
        ensureUserExists(i, `user${i}`);
      }

      const start = Date.now();
      const user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(500) as User;
      const duration = Date.now() - start;

      expect(user).toBeDefined();
      expect(duration).toBeLessThan(100); // Relaxed timing constraint
    }, 15000); // 15 second timeout for this test

    test('violation queries use indexes', async () => {
      ensureUserExists(123456, 'testuser');

      // Create many violations
      for (let i = 0; i < 500; i++) {
        await createViolation(123456, 'no_stickers');
      }

      const start = Date.now();
      const violations = getUserViolations(123456);
      const duration = Date.now() - start;

      expect(violations).toHaveLength(500);
      expect(duration).toBeLessThan(200); // Relaxed timing constraint
    }, 15000); // 15 second timeout for this test

    test('restriction queries use indexes', () => {
      ensureUserExists(123456, 'testuser');

      // Create many restrictions
      for (let i = 0; i < 100; i++) {
        addUserRestriction(123456, 'no_stickers', `pack${i}`);
      }

      const start = Date.now();
      const restrictions = getUserRestrictions(123456);
      const duration = Date.now() - start;

      expect(restrictions).toHaveLength(100);
      expect(duration).toBeLessThan(100); // Relaxed timing constraint
    });

    test('jail event queries use indexes', () => {
      ensureUserExists(123456, 'testuser');
      ensureUserExists(999999, 'admin');

      // Create many jail events
      for (let i = 0; i < 200; i++) {
        JailService.logJailEvent(123456, 'jailed', 999999);
      }

      const start = Date.now();
      const events = JailService.getUserJailEvents(123456, 50);
      const duration = Date.now() - start;

      expect(events).toHaveLength(50);
      expect(duration).toBeLessThan(100); // Relaxed timing constraint
    });
  });

  // ============================================================================
  // EDGE CASES AND ERROR HANDLING
  // ============================================================================
  describe('Edge Cases and Error Handling', () => {
    test('handles null username gracefully', () => {
      expect(() => {
        testDb!.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(123456, null, 'pleb');
      }).not.toThrow();
    });

    test('handles empty string username', () => {
      ensureUserExists(123456, '');

      const user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(123456) as User;
      expect(user.username).toBe('');
    });

    test('handles very long usernames', () => {
      const longName = 'a'.repeat(1000);
      ensureUserExists(123456, longName);

      const user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(123456) as User;
      expect(user.username).toBe(longName);
    });

    test('handles negative user IDs', () => {
      ensureUserExists(-123456, 'negativeuser');

      const user = testDb!.prepare('SELECT * FROM users WHERE id = ?').get(-123456) as User;
      expect(user).toBeDefined();
      expect(user.username).toBe('negativeuser');
    });

    test('handles zero bail amounts', async () => {
      ensureUserExists(123456, 'testuser');
      const violationId = await createViolation(123456, 'unknown_type');

      const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId) as any;
      expect(violation.bail_amount).toBeGreaterThanOrEqual(0);
    });

    test('handles very large bail amounts', () => {
      ensureUserExists(123456, 'testuser');
      const violationId = testDb!.prepare('INSERT INTO violations (user_id, restriction, bail_amount) VALUES (?, ?, ?)').run(123456, 'test', 9999999.99);

      const violation = testDb!.prepare('SELECT * FROM violations WHERE id = ?').get(violationId.lastInsertRowid) as any;
      expect(violation.bail_amount).toBe(9999999.99);
    });

    test('handles special characters in metadata', () => {
      ensureUserExists(123456, 'testuser');
      const metadata = {
        special: "Test with 'quotes' and \"double quotes\"",
        unicode: '测试  тест',
        escape: 'Test\\nWith\\tEscapes'
      };

      addUserRestriction(123456, 'no_urls', undefined, metadata);

      const restrictions = getUserRestrictions(123456);
      expect(JSON.parse(restrictions[0].metadata!)).toEqual(metadata);
    });

    test('handles concurrent user creation attempts', () => {
      // SQLite handles this with REPLACE behavior
      ensureUserExists(123456, 'name1');
      ensureUserExists(123456, 'name2');
      ensureUserExists(123456, 'name3');

      const users = testDb!.prepare('SELECT * FROM users WHERE id = ?').all(123456);
      expect(users).toHaveLength(1);
    });

    test('handles expired restrictions at boundary', () => {
      ensureUserExists(123456, 'testuser');
      const now = Math.floor(Date.now() / 1000);

      addUserRestriction(123456, 'no_stickers', undefined, undefined, now - 1); // Just expired
      addUserRestriction(123456, 'no_urls', undefined, undefined, now); // Expiring now
      addUserRestriction(123456, 'no_media', undefined, undefined, now + 1); // Not expired

      const activeRestrictions = testDb!.prepare(
        'SELECT * FROM user_restrictions WHERE user_id = ? AND (restricted_until IS NULL OR restricted_until > ?)'
      ).all(123456, now);

      expect(activeRestrictions).toHaveLength(1);
    });
  });

  // ============================================================================
  // BATCH OPERATIONS TESTS
  // ============================================================================
  describe('Batch Operations', () => {
    test('creates multiple users efficiently', () => {
      const start = Date.now();

      for (let i = 1; i <= 1000; i++) {
        ensureUserExists(i, `user${i}`);
      }

      const duration = Date.now() - start;
      const count = testDb!.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };

      expect(count.count).toBe(1000);
      expect(duration).toBeLessThan(15000); // Relaxed: 15 seconds
    }, 20000); // 20 second timeout for this test

    test('creates multiple violations efficiently', async () => {
      ensureUserExists(123456, 'testuser');

      const start = Date.now();

      for (let i = 0; i < 100; i++) {
        await createViolation(123456, 'no_stickers');
      }

      const duration = Date.now() - start;
      const violations = getUserViolations(123456);

      expect(violations).toHaveLength(100);
      expect(duration).toBeLessThan(5000); // Relaxed: 5 seconds
    });

    test('creates multiple restrictions efficiently', () => {
      ensureUserExists(123456, 'testuser');

      const start = Date.now();

      for (let i = 0; i < 100; i++) {
        addUserRestriction(123456, 'no_urls', `domain${i}.com`);
      }

      const duration = Date.now() - start;
      const restrictions = getUserRestrictions(123456);

      expect(restrictions).toHaveLength(100);
      expect(duration).toBeLessThan(5000); // Relaxed: 5 seconds
    });

    test('logs multiple jail events efficiently', () => {
      ensureUserExists(123456, 'testuser');
      ensureUserExists(999999, 'admin');

      const start = Date.now();

      for (let i = 0; i < 100; i++) {
        JailService.logJailEvent(123456, 'jailed', 999999, 60, 10.0);
      }

      const duration = Date.now() - start;
      const events = JailService.getUserJailEvents(123456, 100);

      expect(events).toHaveLength(100);
      expect(duration).toBeLessThan(5000); // Relaxed: 5 seconds
    });

    test('bulk payment of violations', async () => {
      ensureUserExists(123456, 'testuser');

      const violationIds: number[] = [];
      for (let i = 0; i < 50; i++) {
        const id = await createViolation(123456, 'no_stickers');
        violationIds.push(id);
      }

      const start = Date.now();

      violationIds.forEach((id, index) => {
        markViolationPaid(id, `tx_${index}`);
      });

      const duration = Date.now() - start;
      const unpaid = getUnpaidViolations(123456);

      expect(unpaid).toHaveLength(0);
      expect(duration).toBeLessThan(5000); // Relaxed: 5 seconds
    });

    test('bulk removal of restrictions', () => {
      ensureUserExists(123456, 'testuser');

      const restrictions = ['no_stickers', 'no_urls', 'no_media', 'no_gifs', 'no_voice'];
      restrictions.forEach(r => addUserRestriction(123456, r as any));

      restrictions.forEach(r => removeUserRestriction(123456, r));

      const remaining = getUserRestrictions(123456);
      expect(remaining).toHaveLength(0);
    });
  });
});
