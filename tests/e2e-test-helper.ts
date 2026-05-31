/**
 * E2E Test Helper Script
 *
 * Provides automated verification functions for wallet system testing.
 * Run with: npx ts-node tests/e2e-test-helper.ts
 */

import { Database } from '../src/sqlite';
import { join } from 'path';

const DB_PATH = join(__dirname, '..', 'data', 'bot.db');

interface User {
  id: number;
  username: string;
  role: string;
  created_at: number;
  updated_at: number;
}

interface UserBalance {
  user_id: number;
  balance: number;
  last_updated: number;
}

interface Transaction {
  id: number;
  transaction_type: string;
  from_user_id: number | null;
  to_user_id: number | null;
  amount: number;
  balance_after: number | null;
  description: string;
  tx_hash: string | null;
  status: string;
  created_at: number;
}

interface ProcessedDeposit {
  id: number;
  tx_hash: string;
  user_id: number | null;
  amount: number;
  from_address: string;
  memo: string;
  height: number;
  processed: number;
  created_at: number;
}

interface TransactionLock {
  user_id: number;
  lock_type: string;
  locked_at: number;
}

class TestHelper {
  private db: Database;

  constructor() {
    this.db = new Database(DB_PATH, { readonly: true });
  }

  /**
   * Get user by ID
   */
  getUser(userId: number): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
  }

  /**
   * Get user balance
   */
  getUserBalance(userId: number): UserBalance | undefined {
    return this.db.prepare('SELECT * FROM user_balances WHERE user_id = ?').get(userId) as UserBalance | undefined;
  }

  /**
   * Get recent transactions for user
   */
  getUserTransactions(userId: number, limit: number = 10): Transaction[] {
    return this.db.prepare(`
      SELECT * FROM transactions
      WHERE from_user_id = ? OR to_user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, userId, limit) as Transaction[];
  }

  /**
   * Get total internal ledger balance
   */
  getTotalInternalBalance(): number {
    const result = this.db.prepare('SELECT SUM(balance) as total FROM user_balances').get() as { total: number };
    return result.total || 0;
  }

  /**
   * Get total user balances (excluding system accounts)
   */
  getTotalUserBalance(): number {
    const result = this.db.prepare('SELECT SUM(balance) as total FROM user_balances WHERE user_id > 0').get() as { total: number };
    return result.total || 0;
  }

  /**
   * Get system account balances
   */
  getSystemBalances(): UserBalance[] {
    return this.db.prepare('SELECT * FROM user_balances WHERE user_id < 0').all() as UserBalance[];
  }

  /**
   * Check for orphaned transactions
   */
  checkOrphanedTransactions(): { from: number; to: number } {
    const fromOrphans = this.db.prepare(`
      SELECT COUNT(*) as count FROM transactions
      WHERE from_user_id IS NOT NULL
      AND from_user_id NOT IN (SELECT id FROM users)
    `).get() as { count: number };

    const toOrphans = this.db.prepare(`
      SELECT COUNT(*) as count FROM transactions
      WHERE to_user_id IS NOT NULL
      AND to_user_id NOT IN (SELECT id FROM users)
    `).get() as { count: number };

    return { from: fromOrphans.count, to: toOrphans.count };
  }

  /**
   * Check for negative balances
   */
  checkNegativeBalances(): UserBalance[] {
    return this.db.prepare('SELECT * FROM user_balances WHERE balance < 0').all() as UserBalance[];
  }

  /**
   * Check for users without balance entries
   */
  checkUsersWithoutBalances(): User[] {
    return this.db.prepare(`
      SELECT u.* FROM users u
      LEFT JOIN user_balances ub ON u.id = ub.user_id
      WHERE ub.user_id IS NULL AND u.id > 0
    `).all() as User[];
  }

  /**
   * Check for stale transaction locks (older than 10 minutes)
   */
  checkStaleLocksCheck(): TransactionLock[] {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    return this.db.prepare(`
      SELECT * FROM transaction_locks WHERE locked_at < ?
    `).all(tenMinutesAgo) as TransactionLock[];
  }

  /**
   * Check for duplicate processed deposits
   */
  checkDuplicateDeposits(): Array<{ tx_hash: string; count: number }> {
    return this.db.prepare(`
      SELECT tx_hash, COUNT(*) as count
      FROM processed_deposits
      GROUP BY tx_hash
      HAVING count > 1
    `).all() as Array<{ tx_hash: string; count: number }>;
  }

  /**
   * Get transaction summary by type
   */
  getTransactionSummary(): Array<{ transaction_type: string; count: number; total_amount: number }> {
    return this.db.prepare(`
      SELECT
        transaction_type,
        COUNT(*) as count,
        SUM(amount) as total_amount
      FROM transactions
      GROUP BY transaction_type
    `).all() as Array<{ transaction_type: string; count: number; total_amount: number }>;
  }

  /**
   * Get recent deposits
   */
  getRecentDeposits(limit: number = 10): ProcessedDeposit[] {
    return this.db.prepare(`
      SELECT * FROM processed_deposits
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as ProcessedDeposit[];
  }

  /**
   * Search user by username
   */
  getUserByUsername(username: string): User | undefined {
    const cleanUsername = username.replace(/^@/, '');
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername) as User | undefined;
  }

  /**
   * Get all users count
   */
  getUserCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM users WHERE id > 0').get() as { count: number };
    return result.count;
  }

  /**
   * Run full integrity check
   */
  runIntegrityCheck(): {
    passed: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    // Check orphaned transactions
    const orphaned = this.checkOrphanedTransactions();
    if (orphaned.from > 0) {
      issues.push(`Found ${orphaned.from} transactions with invalid from_user_id`);
    }
    if (orphaned.to > 0) {
      issues.push(`Found ${orphaned.to} transactions with invalid to_user_id`);
    }

    // Check negative balances
    const negativeBalances = this.checkNegativeBalances();
    if (negativeBalances.length > 0) {
      issues.push(`Found ${negativeBalances.length} users with negative balances`);
    }

    // Check users without balances
    const usersWithoutBalances = this.checkUsersWithoutBalances();
    if (usersWithoutBalances.length > 0) {
      issues.push(`Found ${usersWithoutBalances.length} users without balance entries`);
    }

    // Check stale locks
    const staleLocks = this.checkStaleLocksCheck();
    if (staleLocks.length > 0) {
      issues.push(`Found ${staleLocks.length} stale transaction locks (>10 minutes old)`);
    }

    // Check duplicate deposits
    const duplicateDeposits = this.checkDuplicateDeposits();
    if (duplicateDeposits.length > 0) {
      issues.push(`Found ${duplicateDeposits.length} duplicate deposit tx_hashes`);
    }

    return {
      passed: issues.length === 0,
      issues
    };
  }

  /**
   * Print comprehensive database stats
   */
  printStats(): void {
    console.log('\n=== DATABASE STATISTICS ===\n');

    const userCount = this.getUserCount();
    const totalUserBalance = this.getTotalUserBalance();
    const totalInternalBalance = this.getTotalInternalBalance();
    const systemBalances = this.getSystemBalances();
    const transactionSummary = this.getTransactionSummary();

    console.log(`Total Users: ${userCount}`);
    console.log(`Total User Balances: ${totalUserBalance.toFixed(6)} JUNO`);
    console.log(`Total Internal Balance: ${totalInternalBalance.toFixed(6)} JUNO`);
    console.log('\nSystem Account Balances:');
    systemBalances.forEach(sb => {
      const accountName = sb.user_id === -1 ? 'TREASURY' : sb.user_id === -2 ? 'UNCLAIMED' : 'UNKNOWN';
      console.log(`  ${accountName} (${sb.user_id}): ${sb.balance.toFixed(6)} JUNO`);
    });

    console.log('\nTransaction Summary:');
    transactionSummary.forEach(ts => {
      console.log(`  ${ts.transaction_type}: ${ts.count} txs, ${ts.total_amount.toFixed(6)} JUNO total`);
    });

    console.log('\n=== INTEGRITY CHECK ===\n');
    const integrity = this.runIntegrityCheck();
    if (integrity.passed) {
      console.log('✓ All integrity checks passed');
    } else {
      console.log('✗ Integrity issues found:');
      integrity.issues.forEach(issue => console.log(`  - ${issue}`));
    }
  }

  /**
   * Verify specific user state
   */
  verifyUser(userId: number): void {
    console.log(`\n=== USER ${userId} VERIFICATION ===\n`);

    const user = this.getUser(userId);
    if (!user) {
      console.log('✗ User not found in database');
      return;
    }

    console.log(`Username: @${user.username}`);
    console.log(`Role: ${user.role}`);
    console.log(`Created: ${new Date(user.created_at * 1000).toISOString()}`);
    console.log(`Updated: ${new Date(user.updated_at * 1000).toISOString()}`);

    const balance = this.getUserBalance(userId);
    if (!balance) {
      console.log('\n✗ User has no balance entry');
      return;
    }

    console.log(`\nBalance: ${balance.balance.toFixed(6)} JUNO`);
    console.log(`Last Updated: ${new Date(balance.last_updated * 1000).toISOString()}`);

    const transactions = this.getUserTransactions(userId, 5);
    console.log(`\nRecent Transactions (${transactions.length}):`);
    transactions.forEach(tx => {
      const direction = tx.from_user_id === userId ? 'SENT' : 'RECEIVED';
      const otherUser = tx.from_user_id === userId ? tx.to_user_id : tx.from_user_id;
      console.log(`  [${tx.id}] ${direction} ${tx.amount.toFixed(6)} JUNO (${tx.transaction_type})`);
      console.log(`      ${direction === 'SENT' ? 'To' : 'From'}: ${otherUser}`);
      console.log(`      Balance After: ${tx.balance_after?.toFixed(6) || 'N/A'} JUNO`);
      console.log(`      Date: ${new Date(tx.created_at * 1000).toISOString()}`);
      if (tx.tx_hash) {
        console.log(`      TX Hash: ${tx.tx_hash}`);
      }
    });
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// CLI Interface
if (require.main === module) {
  const helper = new TestHelper();
  const args = process.argv.slice(2);

  try {
    if (args.length === 0 || args[0] === 'stats') {
      helper.printStats();
    } else if (args[0] === 'user' && args[1]) {
      const userId = parseInt(args[1]);
      if (isNaN(userId)) {
        console.error('Invalid user ID');
        process.exit(1);
      }
      helper.verifyUser(userId);
    } else if (args[0] === 'username' && args[1]) {
      const user = helper.getUserByUsername(args[1]);
      if (!user) {
        console.log(`User @${args[1]} not found`);
      } else {
        helper.verifyUser(user.id);
      }
    } else if (args[0] === 'integrity') {
      const result = helper.runIntegrityCheck();
      if (result.passed) {
        console.log('✓ All integrity checks passed');
      } else {
        console.log('✗ Integrity issues:');
        result.issues.forEach(issue => console.log(`  - ${issue}`));
        process.exit(1);
      }
    } else if (args[0] === 'deposits') {
      const limit = args[1] ? parseInt(args[1]) : 10;
      const deposits = helper.getRecentDeposits(limit);
      console.log(`\nRecent Deposits (${deposits.length}):\n`);
      deposits.forEach(d => {
        console.log(`[${d.id}] ${d.amount.toFixed(6)} JUNO`);
        console.log(`  TX: ${d.tx_hash}`);
        console.log(`  User: ${d.user_id || 'UNCLAIMED'}`);
        console.log(`  From: ${d.from_address}`);
        console.log(`  Memo: "${d.memo}"`);
        console.log(`  Height: ${d.height}`);
        console.log(`  Processed: ${d.processed ? 'Yes' : 'No'}`);
        console.log(`  Date: ${new Date(d.created_at * 1000).toISOString()}`);
        console.log();
      });
    } else {
      console.log('Usage:');
      console.log('  npx ts-node tests/e2e-test-helper.ts [command] [args]');
      console.log('\nCommands:');
      console.log('  stats              - Print database statistics and run integrity check');
      console.log('  user <userId>      - Verify specific user by ID');
      console.log('  username <name>    - Verify specific user by username');
      console.log('  integrity          - Run integrity check only');
      console.log('  deposits [limit]   - Show recent deposits (default: 10)');
    }
  } finally {
    helper.close();
  }
}

export default TestHelper;
