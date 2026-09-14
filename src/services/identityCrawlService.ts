/**
 * Identity crawl.
 *
 * Actively asks Telegram for the current profile of known user ids that have
 * no recorded username (members who have not posted since indexing began) and
 * records what it finds in the explorer identity tables. Telegram exposes no
 * join date or member list, so this is the only way to fill those blanks.
 *
 * The crawl is a forward cursor over `telegram_users.user_id`, throttled, and
 * resumable across restarts via `system_state`. When a full pass completes it
 * sets a done flag and idles until reset, so it never re-queries users who
 * genuinely have no username.
 *
 * @module services/identityCrawlService
 */

import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, get } from "../database";
import { logger } from "../utils/logger";
import { ChatInteractionIndexerService } from "./chatInteractionIndexerService";
import { updateExistingUserUsername } from "./userService";

const CURSOR_KEY = "identity_crawl_cursor";
const DONE_KEY = "identity_crawl_done";

/** Delay between Telegram calls to stay well under the API rate limit. */
const THROTTLE_MS = 60;

/** How many times to honor a 429 retry_after for the same user before pausing. */
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Returns the delay (ms) Telegram asked us to wait for a 429, or null when the
 * error is not a rate limit. Telegraf's TelegramError exposes `code` and
 * `parameters` from the API response.
 */
function rateLimitRetryAfterMs(error: unknown): number | null {
	const candidate = error as {
		code?: number;
		parameters?: { retry_after?: number };
	};
	if (candidate?.code !== 429) return null;
	const retryAfter = candidate.parameters?.retry_after;
	return (
		(typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : 1) * 1000
	);
}

export interface CrawlBatchResult {
	attempted: number;
	filled: number;
	unavailable: number;
	done: boolean;
	skipped?: boolean;
	error?: string;
}

function readState(key: string): string | null {
	return (
		get<{ value: string }>("SELECT value FROM system_state WHERE key = ?", [
			key,
		])?.value ?? null
	);
}

function writeState(key: string, value: string): void {
	execute(
		`INSERT INTO system_state (key, value, updated_at)
		 VALUES (?, ?, strftime('%s', 'now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		[key, value],
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IdentityCrawlService {
	private static running = false;

	static isRunning(): boolean {
		return IdentityCrawlService.running;
	}

	/** Clear the completion flag and cursor so the next run starts a fresh pass. */
	static reset(): void {
		writeState(DONE_KEY, "0");
		writeState(CURSOR_KEY, "0");
	}

	/**
	 * Probe up to `limit` user ids after the cursor, recording any profile
	 * Telegram returns. Safe to call repeatedly; concurrent runs are skipped.
	 */
	static async runBatch(
		bot: Telegraf<Context>,
		limit = 100,
	): Promise<CrawlBatchResult> {
		const empty = { attempted: 0, filled: 0, unavailable: 0, done: false };
		if (IdentityCrawlService.running) return { ...empty, skipped: true };

		const chatId = config.groupChatId;
		if (!chatId) return { ...empty, error: "GROUP_CHAT_ID is not configured" };
		if (readState(DONE_KEY) === "1") return { ...empty, done: true };

		IdentityCrawlService.running = true;
		try {
			const cursor = Number.parseInt(readState(CURSOR_KEY) ?? "0", 10) || 0;
			const candidates = ChatInteractionIndexerService.listUsersMissingUsername(
				cursor,
				limit,
			);
			if (candidates.length === 0) {
				writeState(DONE_KEY, "1");
				writeState(CURSOR_KEY, "0");
				return { ...empty, done: true };
			}

			let filled = 0;
			let unavailable = 0;
			let attempted = 0;
			let lastId = cursor;
			for (const userId of candidates) {
				attempted++;
				let attempts = 0;
				let resolved = false;
				while (!resolved) {
					try {
						const member = await bot.telegram.getChatMember(chatId, userId);
						const user = member.user;
						ChatInteractionIndexerService.recordProfile(
							userId,
							user.username,
							user.first_name,
							user.last_name,
						);
						if (user.username) {
							updateExistingUserUsername(userId, user.username);
							filled++;
						}
						resolved = true;
					} catch (error) {
						const retryAfterMs = rateLimitRetryAfterMs(error);
						if (retryAfterMs === null) {
							// Left the group, deleted account, or otherwise unavailable.
							unavailable++;
							resolved = true;
							break;
						}
						attempts++;
						if (attempts > MAX_RATE_LIMIT_RETRIES) {
							// Don't skip the user: pause here and resume from the last
							// fully resolved id on the next run.
							writeState(CURSOR_KEY, String(lastId));
							logger.warn("Identity crawl paused on rate limit", {
								userId,
								attempts,
								retryAfterMs,
							});
							return {
								attempted,
								filled,
								unavailable,
								done: false,
								error: "Rate limited by Telegram; will resume on the next run.",
							};
						}
						logger.warn("Identity crawl rate limited, backing off", {
							userId,
							retryAfterMs,
							attempt: attempts,
						});
						await sleep(retryAfterMs + 250);
					}
				}
				lastId = userId;
				await sleep(THROTTLE_MS);
			}

			writeState(CURSOR_KEY, String(lastId));
			const done = candidates.length < limit;
			if (done) {
				writeState(DONE_KEY, "1");
				writeState(CURSOR_KEY, "0");
			}
			logger.info("Identity crawl batch complete", {
				attempted,
				filled,
				unavailable,
				done,
			});
			return {
				attempted,
				filled,
				unavailable,
				done,
			};
		} catch (error) {
			logger.error("Identity crawl batch failed", { error });
			return {
				...empty,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			IdentityCrawlService.running = false;
		}
	}
}
