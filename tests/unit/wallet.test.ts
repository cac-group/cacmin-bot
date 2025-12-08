import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
/**
 * Unit tests for wallet commands
 */

import { Context } from 'telegraf';
import * as walletHandlers from '../../src/handlers/wallet';
import { UnifiedWalletService } from '../../src/services/unifiedWalletService';
import { LedgerService } from '../../src/services/ledgerService';
import * as roles from '../../src/utils/roles';
import { createPlebContext, createOwnerContext, createAdminContext, createElevatedContext, createMockContext, getReplyText, getAllReplies } from '../helpers/mockContext';

vi.mock('../../src/database', () => ({ query: vi.fn(() => []), execute: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })), get: vi.fn(() => undefined), initDb: vi.fn() }));
vi.mock('../../src/config', () => ({ config: { databasePath: ':memory:', botToken: 'test-token', groupChatId: '-100123456789', botTreasuryAddress: 'juno1testtreasuryaddress', userFundsAddress: 'juno1testuserfundsaddress', adminChatId: '123456789', ownerIds: [111111111] } }));
vi.mock('../../src/services/unifiedWalletService', () => ({
	UnifiedWalletService: { getBalance: vi.fn(), getDepositInstructions: vi.fn(), processWithdrawal: vi.fn(), transferToUser: vi.fn(), sendToUsername: vi.fn(), getTxHistory: vi.fn(), getSystemBalances: vi.fn(), getLedgerStats: vi.fn(), reconcileBalances: vi.fn(), findUserByUsername: vi.fn(), distributeGiveaway: vi.fn(), verifyTransaction: vi.fn() },
	SYSTEM_USER_IDS: { BOT_TREASURY: -1, SYSTEM_RESERVE: -2, UNCLAIMED: -3 }
}));
vi.mock('../../src/services/ledgerService', () => ({ LedgerService: { reconcileAndAlert: vi.fn(), getUserBalance: vi.fn(), transferBetweenUsers: vi.fn() } }));
vi.mock('../../src/services/transactionLock');
vi.mock('../../src/services/depositMonitor');
vi.mock('../../src/utils/roles', () => ({ checkIsElevated: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }, StructuredLogger: { logError: vi.fn(), logUserAction: vi.fn(), logTransaction: vi.fn(), logWalletAction: vi.fn() } }));

