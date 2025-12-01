/**
 * Deposit instruction generation service module.
 * Generates clear, well-formatted deposit instructions with prominent memo warnings
 * to prevent users from losing funds by forgetting the memo field.
 *
 * @module services/depositInstructions
 */

import { bold, code, type FmtString, fmt } from "telegraf/format";
import { config } from "../config";
import { logger } from "../utils/logger";

/**
 * Service for generating clear deposit instructions with prominent memo warnings.
 * Provides both plain text and Markdown formatted instructions.
 */
export class DepositInstructionService {
	/**
	 * Generates comprehensive deposit instructions with memo warnings.
	 * Returns both plain text and Markdown formatted versions.
	 *
	 * @param userId - Telegram user ID (used as memo)
	 * @returns Object containing formatted instructions, wallet address, and memo
	 *
	 * @example
	 * ```typescript
	 * const instructions = DepositInstructionService.generateInstructions(123456);
	 * await ctx.reply(instructions.markdown, { parse_mode: 'Markdown' });
	 * ```
	 */
	static generateInstructions(userId: number): {
		text: string;
		markdown: FmtString;
		walletAddress: string;
		memo: string;
	} {
		const walletAddress = config.userFundsAddress || "NOT_CONFIGURED";
		const memo = userId.toString();

		// Plain text version
		const text = `
DEPOSIT INSTRUCTIONS
====================

Send JUNO to this address:
${walletAddress}

 CRITICAL - MEMO REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEMO: ${memo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 WARNING: Deposits WITHOUT the correct memo CANNOT be credited to your account!
 The memo MUST be EXACTLY: ${memo}
 This is YOUR user ID - do not use any other number!

DOUBLE CHECK:
- Address: ${walletAddress}
- Memo: ${memo}
- Do NOT include any extra text in the memo

Deposits without the correct memo will go to an unclaimed pool and require manual processing.
`;

		// Telegraf Format module version - address and memo in code for click-to-copy
		const markdown = fmt`Send JUNO to ${code(walletAddress)}
${bold("MEMO:")} ${code(memo)} (required - no memo = no credit)
/balance to check deposit`;

		return {
			text,
			markdown,
			walletAddress,
			memo,
		};
	}

	/**
	 * Generates a short reminder about the memo requirement.
	 *
	 * @param userId - Telegram user ID
	 * @returns Short memo reminder message
	 */
	static getMemoReminder(userId: number): string {
		return ` **REMEMBER**: Your memo MUST be \`${userId}\` or funds won't be credited!`;
	}

	/**
	 * Generates instructions for claiming unclaimed deposits.
	 *
	 * @returns Instructions for users who deposited without correct memo
	 */
	static getUnclaimedInstructions(): string {
		return `
 **Unclaimed Deposit?**

If you sent JUNO without a memo or with the wrong memo:

1. Find your transaction hash
2. Contact an admin with:
   • Transaction hash
   • Your user ID
   • Amount sent

Unclaimed deposits are processed manually and may take time.
Always use your user ID as memo to avoid this!
`;
	}

	/**
	 * Validates if a memo matches the expected format for a user.
	 *
	 * @param memo - Memo string from transaction
	 * @param expectedUserId - Expected user ID
	 * @returns Validation result with error message if invalid
	 *
	 * @example
	 * ```typescript
	 * const result = DepositInstructionService.validateMemo('123456', 123456);
	 * if (result.valid) {
	 *   console.log('Valid memo');
	 * } else {
	 *   console.log(`Invalid: ${result.error}`);
	 * }
	 * ```
	 */
	static validateMemo(
		memo: string,
		expectedUserId: number,
	): {
		valid: boolean;
		error?: string;
	} {
		if (!memo || memo.trim() === "") {
			return {
				valid: false,
				error: "No memo provided",
			};
		}

		const trimmedMemo = memo.trim();

		// Check if memo is exactly the user ID
		if (trimmedMemo === expectedUserId.toString()) {
			return { valid: true };
		}

		// Check if memo contains the user ID with extra text (warn but accept)
		if (trimmedMemo.includes(expectedUserId.toString())) {
			logger.warn("Memo contains user ID but has extra text", {
				memo: trimmedMemo,
				expectedUserId,
			});

			return {
				valid: true,
				error:
					"Memo contains extra text - please use only your user ID next time",
			};
		}

		// Check if it's a number but wrong user ID
		const memoAsNumber = parseInt(trimmedMemo, 10);
		if (!Number.isNaN(memoAsNumber)) {
			return {
				valid: false,
				error: `Wrong user ID in memo. Expected ${expectedUserId}, got ${memoAsNumber}`,
			};
		}

		return {
			valid: false,
			error: "Invalid memo format - must be your user ID",
		};
	}

	/**
	 * Formats a deposit confirmation message.
	 *
	 * @param userId - User ID who deposited
	 * @param amount - Amount deposited in JUNO
	 * @param txHash - Transaction hash
	 * @param newBalance - User's new balance after deposit
	 * @returns Formatted confirmation message
	 */
	static formatDepositConfirmation(
		userId: number,
		amount: number,
		txHash: string,
		newBalance: number,
	): string {
		return `
 **Deposit Confirmed!**

• Amount: \`${amount.toFixed(6)} JUNO\`
• From User: \`${userId}\`
• New Balance: \`${newBalance.toFixed(6)} JUNO\`
• Transaction: \`${txHash.substring(0, 10)}...\`

Your funds are now available for use!
`;
	}

	/**
	 * Formats a deposit error message based on the issue type.
	 *
	 * @param issue - Type of deposit issue
	 * @param details - Optional details about the issue
	 * @returns Formatted error message
	 */
	static formatDepositError(
		issue: "no_memo" | "wrong_memo" | "wrong_user" | "not_found",
		details?: any,
	): string {
		switch (issue) {
			case "no_memo":
				return `
 **Deposit Failed - No Memo**

Your deposit was received but **cannot be credited** because no memo was provided.

Your funds are in the unclaimed pool. Contact an admin with your transaction hash to claim them.

**Always include your user ID as memo!**
`;

			case "wrong_memo":
				return `
 **Deposit Failed - Wrong Memo**

Your deposit was received but the memo \`${details?.memo}\` doesn't match your user ID \`${details?.userId}\`.

Your funds are in the unclaimed pool. Contact an admin to claim them.
`;

			case "wrong_user":
				return `
 **Deposit Failed - User Not Found**

A deposit was received with memo \`${details?.memo}\` but this user ID doesn't exist.

The funds are in the unclaimed pool.
`;

			case "not_found":
				return `
 **Transaction Not Found**

The transaction hash \`${details?.txHash}\` was not found on the blockchain.

Please verify the transaction hash and try again.
`;

			default:
				return " **Deposit Error** - Please contact an admin for assistance.";
		}
	}
}
