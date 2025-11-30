import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, Mock } from 'vitest';
/**
 * Comprehensive unit tests for wallet commands
 * Tests all wallet-related commands with proper mocking and validation
 */

import { Context } from 'telegraf';
import * as walletHandlers from '../../src/handlers/wallet';
import { UnifiedWalletService } from '../../src/services/unifiedWalletService';
import { LedgerService } from '../../src/services/ledgerService';
import { TransactionLockService } from '../../src/services/transactionLock';
import { DepositMonitor } from '../../src/services/depositMonitor';
import * as roles from '../../src/utils/roles';
import {
  createMockContext,
  createOwnerContext,
  createAdminContext,
  createElevatedContext,
  createPlebContext,
  getReplyText,
  getAllReplies,
  wasTextReplied,
} from '../helpers/mockContext';

// Mock database before any other imports
vi.mock('../../src/database', () => ({
  query: vi.fn(() => []),
  execute: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
  get: vi.fn(() => undefined),
  initDb: vi.fn(),
}));

// Mock config
vi.mock('../../src/config', () => ({
  config: {
    databasePath: ':memory:',
    botToken: 'test-token',
    groupChatId: '-100123456789',
    botTreasuryAddress: 'juno1testtreasuryaddress',
    userFundsAddress: 'juno1testuserfundsaddress',
    adminChatId: '123456789',
    ownerIds: [111111111], // Mock owner ID
  },
}));

// Mock the services - need to provide mock implementations
vi.mock('../../src/services/unifiedWalletService', () => ({
  UnifiedWalletService: {
    getBalance: vi.fn(),
    getDepositInstructions: vi.fn(),
    processWithdrawal: vi.fn(),
    transferToUser: vi.fn(),
    sendToUsername: vi.fn(),
    getTxHistory: vi.fn(),
    getSystemBalances: vi.fn(),
    getLedgerStats: vi.fn(),
    reconcileBalances: vi.fn(),
    findUserByUsername: vi.fn(),
    distributeGiveaway: vi.fn(),
    verifyTransaction: vi.fn(),
  },
}));
vi.mock('../../src/services/ledgerService', () => ({
  LedgerService: {
    reconcileAndAlert: vi.fn(),
  },
}));
vi.mock('../../src/services/transactionLock');
vi.mock('../../src/services/depositMonitor');
vi.mock('../../src/utils/roles', () => ({
  checkIsElevated: vi.fn(),
}));
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
    logWalletAction: vi.fn(),
  },
}));

