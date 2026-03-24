/**
 * Active time computation utility.
 * Computes estimated "active time" from a series of message timestamps using
 * a windowed session model with conditional backward extension.
 *
 * Algorithm:
 * - Each message gets a forward window of +windowMinutes
 * - A message also gets a backward window of -windowMinutes, but ONLY if that
 *   backward zone overlaps with the forward zone of another message
 * - All resulting intervals are merged (no double-counting)
 * - Total active seconds is the sum of merged interval durations
 *
 * @module utils/activeTime
 */

/**
 * Computes total active time in seconds from an array of unix timestamps.
 *
 * @param timestamps - Array of unix timestamps (seconds) for a single user's messages
 * @param windowMinutes - Size of the activity window in minutes (default: 10)
 * @returns Total active time in seconds
 *
 * @example
 * ```typescript
 * // Messages at 12:01 and 12:10 → 20 minutes
 * const ts = [toUnix("12:01"), toUnix("12:10")];
 * computeActiveTime(ts, 10); // 1200 (seconds)
 * ```
 */
export function computeActiveTime(
	timestamps: number[],
	windowMinutes = 10,
): number {
	if (timestamps.length === 0) return 0;

	const sorted = [...timestamps].sort((a, b) => a - b);
	const windowSec = windowMinutes * 60;

	// Build intervals: each message gets [start, end]
	const intervals: [number, number][] = [];

	for (let i = 0; i < sorted.length; i++) {
		const t = sorted[i];
		const end = t + windowSec;
		let start = t;

		// Activate backward extension if the previous message's forward zone
		// overlaps with this message's backward zone.
		// Condition: sorted[i-1] + windowSec > t - windowSec → sorted[i-1] > t - 2*windowSec
		if (i > 0 && sorted[i - 1] > t - 2 * windowSec) {
			start = t - windowSec;
		}

		intervals.push([start, end]);
	}

	// Sort by start time (backward extension can push a later message's start earlier)
	intervals.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [intervals[0]];

	for (let i = 1; i < intervals.length; i++) {
		const last = merged[merged.length - 1];
		if (intervals[i][0] <= last[1]) {
			last[1] = Math.max(last[1], intervals[i][1]);
		} else {
			merged.push([...intervals[i]]);
		}
	}

	return merged.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/**
 * Formats a duration in seconds into a human-readable string.
 *
 * @param totalSeconds - Duration in seconds
 * @returns Formatted string like "2d 5h 30m", "14h 30m", "45m", etc.
 */
export function formatActiveTime(totalSeconds: number): string {
	if (totalSeconds <= 0) return "0m";

	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

	return parts.join(" ");
}
