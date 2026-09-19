/** Violation tracking and fine management service */

import { execute, get, query } from "../database";
import type { Violation } from "../types";
import { StructuredLogger } from "../utils/logger";
import { PriceService } from "./priceService";

/**
 * Create violation record for user
 * Calculates fine based on restriction type using USD pricing, increments warning count
 */
export async function createViolation(
	userId: number,
	restriction: string,
	message?: string,
): Promise<number> {
	// Calculate fine based on restriction type (USD converted to JUNO)
	const fineAmount = await PriceService.calculateViolationFine(restriction);

	const result = execute(
		`INSERT INTO violations (user_id, restriction, message, bail_amount)
     VALUES (?, ?, ?, ?)`,
		[userId, restriction, message, fineAmount],
	);

	// Update user warning count
	execute(
		"UPDATE users SET warning_count = warning_count + 1, updated_at = ? WHERE id = ?",
		[Math.floor(Date.now() / 1000), userId],
	);

	return result.lastInsertRowid as number;
}

/** SQL fragment for mapping violation columns to camelCase */
const VIOLATION_SELECT = `SELECT id, user_id AS userId, rule_id AS ruleId, restriction,
	message, timestamp, bail_amount AS bailAmount, paid, payment_tx AS paymentTx,
	paid_by_user_id AS paidByUserId, paid_at AS paidAt FROM violations`;

/** Get only unpaid violations for user (for calculating outstanding fines) */
export function getUnpaidViolations(userId: number): Violation[] {
	return query<Violation>(
		`${VIOLATION_SELECT} WHERE user_id = ? AND paid = 0`,
		[userId],
	);
}

/**
 * Mark violation as paid with transaction details
 * Records tx hash, payer user ID (if bail paid by another), and timestamp
 */
export function markViolationPaid(
	violationId: number,
	txHash: string,
	paidByUserId?: number,
): void {
	const now = Math.floor(Date.now() / 1000);
	execute(
		"UPDATE violations SET paid = 1, payment_tx = ?, paid_by_user_id = ?, paid_at = ? WHERE id = ?",
		[txHash, paidByUserId || null, now, violationId],
	);

	StructuredLogger.logTransaction("Violation payment recorded", {
		txHash,
		operation: "violation_paid",
		userId: paidByUserId,
	});
}

/** Calculate total amount owed in unpaid fines for user */
export function getTotalFines(userId: number): number {
	const result = get<{ total: number }>(
		"SELECT SUM(bail_amount) as total FROM violations WHERE user_id = ? AND paid = 0",
		[userId],
	);
	return result?.total || 0;
}