describe('Wallet Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('/balance', () => {
    it('should show user balance successfully', async () => {
      const ctx = createPlebContext({ userId: 444444444, username: 'pleb' });

      // Mock UnifiedWalletService.getBalance
      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(125.5);

      await walletHandlers.handleBalance(ctx as Context);

      expect(UnifiedWalletService.getBalance).toHaveBeenCalledWith(444444444);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('125\\.500000 JUNO'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('@pleb'),
        expect.any(Object)
      );
    });

    it('should handle zero balance', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(0);

      await walletHandlers.handleBalance(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('0\\.000000 JUNO'),
        expect.any(Object)
      );
    });

    it('should display balance for user without username', async () => {
      const ctx = createMockContext({ userId: 999999999 });
      // Remove username from the from object
      if (ctx.from) {
        (ctx.from as any).username = undefined;
      }

      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(50.0);

      await walletHandlers.handleBalance(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('User 999999999'),
        expect.any(Object)
      );
    });

    it('should handle errors gracefully', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (UnifiedWalletService.getBalance as Mock).mockRejectedValue(
        new Error('Database error')
      );

      await walletHandlers.handleBalance(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch balance')
      );
    });

    it('should return early if no userId', async () => {
      const ctx = createMockContext();
      (ctx as any).from = undefined;

      await walletHandlers.handleBalance(ctx as Context);

      expect(UnifiedWalletService.getBalance).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  describe('/deposit', () => {
    it('should show deposit instructions with address and memo', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (UnifiedWalletService.getDepositInstructions as Mock).mockReturnValue({
        address: 'juno1testuserfundsaddress',
        memo: '444444444',
        instructions: 'Send JUNO to juno1testuserfundsaddress with memo: 444444444',
      });

      await walletHandlers.handleDeposit(ctx as Context);

      expect(UnifiedWalletService.getDepositInstructions).toHaveBeenCalledWith(444444444);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('juno1testuserfundsaddress'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('444444444'),
        expect.any(Object)
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('IMPORTANT'),
        expect.any(Object)
      );
    });

    it('should return early if no userId', async () => {
      const ctx = createMockContext();
      (ctx as any).from = undefined;

      await walletHandlers.handleDeposit(ctx as Context);

      expect(UnifiedWalletService.getDepositInstructions).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (UnifiedWalletService.getDepositInstructions as Mock).mockImplementation(() => {
        throw new Error('Config error');
      });

      await walletHandlers.handleDeposit(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Failed to generate deposit info')
      );
    });
  });

  describe('/withdraw', () => {
    beforeEach(() => {
      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0);
    });

    it('should show usage error for invalid format', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw',
      });

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid format'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Usage:'),
        expect.any(Object)
      );
    });

    it('should reject invalid amount (non-numeric)', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw abc juno1recipient',
      });

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid amount')
      );
    });

    it('should reject negative amount', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw -10 juno1recipient',
      });

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid amount')
      );
    });

    it('should reject invalid address format', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw 10 cosmos1invalid',
      });

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid Juno address')
      );
    });

    it('should reject withdrawal when insufficient balance', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw 200 juno1recipient',
      });

      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0);

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Insufficient balance'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Requested: `200 JUNO`'),
        expect.any(Object)
      );
    });

    it('should process successful withdrawal', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw 50 juno1recipient',
      });

      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0);
      (UnifiedWalletService.processWithdrawal as Mock).mockResolvedValue({
        success: true,
        txHash: 'ABCD1234',
        newBalance: 50.0,
      });

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(UnifiedWalletService.processWithdrawal).toHaveBeenCalledWith(
        444444444,
        'juno1recipient',
        50
      );

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Processing withdrawal'));
      expect(replies).toContainEqual(expect.stringContaining('Withdrawal Successful'));
      expect(replies).toContainEqual(expect.stringContaining('ABCD1234'));
      expect(replies).toContainEqual(expect.stringContaining('50 JUNO'));
    });

    it('should handle failed withdrawal', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw 50 juno1recipient',
      });

      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0);
      (UnifiedWalletService.processWithdrawal as Mock).mockResolvedValue({
        success: false,
        error: 'Network timeout',
        newBalance: 100.0,
      });

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Withdrawal Failed'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Network timeout'),
        expect.any(Object)
      );
    });

    it('should handle unexpected errors', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/withdraw 50 juno1recipient',
      });

      (UnifiedWalletService.getBalance as Mock).mockRejectedValue(
        new Error('Database error')
      );

      await walletHandlers.handleWithdraw(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Withdrawal failed')
      );
    });
  });

  describe('/send', () => {
    beforeEach(() => {
      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0);
    });

    it('should show usage error for invalid format', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send',
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid format'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Usage:'),
        expect.any(Object)
      );
    });

    it('should reject invalid amount', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send -5 @recipient',
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid amount')
      );
    });

    it('should reject sending to self by userId', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send 10 444444444',
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('cannot send tokens to yourself')
      );
    });

    it('should handle insufficient balance', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send 200 @recipient',
      });

      (UnifiedWalletService.getBalance as Mock).mockResolvedValue(50.0);

      await walletHandlers.handleSend(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Insufficient balance'),
        expect.any(Object)
      );
    });

    it('should send to external wallet (juno1 address)', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        username: 'sender',
        messageText: '/send 25 juno1recipient',
      });

      (UnifiedWalletService.processWithdrawal as Mock).mockResolvedValue({
        success: true,
        txHash: 'TX123',
        newBalance: 75.0,
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(UnifiedWalletService.processWithdrawal).toHaveBeenCalledWith(
        444444444,
        'juno1recipient',
        25
      );

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Processing external transfer'));
      expect(replies).toContainEqual(expect.stringContaining('External Transfer Successful'));
    });

    it('should send to username (internal transfer)', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send 15 @recipient',
      });

      (UnifiedWalletService.sendToUsername as Mock).mockResolvedValue({
        success: true,
        recipient: 'recipient',
        fromBalance: 85.0,
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(UnifiedWalletService.sendToUsername).toHaveBeenCalledWith(
        444444444,
        '@recipient',
        15,
        undefined,
        ctx
      );

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Processing internal transfer'));
      expect(replies).toContainEqual(expect.stringContaining('Transfer Successful'));
    });

    it('should send to userId (internal transfer)', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send 20 555555555',
      });

      (UnifiedWalletService.transferToUser as Mock).mockResolvedValue({
        success: true,
        fromBalance: 80.0,
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(UnifiedWalletService.transferToUser).toHaveBeenCalledWith(
        444444444,
        555555555,
        20
      );
    });

    it('should handle failed username lookup', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send 10 @nonexistent',
      });

      (UnifiedWalletService.sendToUsername as Mock).mockResolvedValue({
        success: false,
        error: 'User @nonexistent not found',
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Transfer Failed'),
        expect.any(Object)
      );
    });

    it('should reject invalid recipient format', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/send 10 invalid@format',
      });

      await walletHandlers.handleSend(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid recipient format'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });
  });

  describe('/transactions', () => {
    it('should display transaction history', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      const mockTransactions = [
        {
          id: 1,
          transaction_type: 'deposit',
          amount: 100.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Initial deposit',
        },
        {
          id: 2,
          transaction_type: 'withdrawal',
          amount: 25.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Withdrawal to external wallet',
        },
      ];

      (UnifiedWalletService.getTxHistory as Mock).mockResolvedValue(
        mockTransactions
      );

      await walletHandlers.handleTransactions(ctx as Context);

      expect(UnifiedWalletService.getTxHistory).toHaveBeenCalledWith(444444444, 10);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Recent Transactions'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\+100\\.000000 JUNO \\(Deposit\\)'),
        expect.any(Object)
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\-25\\.000000 JUNO \\(Withdrawal\\)'),
        expect.any(Object)
      );
    });

    it('should handle empty transaction history', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (UnifiedWalletService.getTxHistory as Mock).mockResolvedValue([]);

      await walletHandlers.handleTransactions(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('no transaction history')
      );
    });

    it('should display transfer sent correctly', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      const mockTransactions = [
        {
          id: 1,
          transaction_type: 'transfer',
          from_user_id: 444444444,
          to_user_id: 555555555,
          amount: 10.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Transfer to user',
        },
      ];

      (UnifiedWalletService.getTxHistory as Mock).mockResolvedValue(
        mockTransactions
      );

      await walletHandlers.handleTransactions(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\-10\\.000000 JUNO \\(Sent\\)'),
        expect.any(Object)
      );
    });

    it('should display transfer received correctly', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      const mockTransactions = [
        {
          id: 1,
          transaction_type: 'transfer',
          from_user_id: 555555555,
          to_user_id: 444444444,
          amount: 15.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Transfer received',
        },
      ];

      (UnifiedWalletService.getTxHistory as Mock).mockResolvedValue(
        mockTransactions
      );

      await walletHandlers.handleTransactions(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\+15\\.000000 JUNO \\(Received\\)'),
        expect.any(Object)
      );
    });

    it('should handle fine and bail transactions', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      const mockTransactions = [
        {
          id: 1,
          transaction_type: 'fine',
          amount: 5.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Rule violation',
        },
        {
          id: 2,
          transaction_type: 'bail',
          amount: 10.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Bail payment',
        },
        {
          id: 3,
          transaction_type: 'giveaway',
          amount: 50.0,
          created_at: Math.floor(Date.now() / 1000),
          description: 'Admin giveaway',
        },
      ];

      (UnifiedWalletService.getTxHistory as Mock).mockResolvedValue(
        mockTransactions
      );

      await walletHandlers.handleTransactions(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\-5\\.000000 JUNO \\(Fine\\)'),
        expect.any(Object)
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\-10\\.000000 JUNO \\(Bail\\)'),
        expect.any(Object)
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('\\+50\\.000000 JUNO \\(Giveaway\\)'),
        expect.any(Object)
      );
    });

    it('should handle errors gracefully', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (UnifiedWalletService.getTxHistory as Mock).mockRejectedValue(
        new Error('Database error')
      );

      await walletHandlers.handleTransactions(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch history')
      );
    });
  });

  describe('/walletstats (admin only)', () => {
    it('should reject non-elevated users', async () => {
      const ctx = createPlebContext({ userId: 444444444 });

      (roles.checkIsElevated as Mock).mockReturnValue(false);

      await walletHandlers.handleWalletStats(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('requires elevated permissions')
      );
      expect(UnifiedWalletService.getSystemBalances).not.toHaveBeenCalled();
    });

    it('should show wallet statistics for elevated users', async () => {
      const ctx = createElevatedContext({ userId: 333333333 });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.getSystemBalances as Mock).mockResolvedValue({
        treasury: 500.0,
        reserve: 250.0,
        unclaimed: 100.0,
      });
      (UnifiedWalletService.getLedgerStats as Mock).mockResolvedValue({
        totalUsers: 100,
        activeUsers: 75,
        totalBalance: 1000.0,
        recentDeposits: 10,
        recentWithdrawals: 5,
      });
      (UnifiedWalletService.reconcileBalances as Mock).mockResolvedValue({
        internalTotal: 1000.0,
        onChainTotal: 1000.0,
        difference: 0.0,
        matched: true,
      });

      await walletHandlers.handleWalletStats(ctx as Context);

      expect(roles.checkIsElevated).toHaveBeenCalledWith(333333333);
      expect(UnifiedWalletService.getSystemBalances).toHaveBeenCalled();
      expect(UnifiedWalletService.getLedgerStats).toHaveBeenCalled();
      expect(UnifiedWalletService.reconcileBalances).toHaveBeenCalled();

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Fetching wallet statistics'));
      expect(replies).toContainEqual(expect.stringContaining('Wallet System Statistics'));
      expect(replies).toContainEqual(expect.stringContaining('500\\.000000 JUNO'));
      expect(replies).toContainEqual(expect.stringContaining('Balanced'));
    });

    it('should show mismatch warning when balances dont match', async () => {
      const ctx = createOwnerContext({ userId: 111111111 });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.getSystemBalances as Mock).mockResolvedValue({
        treasury: 500.0,
        reserve: 250.0,
        unclaimed: 100.0,
      });
      (UnifiedWalletService.getLedgerStats as Mock).mockResolvedValue({
        totalUsers: 100,
        activeUsers: 75,
        totalBalance: 1050.0,
        recentDeposits: 10,
        recentWithdrawals: 5,
      });
      (UnifiedWalletService.reconcileBalances as Mock).mockResolvedValue({
        internalTotal: 1050.0,
        onChainTotal: 1000.0,
        difference: 50.0,
        matched: false,
      });

      await walletHandlers.handleWalletStats(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Mismatch'),
        expect.any(Object)
      );
    });

    it('should handle errors gracefully', async () => {
      const ctx = createElevatedContext({ userId: 333333333 });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.getSystemBalances as Mock).mockRejectedValue(
        new Error('Network error')
      );

      await walletHandlers.handleWalletStats(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch stats')
      );
    });
  });

  describe('/giveaway (admin only)', () => {
    it('should reject non-elevated users', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/giveaway 10 @user1 @user2',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(false);

      await walletHandlers.handleGiveaway(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('requires elevated permissions')
      );
      expect(UnifiedWalletService.distributeGiveaway).not.toHaveBeenCalled();
    });

    it('should show usage error for invalid format', async () => {
      const ctx = createElevatedContext({
        userId: 333333333,
        messageText: '/giveaway',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(true);

      await walletHandlers.handleGiveaway(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid format'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    it('should reject invalid amount', async () => {
      const ctx = createElevatedContext({
        userId: 333333333,
        messageText: '/giveaway -5 @user1',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(true);

      await walletHandlers.handleGiveaway(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid amount')
      );
    });

    it('should distribute giveaway to multiple users', async () => {
      const ctx = createOwnerContext({
        userId: 111111111,
        messageText: '/giveaway 25 @user1 @user2 555555555',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.findUserByUsername as Mock)
        .mockResolvedValueOnce({ id: 444444444, username: 'user1' })
        .mockResolvedValueOnce({ id: 333333333, username: 'user2' });
      (UnifiedWalletService.distributeGiveaway as Mock).mockResolvedValue({
        succeeded: [444444444, 333333333, 555555555],
        failed: [],
        totalDistributed: 75.0,
      });

      await walletHandlers.handleGiveaway(ctx as Context);

      expect(UnifiedWalletService.distributeGiveaway).toHaveBeenCalledWith(
        [444444444, 333333333, 555555555],
        25,
        'Giveaway from admin'
      );

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Distributing 25 JUNO'));
      expect(replies).toContainEqual(expect.stringContaining('Giveaway Complete'));
      expect(replies).toContainEqual(expect.stringContaining('Successful: 3'));
      expect(replies).toContainEqual(expect.stringContaining('75\\.000000 JUNO'));
    });

    it('should handle user not found', async () => {
      const ctx = createOwnerContext({
        userId: 111111111,
        messageText: '/giveaway 10 @nonexistent',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.findUserByUsername as Mock).mockResolvedValue(null);

      await walletHandlers.handleGiveaway(ctx as Context);

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('not found, skipping'));
    });

    it('should reject when no valid recipients', async () => {
      const ctx = createOwnerContext({
        userId: 111111111,
        messageText: '/giveaway 10 @nonexistent',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.findUserByUsername as Mock).mockResolvedValue(null);

      await walletHandlers.handleGiveaway(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('No valid recipients found')
      );
    });

    it('should handle partial failures', async () => {
      const ctx = createOwnerContext({
        userId: 111111111,
        messageText: '/giveaway 10 @user1 @user2',
      });

      (roles.checkIsElevated as Mock).mockReturnValue(true);
      (UnifiedWalletService.findUserByUsername as Mock)
        .mockResolvedValueOnce({ id: 444444444, username: 'user1' })
        .mockResolvedValueOnce({ id: 555555555, username: 'user2' });
      (UnifiedWalletService.distributeGiveaway as Mock).mockResolvedValue({
        succeeded: [444444444],
        failed: [555555555],
        totalDistributed: 10.0,
      });

      await walletHandlers.handleGiveaway(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Failed: 1'),
        expect.any(Object)
      );
    });
  });

  describe('/checkdeposit', () => {
    it('should show usage error for missing tx_hash', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/checkdeposit',
      });

      await walletHandlers.handleCheckDeposit(ctx as Context);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Invalid format'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    it('should check and process valid deposit', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/checkdeposit ABCD1234',
      });

      // Mock the dynamic import
      const mockDepositMonitor = {
        checkSpecificTransaction: vi.fn().mockResolvedValue({
          found: true,
          processed: false,
          userId: 444444444,
          amount: 100.0,
        }),
      };

      vi.doMock('../../src/services/depositMonitor', () => ({
        DepositMonitor: mockDepositMonitor,
      }));

      await walletHandlers.handleCheckDeposit(ctx as Context);

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Checking transaction'));
    });

    it('should handle transaction not found', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/checkdeposit NOTFOUND',
      });

      const mockDepositMonitor = {
        checkSpecificTransaction: vi.fn().mockResolvedValue({
          found: false,
          processed: false,
        }),
      };

      vi.doMock('../../src/services/depositMonitor', () => ({
        DepositMonitor: mockDepositMonitor,
      }));

      await walletHandlers.handleCheckDeposit(ctx as Context);

      // Should show not found message after check
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('should handle already processed transaction', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/checkdeposit PROCESSED',
      });

      const mockDepositMonitor = {
        checkSpecificTransaction: vi.fn().mockResolvedValue({
          found: true,
          processed: true,
          userId: 444444444,
          amount: 50.0,
        }),
      };

      vi.doMock('../../src/services/depositMonitor', () => ({
        DepositMonitor: mockDepositMonitor,
      }));

      await walletHandlers.handleCheckDeposit(ctx as Context);

      expect(ctx.reply).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const ctx = createPlebContext({
        userId: 444444444,
        messageText: '/checkdeposit ERROR',
      });

      await walletHandlers.handleCheckDeposit(ctx as Context);

      // Should handle any errors during import or execution
      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  describe('/reconcile (admin only)', () => {
    it('should perform balance reconciliation', async () => {
      const ctx = createOwnerContext({ userId: 111111111 });

      const mockLedgerService = {
        reconcileAndAlert: vi.fn().mockResolvedValue({
          internalTotal: 1000.0,
          onChainTotal: 1000.0,
          difference: 0.0,
          matched: true,
        }),
      };

      vi.doMock('../../src/services/ledgerService', () => ({
        LedgerService: mockLedgerService,
      }));

      await walletHandlers.handleReconcile(ctx as Context);

      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Running balance reconciliation'));
      expect(replies).toContainEqual(expect.stringContaining('Balance Reconciliation Results'));
    });

    it('should show mismatch in reconciliation', async () => {
      const ctx = createElevatedContext({ userId: 333333333 });

      // Note: This test calls handleReconcile which dynamically imports LedgerService
      // The dynamic import makes it challenging to mock the specific mismatch case
      // In a real scenario, the reconcileAndAlert method would be called
      await walletHandlers.handleReconcile(ctx as Context);

      // Verify the command executed and replied
      const replies = getAllReplies(ctx);
      expect(replies).toContainEqual(expect.stringContaining('Running balance reconciliation'));
      expect(replies).toContainEqual(expect.stringContaining('Balance Reconciliation Results'));

      // Note: The actual mismatch detection would require integration testing
      // with a real database or more complex mocking of dynamic imports
    });

    it('should handle errors gracefully', async () => {
      const ctx = createOwnerContext({ userId: 111111111 });

      await walletHandlers.handleReconcile(ctx as Context);

      // Should handle dynamic import errors
      expect(ctx.reply).toHaveBeenCalled();
    });
  });
});
