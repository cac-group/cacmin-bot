/**
 * Spam profile pattern management handlers for the CAC Admin Bot.
 * Provides commands for adding, removing, listing, and testing spam patterns
 * that are matched against user bios and personal channel titles during
 * reaction-based spam detection.
 *
 * Patterns are stored in the database and loaded with caching to avoid
 * repeated DB queries on every reaction event.
 *
 * @module handlers/spamPatterns
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { execute, get, query } from "../database";
import { adminOrHigher, ownerOnly } from "../middleware";
import { spamPatternFieldKeyboard } from "../utils/keyboards";
import { logger, StructuredLogger } from "../utils/logger";
import {
	type CompiledPattern,
	compileSafeRegex,
	validatePattern,
} from "../utils/safeRegex";

/** Valid match field values for spam patterns */
export type SpamPatternField = "bio" | "channel" | "both";

/** Database row shape for a spam pattern */
export interface SpamPatternRow {
	id: number;
	pattern: string;
	match_field: SpamPatternField;
	description: string | null;
	added_by: number | null;
	created_at: number;
}

/** Compiled spam pattern with field targeting */
export interface CompiledSpamPattern {
	id: number;
	raw: string;
	compiled: CompiledPattern;
	matchField: SpamPatternField;
	description: string | null;
}

// --- Pattern Cache ---

/** Cached compiled patterns */
let cachedPatterns: CompiledSpamPattern[] | null = null;

/** Timestamp of last cache refresh */
let cacheTimestamp = 0;

/** Cache TTL in milliseconds (60 seconds) */
const CACHE_TTL_MS = 60_000;

/**
 * Invalidates the spam pattern cache.
 * Call after adding or removing patterns to ensure immediate effect.
 */
export function invalidateSpamPatternCache(): void {
	cachedPatterns = null;
	cacheTimestamp = 0;
}

/**
 * Returns compiled spam patterns from the database, with caching.
 * Patterns are refreshed every 60 seconds or when the cache is explicitly invalidated.
 *
 * @returns Array of compiled spam patterns
 */
export function getDbSpamPatterns(): CompiledSpamPattern[] {
	const now = Date.now();
	if (cachedPatterns && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedPatterns;
	}

	const rows = query<SpamPatternRow>(
		"SELECT * FROM spam_patterns ORDER BY id",
		[],
	);

	const compiled: CompiledSpamPattern[] = [];
	for (const row of rows) {
		try {
			const pattern = compileSafeRegex(row.pattern);
			compiled.push({
				id: row.id,
				raw: row.pattern,
				compiled: pattern,
				matchField: row.match_field,
				description: row.description,
			});
		} catch (error) {
			logger.error("Failed to compile DB spam pattern", {
				patternId: row.id,
				pattern: row.pattern,
				error,
			});
		}
	}

	cachedPatterns = compiled;
	cacheTimestamp = now;
	return compiled;
}

/**
 * Registers all spam pattern management commands with the bot.
 *
 * Commands:
 * - /addspampattern - Add a spam profile pattern (owner only)
 * - /removespampattern - Remove a pattern by ID (owner only)
 * - /listspampatterns - List all active patterns (admin or higher)
 * - /spampatternhelp - Detailed usage guide with examples
 *
 * @param bot - Telegraf bot instance
 */
