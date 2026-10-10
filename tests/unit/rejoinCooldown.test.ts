import type { Telegram } from "telegraf";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config";
import { execute, get, query } from "../../src/database";
import { releaseMember } from "../../src/services/chatMuteService";
import { JailService } from "../../src/services/jailService";
import {
	clearOnBuyout,
	getActiveCooldown,
	REJOIN_COOLDOWN_REASON,
	recordMemberLeave,
	recordMemberRejoin,
} from "../../src/services/rejoinCooldownService";
import { AmountPrecision } from "../../src/utils/precision";

const CHAT_ID = -100999;
const T0 = 1_800_000_000;
const TEST_USER_IDS = [
	990010, 990011, 990012, 990013, 990014, 990015, 990016, 990017, 990018,
	990019, 990020,
];

/** Minimal Telegram double that satisfies muteMember and records restores. */
function telegramDouble(): Telegram {
	return {
		getChatMember: async () => ({ status: "member" }),
		restrictChatMember: async () => {},
		sendMessage: async () => ({}),
	} as unknown as Telegram;
}

/** Telegram double that records the permissions applied by restrictChatMember. */
function restoringTelegram() {
	const applied: Array<Record<string, boolean>> = [];
	return {
		applied,
		telegram: {
			getChatMember: async () => ({ status: "member" }),
			restrictChatMember: async (
				_chatId: number,
				_userId: number,
				params: { permissions: Record<string, boolean> },
			) => {
				applied.push(params.permissions);
			},
			sendMessage: async () => ({}),
		} as unknown as Telegram,
	};
}

function seedUser(userId: number, role = "pleb"): void {
	execute(
		`INSERT INTO users (id, username, role) VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET role = excluded.role`,
		[userId, `cooldown_${userId}`, role],
	);
}

