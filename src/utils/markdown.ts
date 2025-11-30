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
 * Tagged template literal for building MarkdownV2 messages.
 * Escapes BOTH static template parts AND interpolated values, EXCEPT for
 * MarkdownV2 formatting markers: * _ ` [ ] and newlines.
 *
 * @deprecated Prefer using Telegraf's Format module (fmt, bold, etc.) instead.
 * The Telegraf fmt function uses entity-based formatting which doesn't require escaping.
 *
 * @example
 * ```typescript
 * const amount = 1.5;
 * const user = "test_user";
 * md`Sent *${amount}* JUNO to ${user}!`
 * // Returns: 'Sent *1\\.5* JUNO to test\\_user\\!'
 * ```
 */
export function md(
	strings: TemplateStringsArray,
	...values: (string | number)[]
): string {
	// Chars to escape in static parts (excludes formatting: * _ ` [ ])
	const staticEscape = /([()~>#+\-=|{}.!\\])/g;
	return strings.reduce((result, str, i) => {
		const escapedStr = str.replace(staticEscape, "\\$1");
		const value = i < values.length ? escapeMarkdownV2(values[i]) : "";
		return result + escapedStr + value;
	}, "");
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

/**
 * Formats a JUNO amount with proper escaping for MarkdownV2.
 *
 * @param amount - The JUNO amount
 * @param decimals - Number of decimal places (default: 6)
 * @returns Escaped string like "1\\.234567 JUNO"
 *
 * @example
 * ```typescript
 * formatJunoAmount(1.5);
 * // Returns: '1\\.500000 JUNO'
 * ```
 */
export function formatJunoAmount(amount: number, decimals = 6): string {
	return `${escapeNumber(amount, decimals)} JUNO`;
}