export function registerSpamPatternHandlers(bot: Telegraf<Context>): void {
	/**
	 * Command: /addspampattern [pattern] [bio|channel|both]
	 *
	 * Interactive mode (no args): Shows field selection keyboard.
	 * Command mode: Adds pattern directly.
	 *
	 * Permission: Owner only
	 */
	bot.command("addspampattern", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const rawArgs = ctx.message?.text.split(" ").slice(1).join(" ") || "";

		// No args -> interactive keyboard flow
		if (!rawArgs.trim()) {
			return ctx.reply(
				fmt`${bold("Add Spam Profile Pattern")}

Select which profile field this pattern should match against:

${bold("Bio")} - The user's biography text
${bold("Channel")} - The user's linked personal channel title
${bold("Both")} - Match against both fields

After selecting, you'll be prompted to enter the pattern.

Or use the command directly:
${code('/addspampattern "pattern" [bio|channel|both]')}

For detailed help: ${code("/spampatternhelp")}`,
				{
					reply_markup: spamPatternFieldKeyboard,
				},
			);
		}

		// Parse args: pattern (possibly quoted) followed by optional field
		const { pattern, field, description } = parseSpamPatternArgs(rawArgs);
		if (!pattern) {
			return ctx.reply(
				fmt`Invalid syntax. Usage:
${code('/addspampattern "pattern" [bio|channel|both]')}
${code("/addspampattern /regex/i [bio|channel|both]")}

For help: ${code("/spampatternhelp")}`,
			);
		}

		await addPattern(ctx, userId, pattern, field, description);
	});

	/**
	 * Command: /removespampattern <id>
	 * Removes a spam pattern by its ID.
	 *
	 * Permission: Owner only
	 */
	bot.command("removespampattern", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const args = ctx.message?.text.split(" ").slice(1) || [];
		const idStr = args[0];

		if (!idStr) {
			return ctx.reply(
				fmt`Usage: ${code("/removespampattern <id>")}

Use ${code("/listspampatterns")} to see pattern IDs.`,
			);
		}

		const patternId = parseInt(idStr, 10);
		if (Number.isNaN(patternId)) {
			return ctx.reply("Invalid pattern ID. Must be a number.");
		}

		const existing = get<SpamPatternRow>(
			"SELECT * FROM spam_patterns WHERE id = ?",
			[patternId],
		);
		if (!existing) {
			return ctx.reply(`No spam pattern found with ID ${patternId}.`);
		}

		execute("DELETE FROM spam_patterns WHERE id = ?", [patternId]);
		invalidateSpamPatternCache();

		StructuredLogger.logSecurityEvent("Spam pattern removed", {
			userId,
			operation: "remove_spam_pattern",
			patternId,
			pattern: existing.pattern,
			matchField: existing.match_field,
		});

		await ctx.reply(
			fmt`Spam pattern #${patternId} removed.
Pattern: ${code(existing.pattern)}
Field: ${existing.match_field}`,
		);
	});

	/**
	 * Command: /listspampatterns
	 * Lists all active spam profile patterns.
	 *
	 * Permission: Admin or higher
	 */
	bot.command("listspampatterns", adminOrHigher, async (ctx) => {
		const rows = query<SpamPatternRow>(
			"SELECT * FROM spam_patterns ORDER BY id",
			[],
		);

		if (rows.length === 0) {
			return ctx.reply(
				"No custom spam patterns configured. Only built-in patterns are active.",
			);
		}

		const lines = rows.map((r) => {
			const desc = r.description ? ` -- ${r.description}` : "";
			const date = new Date(r.created_at * 1000).toISOString().split("T")[0];
			return `#${r.id} [${r.match_field}] ${r.pattern}${desc} (${date})`;
		});

		await ctx.reply(
			fmt`${bold("Spam Profile Patterns")}

${lines.join("\n")}

${bold("Built-in patterns")} (always active):
18+, secret place, onlyfans, adult content, private video, hot content, free nudes, dating site, sexy content, bonus scam, elon musk

Use ${code("/removespampattern <id>")} to remove a pattern.`,
		);
	});

	/**
	 * Command: /testspampattern <pattern> <sample_text>
	 * Tests a pattern against sample text without saving it.
	 *
	 * Permission: Owner only
	 */
	bot.command("testspampattern", ownerOnly, async (ctx) => {
		const rawArgs = ctx.message?.text.split(" ").slice(1).join(" ") || "";
		if (!rawArgs.trim()) {
			return ctx.reply(
				fmt`Usage: ${code('/testspampattern "pattern" sample text here')}

Tests whether a pattern would match the given sample text.`,
			);
		}

		const { pattern, remainder } = parsePatternAndRemainder(rawArgs);
		if (!pattern || !remainder) {
			return ctx.reply(
				fmt`Usage: ${code('/testspampattern "pattern" sample text here')}
${code("/testspampattern /regex/i sample text here")}`,
			);
		}

		const validation = validatePattern(pattern);
		if (!validation.isValid || !validation.sanitized) {
			return ctx.reply(`Invalid pattern: ${validation.error || "unknown"}`);
		}

		try {
			const compiled = compileSafeRegex(validation.sanitized);
			const matches = compiled.regex.test(remainder);
			await ctx.reply(
				fmt`${bold("Pattern Test")}

Pattern: ${code(pattern)} (${compiled.type})
Sample: ${code(remainder)}
Result: ${matches ? "MATCH" : "no match"}`,
			);
		} catch (error) {
			await ctx.reply(
				`Pattern compilation error: ${error instanceof Error ? error.message : "unknown"}`,
			);
		}
	});

	/**
	 * Command: /spampatternhelp
	 * Displays detailed usage guide for spam pattern management.
	 *
	 * Permission: Admin or higher
	 */
	bot.command("spampatternhelp", adminOrHigher, async (ctx) => {
		await ctx.reply(
			fmt`${bold("Spam Profile Pattern Guide")}

Spam patterns are matched against the profiles of users who react to messages. If a low-message user's profile matches, they are permanently banned.

${bold("Profile Fields:")}

${bold("bio")} - The "Bio" text on a user's profile
Example: A spammer with bio "Hot content 18+ click here"

${bold("channel")} - The personal channel linked on a user's profile
Example: A scam bot with channel titled "BONUS 1000$"

${bold("both")} (default) - Matches against both fields

${bold("Pattern Types:")}

${bold("Simple text")} (case-insensitive substring match):
${code('/addspampattern "bonus" channel')}
Matches: "BONUS 1000$", "Get your bonus now"

${bold("Wildcards")} (* = any chars, ? = single char):
${code('/addspampattern "free*nudes" bio')}
Matches: "free nudes", "free hot nudes"

${bold("Regex")} (/pattern/flags format):
${code("/addspampattern /bonus\\s*\\d+\\s*\\$/i channel")}
Matches: "BONUS 1000$", "bonus 500 $"

${bold("Examples:")}

Block "crypto giveaway" scam channels:
${code('/addspampattern "crypto giveaway" channel')}

Block channels with dollar amounts:
${code("/addspampattern /\\d+\\s*\\$/i channel")}

Block bio spam with adult content:
${code("/addspampattern /cam\\s*girl/i bio")}

Block "Elon Musk" scam channels:
${code('/addspampattern "elon musk" channel')}

${bold("Testing:")}
${code('/testspampattern "bonus" BONUS 1000$')}
Tests a pattern against sample text without saving.

${bold("Management:")}
${code("/listspampatterns")} - View all patterns
${code("/removespampattern <id>")} - Remove by ID`,
		);
	});

	logger.info("Spam pattern management handlers registered");
}

