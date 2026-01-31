/**
 * User resolution utilities for the CAC Admin Bot.
 * Provides functions for resolving user identifiers (usernames, IDs, reply-to)
 * to database User objects, supporting flexible command invocation patterns.
 *
 * @module utils/userResolver
 */

import type { Context } from "telegraf";
import { get } from "../database";
import { ensureUserExists } from "../services/userService";
import type { User } from "../types";

/**
 * Resolves a username or user ID string to a complete User object from the database.
 *
 * Supports multiple identifier formats:
 * - Numeric ID: "123456789"
 * - @username: "@alice"
 * - Bare username: "alice" (case-insensitive)
 *
 * @param userIdentifier - The identifier to resolve (numeric ID, @username, or username)
 * @returns The User object if found in database, null otherwise
 *
 * @example
 * ```typescript
 * const user = resolveUser("@alice");     // Find by @username
 * const user = resolveUser("123456789");  // Find by numeric ID
 * const user = resolveUser("alice");      // Find by bare username
 * ```
 */
export function resolveUser(userIdentifier: string): User | null {
	// Remove @ prefix if present
	const cleanIdentifier = userIdentifier.startsWith("@")
		? userIdentifier.substring(1)
		: userIdentifier;

	// Check if it's a numeric ID
	const numericId = parseInt(cleanIdentifier, 10);
	if (!Number.isNaN(numericId) && numericId > 0) {
		const user = get<User>("SELECT * FROM users WHERE id = ?", [numericId]);
		return user || null;
	}

	// Try to find by username (case-insensitive)
	const user = get<User>(
		"SELECT * FROM users WHERE LOWER(username) = LOWER(?)",
		[cleanIdentifier],
	);

	return user || null;
}

/**
 * Resolves a username or ID string to a numeric user ID.
 * Convenience wrapper around {@link resolveUser} when only the ID is needed.
 *
 * @param userIdentifier - The identifier to resolve (numeric ID, @username, or username)
 * @returns The numeric user ID if found, null otherwise
 *
 * @example
 * ```typescript
 * const userId = resolveUserId("@alice");  // Returns 123456789
 * const userId = resolveUserId("invalid"); // Returns null
 * ```
 */
export function resolveUserId(userIdentifier: string): number | null {
	const user = resolveUser(userIdentifier);
	return user ? user.id : null;
}

/**
 * Formats a User object for display in messages.
 *
 * @param user - The User object to format
 * @returns Formatted string in the format "@username (123456)"
 *
 * @example
 * ```typescript
 * const display = formatUserDisplay(user); // "@alice (123456789)"
 * ```
 */
export function formatUserDisplay(user: User): string {
	return `@${user.username} (${user.id})`;
}

/**
 * Formats a user ID for display by looking up the username in the database.
 * Falls back to displaying just the ID if the user is not found.
 *
 * @param userId - The numeric user ID to format
 * @returns Formatted string: "@username (123456)" if found, "(123456)" otherwise
 *
 * @example
 * ```typescript
 * const display = formatUserIdDisplay(123456789); // "@alice (123456789)"
 * const display = formatUserIdDisplay(999999999); // "(999999999)"
 * ```
 */
export function formatUserIdDisplay(userId: number): string {
	const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
	return user ? formatUserDisplay(user) : `(${userId})`;
}

/**
 * Result of resolving a target user from command context.
 * Contains the resolved user information and the source of resolution.
 */
export interface TargetUserResult {
	/** The numeric Telegram user ID */
	userId: number;
	/** The user's username (or generated fallback like "user_123456") */
	username: string;
	/** How the user was resolved: "args" from command arguments, "reply" from reply-to message */
	source: "args" | "reply";
}

