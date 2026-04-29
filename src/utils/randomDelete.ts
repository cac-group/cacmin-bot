/**
 * Shared helpers for the chance-based random delete restriction.
 */

export const DEFAULT_RANDOM_DELETE_CHANCE = "10%";
export const RANDOM_DELETE_MIN_UNIQUE_WORDS = 6;

function formatPercent(percent: number): string {
	const rounded = Number.parseFloat(percent.toFixed(2));
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toString()}%`;
}

/**
 * Normalize user input for the random delete chance.
 * Accepts percent values like `10`, `10%`, fractional values like `0.1`,
 * and the keyword `default`.
 */
export function normalizeRandomDeleteChance(
	input?: string | null,
): string | null {
	if (!input || input === "-") {
		return DEFAULT_RANDOM_DELETE_CHANCE;
	}

	const trimmed = input.trim().toLowerCase();
	if (!trimmed || trimmed === "default") {
		return DEFAULT_RANDOM_DELETE_CHANCE;
	}

	const numericInput = trimmed.endsWith("%")
		? trimmed.slice(0, -1).trim()
		: trimmed;
	const numericValue = Number.parseFloat(numericInput);
	if (!Number.isFinite(numericValue) || numericValue <= 0) {
		return null;
	}

	const percentValue = numericValue <= 1 ? numericValue * 100 : numericValue;
	if (percentValue <= 0 || percentValue > 100) {
		return null;
	}

	return formatPercent(percentValue);
}

/**
 * Parse the stored action value into a probability between 0 and 1.
 * Invalid persisted values fall back to the default chance.
 */
export function getRandomDeleteProbability(action?: string | null): number {
	const normalized = normalizeRandomDeleteChance(action);
	if (!normalized) {
		return Number.parseFloat(DEFAULT_RANDOM_DELETE_CHANCE) / 100;
	}

	return Number.parseFloat(normalized) / 100;
}
