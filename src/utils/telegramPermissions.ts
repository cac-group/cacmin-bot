/**
 * Shared Telegram chat-permission sets.
 *
 * `restrictChatMember` needs a full permission object; keeping the two
 * canonical shapes here avoids copy-pasting 14 fields across handlers.
 *
 * @module utils/telegramPermissions
 */

import type { ChatPermissions } from "telegraf/types";

/** Every sending permission disabled — mute or jail a member. */
export const CHAT_MUTE_PERMISSIONS: ChatPermissions = {
	can_send_messages: false,
	can_send_audios: false,
	can_send_documents: false,
	can_send_photos: false,
	can_send_videos: false,
	can_send_video_notes: false,
	can_send_voice_notes: false,
	can_send_polls: false,
	can_send_other_messages: false,
	can_add_web_page_previews: false,
	can_change_info: false,
	can_invite_users: false,
	can_pin_messages: false,
	can_manage_topics: false,
};

/** Standard member permissions restored when a mute/jail ends. */
export const CHAT_RESTORE_PERMISSIONS: ChatPermissions = {
	can_send_messages: true,
	can_send_audios: true,
	can_send_documents: true,
	can_send_photos: true,
	can_send_videos: true,
	can_send_video_notes: true,
	can_send_voice_notes: true,
	can_send_polls: true,
	can_send_other_messages: true,
	can_add_web_page_previews: true,
	can_change_info: false,
	can_invite_users: true,
	can_pin_messages: false,
	can_manage_topics: false,
};
