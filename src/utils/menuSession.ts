/**
 * Menu session manager for tracking interactive menu ownership and expiry.
 * Ensures only the initiating user can interact with a menu and prevents
 * duplicate menus from cluttering the chat.
 *
 * @module utils/menuSession
 */

import type { Context } from "telegraf";
import type { FmtString } from "telegraf/format";
import type { InlineKeyboardMarkup } from "telegraf/types";

export interface MenuSession {
	userId: number;
	chatId: number;
	messageId: number;
	menuType: string;
	createdAt: number;
	expiresAt: number;
}

/** Reference to the single message that drives an interactive flow. */
export interface MenuRef {
	chatId: number;
	messageId: number;
}

/** Capture the originating menu message from a callback context. */
export function menuRefFromContext(ctx: Context): MenuRef | null {
	const chatId = ctx.chat?.id;
	const messageId = ctx.callbackQuery?.message?.message_id;
	return chatId && messageId ? { chatId, messageId } : null;
}

/**
 * Render a flow step into its originating menu message. The keyboard is
 * removed unless an explicit replacement is supplied, so a flow never leaves
 * stale buttons behind. Falls back to a fresh reply when the menu message is
 * gone or the update did not originate from a button.
 */
export async function editMenu(
	ctx: Context,
	ref: MenuRef | null | undefined,
	text: string | FmtString,
	replyMarkup: InlineKeyboardMarkup = { inline_keyboard: [] },
): Promise<void> {
	if (ref) {
		try {
			await ctx.telegram.editMessageText(
				ref.chatId,
				ref.messageId,
				undefined,
				text,
				{ reply_markup: replyMarkup },
			);
			return;
		} catch {
			// Menu message may have been deleted or is too old.
		}
	}
	await ctx.reply(text);
}

// Menu expiry time in milliseconds (30 seconds)
const MENU_EXPIRY_MS = 30 * 1000;

// Active menu sessions by chat
// Key: `${chatId}_${menuType}` to prevent duplicate menus of same type per chat
const activeMenus = new Map<string, MenuSession>();

// Track menus by message ID for quick lookup during callbacks
const menusByMessageId = new Map<string, MenuSession>();

/**
 * Create a new menu session
 * @returns The session if created, or null if a menu of this type already exists
 */
export function createMenuSession(
	userId: number,
	chatId: number,
	messageId: number,
	menuType: string,
): MenuSession | null {
	const chatKey = `${chatId}_${menuType}`;
	const now = Date.now();

	// Check if there's an existing active menu of this type
	const existing = activeMenus.get(chatKey);
	if (existing && existing.expiresAt > now) {
		return null; // Menu already exists and hasn't expired
	}

	// Remove any expired menu
	if (existing) {
		cleanupSession(existing);
	}

	const session: MenuSession = {
		userId,
		chatId,
		messageId,
		menuType,
		createdAt: now,
		expiresAt: now + MENU_EXPIRY_MS,
	};

	activeMenus.set(chatKey, session);
	menusByMessageId.set(`${chatId}_${messageId}`, session);

	return session;
}

/**
 * Get menu session by message ID
 */
export function getMenuSessionByMessage(
	chatId: number,
	messageId: number,
): MenuSession | null {
	const key = `${chatId}_${messageId}`;
	const session = menusByMessageId.get(key);

	if (!session) return null;

	// Check if expired
	if (Date.now() > session.expiresAt) {
		cleanupSession(session);
		return null;
	}

	return session;
}

/**
 * Get active menu session by chat and type
 */
export function getActiveMenuSession(
	chatId: number,
	menuType: string,
): MenuSession | null {
	const key = `${chatId}_${menuType}`;
	const session = activeMenus.get(key);

	if (!session) return null;

	// Check if expired
	if (Date.now() > session.expiresAt) {
		cleanupSession(session);
		return null;
	}

	return session;
}

/**
 * Clean up a menu session
 */
export function cleanupSession(session: MenuSession): void {
	const chatKey = `${session.chatId}_${session.menuType}`;
	const msgKey = `${session.chatId}_${session.messageId}`;

	activeMenus.delete(chatKey);
	menusByMessageId.delete(msgKey);
}

/**
 * Clean up menu session by message ID
 */
export function cleanupMenuByMessage(chatId: number, messageId: number): void {
	const session = menusByMessageId.get(`${chatId}_${messageId}`);
	if (session) {
		cleanupSession(session);
	}
}

/**
 * Validate menu interaction from callback context
 * Returns error message if interaction not allowed, null if allowed
 */
export async function validateMenuInteraction(
	ctx: Context,
	_menuType: string,
): Promise<string | null> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;
	const messageId = ctx.callbackQuery?.message?.message_id;

	if (!userId || !chatId || !messageId) {
		return "Invalid context";
	}

	const session = getMenuSessionByMessage(chatId, messageId);

	if (!session) {
		return "This menu has expired.";
	}

	if (session.userId !== userId) {
		return "Only the person who started this can use these buttons.";
	}

	return null; // Interaction allowed
}

/**
 * Clean up all expired sessions (call periodically)
 */
export function cleanupExpiredSessions(): void {
	const now = Date.now();

	for (const [key, session] of activeMenus.entries()) {
		if (now > session.expiresAt) {
			activeMenus.delete(key);
			menusByMessageId.delete(`${session.chatId}_${session.messageId}`);
		}
	}
}

// Run cleanup every minute
setInterval(cleanupExpiredSessions, 60 * 1000);