describe('Wallet Commands', () => {
	beforeEach(() => vi.clearAllMocks());

	describe('/balance', () => {
		it('shows balance and handles edge cases', async () => {
			// Normal balance
			let ctx = createPlebContext({ userId: 444444444, username: 'pleb' });
			(UnifiedWalletService.getBalance as Mock).mockResolvedValue(125.5);
			await walletHandlers.handleBalance(ctx as Context);
			expect(getReplyText(ctx)).toContain('125.500000 JUNO');

			// Zero balance
			ctx = createPlebContext({ userId: 444444444 });
			(UnifiedWalletService.getBalance as Mock).mockResolvedValue(0);
			await walletHandlers.handleBalance(ctx as Context);
			expect(getReplyText(ctx)).toContain('0.000000 JUNO');

			// No username
			ctx = createMockContext({ userId: 999999999 });
			if (ctx.from) (ctx.from as any).username = undefined;
			(UnifiedWalletService.getBalance as Mock).mockResolvedValue(50.0);
			await walletHandlers.handleBalance(ctx as Context);
			expect(getReplyText(ctx)).toContain('User 999999999');

			// Error handling
			ctx = createPlebContext({ userId: 444444444 });
			(UnifiedWalletService.getBalance as Mock).mockRejectedValue(new Error('DB error'));
			await walletHandlers.handleBalance(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch balance'));
		});
	});

	describe('/deposit', () => {
		it('shows deposit instructions', async () => {
			const ctx = createPlebContext({ userId: 444444444 });
			(UnifiedWalletService.getDepositInstructions as Mock).mockReturnValue({ address: 'juno1testuserfundsaddress', memo: '444444444' });
			await walletHandlers.handleDeposit(ctx as Context);
			const replies = getAllReplies(ctx);
			expect(replies.some(r => r.includes('juno1testuserfundsaddress'))).toBe(true);
			expect(replies.some(r => r.includes('444444444'))).toBe(true);
		});
	});

	describe('/withdraw', () => {
		beforeEach(() => (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0));

		it('validates input correctly', async () => {
			// Missing args
			let ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw' });
			await walletHandlers.handleWithdraw(ctx as Context);
			expect(getReplyText(ctx)).toContain('Invalid format');

			// Invalid amount
			ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw abc juno1recipient' });
			await walletHandlers.handleWithdraw(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Invalid amount'));

			// Negative amount
			ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw -10 juno1recipient' });
			await walletHandlers.handleWithdraw(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Invalid amount'));

			// Invalid address
			ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw 10 cosmos1invalid' });
			await walletHandlers.handleWithdraw(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Invalid Juno address'));
		});

		it('processes withdrawal correctly', async () => {
			// Insufficient balance
			let ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw 200 juno1recipient' });
			await walletHandlers.handleWithdraw(ctx as Context);
			expect(getReplyText(ctx)).toContain('broke');

			// Successful withdrawal
			ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw 50 juno1recipient' });
			(UnifiedWalletService.processWithdrawal as Mock).mockResolvedValue({ success: true, txHash: 'ABCD1234', newBalance: 50.0 });
			await walletHandlers.handleWithdraw(ctx as Context);
			const replies = getAllReplies(ctx);
			expect(replies.some(r => r.includes('Withdrawal Successful'))).toBe(true);
			expect(replies.some(r => r.includes('ABCD1234'))).toBe(true);

			// Failed withdrawal
			ctx = createPlebContext({ userId: 444444444, messageText: '/withdraw 50 juno1recipient' });
			(UnifiedWalletService.processWithdrawal as Mock).mockResolvedValue({ success: false, error: 'Network timeout', newBalance: 100.0 });
			await walletHandlers.handleWithdraw(ctx as Context);
			expect(getAllReplies(ctx).some(r => r.includes('Withdrawal Failed'))).toBe(true);
		});
	});

	describe('/send', () => {
		beforeEach(() => (UnifiedWalletService.getBalance as Mock).mockResolvedValue(100.0));

		it('validates input and prevents self-send', async () => {
			let ctx = createPlebContext({ userId: 444444444, messageText: '/send' });
			await walletHandlers.handleSend(ctx as Context);
			expect(getReplyText(ctx)).toContain('Invalid format');

			ctx = createPlebContext({ userId: 444444444, messageText: '/send 10 444444444' });
			await walletHandlers.handleSend(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('cannot send tokens to yourself'));

			ctx = createPlebContext({ userId: 444444444, messageText: '/send 10 invalid@format' });
			await walletHandlers.handleSend(ctx as Context);
			expect(getReplyText(ctx)).toContain('Invalid recipient format');
		});

		it('handles internal and external transfers', async () => {
			// External (juno1 address)
			let ctx = createPlebContext({ userId: 444444444, username: 'sender', messageText: '/send 25 juno1recipient' });
			(UnifiedWalletService.processWithdrawal as Mock).mockResolvedValue({ success: true, txHash: 'TX123', newBalance: 75.0 });
			await walletHandlers.handleSend(ctx as Context);
			expect(getAllReplies(ctx).some(r => r.includes('External Transfer Successful'))).toBe(true);

			// Internal (username)
			ctx = createPlebContext({ userId: 444444444, messageText: '/send 15 @recipient' });
			(UnifiedWalletService.sendToUsername as Mock).mockResolvedValue({ success: true, recipient: 'recipient', fromBalance: 85.0 });
			await walletHandlers.handleSend(ctx as Context);
			expect(getAllReplies(ctx).some(r => r.includes('Transfer Successful'))).toBe(true);

			// Internal (userId)
			ctx = createPlebContext({ userId: 444444444, messageText: '/send 20 555555555' });
			(UnifiedWalletService.transferToUser as Mock).mockResolvedValue({ success: true, fromBalance: 80.0 });
			await walletHandlers.handleSend(ctx as Context);
			expect(UnifiedWalletService.transferToUser).toHaveBeenCalledWith(444444444, 555555555, 20);
		});
	});

	describe('/transactions', () => {
		it('displays transaction history correctly', async () => {
			// With transactions
			let ctx = createPlebContext({ userId: 444444444 });
			(UnifiedWalletService.getTxHistory as Mock).mockResolvedValue([
				{ id: 1, transaction_type: 'deposit', amount: 100.0, created_at: Math.floor(Date.now() / 1000), description: 'Deposit' },
				{ id: 2, transaction_type: 'withdrawal', amount: 25.0, created_at: Math.floor(Date.now() / 1000), description: 'Withdrawal' },
				{ id: 3, transaction_type: 'transfer', from_user_id: 444444444, to_user_id: 555, amount: 10.0, created_at: Math.floor(Date.now() / 1000), description: 'Sent' },
				{ id: 4, transaction_type: 'transfer', from_user_id: 555, to_user_id: 444444444, amount: 15.0, created_at: Math.floor(Date.now() / 1000), description: 'Received' },
				{ id: 5, transaction_type: 'fine', amount: 5.0, created_at: Math.floor(Date.now() / 1000), description: 'Fine' },
			]);
			await walletHandlers.handleTransactions(ctx as Context);
			const replyText = getReplyText(ctx);
			expect(replyText).toContain('+100.000000 JUNO (Deposit)');
			expect(replyText).toContain('-25.000000 JUNO (Withdrawal)');
			expect(replyText).toContain('-10.000000 JUNO (Sent)');
			expect(replyText).toContain('+15.000000 JUNO (Received)');
			expect(replyText).toContain('-5.000000 JUNO (Fine)');

			// Empty history
			ctx = createPlebContext({ userId: 444444444 });
			(UnifiedWalletService.getTxHistory as Mock).mockResolvedValue([]);
			await walletHandlers.handleTransactions(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('no transaction history'));
		});
	});

	describe('/walletstats (admin only)', () => {
		it('requires elevated permissions and shows stats', async () => {
			// Non-elevated rejected
			let ctx = createPlebContext({ userId: 444444444 });
			(roles.checkIsElevated as Mock).mockReturnValue(false);
			await walletHandlers.handleWalletStats(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('requires elevated permissions'));

			// Elevated shows stats
			ctx = createElevatedContext({ userId: 333333333 });
			(roles.checkIsElevated as Mock).mockReturnValue(true);
			(UnifiedWalletService.getSystemBalances as Mock).mockResolvedValue({ treasury: 500.0, reserve: 250.0, unclaimed: 100.0 });
			(UnifiedWalletService.getLedgerStats as Mock).mockResolvedValue({ totalUsers: 100, activeUsers: 75, totalBalance: 1000.0, recentDeposits: 10, recentWithdrawals: 5 });
			(UnifiedWalletService.reconcileBalances as Mock).mockResolvedValue({ internalTotal: 1000.0, onChainTotal: 1000.0, difference: 0.0, matched: true });
			await walletHandlers.handleWalletStats(ctx as Context);
			const replies = getAllReplies(ctx);
			expect(replies.some(r => r.includes('Wallet System Statistics'))).toBe(true);
			expect(replies.some(r => r.includes('Balanced'))).toBe(true);
		});
	});

	describe('/giveaway (admin only)', () => {
		it('distributes giveaway to users', async () => {
			let ctx = createPlebContext({ userId: 444444444, messageText: '/giveaway 10 @user1' });
			(roles.checkIsElevated as Mock).mockReturnValue(false);
			await walletHandlers.handleGiveaway(ctx as Context);
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('requires elevated permissions'));

			ctx = createOwnerContext({ userId: 111111111, messageText: '/giveaway 25 @user1 @user2' });
			(roles.checkIsElevated as Mock).mockReturnValue(true);
			(UnifiedWalletService.findUserByUsername as Mock).mockResolvedValueOnce({ id: 444444444, username: 'user1' }).mockResolvedValueOnce({ id: 333333333, username: 'user2' });
			(UnifiedWalletService.distributeGiveaway as Mock).mockResolvedValue({ succeeded: [444444444, 333333333], failed: [], totalDistributed: 50.0 });
			await walletHandlers.handleGiveaway(ctx as Context);
			const replies = getAllReplies(ctx);
			expect(replies.some(r => r.includes('Giveaway Complete'))).toBe(true);
			expect(replies.some(r => r.includes('Successful: 2'))).toBe(true);
		});
	});

	describe('/treasurybalance', () => {
		it('shows treasury balance', async () => {
			const ctx = createAdminContext({ userId: 222222222 });
			(LedgerService.getUserBalance as Mock).mockResolvedValue(500.0);
			await walletHandlers.handleTreasuryBalance(ctx as Context);
			expect(LedgerService.getUserBalance).toHaveBeenCalledWith(-1);
			expect(getReplyText(ctx)).toContain('500.000000 JUNO');
		});
	});

	describe('/fundtreasury (owner only)', () => {
		it('handles treasury funding operations', async () => {
			// Help when no args
			let ctx = createOwnerContext({ userId: 111111111, messageText: '/fundtreasury' });
			(LedgerService.getUserBalance as Mock).mockResolvedValue(100.0);
			await walletHandlers.handleFundTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Fund Game Treasury');

			// Deposit instructions
			ctx = createOwnerContext({ userId: 111111111, messageText: '/fundtreasury deposit' });
			(LedgerService.getUserBalance as Mock).mockResolvedValue(100.0);
			await walletHandlers.handleFundTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Treasury External Deposit');

			// Transfer to treasury
			ctx = createOwnerContext({ userId: 111111111, messageText: '/fundtreasury 50' });
			(LedgerService.getUserBalance as Mock).mockResolvedValueOnce(100.0).mockResolvedValueOnce(200.0).mockResolvedValueOnce(150.0);
			(LedgerService.transferBetweenUsers as Mock).mockResolvedValue({ success: true, fromBalance: 150.0 });
			await walletHandlers.handleFundTreasury(ctx as Context);
			expect(LedgerService.transferBetweenUsers).toHaveBeenCalledWith(111111111, -1, 50, 'Fund game treasury');
			expect(getReplyText(ctx)).toContain('Treasury Funded');
		});
	});

	describe('/withdrawtreasury (owner only)', () => {
		it('handles treasury withdrawals', async () => {
			// Help
			let ctx = createOwnerContext({ userId: 111111111, messageText: '/withdrawtreasury' });
			(LedgerService.getUserBalance as Mock).mockResolvedValue(500.0);
			await walletHandlers.handleWithdrawTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Withdraw from Treasury');

			// Successful withdrawal
			ctx = createOwnerContext({ userId: 111111111, messageText: '/withdrawtreasury 100' });
			(LedgerService.getUserBalance as Mock).mockResolvedValueOnce(500.0).mockResolvedValueOnce(400.0);
			(LedgerService.transferBetweenUsers as Mock).mockResolvedValue({ success: true, toBalance: 100.0 });
			await walletHandlers.handleWithdrawTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Treasury Withdrawal Complete');

			// Insufficient balance
			ctx = createOwnerContext({ userId: 111111111, messageText: '/withdrawtreasury 1000' });
			(LedgerService.getUserBalance as Mock).mockResolvedValue(500.0);
			await walletHandlers.handleWithdrawTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Insufficient treasury balance');
		});
	});

	describe('/checkdeposit', () => {
		it('validates and checks deposits', async () => {
			let ctx = createPlebContext({ userId: 444444444, messageText: '/checkdeposit' });
			await walletHandlers.handleCheckDeposit(ctx as Context);
			expect(getReplyText(ctx)).toContain('Invalid format');

			ctx = createPlebContext({ userId: 444444444, messageText: '/checkdeposit ABCD1234' });
			await walletHandlers.handleCheckDeposit(ctx as Context);
			expect(ctx.reply).toHaveBeenCalled();
		});
	});

	describe('/reconcile (admin only)', () => {
		it('performs balance reconciliation', async () => {
			const ctx = createOwnerContext({ userId: 111111111 });
			await walletHandlers.handleReconcile(ctx as Context);
			const replies = getAllReplies(ctx);
			expect(replies.some(r => r.includes('Running balance reconciliation'))).toBe(true);
			// Reconcile may or may not complete depending on mock state
			expect(ctx.reply).toHaveBeenCalled();
		});
	});

	describe('/contributetreasury (admin only)', () => {
		it('handles admin treasury contributions', async () => {
			let ctx = createAdminContext({ userId: 222222222, messageText: '/contributetreasury' });
			(LedgerService.getUserBalance as Mock).mockResolvedValueOnce(100.0).mockResolvedValueOnce(200.0);
			await walletHandlers.handleContributeTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Contribute to Treasury');

			ctx = createAdminContext({ userId: 222222222, messageText: '/contributetreasury 25' });
			(LedgerService.getUserBalance as Mock).mockResolvedValueOnce(100.0).mockResolvedValueOnce(200.0).mockResolvedValueOnce(125.0);
			(LedgerService.transferBetweenUsers as Mock).mockResolvedValue({ success: true, fromBalance: 175.0 });
			await walletHandlers.handleContributeTreasury(ctx as Context);
			expect(getReplyText(ctx)).toContain('Contribution Received');
		});
	});
});
