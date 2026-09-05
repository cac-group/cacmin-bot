/**
 * Recent bot-response deduplication utilities.
 *
 * @module utils/autoDelete
 */

import type { Context, Telegram } from "telegraf";
import type { Message } from "telegraf/types";

/** Responses with the same event key are considered duplicates for this period. */
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

interface TrackedResponse {
	chatId: number;
	messageId: number;
	sentAt: number;
}

const recentResponses = new Map<string, TrackedResponse>();

function responseKey(chatId: number, userId: number, eventKey: string): string {
	return `${chatId}:${userId}:${eventKey}`;
}

/**
 * Remove a recent response before sending its replacement.
 *
 * @param telegram - Telegram instance for API calls
 * @param chatId - Chat containing the response
 * @param userId - User addressed by the response
 * @param eventKey - Command or event identity
 */
export async function prepareResponse(
	telegram: Telegram,
	chatId: number,
	userId: number,
	eventKey: string,
): Promise<void> {
	const key = responseKey(chatId, userId, eventKey);
	const previous = recentResponses.get(key);
	if (!previous || Date.now() - previous.sentAt > DEDUPE_WINDOW_MS) return;

	try {
		await telegram.deleteMessage(previous.chatId, previous.messageId);
	} catch {
		// If deletion fails, the old message is likely no longer prominent.
	}
	recentResponses.delete(key);
}

/**
 * Record a newly sent response for later duplicate suppression.
 *
 * @param chatId - Chat containing the response
 * @param userId - User addressed by the response
 * @param eventKey - Command or event identity
 * @param messageId - New bot response message ID
 */
export function recordResponse(
	chatId: number,
	userId: number,
	eventKey: string,
	messageId: number,
): void {
	recentResponses.set(responseKey(chatId, userId, eventKey), {
		chatId,
		messageId,
		sentAt: Date.now(),
	});
}

/**
 * Delete the previous response for an event when it is repeated shortly after.
 * @param telegram - Telegram instance for API calls
 * @param chatId - Chat containing the message
 * @param userId - User who initiated the event
 * @param eventKey - Command or event identity
 * @param messageId - New bot response message ID
 */
export async function dedupeResponse(
	telegram: Telegram,
	chatId: number,
	userId: number,
	eventKey: string,
	messageId: number,
): Promise<void> {
	await prepareResponse(telegram, chatId, userId, eventKey);
	recordResponse(chatId, userId, eventKey, messageId);
}

/**
 * Track a bot response for recent duplicate suppression.
 * @param ctx - Telegraf context
 * @param botMessageId - Bot response message ID
 */
export async function trackResponse(
	ctx: Context,
	botMessageId: number,
	eventKey?: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	const userId = ctx.from?.id;
	if (!chatId || !userId) return;

	const text =
		ctx.message && "text" in ctx.message ? ctx.message.text : "message";
	const command = text.trim().split(/\s+/, 1)[0].toLowerCase();
	await dedupeResponse(
		ctx.telegram,
		chatId,
		userId,
		eventKey || command,
		botMessageId,
	);
}

/**
 * Helper to send a reply and track it for recent duplicate suppression.
 * Returns the sent message for further use if needed.
 * @param ctx - Telegraf context
 * @param content - Message content (string or FmtString)
 * @param options - Reply options (optional)
 */
export async function replyAndDelete<T extends Message>(
	ctx: Context,
	content: Parameters<Context["reply"]>[0],
	options?: Parameters<Context["reply"]>[1],
	eventKey?: string,
): Promise<T> {
	const sentMessage = (await ctx.reply(content as string, options)) as T;
	await trackResponse(ctx, sentMessage.message_id, eventKey);
	return sentMessage;
}

/**
 * Track a response for recent duplicate suppression.
 * @param ctx - Telegraf context
 * @param botMessageId - Bot response message ID
 */
export async function autoDeleteInGroup(
	ctx: Context,
	botMessageId: number,
	eventKey?: string,
): Promise<void> {
	await trackResponse(ctx, botMessageId, eventKey);
}

/**
 * Helper to send a reply and track it for recent duplicate suppression.
 * @param ctx - Telegraf context
 * @param content - Message content (string or FmtString)
 * @param options - Reply options (optional)
 */
export async function replyWithAutoDelete<T extends Message>(
	ctx: Context,
	content: Parameters<Context["reply"]>[0],
	options?: Parameters<Context["reply"]>[1],
	eventKey?: string,
): Promise<T> {
	const sentMessage = (await ctx.reply(content as string, options)) as T;
	await autoDeleteInGroup(ctx, sentMessage.message_id, eventKey);
	return sentMessage;
}
