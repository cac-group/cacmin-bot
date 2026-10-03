import type { Context, Telegraf, Telegram } from "telegraf";
import { config } from "../config";
import { execute, get, query, transaction } from "../database";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";
import { muteMember, releaseMute } from "./chatMuteService";

export type RateLimitWindow = "15m" | "1h" | "24h";
/** Default tier multipliers: 15m base, 1h 2x base, 24h 4x hourly. */
export const RATE_LIMIT_MULTIPLIERS = {
	"15m": 1,
	"1h": 2,
	"24h": 8,
} as const;
const WINDOWS: Record<RateLimitWindow, number> = {
	"15m": 900,
	"1h": 3600,
	"24h": 86400,
};

export interface RateLimitStatus {
	userId: number;
	limits: Record<RateLimitWindow, number>;
	baseLimits: Record<RateLimitWindow, number>;
	usage: Record<RateLimitWindow, number>;
	rollover: Record<RateLimitWindow, number>;
	resetsAt: Record<RateLimitWindow, number>;
}

export interface AdmissionResult {
	allowed: boolean;
	status: RateLimitStatus;
	violated: RateLimitWindow[];
}

/** Calculate one-period carry without allowing unused capacity to compound. */
export function calculateRolloverCapacity(
	baseLimit: number,
	previousUsage: number,
	currentUsage: number,
): { limit: number; rollover: number } {
	const carriedCapacity = Math.max(0, baseLimit - previousUsage);
	return {
		limit: baseLimit + carriedCapacity,
		rollover: Math.max(
			0,
			carriedCapacity - Math.max(0, currentUsage - baseLimit),
		),
	};
}

interface LimitRow {
	limit_15m: number;
	limit_1h: number;
	limit_24h: number;
}

interface MuteRow {
	muted_until: number;
	kind: import("./chatMuteService").MuteKind;
}

/** Persistent character accounting and enforcement state for configured users. */
export class RateLimitService {
	/** Configure a user's base limit; hourly is 2x and daily is 4x the hourly limit. */
	static setLimits(userId: number, baseLimit: number): void {
		const now = Math.floor(Date.now() / 1000);
		transaction(() => {
			const previous = get<LimitRow>(
				"SELECT limit_15m, limit_1h, limit_24h FROM user_rate_limits WHERE user_id = ?",
				[userId],
			);
			const next = [
				baseLimit * RATE_LIMIT_MULTIPLIERS["15m"],
				baseLimit * RATE_LIMIT_MULTIPLIERS["1h"],
				baseLimit * RATE_LIMIT_MULTIPLIERS["24h"],
			];
			execute(
				`INSERT INTO user_rate_limits (user_id, limit_15m, limit_1h, limit_24h, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET limit_15m=excluded.limit_15m,
				 limit_1h=excluded.limit_1h, limit_24h=excluded.limit_24h, updated_at=excluded.updated_at`,
				[userId, ...next, now],
			);
			if (
				previous &&
				[previous.limit_15m, previous.limit_1h, previous.limit_24h].some(
					(value, index) => value !== next[index],
				)
			) {
				execute("DELETE FROM user_rate_limit_usage WHERE user_id = ?", [
					userId,
				]);
			}
			logger.info("Rate-limit config set", {
				tag: "config",
				subtag: "set_limits",
				userId,
				baseLimit,
				limits: { "15m": next[0], "1h": next[1], "24h": next[2] },
				usageReset: Boolean(
					previous &&
						[previous.limit_15m, previous.limit_1h, previous.limit_24h].some(
							(value, index) => value !== next[index],
						),
				),
			});
		});
	}

	/** Count plain text, emoji, sticker, and shared-image content using the bot's policy weights. */
	static countMessageCharacters(message: any): number {
		const text: string = message?.text || message?.caption || "";
		const textCharacters = Array.from(text).reduce<number>(
			(total, character) =>
				total + (/\p{Extended_Pictographic}/u.test(character) ? 2 : 1),
			0,
		);
		const sharedImage = message?.photo || message?.document ? 25 : 0;
		return textCharacters + (message?.sticker ? 5 : 0) + sharedImage;
	}

