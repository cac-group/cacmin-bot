import type { Context, Telegraf } from "telegraf";
import { config } from "../config";
import { execute, get, query, transaction } from "../database";
import { logger } from "../utils/logger";
import { AmountPrecision } from "../utils/precision";

export type RateLimitWindow = "15m" | "1h" | "24h";
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

interface LimitRow {
	limit_15m: number;
	limit_1h: number;
	limit_24h: number;
}

interface MuteRow {
	muted_until: number;
	limiting_window: RateLimitWindow;
	permission_snapshot: string;
}

/** Persistent character accounting and enforcement state for configured users. */
export class RateLimitService {
	/** Configure a user's base limit; hourly is 4x and daily is 24x the hourly limit. */
	static setLimits(userId: number, baseLimit: number): void {
		const now = Math.floor(Date.now() / 1000);
		execute(
			`INSERT INTO user_rate_limits (user_id, limit_15m, limit_1h, limit_24h, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET limit_15m=excluded.limit_15m,
			 limit_1h=excluded.limit_1h, limit_24h=excluded.limit_24h, updated_at=excluded.updated_at`,
			[userId, baseLimit, baseLimit * 4, baseLimit * 96, now],
		);
	}

	/** Count plain text, emoji, and sticker content using the bot's policy weights. */
	static countMessageCharacters(message: any): number {
		const text: string = message?.text || message?.caption || "";
		const textCharacters = Array.from(text).reduce<number>(
			(total, character) =>
				total + (/\p{Extended_Pictographic}/u.test(character) ? 2 : 1),
			0,
		);
		return textCharacters + (message?.sticker ? 5 : 0);
	}

	/** Remove a user's rate limit configuration and active rate-limit state. */
	static clearLimits(userId: number): void {
		transaction(() => {
			execute("DELETE FROM user_rate_limits WHERE user_id = ?", [userId]);
			execute("DELETE FROM user_rate_limit_usage WHERE user_id = ?", [userId]);
			execute("DELETE FROM user_rate_limit_mutes WHERE user_id = ?", [userId]);
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
			const carriedCapacity = Math.max(0, baseLimits[window] - previous);
			rollover[window] = Math.max(
				0,
				carriedCapacity - Math.max(0, current - baseLimits[window]),
			);
			limits[window] = baseLimits[window] + carriedCapacity;
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
		bot: Telegraf<Context>,
		chatId: number,
		userId: number,
		until: number,
		window: RateLimitWindow,
	): Promise<void> {
		const member = await bot.telegram.getChatMember(chatId, userId);
		const permissions =
			"permissions" in member && member.permissions ? member.permissions : {};
		execute(
			`INSERT INTO user_rate_limit_mutes (user_id, muted_until, limiting_window, permission_snapshot)
			VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET muted_until=excluded.muted_until,
			limiting_window=excluded.limiting_window`,
			[userId, until, window, JSON.stringify(permissions)],
		);
		await bot.telegram.restrictChatMember(chatId, userId, {
			permissions: Object.fromEntries(
				Object.keys(permissions).map((key) => [key, false]),
			) as any,
			until_date: until,
		});
	}

	/** Restore expired rate-limit mutes without overriding an active jail. */
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
				const user = get<{ muted_until: number | null }>(
					"SELECT muted_until FROM users WHERE id = ?",
					[mute.user_id],
				);
				if (!user?.muted_until || user.muted_until <= now) {
					await bot.telegram.restrictChatMember(chatId, mute.user_id, {
						permissions: JSON.parse(mute.permission_snapshot),
					});
				}
				execute("DELETE FROM user_rate_limit_mutes WHERE user_id = ?", [
					mute.user_id,
				]);
			} catch (error) {
				logger.error("Failed to restore rate-limit permissions", {
					userId: mute.user_id,
					error,
				});
			}
		}
	}

	/** Clear a rate-limit mute and restore its captured permissions when no window is full. */
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
			"SELECT * FROM user_rate_limit_mutes WHERE user_id = ?",
			[userId],
		);
		if (!mute) return true;
		await bot.telegram.restrictChatMember(chatId, userId, {
			permissions: JSON.parse(mute.permission_snapshot),
		});
		execute("DELETE FROM user_rate_limit_mutes WHERE user_id = ?", [userId]);
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
