/** User management service - user records and restrictions */

import { execute, query } from "../database";
import type { User, UserRestriction } from "../types";
import { StructuredLogger } from "../utils/logger";

/**
 * Create new user with all required fields
 * Used internally for consistent user record creation
 * Returns null if user already exists
 */
export const createUser = (
	userId: number,
	username: string,
	role: string = "pleb",
	source: string = "unknown",
): User | null => {
	const existing = query<User>("SELECT id FROM users WHERE id = ?", [
		userId,
	])[0];

	if (existing) {
		return null; // User already exists
	}

	const now = Math.floor(Date.now() / 1000);
	execute(
		"INSERT INTO users (id, username, role, whitelist, blacklist, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[userId, username, role, 0, 0, now, now],
	);

	StructuredLogger.logUserAction("User created", {
		userId,
		username,
		role,
		operation: "user_created",
		source,
	});

	return query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
};

/**
 * Ensure user exists in database, create if missing
 * Primary function used by middleware/handlers (synchronous by design)
 *
 * Behavior:
 * - User doesn't exist: Creates with default role 'pleb'
 * - User exists: Updates username (Telegram usernames are mutable)
 */
export const ensureUserExists = (userId: number, username: string): void => {
	const userExists = query<User>("SELECT id FROM users WHERE id = ?", [
		userId,
	])[0];

	if (!userExists) {
		createUser(userId, username, "pleb", "ensure_exists");
	} else {
		// Update username if it changed (Telegram allows username changes)
		execute("UPDATE users SET username = ?, updated_at = ? WHERE id = ?", [
			username,
			Math.floor(Date.now() / 1000),
			userId,
		]);
	}
};

/**
 * Get userId by username (database lookup only)
 * Does NOT create users or query Telegram API
 * Returns null if username not found
 */
export const getUserIdByUsername = (username: string): number | null => {
	const cleanUsername = username.replace(/^@/, "");

	const user = query<User>("SELECT id FROM users WHERE username = ?", [
		cleanUsername,
	])[0];

	return user?.id || null;
};

/** Get user by userId (primary lookup method - userId is immutable) */
export const getUserById = (userId: number): User | null => {
	return query<User>("SELECT * FROM users WHERE id = ?", [userId])[0] || null;
};

/** Check if user exists (lightweight check before operations) */
export const userExists = (userId: number): boolean => {
	return !!query<User>("SELECT id FROM users WHERE id = ?", [userId])[0];
};

/**
 * Set or update a user's role in the database.
 * Creates user if not exists, updates role if exists.
 *
 * @param userId - Telegram user ID
 * @param username - Current username
 * @param role - Target role: 'owner', 'admin', 'elevated', or 'pleb'
 */
export const setUserRole = (
	userId: number,
	username: string,
	role: "owner" | "admin" | "elevated" | "pleb",
): void => {
	execute(
		`INSERT INTO users (id, username, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET role = ?, username = COALESCE(?, username), updated_at = ?`,
		[
			userId,
			username,
			role,
			Math.floor(Date.now() / 1000),
			Math.floor(Date.now() / 1000),
			role,
			username,
			Math.floor(Date.now() / 1000),
		],
	);

	StructuredLogger.logSecurityEvent("User role updated", {
		userId,
		username,
		role,
		operation: "set_role",
	});
};

/**
 * Add restriction for user
 * Can be time-limited or permanent with optional metadata and severity levels
 * restrictedUntil: Unix timestamp (null for permanent)
 * severity: 'delete' (default), 'mute' (30 min), or 'jail' (1 hour immediate)
 * violationThreshold: Number of violations before auto-jail (default: 5)
 * autoJailDuration: Auto-jail duration in minutes (default: 2880 = 2 days)
 * autoJailFine: JUNO fine amount for auto-jail (default: 10.0)
 */
export const addUserRestriction = (
	userId: number,
	restriction: string,
	restrictedAction?: string,
	metadata?: Record<string, any>,
	restrictedUntil?: number,
	severity: "delete" | "mute" | "jail" = "delete",
	violationThreshold: number = 5,
	autoJailDuration: number = 2880,
	autoJailFine: number = 10.0,
): void => {
	execute(
		"INSERT INTO user_restrictions (user_id, restriction, restricted_action, metadata, restricted_until, severity, violation_threshold, auto_jail_duration, auto_jail_fine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			userId,
			restriction,
			restrictedAction || null,
			metadata ? JSON.stringify(metadata) : null,
			restrictedUntil || null,
			severity,
			violationThreshold,
			autoJailDuration,
			autoJailFine,
		],
	);

	StructuredLogger.logSecurityEvent("User restriction added", {
		userId,
		operation: "add_restriction",
		restrictedAction: restriction,
		severity,
		violationThreshold,
		autoJailDuration,
		autoJailFine,
	});
};

/** Remove restriction for user (completely removes from database) */
export const removeUserRestriction = (
	userId: number,
	restriction: string,
): void => {
	execute(
		"DELETE FROM user_restrictions WHERE user_id = ? AND restriction = ?",
		[userId, restriction],
	);

	StructuredLogger.logSecurityEvent("User restriction removed", {
		userId,
		operation: "remove_restriction",
		restrictedAction: restriction,
	});
};

/**
 * Get all restrictions for user (regardless of expiration)
 * Callers should check restrictedUntil field to filter expired
 */
export const getUserRestrictions = (userId: number): UserRestriction[] => {
	return query<UserRestriction>(
		`SELECT id, user_id AS userId, restriction, restricted_action AS restrictedAction,
		 metadata, restricted_until AS restrictedUntil, severity, violation_threshold AS violationThreshold,
		 auto_jail_duration AS autoJailDuration, auto_jail_fine AS autoJailFine,
		 fine_amount AS fineAmount, custom_message AS customMessage, created_at AS createdAt
		 FROM user_restrictions WHERE user_id = ?`,
		[userId],
	);
};
