/** Violation tracking service. Violations are warning history; the only
 * payable amount in the bot is the fixed jail bail. */

import { config } from "../config";
import { execute } from "../database";
import { AmountPrecision } from "../utils/precision";

/**
 * Create violation record for user.
 * Records the fixed fine amount for history and increments warning count.
 */
export async function createViolation(
	userId: number,
	restriction: string,
	message?: string,
): Promise<number> {
	const result = execute(
		`INSERT INTO violations (user_id, restriction, message, bail_amount)
     VALUES (?, ?, ?, ?)`,
		[
			userId,
			restriction,
			message,
			AmountPrecision.toDbMicro(config.defaultJailBailAmount),
		],
	);

	execute(
		"UPDATE users SET warning_count = warning_count + 1, updated_at = ? WHERE id = ?",
		[Math.floor(Date.now() / 1000), userId],
	);

	return result.lastInsertRowid as number;
}
