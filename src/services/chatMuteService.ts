/**
 * Telegram-side chat muting.
 *
 * `restrictChatMember` needs an explicit, complete permission set: any field
 * omitted is treated as `false`. Every mute therefore denies the same explicit
 * set, and every restore re-applies the permissions the member actually had
 * before the mute (captured from `getChatMember`) so lifting a mute never grants
 * more than before. Telegram also treats an `until_date` under 30 seconds away
 * as a permanent restriction, so all mute deadlines are clamped.
 *
 * Every mute kind stores its deadline and captured binding in
 * `user_rate_limit_mutes` keyed on `(user_id, kind)`, so a short jail and a long
 * rate-limit mute never overwrite each other. `releaseMute` only lifts the chat
 * restriction once no kind still has an active deadline.
 *
 * @module services/chatMuteService
 */

import type { Telegram } from "telegraf";
import type { ChatPermissions } from "telegraf/types";
import { execute, get, query } from "../database";
import { logger } from "../utils/logger";
import {
	CHAT_MUTE_PERMISSIONS,
	CHAT_RESTORE_PERMISSIONS,
	PERMISSION_FIELDS,
} from "../utils/telegramPermissions";

/** Distinguishes mute sources sharing the same table. */
export type MuteKind =
	| "rate_limit"
	| "flood"
	| "jail"
	| "reaction_spam"
	| "identity_block"
	| "duel"
	| "restriction";

/** A member's permissions prior to a mute, stored so it can be restored. */
export interface PermissionBinding {
	kind: "permissions" | "status";
	permissions?: ChatPermissions;
	status?: string;
}

/** One chat, one Telegram client, one user. */
export interface ChatMember {
	telegram: Telegram;
	chatId: number;
	userId: number;
}

/** Capture a member's current permission binding so it can be restored later. */
export async function bindMemberPermissions(
	telegram: Telegram,
	chatId: number,
	userId: number,
): Promise<PermissionBinding> {
	const member = await telegram.getChatMember(chatId, userId);
	if (member.status === "administrator" || member.status === "creator") {
		return { kind: "status", status: member.status };
	}
	const memberPermissions =
		"permissions" in member && member.permissions ? member.permissions : {};
	const defaults = { ...CHAT_MUTE_PERMISSIONS };
	for (const field of PERMISSION_FIELDS) defaults[field] = true;
	defaults.can_change_info = false;
	defaults.can_pin_messages = false;
	defaults.can_manage_topics = false;
	return {
		kind: "permissions",
		permissions: { ...defaults, ...memberPermissions },
	};
}

/** Serialize a binding for storage in a `permission_snapshot` column. */
export function serializeBinding(binding: PermissionBinding): string {
	return JSON.stringify(binding);
}

/** Parse a stored binding, tolerating the legacy bare-permissions format. */
export function parseBinding(snapshot: string): PermissionBinding {
	try {
		const parsed = JSON.parse(snapshot);
		if (!parsed || typeof parsed !== "object") {
			return { kind: "permissions", permissions: {} };
		}
		if (parsed.kind === "status" || parsed.kind === "permissions") {
			return parsed as PermissionBinding;
		}
		return { kind: "permissions", permissions: parsed as ChatPermissions };
	} catch {
		return { kind: "permissions", permissions: {} };
	}
}

/**
 * Mute a member until `until` (unix seconds), capturing their prior permissions
 * for later restoration. Clamps the deadline past Telegram's 30-second
 * permanent-mute threshold and keeps the furthest-out deadline for the kind.
 */
export async function muteMember(
	member: ChatMember,
	kind: MuteKind,
	until: number,
): Promise<void> {
	const untilDate = Math.max(until, Math.floor(Date.now() / 1000) + 31);
	const binding = await bindMemberPermissions(
		member.telegram,
		member.chatId,
		member.userId,
	);
	await member.telegram.restrictChatMember(member.chatId, member.userId, {
		permissions: CHAT_MUTE_PERMISSIONS,
		until_date: untilDate,
		use_independent_chat_permissions: true,
	});
	execute(
		`INSERT INTO user_rate_limit_mutes (user_id, kind, muted_until, limiting_window, permission_snapshot)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET
		 muted_until=MAX(muted_until, excluded.muted_until)`,
		[member.userId, kind, untilDate, kind, serializeBinding(binding)],
	);
	logger.warn("Chat mute applied", {
		tag: "moderation",
		subtag: "mute_applied",
		userId: member.userId,
		chatId: member.chatId,
		kind,
		until: untilDate,
	});
	await announce(member, "muted");
}