/** The shared SQLite file persists between runs; clear our fixed ids first. */
function resetTestUsers(): void {
	for (const userId of TEST_USER_IDS) {
		execute("DELETE FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]);
		execute("DELETE FROM user_rate_limit_mutes WHERE user_id = ?", [userId]);
		execute("DELETE FROM jailings WHERE user_id = ?", [userId]);
		execute("DELETE FROM jail_events WHERE user_id = ?", [userId]);
		execute("DELETE FROM user_membership_events WHERE user_id = ?", [userId]);
	}
}

function cooldownRow(userId: number) {
	return get<{ pending: number; remaining_seconds: number }>(
		"SELECT pending, remaining_seconds FROM user_rejoin_cooldowns WHERE user_id = ?",
		[userId],
	);
}

function muteRow(userId: number) {
	return get<{ muted_until: number; kind: string }>(
		"SELECT muted_until, kind FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[userId],
	);
}

describe("rejoin cooldown", () => {
	beforeEach(() => {
		resetTestUsers();
	});

	it("does nothing on a first-ever join (no prior leave)", async () => {
		const userId = 990010;
		seedUser(userId);
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);
		expect(muteRow(userId)).toBeUndefined();
		expect(cooldownRow(userId)).toBeUndefined();
	});

	it("mutes for one interval on leave/rejoin and opens a payable jailing", async () => {
		const userId = 990011;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		expect(cooldownRow(userId)).toMatchObject({
			pending: 1,
			remaining_seconds: 0,
		});

		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0 + 5);
		expect(cooldownRow(userId)).toMatchObject({
			pending: 0,
			remaining_seconds: 0,
		});
		const mute = muteRow(userId);
		expect(mute?.muted_until).toBe(T0 + 5 + config.rejoinCooldownSeconds);

		const jailing = get<{ bail_amount: number; reason: string; paid: number }>(
			"SELECT bail_amount, reason, paid FROM jailings WHERE user_id = ? ORDER BY id DESC LIMIT 1",
			[userId],
		);
		expect(jailing?.reason).toBe(REJOIN_COOLDOWN_REASON);
		expect(jailing?.paid).toBe(0);
		expect(AmountPrecision.fromDbMicro(jailing?.bail_amount ?? 0)).toBeCloseTo(
			config.defaultJailBailAmount,
			6,
		);
	});

	it("pauses while away and adds an hour on the next rejoin", async () => {
		const userId = 990012;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);
		// 10 minutes of the 1h mute elapse, then they leave.
		recordMemberLeave(userId, T0 + 600);
		expect(cooldownRow(userId)).toMatchObject({
			pending: 1,
			remaining_seconds: config.rejoinCooldownSeconds - 600,
		});
		// They rejoin 1 hour later: remaining (3000) + 3600 = 6600.
		const rejoinAt = T0 + 600 + 3600;
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, rejoinAt);
		expect(muteRow(userId)?.muted_until).toBe(
			rejoinAt +
				(config.rejoinCooldownSeconds - 600) +
				config.rejoinCooldownSeconds,
		);
		expect(cooldownRow(userId)).toMatchObject({
			pending: 0,
			remaining_seconds: 0,
		});
	});

	it("reports the active cooldown for /mystatus", async () => {
		const userId = 990013;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);
		expect(getActiveCooldown(userId, T0 + 10)?.mutedUntil).toBe(
			T0 + config.rejoinCooldownSeconds,
		);
		expect(
			getActiveCooldown(userId, T0 + config.rejoinCooldownSeconds + 1),
		).toBeNull();
	});

	it("clears the accrued cooldown when the jailing is bought out", async () => {
		const userId = 990014;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);

		const jailing = get<{ jailing_id: string }>(
			"SELECT jailing_id FROM jailings WHERE user_id = ? AND paid = 0 ORDER BY id DESC LIMIT 1",
			[userId],
		);
		expect(jailing?.jailing_id).toBeTruthy();

		const result = JailService.payJailing(
			jailing?.jailing_id ?? "",
			userId,
			`tx_${userId}`,
		);
		expect(result.success).toBe(true);
		expect(cooldownRow(userId)).toBeUndefined();
		// The mute row must survive the payment: releaseMember needs its stored
		// permission binding to restore the real member rights, not the mute set.
		expect(muteRow(userId)).toBeDefined();

		const { telegram, applied } = restoringTelegram();
		await releaseMember({ telegram, chatId: CHAT_ID, userId });
		expect(muteRow(userId)).toBeUndefined();
		expect(applied.some((p) => p.can_send_messages === true)).toBe(true);
	});

	it("skips the cooldown while another mute is active", async () => {
		const userId = 990017;
		seedUser(userId);
		// An open, unexpired jail (non-cooldown reason).
		execute(
			"INSERT INTO jailings (jailing_id, user_id, bail_amount, muted_until, reason) VALUES ('JAILTEST', ?, 1, ?, NULL)",
			[userId, T0 + 3600],
		);
		recordMemberLeave(userId, T0);
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);
		expect(muteRow(userId)).toBeUndefined();
		expect(cooldownRow(userId)).toMatchObject({
			pending: 0,
			remaining_seconds: 0,
		});
	});

	it("cancels an open cooldown when a real jail starts, so its memo cannot lift the jail", async () => {
		const userId = 990019;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);

		const cooldownJailing = get<{ jailing_id: string }>(
			"SELECT jailing_id FROM jailings WHERE user_id = ? AND reason = ? AND paid = 0",
			[userId, REJOIN_COOLDOWN_REASON],
		);
		expect(cooldownJailing?.jailing_id).toBeTruthy();

		JailService.jailUser({
			userId,
			durationMinutes: 60,
			metadata: { reason: "test_jail" },
		});

		// The cooldown jailing is no longer payable...
		expect(
			JailService.getJailingByPublicId(cooldownJailing?.jailing_id ?? ""),
		).toBeNull();
		expect(cooldownRow(userId)).toBeUndefined();
		expect(muteRow(userId)).toBeUndefined();
		// ...and the real jail remains open.
		const jail = get<{ paid: number; reason: string | null }>(
			"SELECT paid, reason FROM jailings WHERE user_id = ? ORDER BY id DESC LIMIT 1",
			[userId],
		);
		expect(jail?.paid).toBe(0);
		expect(jail?.reason).toBe("test_jail");
	});

	it("abandons the cooldown if a jail starts during the mute apply", async () => {
		const userId = 990020;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		let injected = false;
		const telegram = {
			getChatMember: async () => ({ status: "member" }),
			restrictChatMember: async () => {
				if (injected) return;
				injected = true;
				// Simulate a concurrent jail landing while muteMember awaits.
				execute(
					"INSERT INTO jailings (jailing_id, user_id, bail_amount, muted_until, reason) VALUES ('RACEJAIL', ?, 1, ?, NULL)",
					[userId, T0 + 7200],
				);
			},
			sendMessage: async () => ({}),
		} as unknown as Telegram;

		await recordMemberRejoin(telegram, CHAT_ID, userId, T0);

		// No payable cooldown jailing was opened, and no cooldown state remains.
		expect(
			get(
				"SELECT 1 FROM jailings WHERE user_id = ? AND reason = ? AND paid = 0",
				[userId, REJOIN_COOLDOWN_REASON],
			),
		).toBeUndefined();
		expect(cooldownRow(userId)).toBeUndefined();
	});

	it("does nothing when the cooldown is disabled", async () => {
		const userId = 990018;
		seedUser(userId);
		const previous = config.rejoinCooldownSeconds;
		config.rejoinCooldownSeconds = 0;
		try {
			recordMemberLeave(userId, T0);
			expect(cooldownRow(userId)).toBeUndefined();
			await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);
			expect(muteRow(userId)).toBeUndefined();
		} finally {
			config.rejoinCooldownSeconds = previous;
		}
	});

	it("ignores admins", async () => {
		const userId = 990015;
		seedUser(userId, "admin");
		recordMemberLeave(userId, T0);
		expect(cooldownRow(userId)).toBeUndefined();
		await recordMemberRejoin(telegramDouble(), CHAT_ID, userId, T0);
		expect(muteRow(userId)).toBeUndefined();
	});

	it("clearOnBuyout removes the pending record", () => {
		const userId = 990016;
		seedUser(userId);
		recordMemberLeave(userId, T0);
		expect(
			query("SELECT 1 FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]),
		).toHaveLength(1);
		clearOnBuyout(userId);
		expect(
			query("SELECT 1 FROM user_rejoin_cooldowns WHERE user_id = ?", [userId]),
		).toHaveLength(0);
	});
});
