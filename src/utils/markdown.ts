/**
 * MarkdownV2 escaping utilities for Telegram messages.
 *
 * IMPORTANT: Prefer using Telegraf's Format module (fmt, bold, italic, code, etc.)
 * from 'telegraf/format' for new code. It uses entity-based formatting which
 * doesn't require any escaping.
 *
 * Example:
 * ```typescript
 * import { fmt, bold, code } from 'telegraf/format';
 * ctx.reply(fmt`Hello ${bold(username)}! Balance: ${code(amount)}`);
 * ```
 *
 * The functions below are kept for backwards compatibility and edge cases
 * where manual MarkdownV2 strings are needed.
 *
 * @module utils/markdown
 */

/**
 * Characters that must be escaped in MarkdownV2 (outside formatting).
 */
const MARKDOWN_V2_SPECIAL_CHARS = /([_*[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escapes special characters for Telegram MarkdownV2 format.
 * @deprecated Prefer using Telegraf's Format module (fmt, bold, etc.) instead.
 *
 * @param text - The text to escape
 * @returns The escaped text safe for MarkdownV2
 *
 * @example
 * ```typescript
 * escapeMarkdownV2('Hello-World 1.5 JUNO');
 * // Returns: 'Hello\\-World 1\\.5 JUNO'
 * ```
 */
export function escapeMarkdownV2(text: string | number): string {
	return String(text).replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$1");
}

/**
 * Escapes a number formatted with decimals for MarkdownV2.
 * Convenience wrapper for numeric values.
 *
 * @param value - The numeric value
 * @param decimals - Number of decimal places (default: 2)
 * @returns Escaped string representation
 *
 * @example
 * ```typescript
 * escapeNumber(123.456, 2);
 * // Returns: '123\\.46'
 * ```
 */
export function escapeNumber(value: number, decimals = 2): string {
	return escapeMarkdownV2(value.toFixed(decimals));
}