// --- Internal helpers ---

/**
 * Adds a spam pattern to the database after validation.
 *
 * @param ctx - Telegraf context for replying
 * @param userId - ID of the user adding the pattern
 * @param pattern - Pattern string to add
 * @param field - Which profile field to match
 * @param description - Optional description
 */
export async function addPattern(
	ctx: Context,
	userId: number,
	pattern: string,
	field: SpamPatternField,
	description?: string,
): Promise<void> {
	// Validate the pattern
	const validation = validatePattern(pattern);
	if (!validation.isValid || !validation.sanitized) {
		await ctx.reply(`Invalid pattern: ${validation.error || "unknown"}`);
		return;
	}

	const sanitized = validation.sanitized;

	// Try to compile it
	try {
		compileSafeRegex(sanitized);
	} catch (error) {
		await ctx.reply(
			`Pattern compilation failed: ${error instanceof Error ? error.message : "unknown"}`,
		);
		return;
	}

	// Check for duplicate
	const existing = get<SpamPatternRow>(
		"SELECT * FROM spam_patterns WHERE pattern = ?",
		[sanitized],
	);
	if (existing) {
		await ctx.reply(
			fmt`Pattern already exists as #${existing.id} [${existing.match_field}].`,
		);
		return;
	}

	// Insert
	execute(
		"INSERT INTO spam_patterns (pattern, match_field, description, added_by) VALUES (?, ?, ?, ?)",
		[sanitized, field, description || null, userId],
	);
	invalidateSpamPatternCache();

	const inserted = get<SpamPatternRow>(
		"SELECT * FROM spam_patterns WHERE pattern = ?",
		[sanitized],
	);

	StructuredLogger.logSecurityEvent("Spam pattern added", {
		userId,
		operation: "add_spam_pattern",
		patternId: inserted?.id,
		pattern: sanitized,
		matchField: field,
		description,
	});

	await ctx.reply(
		fmt`Spam pattern added (#${inserted?.id || "?"}).
Pattern: ${code(sanitized)}
Field: ${field}${description ? `\nDescription: ${description}` : ""}

Bots matching this in their profile will be auto-banned on first reaction.`,
	);
}