	/** Remove a user's rate limit configuration and active rate-limit state. */
	static clearLimits(userId: number): void {
		transaction(() => {
			execute("DELETE FROM user_rate_limits WHERE user_id = ?", [userId]);
			execute("DELETE FROM user_rate_limit_usage WHERE user_id = ?", [userId]);
			execute(
				"DELETE FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'rate_limit'",
				[userId],
			);
			logger.info("Rate-limit config and state cleared", {
				tag: "config",
				subtag: "clear_limits",
				userId,
			});
		});
	}

	/** Return current bucket usage, one-period rollover, and the next bucket reset. */
	static getStatus(
		userId: number,
		now = Math.floor(Date.now() / 1000),
	): RateLimitStatus | null {
		const row = get<LimitRow>(
			"SELECT limit_15m, limit_1h, limit_24h FROM user_rate_limits WHERE user_id = ?",
			[userId],
		);
		if (!row) return null;
		const baseLimits = {
			"15m": row.limit_15m,
			"1h": row.limit_1h,
			"24h": row.limit_24h,
		};
		const limits = { ...baseLimits };
		const usage = {} as Record<RateLimitWindow, number>;
		const rollover = {} as Record<RateLimitWindow, number>;
		const resetsAt = {} as Record<RateLimitWindow, number>;
		for (const window of Object.keys(WINDOWS) as RateLimitWindow[]) {
			const seconds = WINDOWS[window];
			const periodStart = Math.floor(now / seconds) * seconds;
			const current =
				query<{ total: number }>(
					"SELECT COALESCE(SUM(characters), 0) AS total FROM user_rate_limit_usage WHERE user_id = ? AND created_at >= ?",
					[userId, periodStart],
				)[0]?.total || 0;
			const previous =
				query<{ total: number }>(
					"SELECT COALESCE(SUM(characters), 0) AS total FROM user_rate_limit_usage WHERE user_id = ? AND created_at >= ? AND created_at < ?",
					[userId, periodStart - seconds, periodStart],
				)[0]?.total || 0;
			usage[window] = current;
			const capacity = calculateRolloverCapacity(
				baseLimits[window],
				previous,
				current,
			);
			rollover[window] = capacity.rollover;
			limits[window] = capacity.limit;
			resetsAt[window] = periodStart + seconds;
		}
		return { userId, limits, baseLimits, usage, rollover, resetsAt };
	}

	/** Atomically admit a message or reject it without counting its characters. */
	static admitMessage(
		userId: number,
		messageId: number,
		characters: number,
		now = Math.floor(Date.now() / 1000),
	): AdmissionResult {
		return transaction(() => {
			const status = RateLimitService.getStatus(userId, now);
			if (!status)
				return {
					allowed: true,
					status: null as unknown as RateLimitStatus,
					violated: [],
				};
			const violated = (Object.keys(WINDOWS) as RateLimitWindow[]).filter(
				(window) => status.usage[window] + characters > status.limits[window],
			);
			if (violated.length === 0) {
				execute(
					"INSERT OR IGNORE INTO user_rate_limit_usage (user_id, message_id, characters, created_at) VALUES (?, ?, ?, ?)",
					[userId, messageId, characters, now],
				);
			}
			return {
				allowed: violated.length === 0,
				status: RateLimitService.getStatus(userId, now) as RateLimitStatus,
				violated,
			};
		});
	}

	/** Clear a user's accumulated usage and any active rate-limit mute without altering their configured limits. */
	static clearUsage(userId: number): void {
		transaction(() => {
			execute("DELETE FROM user_rate_limit_usage WHERE user_id = ?", [userId]);
			execute(
				"DELETE FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'rate_limit'",
				[userId],
			);
			logger.info("Rate-limit usage and mute cleared", {
				tag: "config",
				subtag: "clear_usage",
				userId,
			});
		});
	}

