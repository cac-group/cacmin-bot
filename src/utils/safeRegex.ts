/**
 * Safe regex utilities with timeout protection to prevent ReDoS attacks.
 * Inspired by banBaby's security module with pattern validation and compilation.
 *
 * @module utils/safeRegex
 */

import { logger } from "./logger";

const MAX_PATTERN_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 100;
const SAFE_FLAGS = "gimsu";

/**
 * Pattern validation result
 */
export interface PatternValidation {
	isValid: boolean;
	error?: string;
	sanitized?: string;
}

/**
 * Compiled pattern object
 */
export interface CompiledPattern {
	raw: string;
	regex: RegExp;
	type: "simple" | "wildcard" | "regex";
}

/**
 * Validates and sanitizes a regex pattern.
 * Checks for length limits, control characters, and valid syntax.
 *
 * @param pattern - Raw pattern string to validate
 * @returns Validation result with sanitized pattern if valid
 *
 * @example
 * ```typescript
 * const result = validatePattern('test.*pattern');
 * if (result.isValid) {
 *   console.log('Sanitized:', result.sanitized);
 * }
 * ```
 */
export function validatePattern(pattern: string): PatternValidation {
	if (!pattern || pattern.trim().length === 0) {
		return { isValid: false, error: "Pattern cannot be empty" };
	}

	if (pattern.length > MAX_PATTERN_LENGTH) {
		return {
			isValid: false,
			error: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`,
		};
	}

	// Remove control characters except newline and tab
	const sanitized = pattern.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");

	// Check if pattern is a regex (starts and ends with /)
	if (sanitized.startsWith("/")) {
		const lastSlash = sanitized.lastIndexOf("/");
		if (lastSlash <= 0) {
			return {
				isValid: false,
				error: "Invalid regex format: missing closing /",
			};
		}

		const flags = sanitized.substring(lastSlash + 1);
		for (const flag of flags) {
			if (!SAFE_FLAGS.includes(flag)) {
				return { isValid: false, error: `Invalid regex flag: ${flag}` };
			}
		}

		// Try to compile the regex to check validity
		try {
			const regexPart = sanitized.substring(1, lastSlash);
			new RegExp(regexPart, flags);
		} catch (error) {
			return {
				isValid: false,
				error: `Invalid regex syntax: ${error instanceof Error ? error.message : "unknown"}`,
			};
		}
	}

	return { isValid: true, sanitized };
}

/**
 * Compiles a pattern into a safe RegExp object.
 * Supports three pattern types:
 * 1. Simple text (case-insensitive substring)
 * 2. Wildcards (* and ? patterns)
 * 3. Regular expressions (/pattern/flags)
 *
 * @param pattern - Validated pattern string
 * @returns Compiled pattern object with regex
 *
 * @example
 * ```typescript
 * const pattern = compileSafeRegex('test*');
 * if (pattern.regex.test('testing')) {
 *   console.log('Match found!');
 * }
 * ```
 */
export function compileSafeRegex(pattern: string): CompiledPattern {
	// Regex format: /pattern/flags
	if (pattern.startsWith("/")) {
		const lastSlash = pattern.lastIndexOf("/");
		const regexPart = pattern.substring(1, lastSlash);
		const flags = pattern.substring(lastSlash + 1) || "i";

		return {
			raw: pattern,
			regex: new RegExp(regexPart, flags),
			type: "regex",
		};
	}

	// Wildcard format: contains * or ?
	if (pattern.includes("*") || pattern.includes("?")) {
		// Escape special regex chars except * and ?
		const escaped = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".");

		return {
			raw: pattern,
			regex: new RegExp(escaped, "i"),
			type: "wildcard",
		};
	}

	// Simple text: case-insensitive substring match
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return {
		raw: pattern,
		regex: new RegExp(escaped, "i"),
		type: "simple",
	};
}

/**
 * Tests a pattern against a string with timeout protection.
 * Prevents ReDoS attacks by limiting execution time.
 *
 * @param regex - Compiled RegExp to test
 * @param text - Text to test against
 * @param timeoutMs - Maximum execution time in milliseconds
 * @returns Promise resolving to true if match found, false otherwise
 *
 * @example
 * ```typescript
 * const regex = /test.pattern/gi;
 * const matches = await testPatternSafely(regex, 'test my pattern', 100);
 * ```
 */
export function testPatternSafely(
	regex: RegExp,
	text: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		const timeoutId = setTimeout(() => {
			logger.warn("Regex execution timeout", {
				pattern: regex.source,
				flags: regex.flags,
				timeoutMs,
			});
			resolve(false);
		}, timeoutMs);

		try {
			// Reset lastIndex to avoid issues with global flag
			regex.lastIndex = 0;
			const result = regex.test(text);
			clearTimeout(timeoutId);
			resolve(result);
		} catch (error) {
			clearTimeout(timeoutId);
			logger.error("Regex execution error", {
				pattern: regex.source,
				error,
			});
			resolve(false);
		}
	});
}

/**
 * Creates a complete pattern object from raw input.
 * Validates, sanitizes, and compiles the pattern.
 *
 * @param rawPattern - Raw pattern string from user input
 * @returns Compiled pattern object or null if invalid
 *
 * @example
 * ```typescript
 * const pattern = createPatternObject('test*');
 * if (pattern) {
 *   const matches = await testPatternSafely(pattern.regex, 'testing');
 * }
 * ```
 */
export function createPatternObject(
	rawPattern: string,
): CompiledPattern | null {
	const validation = validatePattern(rawPattern);

	if (!validation.isValid || !validation.sanitized) {
		logger.error("Invalid pattern", {
			pattern: rawPattern,
			error: validation.error,
		});
		return null;
	}

	try {
		return compileSafeRegex(validation.sanitized);
	} catch (error) {
		logger.error("Pattern compilation error", {
			pattern: rawPattern,
			error,
		});
		return null;
	}
}
