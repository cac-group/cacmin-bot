/** User resolution utilities for converting usernames/IDs to User objects */

import type { Context } from "telegraf";
import { get } from "../database";
import { ensureUserExists } from "../services/userService";
import type { User } from "../types";

/**
 * Resolve username or ID string to numeric userId
 * Supports: numeric ID, @username, username (case-insensitive)
 * Returns null if not found in database
 */
export function resolveUserId(userIdentifier: string): number | null {
	// Remove @ prefix if present
	const cleanIdentifier = userIdentifier.startsWith("@")
		? userIdentifier.substring(1)
		: userIdentifier;

	// Check if it's a numeric ID
	const numericId = parseInt(cleanIdentifier, 10);
	if (!Number.isNaN(numericId)) {
		// Verify the user exists
		const user = get<User>("SELECT id FROM users WHERE id = ?", [numericId]);
		return user ? numericId : null;
	}

	// Try to find by username (case-insensitive)
	const user = get<User>(
		"SELECT id FROM users WHERE LOWER(username) = LOWER(?)",
		[cleanIdentifier],
	);

	return user ? user.id : null;
}

/**
 * Resolve username or ID to complete User object
 * Returns full user record with role, restrictions, etc.
 * Case-insensitive for username lookups
 */
export function resolveUser(userIdentifier: string): User | null {
	// Remove @ prefix if present
	const cleanIdentifier = userIdentifier.startsWith("@")
		? userIdentifier.substring(1)
		: userIdentifier;

	// Check if it's a numeric ID
	const numericId = parseInt(cleanIdentifier, 10);
	if (!Number.isNaN(numericId)) {
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

/** Format User object for display: @username (123456) */
export function formatUserDisplay(user: User): string {
	return `@${user.username} (${user.id})`;
}

/**
 * Format user ID for display by looking up username
 * Falls back to (123456) if username not found
 */
export function formatUserIdDisplay(userId: number): string {
	const user = get<User>("SELECT * FROM users WHERE id = ?", [userId]);
	return user ? formatUserDisplay(user) : `(${userId})`;
}

/**
 * Result of resolving a target user from command context
 */
export interface TargetUserResult {
	userId: number;
	username: string;
	source: "args" | "reply";
}

/**
 * Resolve target user from command arguments or reply-to message.
 * If args provided, uses that. Otherwise checks if message is a reply
 * and uses the replied-to user. Ensures user exists in database.
 *
 * @param ctx - Telegraf context
 * @param args - Command arguments (first arg should be user identifier)
 * @returns Target user info or null if not resolvable
 */
export function resolveTargetUser(
	ctx: Context,
	args: string[],
): TargetUserResult | null {
	// Priority 1: Check command arguments
	if (args.length > 0 && args[0]) {
		const userIdent = args[0];
		const cleanIdent = userIdent.startsWith("@")
			? userIdent.substring(1)
			: userIdent;

		// Try numeric ID first
		const numericId = parseInt(cleanIdent, 10);
		if (!Number.isNaN(numericId) && numericId > 0) {
			const user = get<User>("SELECT * FROM users WHERE id = ?", [numericId]);
			if (user) {
				return { userId: user.id, username: user.username, source: "args" };
			}
		}

		// Try username lookup
		const user = get<User>(
			"SELECT * FROM users WHERE LOWER(username) = LOWER(?)",
			[cleanIdent],
		);
		if (user) {
			return { userId: user.id, username: user.username, source: "args" };
		}

		// Not found in database
		return null;
	}

	// Priority 2: Check reply-to message
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
}

/**
 * Get remaining args after removing the user identifier (if from args).
 * Use when command has format: /cmd <user> <other args...>
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
