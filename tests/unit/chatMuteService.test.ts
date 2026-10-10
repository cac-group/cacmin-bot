import type { Telegram } from "telegraf";
import { describe, expect, it } from "vitest";
import { execute, query } from "../../src/database";
import {
	muteMember,
	releaseMember,
	releaseMute,
} from "../../src/services/chatMuteService";

/** Minimal Telegram double that records restrict calls and tracks member status. */
function telegramDouble(status = "member") {
	const restricts: Array<{ userId: number; permissions: unknown }> = [];
	const messages: string[] = [];
	const telegram = {
		getChatMember: async () => ({ status }),
		restrictChatMember: async (
			_chatId: number,
			userId: number,
			params: { permissions: unknown },
		) => {
			restricts.push({ userId, permissions: params.permissions });
		},
		sendMessage: async (_chatId: number, text: string) => {
			messages.push(text);
		},
	};
	return { telegram: telegram as unknown as Telegram, restricts, messages };
}

function seedUser(userId: number, username: string): void {
	execute(
		"INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'pleb')",
		[userId, username],
	);
}

describe("chatMuteService", () => {
	it("restores captured permissions on release", async () => {
		const userId = 88001;
		seedUser(userId, "release_target");
		const { telegram, restricts } = telegramDouble();
		const member = { telegram, chatId: -1001, userId };
		await muteMember(member, "jail", Math.floor(Date.now() / 1000) + 600);
		restricts.length = 0;
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ? AND kind = 'jail'",
			[userId],
		);
		const released = await releaseMute(member, "jail");
		expect(released).toBe(true);
		expect(restricts).toHaveLength(1);
		expect(
			(restricts[0].permissions as Record<string, boolean>).can_send_messages,
		).toBe(true);
	});

	it("is idempotent: a second release for the same kind does nothing", async () => {
		const userId = 88002;
		seedUser(userId, "idempotent_target");
		const { telegram, restricts } = telegramDouble();
		const member = { telegram, chatId: -1001, userId };
		await muteMember(member, "jail", Math.floor(Date.now() / 1000) + 600);
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ? AND kind = 'jail'",
			[userId],
		);
		expect(await releaseMute(member, "jail")).toBe(true);
		restricts.length = 0;
		// Second call: the row is gone, so no restore and no second unmute.
		expect(await releaseMute(member, "jail")).toBe(false);
		expect(restricts).toHaveLength(0);
	});

	it("does not re-apply permissions for an administrator binding", async () => {
		const userId = 88003;
		seedUser(userId, "admin_target");
		const { telegram, restricts } = telegramDouble("administrator");
		const member = { telegram, chatId: -1001, userId };
		await muteMember(member, "jail", Math.floor(Date.now() / 1000) + 600);
		restricts.length = 0;
		await releaseMember(member);
		expect(restricts).toHaveLength(0);
	});

	it("uses the freshly captured permissions when no binding was stored", async () => {
		const userId = 88004;
		seedUser(userId, "unbound_target");
		const { telegram, restricts } = telegramDouble();
		await releaseMember({ telegram, chatId: -1001, userId });
		expect(restricts).toHaveLength(1);
		expect(
			(restricts[0].permissions as Record<string, boolean>).can_send_messages,
		).toBe(true);
	});

	it("keeps tracking when a rate-limit release leaves a jail active", async () => {
		const userId = 88005;
		seedUser(userId, "mixed_target");
		const { telegram, restricts } = telegramDouble();
		const member = { telegram, chatId: -1001, userId };
		await muteMember(member, "rate_limit", Math.floor(Date.now() / 1000) + 60);
		await muteMember(member, "jail", Math.floor(Date.now() / 1000) + 3600);
		restricts.length = 0;
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ? AND kind = 'rate_limit'",
			[userId],
		);
		expect(await releaseMute(member, "rate_limit")).toBe(false);
		expect(restricts).toHaveLength(0);
		expect(
			query("SELECT kind FROM user_rate_limit_mutes WHERE user_id = ?", [
				userId,
			]),
		).toEqual([{ kind: "jail" }]);
	});

	it("restores standard rights when a jail is applied while the member is already restricted", async () => {
		const userId = 88006;
		seedUser(userId, "restricted_target");
		const restricts: Array<Record<string, boolean>> = [];
		const telegram = {
			// Telegram's restricted member has no `permissions` object, so the
			// captured binding must fall back to standard member rights.
			getChatMember: async () => ({
				status: "restricted",
				can_send_messages: false,
			}),
			restrictChatMember: async (
				_chatId: number,
				_userId: number,
				params: { permissions: Record<string, boolean> },
			) => {
				restricts.push(params.permissions);
			},
			sendMessage: async () => ({}),
		} as unknown as Telegram;
		const member = { telegram, chatId: -1001, userId };
		await muteMember(member, "jail", Math.floor(Date.now() / 1000) + 600);
		execute(
			"UPDATE user_rate_limit_mutes SET muted_until = 0 WHERE user_id = ? AND kind = 'jail'",
			[userId],
		);
		await releaseMute(member, "jail");
		expect(restricts[restricts.length - 1]?.can_send_messages).toBe(true);
	});
});
