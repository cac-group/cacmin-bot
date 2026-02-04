/** Role checking and authorization utilities for permission system */

import { config } from "../config";
import { query } from "../database";
import type { User } from "../types";

/**
 * Check if user is a configured owner (by config or database role).
 * Checks both the config.ownerIds array and the database role.
 *
 * @param userId - Telegram user ID
 * @returns True if user is an owner
 */
export const isOwner = (userId: number): boolean => {
	if (config.ownerIds.includes(userId)) return true;
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	return user?.role === "owner";
};

/**
 * Check if user is a configured admin (by config or database role).
 * Note: Owners are NOT considered admins by this function (use isOwnerOrAdmin for that).
 *
 * @param userId - Telegram user ID
 * @returns True if user is an admin
 */
export const isAdmin = (userId: number): boolean => {
	if (config.adminIds.includes(userId)) return true;
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	return user?.role === "admin";
};

/** Check if user ID matches group owner ID */
export const isGroupOwner = (userId: number, ownerId: number): boolean =>
	userId === ownerId;

/**
 * Check if user has specific role (exact match, not hierarchy-aware)
 * For hierarchy checks, use checkIsElevated
 */
export const hasRole = (
	userId: number,
	role: "owner" | "admin" | "elevated" | "default",
): boolean => {
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	return user?.role === role;
};

/**
 * Check if user has elevated permissions (hierarchy-aware)
 * Returns true if user is owner, admin, or elevated
 *
 * Role hierarchy: owner > admin > elevated > pleb/default
 */
export const checkIsElevated = (userId: number): boolean => {
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	return (
		user?.role === "owner" ||
		user?.role === "admin" ||
		user?.role === "elevated"
	);
};

/**
 * Check if user is immune to moderation actions
 * Admins and owners cannot be jailed, warned, muted, banned, or restricted
 */
export const isImmuneToModeration = (userId: number): boolean => {
	const user = query<User>("SELECT * FROM users WHERE id = ?", [userId])[0];
	return user?.role === "owner" || user?.role === "admin";
};