/**
 * Resolves the target user from command arguments or reply-to message.
 * Supports flexible invocation patterns for moderation and other user-targeted commands.
 *
 * **Invocation Patterns:**
 * - Direct with @username: `/jail @alice 1000` - jail alice for 1000 minutes
 * - Direct with user ID: `/jail 123456 1000` - jail user 123456 for 1000 minutes
 * - Reply-based: Reply to a message with `/jail 1000` - jail replied-to user for 1000 minutes
 *
 * **Resolution Logic:**
 * 1. If args[0] starts with @, treat as username reference (no fallback on failure)
 * 2. If args[0] is purely numeric and user exists in DB, use that user
 * 3. If args[0] is numeric but user doesn't exist, check reply-to (number is likely a parameter)
 * 4. If no args provided, check reply-to message
 *
 * The `source` field in the result indicates how the user was resolved, which is
 * important for {@link getRemainingArgs} to correctly extract additional parameters.
 *
 * @param ctx - Telegraf context containing the message and reply-to information
 * @param args - Command arguments (first arg might be user identifier or parameter)
 * @returns Target user info with source, or null if user cannot be resolved
 *
 * @example
 * ```typescript
 * // Direct invocation: /jail @alice 1000
 * const target = resolveTargetUser(ctx, ["@alice", "1000"]);
 * // Returns { userId: 123, username: "alice", source: "args" }
 *
 * // Reply-based invocation: /jail 1000 (replying to alice's message)
 * const target = resolveTargetUser(ctx, ["1000"]);
 * // Returns { userId: 123, username: "alice", source: "reply" }
 *
 * // No target found
 * const target = resolveTargetUser(ctx, ["@nonexistent"]);
 * // Returns null
 * ```
 */
export function resolveTargetUser(
	ctx: Context,
	args: string[],
): TargetUserResult | null {
	// Helper to get reply-to user
	const getReplyToUser = (): TargetUserResult | null => {
		const replyTo =
			ctx.message && "reply_to_message" in ctx.message
				? ctx.message.reply_to_message
				: null;

		if (replyTo?.from && !replyTo.from.is_bot) {
			const replyUserId = replyTo.from.id;
			const replyUsername = replyTo.from.username || `user_${replyUserId}`;

			// Ensure user exists in database
			ensureUserExists(replyUserId, replyUsername);

			return { userId: replyUserId, username: replyUsername, source: "reply" };
		}
		return null;
	};

	// Priority 1: Check command arguments
	if (args.length > 0 && args[0]) {
		const firstArg = args[0];

		// If starts with @, it's definitely a username reference - no fallback
		if (firstArg.startsWith("@")) {
			const user = resolveUser(firstArg);
			if (user) {
				return { userId: user.id, username: user.username, source: "args" };
			}
			// @ reference that doesn't exist - clear error, no fallback
			return null;
		}

		// Try to resolve as user (could be numeric ID or bare username)
		const user = resolveUser(firstArg);
		if (user) {
			return { userId: user.id, username: user.username, source: "args" };
		}

		// User not found - if this looks like a number (potential parameter like duration),
		// and there's a reply-to message, use the reply target instead
		const isNumeric = /^\d+$/.test(firstArg);
		if (isNumeric) {
			const replyUser = getReplyToUser();
			if (replyUser) {
				return replyUser;
			}
		}

		// Not found in database and no valid fallback
		return null;
	}

	// Priority 2: No args - check reply-to message
	return getReplyToUser();
}

/**
 * Extracts remaining arguments after the user identifier has been consumed.
 * Used in conjunction with {@link resolveTargetUser} for commands that take
 * additional parameters after the target user.
 *
 * When the user was resolved from command arguments (source: "args"), the first
 * argument is skipped. When resolved from reply-to (source: "reply"), all
 * arguments are returned since none were consumed for user identification.
 *
 * @param args - Original command arguments
 * @param result - Result from resolveTargetUser, or null
 * @returns Arguments remaining after user identifier (if any) is removed
 *
 * @example
 * ```typescript
 * // User from args: /jail @alice 1000
 * const target = resolveTargetUser(ctx, ["@alice", "1000"]);
 * const remaining = getRemainingArgs(["@alice", "1000"], target);
 * // Returns ["1000"] - first arg consumed
 *
 * // User from reply: /jail 1000 (replying to message)
 * const target = resolveTargetUser(ctx, ["1000"]);
 * const remaining = getRemainingArgs(["1000"], target);
 * // Returns ["1000"] - no args consumed
 *
 * // No user found
 * const remaining = getRemainingArgs(["1000"], null);
 * // Returns ["1000"]
 * ```
 */
export function getRemainingArgs(
	args: string[],
	result: TargetUserResult | null,
): string[] {
	if (!result || result.source === "reply") {
		// No user arg consumed, return all args
		return args;
	}
	// User was from args, skip first arg
	return args.slice(1);
}
