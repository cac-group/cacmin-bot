import type { Context, Telegraf } from "telegraf";
import { beforeEach, describe, expect, it } from "vitest";
import { execute, get } from "../../src/database";
import { registerMembershipHandlers } from "../../src/handlers/membership";

const CHAT_ID = -100999;
const USER = 990030;
const NOW = 1_800_000_000;

/** Capture the handlers the membership module registers. */
function fakeBot() {
	const handlers: Record<
		string,
		(ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>
	> = {};
	const bot = {
		on: (
			event: string,
			fn: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
		) => {
			handlers[event] = fn;
		},
	} as unknown as Telegraf<Context>;
	registerMembershipHandlers(bot);
	return handlers;
}

const telegram = {
	getChatMember: async () => ({ status: "member" }),
	restrictChatMember: async () => {},
	sendMessage: async () => ({}),
};

function joinContext(username: string) {
	return {
		message: {
			new_chat_members: [{ id: USER, is_bot: false, username }],
			date: NOW,
		},
		chat: { id: CHAT_ID, type: "supergroup" },
		telegram,
	};
}

function cooldownMute() {
	return get<{ muted_until: number }>(
		"SELECT muted_until FROM user_rate_limit_mutes WHERE user_id = ? AND kind = 'cooldown'",
		[USER],
	);
}

describe("membership handler -> rejoin cooldown", () => {
	beforeEach(() => {
		execute("DELETE FROM user_rejoin_cooldowns WHERE user_id = ?", [USER]);
		execute("DELETE FROM user_rate_limit_mutes WHERE user_id = ?", [USER]);
		execute("DELETE FROM jailings WHERE user_id = ?", [USER]);
		execute("DELETE FROM user_membership_events WHERE user_id = ?", [USER]);
		execute("DELETE FROM user_memberships WHERE user_id = ?", [USER]);
		execute("DELETE FROM users WHERE id = ?", [USER]);
	});

	it("mutes a known member on a new_chat_members join", async () => {
		execute(
			"INSERT INTO users (id, username, role) VALUES (?, 'known_user', 'pleb')",
			[USER],
		);
		const handlers = fakeBot();
		await handlers.message(joinContext("known_user"), async () => {});
		expect(cooldownMute()?.muted_until).toBe(NOW + 3600);
	});

	it("does not mute a first-ever join", async () => {
		const handlers = fakeBot();
		await handlers.message(joinContext("brand_new_user"), async () => {});
		expect(cooldownMute()).toBeUndefined();
	});
});
