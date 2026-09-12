/**
 * In-memory group flood limiter.
 *
 * Tracks the most recent message IDs per user per chat in a sliding window and
 * reports when a sender exceeds their allowance so the caller can delete the
 * burst and jail them. State is intentionally in-memory: a restart only clears
 * the short window, and messages themselves are the source of truth.
 *
 * @module services/spamLimiterService
 */

export interface SpamLimitConfig {
	/** Messages allowed within the window before enforcement (<= 0 disables) */
	maxMessages: number;
	/** Sliding window length in milliseconds */
	windowMs: number;
	/** Number of the sender's most recent messages to report for deletion */
	deleteCount: number;
}

export interface SpamBurst {
	/** Message IDs to delete, most recent last */
	messageIds: number[];
}

interface TrackedMessage {
	id: number;
	at: number;
}

const trackers = new Map<string, TrackedMessage[]>();

/**
 * Records a message and returns the burst to enforce when the sender has sent
 * more than `maxMessages` within `windowMs`, otherwise null.
 *
 * @param userId - Sender's Telegram user ID
 * @param chatId - Chat the message was sent in
 * @param messageId - Telegram message ID
 * @param config - Limiter thresholds
 * @param now - Current epoch milliseconds (injectable for tests)
 * @returns The messages to delete, or null when under the limit
 */
export function recordMessage(
	userId: number,
	chatId: number,
	messageId: number,
	config: SpamLimitConfig,
	now: number = Date.now(),
): SpamBurst | null {
	if (config.maxMessages <= 0) return null;

	const key = `${userId}:${chatId}`;
	const cutoff = now - config.windowMs;
	const entries = (trackers.get(key) ?? []).filter(
		(entry) => entry.at > cutoff,
	);
	entries.push({ id: messageId, at: now });

	if (entries.length > config.maxMessages) {
		const messageIds =
			config.deleteCount > 0
				? entries.slice(-config.deleteCount).map((entry) => entry.id)
				: [];
		trackers.delete(key);
		return { messageIds };
	}

	trackers.set(key, entries);
	return null;
}

/** Drops entries older than the window to keep memory bounded. */
export function pruneTrackers(
	windowMs: number,
	now: number = Date.now(),
): void {
	const cutoff = now - windowMs;
	for (const [key, entries] of trackers) {
		const fresh = entries.filter((entry) => entry.at > cutoff);
		if (fresh.length === 0) {
			trackers.delete(key);
		} else {
			trackers.set(key, fresh);
		}
	}
}

/** Clears all tracked state (tests). */
export function clearTrackers(): void {
	trackers.clear();
}
