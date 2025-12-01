/** Exact 6-decimal JUNO arithmetic - NO ROUNDING, uses micro-units (1M uJUNO = 1 JUNO) */

export class AmountPrecision {
	/** Sanitize a value that may have floating-point imprecision (e.g., from SQLite REAL) */
	static sanitize(amount: number): number {
		// Round to 6 decimals to eliminate floating-point representation errors
		return Math.round(amount * 1_000_000) / 1_000_000;
	}
	/** Validate ≤6 decimals, return exact 6-decimal repr (throws if >6) */
	static validateAmount(amount: number): number {
		// Convert to string to check decimal places
		const amountStr = amount.toString();

		// Check if it has a decimal point
		if (amountStr.includes(".")) {
			const parts = amountStr.split(".");
			const decimals = parts[1];

			// If more than 6 decimals, it's invalid
			if (decimals.length > 6) {
				throw new Error(
					`Invalid amount precision: ${amount} has ${decimals.length} decimals. ` +
						`JUNO amounts must have at most 6 decimal places.`,
				);
			}
		}

		// Parse to exactly 6 decimals (padding with zeros if needed for storage)
		return AmountPrecision.toExact6Decimals(amount);
	}

	/** Convert to exact 6 decimals (pads zeros, throws if >6) */
	static toExact6Decimals(amount: number): number {
		// First validate it doesn't have too many decimals
		const amountStr = amount.toString();

		if (amountStr.includes(".")) {
			const decimals = amountStr.split(".")[1];
			if (decimals.length > 6) {
				throw new Error(
					`Cannot convert ${amount} to 6 decimals - too many decimal places`,
				);
			}
		}

		// Convert to 6 decimal string representation
		const fixed = amount.toFixed(6);

		// Parse back to number (this preserves exact precision)
		return parseFloat(fixed);
	}

	/** Format amount as 6-decimal string */
	static format(amount: number): string {
		return amount.toFixed(6);
	}

	/** Convert JUNO → uJUNO (1 JUNO = 1M uJUNO) */
	static toMicroJuno(amount: number): number {
		// Validate first
		AmountPrecision.validateAmount(amount);

		// Multiply by 1 million and ensure it's an integer
		const micro = Math.floor(amount * 1_000_000);

		// Verify no precision loss
		const backToJuno = micro / 1_000_000;
		if (Math.abs(backToJuno - amount) > 0.000001) {
			throw new Error(
				`Precision loss detected converting ${amount} to micro units`,
			);
		}

		return micro;
	}

	/** Convert uJUNO → JUNO (must be integer) */
	static fromMicroJuno(microAmount: number): number {
		// Ensure it's an integer
		if (!Number.isInteger(microAmount)) {
			throw new Error(`Micro amount must be an integer, got ${microAmount}`);
		}

		// Convert to JUNO with exactly 6 decimals
		const juno = microAmount / 1_000_000;
		return AmountPrecision.toExact6Decimals(juno);
	}

	/** Add two amounts with exact precision (integer math in uJUNO) */
	static add(amount1: number, amount2: number): number {
		// Sanitize and validate both amounts
		const validated1 = AmountPrecision.validateAmount(AmountPrecision.sanitize(amount1));
		const validated2 = AmountPrecision.validateAmount(AmountPrecision.sanitize(amount2));

		// Convert to micro for exact integer math
		const micro1 = AmountPrecision.toMicroJuno(validated1);
		const micro2 = AmountPrecision.toMicroJuno(validated2);

		// Add in micro units
		const resultMicro = micro1 + micro2;

		// Convert back to JUNO
		return AmountPrecision.fromMicroJuno(resultMicro);
	}

	/** Subtract amounts with exact precision (throws if negative result) */
	static subtract(amount1: number, amount2: number): number {
		// Sanitize and validate both amounts
		const validated1 = AmountPrecision.validateAmount(AmountPrecision.sanitize(amount1));
		const validated2 = AmountPrecision.validateAmount(AmountPrecision.sanitize(amount2));

		// Convert to micro for exact integer math
		const micro1 = AmountPrecision.toMicroJuno(validated1);
		const micro2 = AmountPrecision.toMicroJuno(validated2);

		// Ensure no negative result
		if (micro1 < micro2) {
			throw new Error(
				`Cannot subtract ${amount2} from ${amount1} - would result in negative amount`,
			);
		}

		// Subtract in micro units
		const resultMicro = micro1 - micro2;

		// Convert back to JUNO
		return AmountPrecision.fromMicroJuno(resultMicro);
	}

	/** Multiply amount by integer multiplier with exact precision */
	static multiply(amount: number, multiplier: number): number {
		// Sanitize and validate the amount (handles floating-point imprecision from DB)
		const sanitized = AmountPrecision.sanitize(amount);
		const validated = AmountPrecision.validateAmount(sanitized);

		// Multiplier must be a positive integer
		if (!Number.isInteger(multiplier) || multiplier < 0) {
			throw new Error(`Multiplier must be a non-negative integer, got ${multiplier}`);
		}

		// Convert to micro for exact integer math
		const micro = AmountPrecision.toMicroJuno(validated);
		const resultMicro = micro * multiplier;

		// Convert back to JUNO
		return AmountPrecision.fromMicroJuno(resultMicro);
	}

	/** Check exact equality at micro precision */
	static equals(amount1: number, amount2: number): boolean {
		try {
			// Sanitize to handle floating-point artifacts from DB
			const micro1 = AmountPrecision.toMicroJuno(AmountPrecision.sanitize(amount1));
			const micro2 = AmountPrecision.toMicroJuno(AmountPrecision.sanitize(amount2));
			return micro1 === micro2;
		} catch {
			return false;
		}
	}

	/** Check if amount1 > amount2 at micro precision */
	static isGreaterThan(amount1: number, amount2: number): boolean {
		// Sanitize to handle floating-point artifacts from DB
		const micro1 = AmountPrecision.toMicroJuno(AmountPrecision.sanitize(amount1));
		const micro2 = AmountPrecision.toMicroJuno(AmountPrecision.sanitize(amount2));
		return micro1 > micro2;
	}

	/** Check if amount1 >= amount2 at micro precision */
	static isGreaterOrEqual(amount1: number, amount2: number): boolean {
		// Sanitize to handle floating-point artifacts from DB
		const micro1 = AmountPrecision.toMicroJuno(AmountPrecision.sanitize(amount1));
		const micro2 = AmountPrecision.toMicroJuno(AmountPrecision.sanitize(amount2));
		return micro1 >= micro2;
	}

	/** Parse and validate user input (strips whitespace, ensures positive, validates precision) */
	static parseUserInput(input: string): number {
		// Remove any whitespace
		const cleaned = input.trim();

		// Check if valid number
		const parsed = parseFloat(cleaned);
		if (Number.isNaN(parsed)) {
			throw new Error(`Invalid amount: ${input}`);
		}

		// Check if positive
		if (parsed <= 0) {
			throw new Error(`Amount must be positive: ${parsed}`);
		}

		// Validate precision
		return AmountPrecision.validateAmount(parsed);
	}
}
