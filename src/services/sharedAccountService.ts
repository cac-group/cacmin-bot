/**
 * Shared Account Service
 *
 * Manages shared accounts that multiple users can access with different permission levels.
 * Shared accounts use IDs from -100 to -999 (900 possible accounts).
 *
 * Permission Levels:
 * - view: Read-only access to balance and history
 * - spend: Can send funds (with optional spend limit)
 * - admin: Full control (can manage permissions, unlimited spending)
 *
 * @module services/sharedAccountService
 */

import { execute, get, query } from "../database";
import { logger, StructuredLogger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

/**
 * Permission level type
 */
export type PermissionLevel = "view" | "spend" | "admin";

/**
 * Shared account interface
 */
export interface SharedAccount {
	id: number;
	name: string;
	displayName: string | null;
	description: string | null;
	createdBy: number;
	createdAt: number;
	metadata: string | null;
}

/**
 * Permission record interface
 */
export interface Permission {
	id: number;
	sharedAccountId: number;
	userId: number;
	permissionLevel: PermissionLevel;
	spendLimit: number | null;
	grantedBy: number;
	grantedAt: number;
	revoked: number;
	revokedAt: number | null;
	revokedBy: number | null;
}

/**
 * Service for managing shared accounts and permissions
 */
export class SharedAccountService {
	/**
	 * Range for shared account IDs
	 */
	private static readonly MIN_SHARED_ACCOUNT_ID = -999;
	private static readonly MAX_SHARED_ACCOUNT_ID = -100;

	/**
	 * Creates a new shared account
	 *
	 * @param name - Unique account name (used in commands)
	 * @param displayName - Human-readable display name
	 * @param description - Account description
	 * @param createdBy - User ID of creator
	 * @returns Created account ID
	 *
	 * @example
	 * const accountId = await SharedAccountService.createSharedAccount(
	 *   'admin_pool',
	 *   'Admin Pool',
	 *   'Shared treasury for admins',
	 *   123456
	 * );
	 */
	static async createSharedAccount(
		name: string,
		displayName: string,
		description: string,
		createdBy: number,
	): Promise<number> {
		// Validate name
		if (!SharedAccountService.validateAccountName(name)) {
			throw new Error(
				"Invalid account name. Use lowercase letters, numbers, and underscores only.",
			);
		}

		// Check if name already exists
		const existing = await SharedAccountService.getSharedAccountByName(name);
		if (existing) {
			throw new Error(`Shared account with name '${name}' already exists.`);
		}

		// Get next available ID
		const accountId = await SharedAccountService.getNextAccountId();

		// Create account
		execute(
			`INSERT INTO shared_accounts (id, name, display_name, description, created_by)
       VALUES (?, ?, ?, ?, ?)`,
			[accountId, name, displayName, description, createdBy],
		);

		// Grant creator admin permission
		await SharedAccountService.grantPermission(
			accountId,
			createdBy,
			"admin",
			createdBy,
		);

		// Initialize balance in user_balances
		const { LedgerService } = await import("./ledgerService");
		await LedgerService.ensureUserBalance(accountId);

		StructuredLogger.logUserAction("Shared account created", {
			userId: createdBy,
			operation: "create_shared_account",
			accountId: accountId.toString(),
			accountName: name,
		});

		logger.info("Shared account created", {
			accountId,
			name,
			displayName,
			createdBy,
		});

		return accountId;
	}

	/**
	 * Deletes a shared account
	 *
	 * @param accountId - Account ID to delete
	 * @param deletedBy - User ID performing deletion (must have admin permission)
	 * @returns True if deleted successfully
	 *
	 * @example
	 * await SharedAccountService.deleteSharedAccount(-100, 123456);
	 */
	static async deleteSharedAccount(
		accountId: number,
		deletedBy: number,
	): Promise<boolean> {
		// Verify account exists
		const account = await SharedAccountService.getSharedAccount(accountId);
		if (!account) {
			throw new Error("Shared account not found.");
		}

		// Verify user has admin permission
		if (
			!(await SharedAccountService.hasPermission(accountId, deletedBy, "admin"))
		) {
			throw new Error("Only account admins can delete shared accounts.");
		}

		// Delete account (cascades to permissions due to foreign key)
		execute("DELETE FROM shared_accounts WHERE id = ?", [accountId]);

		StructuredLogger.logUserAction("Shared account deleted", {
			userId: deletedBy,
			operation: "delete_shared_account",
			accountId: accountId.toString(),
			accountName: account.name,
		});

		logger.info("Shared account deleted", {
			accountId,
			name: account.name,
			deletedBy,
		});

		return true;
	}

	/**
	 * Gets a shared account by ID
	 *
	 * @param accountId - Account ID
	 * @returns Shared account or null if not found
	 */
	static async getSharedAccount(
		accountId: number,
	): Promise<SharedAccount | null> {
		const account = get<any>("SELECT * FROM shared_accounts WHERE id = ?", [
			accountId,
		]);

		if (!account) return null;

		return {
			id: account.id,
			name: account.name,
			displayName: account.display_name,
			description: account.description,
			createdBy: account.created_by,
			createdAt: account.created_at,
			metadata: account.metadata,
		};
	}

	/**
	 * Gets a shared account by name
	 *
	 * @param name - Account name
	 * @returns Shared account or null if not found
	 */
	static async getSharedAccountByName(
		name: string,
	): Promise<SharedAccount | null> {
		const account = get<any>("SELECT * FROM shared_accounts WHERE name = ?", [
			name,
		]);

		if (!account) return null;

		return {
			id: account.id,
			name: account.name,
			displayName: account.display_name,
			description: account.description,
			createdBy: account.created_by,
			createdAt: account.created_at,
			metadata: account.metadata,
		};
	}

	/**
	 * Lists all shared accounts
	 *
	 * @returns Array of all shared accounts
	 */
	static async listSharedAccounts(): Promise<SharedAccount[]> {
		const accounts = query<any>("SELECT * FROM shared_accounts ORDER BY name");

		return accounts.map((account) => ({
			id: account.id,
			name: account.name,
			displayName: account.display_name,
			description: account.description,
			createdBy: account.created_by,
			createdAt: account.created_at,
			metadata: account.metadata,
		}));
	}

	/**
	 * Grants permission to a user for a shared account
	 *
	 * @param accountId - Account ID
	 * @param userId - User to grant permission to
	 * @param level - Permission level
	 * @param grantedBy - User granting the permission (must have admin)
	 * @param spendLimit - Optional spend limit (for 'spend' level only)
	 * @returns True if granted successfully
	 *
	 * @example
	 * // Grant admin access
	 * await SharedAccountService.grantPermission(-100, 789, 'admin', 123);
	 *
	 * // Grant spend access with 100 JUNO limit
	 * await SharedAccountService.grantPermission(-100, 456, 'spend', 123, 100);
	 */
	static async grantPermission(
		accountId: number,
		userId: number,
		level: PermissionLevel,
		grantedBy: number,
		spendLimit?: number,
	): Promise<boolean> {
		// Verify account exists
		const account = await SharedAccountService.getSharedAccount(accountId);
		if (!account) {
			throw new Error("Shared account not found.");
		}

		// Verify granter has admin permission (unless it's the creator during initialization)
		if (grantedBy !== account.createdBy || userId !== grantedBy) {
			if (
				!(await SharedAccountService.hasPermission(
					accountId,
					grantedBy,
					"admin",
				))
			) {
				throw new Error("Only account admins can grant permissions.");
			}
		}

		// Validate spend limit
		if (level === "spend" && spendLimit !== undefined && spendLimit < 0) {
			throw new Error("Spend limit must be positive.");
		}

		// Check if permission already exists
		const existing = await SharedAccountService.getUserPermission(
			accountId,
			userId,
		);
		if (existing && !existing.revoked) {
			throw new Error(
				"User already has permission. Use updatePermission to modify.",
			);
		}

		// Grant permission (convert spendLimit to micro-units for DB storage)
		const spendLimitMicro = spendLimit !== undefined
			? AmountPrecision.toDbMicro(spendLimit)
			: null;
		execute(
			`INSERT OR REPLACE INTO shared_account_permissions
       (shared_account_id, user_id, permission_level, spend_limit, granted_by)
       VALUES (?, ?, ?, ?, ?)`,
			[accountId, userId, level, spendLimitMicro, grantedBy],
		);

		StructuredLogger.logUserAction("Permission granted", {
			userId: grantedBy,
			operation: "grant_permission",
			accountId: accountId.toString(),
			targetUserId: userId.toString(),
			permissionLevel: level,
			spendLimit: spendLimit?.toString(),
		});

		logger.info("Permission granted", {
			accountId,
			userId,
			level,
			spendLimit,
			grantedBy,
		});

		return true;
	}

	/**
	 * Revokes permission from a user
	 *
	 * @param accountId - Account ID
	 * @param userId - User to revoke permission from
	 * @param revokedBy - User revoking the permission (must have admin)
	 * @returns True if revoked successfully
	 */
	static async revokePermission(
		accountId: number,
		userId: number,
		revokedBy: number,
	): Promise<boolean> {
		// Verify account exists
		const account = await SharedAccountService.getSharedAccount(accountId);
		if (!account) {
			throw new Error("Shared account not found.");
		}

		// Verify revoker has admin permission
		if (
			!(await SharedAccountService.hasPermission(accountId, revokedBy, "admin"))
		) {
			throw new Error("Only account admins can revoke permissions.");
		}

		// Prevent revoking creator's permission
		if (userId === account.createdBy) {
			throw new Error("Cannot revoke creator's admin permission.");
		}

		// Revoke permission (soft delete)
		const now = Math.floor(Date.now() / 1000);
		execute(
			`UPDATE shared_account_permissions
       SET revoked = 1, revoked_at = ?, revoked_by = ?
       WHERE shared_account_id = ? AND user_id = ? AND revoked = 0`,
			[now, revokedBy, accountId, userId],
		);

		StructuredLogger.logUserAction("Permission revoked", {
			userId: revokedBy,
			operation: "revoke_permission",
			accountId: accountId.toString(),
			targetUserId: userId.toString(),
		});

		logger.info("Permission revoked", {
			accountId,
			userId,
			revokedBy,
		});

		return true;
	}

	/**
	 * Updates an existing permission
	 *
	 * @param accountId - Account ID
	 * @param userId - User whose permission to update
	 * @param level - New permission level
	 * @param updatedBy - User updating the permission (must have admin)
	 * @param spendLimit - New spend limit (for 'spend' level)
	 * @returns True if updated successfully
	 */
	static async updatePermission(
		accountId: number,
		userId: number,
		level: PermissionLevel,
		updatedBy: number,
		spendLimit?: number,
	): Promise<boolean> {
		// Verify account exists
		const account = await SharedAccountService.getSharedAccount(accountId);
		if (!account) {
			throw new Error("Shared account not found.");
		}

		// Verify updater has admin permission
		if (
			!(await SharedAccountService.hasPermission(accountId, updatedBy, "admin"))
		) {
			throw new Error("Only account admins can update permissions.");
		}

		// Prevent updating creator's permission
		if (userId === account.createdBy) {
			throw new Error("Cannot update creator's admin permission.");
		}

		// Check if permission exists
		const existing = await SharedAccountService.getUserPermission(
			accountId,
			userId,
		);
		if (!existing || existing.revoked) {
			throw new Error(
				"User does not have active permission. Use grantPermission first.",
			);
		}

		// Update permission (convert spendLimit to micro-units for DB storage)
		const spendLimitMicro = spendLimit !== undefined
			? AmountPrecision.toDbMicro(spendLimit)
			: null;
		execute(
			`UPDATE shared_account_permissions
       SET permission_level = ?, spend_limit = ?
       WHERE shared_account_id = ? AND user_id = ? AND revoked = 0`,
			[level, spendLimitMicro, accountId, userId],
		);

		StructuredLogger.logUserAction("Permission updated", {
			userId: updatedBy,
			operation: "update_permission",
			accountId: accountId.toString(),
			targetUserId: userId.toString(),
			newLevel: level,
			spendLimit: spendLimit?.toString(),
		});

		logger.info("Permission updated", {
			accountId,
			userId,
			level,
			spendLimit,
			updatedBy,
		});

		return true;
	}

	/**
	 * Gets a user's permission for a shared account
	 *
	 * @param accountId - Account ID
	 * @param userId - User ID
	 * @returns Permission record or null if no permission
	 */
	static async getUserPermission(
		accountId: number,
		userId: number,
	): Promise<Permission | null> {
		const permission = get<any>(
			`SELECT * FROM shared_account_permissions
       WHERE shared_account_id = ? AND user_id = ? AND revoked = 0`,
			[accountId, userId],
		);

		if (!permission) return null;

		// spend_limit stored in micro-units, convert to JUNO
		const spendLimit = permission.spend_limit !== null
			? AmountPrecision.fromDbMicro(permission.spend_limit)
			: null;

		return {
			id: permission.id,
			sharedAccountId: permission.shared_account_id,
			userId: permission.user_id,
			permissionLevel: permission.permission_level,
			spendLimit,
			grantedBy: permission.granted_by,
			grantedAt: permission.granted_at,
			revoked: permission.revoked,
			revokedAt: permission.revoked_at,
			revokedBy: permission.revoked_by,
		};
	}

	/**
	 * Checks if a user has at least the specified permission level
	 *
	 * @param accountId - Account ID
	 * @param userId - User ID
	 * @param requiredLevel - Required permission level
	 * @returns True if user has required level or higher
	 *
	 * @example
	 * // Check if user can view
	 * const canView = await SharedAccountService.hasPermission(-100, userId, 'view');
	 *
	 * // Check if user can spend
	 * const canSpend = await SharedAccountService.hasPermission(-100, userId, 'spend');
	 */
	static async hasPermission(
		accountId: number,
		userId: number,
		requiredLevel: PermissionLevel,
	): Promise<boolean> {
		const permission = await SharedAccountService.getUserPermission(
			accountId,
			userId,
		);
		if (!permission) return false;

		// Permission hierarchy: admin > spend > view
		const levels: Record<PermissionLevel, number> = {
			view: 1,
			spend: 2,
			admin: 3,
		};

		return levels[permission.permissionLevel] >= levels[requiredLevel];
	}

	/**
	 * Checks if a user can spend a specific amount
	 *
	 * @param accountId - Account ID
	 * @param userId - User ID
	 * @param amount - Amount to spend
	 * @returns True if user can spend the amount
	 */
	static async canSpend(
		accountId: number,
		userId: number,
		amount: number,
	): Promise<boolean> {
		const permission = await SharedAccountService.getUserPermission(
			accountId,
			userId,
		);
		if (!permission) return false;

		// Must have at least 'spend' level
		if (permission.permissionLevel === "view") return false;

		// Admin has unlimited spending
		if (permission.permissionLevel === "admin") return true;

		// Check spend limit for 'spend' level
		if (permission.spendLimit === null) return true; // No limit
		return amount <= permission.spendLimit;
	}

	/**
	 * Lists all permissions for a user across all shared accounts
	 *
	 * @param userId - User ID
	 * @returns Array of permissions
	 */
	static async listUserPermissions(userId: number): Promise<Permission[]> {
		const permissions = query<any>(
			`SELECT * FROM shared_account_permissions
       WHERE user_id = ? AND revoked = 0
       ORDER BY granted_at DESC`,
			[userId],
		);

		return permissions.map((p) => ({
			id: p.id,
			sharedAccountId: p.shared_account_id,
			userId: p.user_id,
			permissionLevel: p.permission_level,
			spendLimit: p.spend_limit !== null
				? AmountPrecision.fromDbMicro(p.spend_limit)
				: null,
			grantedBy: p.granted_by,
			grantedAt: p.granted_at,
			revoked: p.revoked,
			revokedAt: p.revoked_at,
			revokedBy: p.revoked_by,
		}));
	}

	/**
	 * Lists all permissions for a shared account
	 *
	 * @param accountId - Account ID
	 * @returns Array of permissions
	 */
	static async listAccountPermissions(
		accountId: number,
	): Promise<Permission[]> {
		const permissions = query<any>(
			`SELECT * FROM shared_account_permissions
       WHERE shared_account_id = ? AND revoked = 0
       ORDER BY permission_level DESC, granted_at ASC`,
			[accountId],
		);

		return permissions.map((p) => ({
			id: p.id,
			sharedAccountId: p.shared_account_id,
			userId: p.user_id,
			permissionLevel: p.permission_level,
			spendLimit: p.spend_limit !== null
				? AmountPrecision.fromDbMicro(p.spend_limit)
				: null,
			grantedBy: p.granted_by,
			grantedAt: p.granted_at,
			revoked: p.revoked,
			revokedAt: p.revoked_at,
			revokedBy: p.revoked_by,
		}));
	}

	/**
	 * Gets the next available shared account ID
	 * Shared accounts use IDs from -100 to -999
	 *
	 * @returns Next available ID (most negative first: -100, -101, etc.)
	 */
	static async getNextAccountId(): Promise<number> {
		const result = get<{ minId: number | null }>(
			"SELECT MIN(id) as minId FROM shared_accounts WHERE id >= ? AND id <= ?",
			[
				SharedAccountService.MIN_SHARED_ACCOUNT_ID,
				SharedAccountService.MAX_SHARED_ACCOUNT_ID,
			],
		);

		// If no accounts exist, start at -100
		if (!result || result.minId === null) {
			return SharedAccountService.MAX_SHARED_ACCOUNT_ID;
		}

		// If we've used all IDs, throw error
		if (result.minId === SharedAccountService.MIN_SHARED_ACCOUNT_ID) {
			throw new Error("Maximum number of shared accounts (900) reached.");
		}

		// Return next ID (one more negative)
		return result.minId - 1;
	}

	/**
	 * Validates account name format
	 *
	 * @param name - Account name to validate
	 * @returns True if valid
	 */
	static validateAccountName(name: string): boolean {
		// Allow lowercase letters, numbers, and underscores
		// Must be 3-32 characters
		return /^[a-z0-9_]{3,32}$/.test(name);
	}
}