/**
 * Parses command arguments for /addspampattern.
 * Supports quoted patterns and optional field/description.
 *
 * @param rawArgs - Raw argument string after the command
 * @returns Parsed pattern, field, and description
 */
function parseSpamPatternArgs(rawArgs: string): {
	pattern: string | null;
	field: SpamPatternField;
	description?: string;
} {
	let pattern: string | null = null;
	let remaining = rawArgs.trim();
	let field: SpamPatternField = "both";

	// Handle quoted pattern
	if (remaining.startsWith('"')) {
		const endQuote = remaining.indexOf('"', 1);
		if (endQuote === -1) {
			return { pattern: null, field };
		}
		pattern = remaining.substring(1, endQuote);
		remaining = remaining.substring(endQuote + 1).trim();
	}
	// Handle regex pattern (/.../)
	else if (remaining.startsWith("/")) {
		const lastSlash = remaining.lastIndexOf("/");
		if (lastSlash <= 0) {
			return { pattern: null, field };
		}
		// Check for flags after the last slash
		let endIdx = lastSlash + 1;
		while (endIdx < remaining.length && /[gimsu]/.test(remaining[endIdx])) {
			endIdx++;
		}
		pattern = remaining.substring(0, endIdx);
		remaining = remaining.substring(endIdx).trim();
	}
	// Unquoted single-word pattern
	else {
		const parts = remaining.split(/\s+/);
		pattern = parts[0];
		remaining = parts.slice(1).join(" ").trim();
	}

	if (!pattern) return { pattern: null, field };

	// Parse optional field
	const parts = remaining.split(/\s+/);
	if (parts[0] && ["bio", "channel", "both"].includes(parts[0])) {
		field = parts[0] as SpamPatternField;
		remaining = parts.slice(1).join(" ").trim();
	}

	return {
		pattern,
		field,
		description: remaining || undefined,
	};
}

/**
 * Parses a pattern and remaining text from /testspampattern args.
 *
 * @param rawArgs - Raw argument string
 * @returns Pattern and remainder text
 */
function parsePatternAndRemainder(rawArgs: string): {
	pattern: string | null;
	remainder: string | null;
} {
	const remaining = rawArgs.trim();

	// Quoted pattern
	if (remaining.startsWith('"')) {
		const endQuote = remaining.indexOf('"', 1);
		if (endQuote === -1) return { pattern: null, remainder: null };
		const pattern = remaining.substring(1, endQuote);
		const rest = remaining.substring(endQuote + 1).trim();
		return { pattern, remainder: rest || null };
	}

	// Regex pattern
	if (remaining.startsWith("/")) {
		const lastSlash = remaining.lastIndexOf("/");
		if (lastSlash <= 0) return { pattern: null, remainder: null };
		let endIdx = lastSlash + 1;
		while (endIdx < remaining.length && /[gimsu]/.test(remaining[endIdx])) {
			endIdx++;
		}
		const pattern = remaining.substring(0, endIdx);
		const rest = remaining.substring(endIdx).trim();
		return { pattern, remainder: rest || null };
	}

	// First word as pattern
	const spaceIdx = remaining.indexOf(" ");
	if (spaceIdx === -1) return { pattern: null, remainder: null };
	return {
		pattern: remaining.substring(0, spaceIdx),
		remainder: remaining.substring(spaceIdx + 1).trim(),
	};
}
