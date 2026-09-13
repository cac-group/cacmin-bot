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
			let lastId = cursor;
			for (const userId of candidates) {
				lastId = userId;
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
				} catch {
					// Left the group, deleted account, or otherwise unavailable.
					unavailable++;
				}
				await sleep(THROTTLE_MS);
			}

			writeState(CURSOR_KEY, String(lastId));
			const done = candidates.length < limit;
			if (done) {
				writeState(DONE_KEY, "1");
				writeState(CURSOR_KEY, "0");
			}
			logger.info("Identity crawl batch complete", {
				attempted: candidates.length,
				filled,
				unavailable,
				done,
			});
			return {
				attempted: candidates.length,
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