/** Post a one-line mute/unmute notice to the chat. Skipped without a real username. */
async function announce(
	member: ChatMember,
	kind: "muted" | "unmuted",
): Promise<void> {
	const row = get<{ username: string | null }>(
		"SELECT username FROM users WHERE id = ?",
		[member.userId],
	);
	// Skip placeholder identities like `user_123`; they are not real handles.
	const username = row?.username;
	if (!username || username.startsWith("user_")) return;
	await member.telegram
		.sendMessage(
			member.chatId,
			kind === "muted"
				? `@${username} has been muted.`
				: `@${username} has been unmuted.`,
		)
		.catch(() => {});
}

/** Whether any mute kind still has an unexpired deadline for this user. */
function hasActiveMute(userId: number, now: number): boolean {
	return Boolean(
		query<{ user_id: number }>(
			"SELECT user_id FROM user_rate_limit_mutes WHERE user_id = ? AND muted_until > ? LIMIT 1",
			[userId, now],
		)[0],
	);
}

/** Remove every stored binding for a user. */
function clearBindings(userId: number): void {
	execute("DELETE FROM user_rate_limit_mutes WHERE user_id = ?", [userId]);
}

/** Whether any mute binding is stored for this user. */
export function hasStoredBinding(userId: number): boolean {
	return Boolean(
		query<{ user_id: number }>(
			"SELECT user_id FROM user_rate_limit_mutes WHERE user_id = ? LIMIT 1",
			[userId],
		)[0],
	);
}

/**
 * The pre-mute binding for a full release. Any stored binding reflects the same
 * unrestricted state, so the earliest-captured one is authoritative.
 */
export function getStoredBinding(userId: number): PermissionBinding | null {
	const first = query<{ permission_snapshot: string }>(
		"SELECT permission_snapshot FROM user_rate_limit_mutes WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
		[userId],
	)[0];
	if (first) return parseBinding(first.permission_snapshot);
	const row = get<{ permission_snapshot: string }>(
		"SELECT permission_snapshot FROM user_rate_limit_mutes WHERE user_id = ? LIMIT 1",
		[userId],
	);
	return row ? parseBinding(row.permission_snapshot) : null;
}

/**
 * Lift one kind's mute once its deadline has passed. Deletes just that binding,
 * and only re-grants chat permissions when no other kind is still active. A
 * `status` binding never triggers a restore call: the member's admin status
 * already grants speech, so re-applying permissions would only risk demotion.
 */
export async function releaseMute(
	member: ChatMember,
	kind: MuteKind,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	// Delete first and let the row count arbitrate: only the caller whose DELETE
	// actually removed this kind's expired row proceeds, so overlapping cleanups
	// cannot restore or announce twice.
	const binding = get<{ permission_snapshot: string }>(
		"SELECT permission_snapshot FROM user_rate_limit_mutes WHERE user_id = ? AND kind = ?",
		[member.userId, kind],
	);
	const deleted = execute(
		"DELETE FROM user_rate_limit_mutes WHERE user_id = ? AND kind = ? AND muted_until <= ?",
		[member.userId, kind, now],
	);
	if (deleted.changes === 0) return false;
	// Another kind (e.g. a jail) is still muting; leave the restriction in place.
	if (hasActiveMute(member.userId, now)) return false;
	clearBindings(member.userId);
	// `status` bindings are not restored: admins already have speech rights.
	if (binding) {
		const parsed = parseBinding(binding.permission_snapshot);
		if (parsed.kind !== "status") {
			await member.telegram.restrictChatMember(member.chatId, member.userId, {
				permissions: parsed.permissions ?? {},
			});
		}
	}
	await announce(member, "unmuted");
	return true;
}

/**
 * Full release for manual unjail and bail payment: apply the stored binding (or
 * standard member rights when none was captured) and clear every binding.
 */
export async function releaseMember(member: ChatMember): Promise<void> {
	const binding = getStoredBinding(member.userId);
	// Admins/creators hold rights that chat permissions cannot express; a restore
	// call would risk demoting them, so only clear our records.
	const current =
		binding ??
		(await bindMemberPermissions(
			member.telegram,
			member.chatId,
			member.userId,
		));
	if (current.kind === "status") {
		clearBindings(member.userId);
		return;
	}
	await member.telegram.restrictChatMember(member.chatId, member.userId, {
		// Prefer the stored binding; otherwise use the state captured just now.
		permissions:
			binding?.permissions ?? current.permissions ?? CHAT_RESTORE_PERMISSIONS,
	});
	clearBindings(member.userId);
	await announce(member, "unmuted");
}