	/** Clear current and immediately previous usage buckets for a selected window. */
	static resetWindow(
		userId: number,
		window: RateLimitWindow,
		now = Math.floor(Date.now() / 1000),
	): void {
		const seconds = WINDOWS[window];
		const periodStart = Math.floor(now / seconds) * seconds;
		execute(
			"DELETE FROM user_rate_limit_usage WHERE user_id = ? AND created_at >= ?",
			[userId, periodStart - seconds],
		);
		logger.info("Rate-limit window reset", {
			tag: "config",
			subtag: "reset_window",
			userId,
			window,
			periodStart,
		});
	}

	/** Check whether a transaction hash has already been consumed by any payment flow. */
	static isPaymentHashUsed(paymentTx: string): boolean {
		return Boolean(
			query<{ id: number }>(
				`SELECT id FROM jail_events WHERE payment_tx = ?
				 UNION ALL SELECT id FROM violations WHERE payment_tx = ?
				 UNION ALL SELECT id FROM rate_limit_reset_payments WHERE payment_tx = ? LIMIT 1`,
				[paymentTx, paymentTx, paymentTx],
			)[0],
		);
	}

	/** Create a rate-limit mute after capturing the member's current permissions. */
	static async muteUser(
		telegram: Telegram,
		chatId: number,
		userId: number,
		until: number,
		window: RateLimitWindow,
	): Promise<void> {
		await muteMember({ telegram, chatId, userId }, "rate_limit", until);
		logger.warn("Rate-limit mute applied", {
			tag: "moderation",
			subtag: "mute_applied",
			userId,
			chatId,
			until,
			window,
			operation: "rate_limit_mute",
		});
	}

	/** Restore expired chat mutes without overriding an active jail. */
	static async cleanExpiredMutes(
		bot: Telegraf<Context>,
		chatId?: number,
	): Promise<void> {
		if (!chatId) return;
		const now = Math.floor(Date.now() / 1000);
		const mutes = query<MuteRow & { user_id: number }>(
			"SELECT * FROM user_rate_limit_mutes WHERE muted_until <= ?",
			[now],
		);
		for (const mute of mutes) {
			try {
				// releaseMute only lifts the chat restriction once no other kind
				// (e.g. an active jail) still holds a deadline.
				const released = await releaseMute(
					{ telegram: bot.telegram, chatId, userId: mute.user_id },
					mute.kind,
				);
				logger.info("Chat mute expired", {
					tag: "moderation",
					subtag: "mute_expired",
					userId: mute.user_id,
					chatId,
					kind: mute.kind,
					released,
				});
			} catch (error) {
				logger.error("Failed to restore chat mute permissions", {
					userId: mute.user_id,
					error,
				});
			}
		}
	}

	/** Clear a chat mute and restore its captured permissions when no window is full. */
	static async releaseMuteIfAllowed(
		bot: Telegraf<Context>,
		chatId: number,
		userId: number,
	): Promise<boolean> {
		const status = RateLimitService.getStatus(userId);
		if (
			status &&
			(Object.keys(WINDOWS) as RateLimitWindow[]).some(
				(window) => status.usage[window] >= status.limits[window],
			)
		)
			return false;
		const mute = get<MuteRow>(
			"SELECT * FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'rate_limit'",
			[userId],
		);
		if (!mute) return true;
		// Force-expire the rate-limit deadline so releaseMute lifts it now.
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ? AND kind = 'rate_limit'",
			[userId],
		);
		const released = await releaseMute(
			{ telegram: bot.telegram, chatId, userId },
			"rate_limit",
		);
		logger.info("Chat mute removed after reset", {
			tag: "moderation",
			subtag: "mute_removed",
			userId,
			chatId,
			released,
		});
		return true;
	}

	/** Convert a configured JUNO fee to exact database micro-units. */
	static feeMicro(window: RateLimitWindow): number {
		return AmountPrecision.toDbMicro(config.rateLimitResetFees[window]);
	}

	/** Return the duration represented by a window. */
	static windowSeconds(window: RateLimitWindow): number {
		return WINDOWS[window];
	}
}
