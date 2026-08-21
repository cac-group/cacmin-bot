/**
 * Identity block handlers for banning users whose visible Telegram identity matches spam patterns.
 * Matches first name, last name, full display name, or username on joins, messages, and chat-member updates.
 *
 * @module handlers/identityBlocks
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import type { User } from "telegraf/types";
import { execute, get, query } from "../database";
import { adminOrHigher, ownerOnly } from "../middleware";
import { logger, StructuredLogger } from "../utils/logger";
import { isAdmin, isOwner } from "../utils/roles";
import {
	type CompiledPattern,
	compileSafeRegex,
	validatePattern,
} from "../utils/safeRegex";

export type IdentityBlockField = "name" | "username" | "both";

interface IdentityBlockRow {
	id: number;
	pattern: string;
	match_field: IdentityBlockField;
	description: string | null;
	added_by: number | null;
	created_at: number;
}

interface CompiledIdentityBlock {
	id: number;
	raw: string;
	compiled: CompiledPattern;
	matchField: IdentityBlockField;
	description: string | null;
}

interface IdentityMatch {
	field: string;
	patternSource: string;
	matchedValue: string;
}

const CACHE_TTL_MS = 60_000;

const BUILTIN_IDENTITY_PATTERNS: CompiledIdentityBlock[] = [
	{
		id: 0,
		raw: "/chi\\.?ld\\s*po\\.?rn\\s*gds81/i",
		compiled: compileSafeRegex("/chi\\.?ld\\s*po\\.?rn\\s*gds81/i"),
		matchField: "both",
		description: "Child exploitation spam signature",
	},
];

let cachedPatterns: CompiledIdentityBlock[] | null = null;
let cacheTimestamp = 0;

export function invalidateIdentityBlockCache(): void {
	cachedPatterns = null;
	cacheTimestamp = 0;
}

export function getDbIdentityBlocks(): CompiledIdentityBlock[] {
	const now = Date.now();
	if (cachedPatterns && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedPatterns;
	}

	const rows = query<IdentityBlockRow>(
		"SELECT * FROM identity_block_patterns ORDER BY id",
		[],
	);

	const compiled: CompiledIdentityBlock[] = [];
	for (const row of rows) {
		try {
			compiled.push({
				id: row.id,
				raw: row.pattern,
				compiled: compileSafeRegex(row.pattern),
				matchField: row.match_field,
				description: row.description,
			});
		} catch (error) {
			logger.error("Failed to compile identity block pattern", {
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

export function detectBlockedIdentity(user: User): IdentityMatch | null {
	const firstName = user.first_name?.trim();
	const lastName = user.last_name?.trim();
	const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
	const username = user.username?.trim();

	const fields: [IdentityBlockField, string, string | undefined][] = [
		["name", "display_name", displayName || undefined],
		["name", "first_name", firstName],
		["name", "last_name", lastName],
		["username", "username", username],
		["username", "username", username ? `@${username}` : undefined],
	];

	for (const pattern of [
		...BUILTIN_IDENTITY_PATTERNS,
		...getDbIdentityBlocks(),
	]) {
		for (const [fieldType, fieldName, value] of fields) {
			if (!value) continue;
			if (pattern.matchField !== "both" && pattern.matchField !== fieldType) {
				continue;
			}

			try {
				pattern.compiled.regex.lastIndex = 0;
				if (pattern.compiled.regex.test(value)) {
					return {
						field: fieldName,
						patternSource:
							pattern.id === 0 ? "builtin" : `db#${pattern.id}:${pattern.raw}`,
						matchedValue: value,
					};
				}
			} catch {
				// Skip broken patterns without interrupting moderation flow.
			}
		}
	}

	return null;
}

export async function banIfBlockedIdentity(
	telegram: Telegraf<Context>["telegram"],
	chatId: number,
	user: User,
	source: string,
): Promise<boolean> {
	if (isOwner(user.id) || isAdmin(user.id)) {
		return false;
	}

	const match = detectBlockedIdentity(user);
	if (!match) {
		return false;
	}

	try {
		await telegram.banChatMember(chatId, user.id);

		StructuredLogger.logSecurityEvent("User auto-banned via identity block", {
			userId: user.id,
			username: user.username,
			firstName: user.first_name,
			lastName: user.last_name,
			chatId,
			matchedField: match.field,
			matchedValue: match.matchedValue.substring(0, 200),
			patternSource: match.patternSource,
			operation: "identity_block_ban",
			source,
		});

		logger.info("[IDENTITY_BLOCK_BAN]", {
			userId: user.id,
			username: user.username,
			firstName: user.first_name,
			lastName: user.last_name,
			chatId,
			matchedField: match.field,
			patternSource: match.patternSource,
			source,
		});

		return true;
	} catch (error) {
		logger.error("Failed to ban identity-blocked user", {
			userId: user.id,
			chatId,
			error,
		});
		return false;
	}
}

export function registerIdentityBlockModeration(bot: Telegraf<Context>): void {
	bot.on("message", async (ctx, next) => {
		const chatId = ctx.chat?.id;
		const msg = ctx.message;

		if (!chatId || !msg || ctx.chat?.type === "private") {
			return next();
		}

		if ("new_chat_members" in msg && msg.new_chat_members) {
			for (const member of msg.new_chat_members) {
				await banIfBlockedIdentity(ctx.telegram, chatId, member, "join");
			}
			return next();
		}

		if (ctx.from) {
			const banned = await banIfBlockedIdentity(
				ctx.telegram,
				chatId,
				ctx.from,
				"message",
			);

			if (banned) {
				try {
					await ctx.deleteMessage();
				} catch {
					// Message may already be gone or bot may not have delete rights.
				}
				return;
			}
		}

		return next();
	});

	bot.on("chat_member", async (ctx) => {
		const update = ctx.chatMember;
		if (!update || update.chat.type === "private") return;

		await banIfBlockedIdentity(
			ctx.telegram,
			update.chat.id,
			update.new_chat_member.user,
			"chat_member",
		);
	});

	logger.info("Identity block moderation registered");
}

export function registerIdentityBlockHandlers(bot: Telegraf<Context>): void {
	bot.command("addidentityblock", ownerOnly, async (ctx) => {
		const userId = ctx.from?.id;
		if (!userId) return;

		const rawArgs = ctx.message?.text.split(" ").slice(1).join(" ") || "";
		const { pattern, field, description } = parseIdentityBlockArgs(rawArgs);

		if (!pattern) {
			return ctx.reply(
				fmt`Usage: ${code('/addidentityblock "pattern" [name|username|both]')}
${code("/addidentityblock /regex/i [name|username|both]")}

For help: ${code("/identityblockhelp")}`,
			);
		}

		await addIdentityBlockPattern(ctx, userId, pattern, field, description);
	});

	bot.command("removeidentityblock", ownerOnly, async (ctx) => {
		const id = Number(ctx.message?.text.split(" ")[1]);
		if (!Number.isInteger(id)) {
			return ctx.reply("Usage: /removeidentityblock <id>");
		}

		const existing = get<IdentityBlockRow>(
			"SELECT * FROM identity_block_patterns WHERE id = ?",
			[id],
		);

		if (!existing) {
			return ctx.reply(`No identity block pattern found with ID ${id}.`);
		}

		execute("DELETE FROM identity_block_patterns WHERE id = ?", [id]);
		invalidateIdentityBlockCache();

		StructuredLogger.logSecurityEvent("Identity block pattern removed", {
			userId: ctx.from?.id,
			operation: "remove_identity_block",
			patternId: id,
			pattern: existing.pattern,
			matchField: existing.match_field,
		});

		await ctx.reply(
			fmt`Identity block pattern #${id} removed.
Pattern: ${code(existing.pattern)}
Field: ${existing.match_field}`,
		);
	});

	bot.command("listidentityblocks", adminOrHigher, async (ctx) => {
		const rows = query<IdentityBlockRow>(
			"SELECT * FROM identity_block_patterns ORDER BY id",
			[],
		);

		const custom =
			rows.length === 0
				? "No custom identity block patterns configured."
				: rows
						.map((r) => {
							const desc = r.description ? ` -- ${r.description}` : "";
							const date = new Date(r.created_at * 1000)
								.toISOString()
								.split("T")[0];
							return `#${r.id} [${r.match_field}] ${r.pattern}${desc} (${date})`;
						})
						.join("\n");

		await ctx.reply(
			fmt`${bold("Identity Block Patterns")}

${custom}

${bold("Built-in patterns")}:
${BUILTIN_IDENTITY_PATTERNS.map((p) => `[${p.matchField}] ${p.raw}`).join("\n")}

Use ${code("/removeidentityblock <id>")} to remove a custom pattern.`,
		);
	});

	bot.command("testidentityblock", ownerOnly, async (ctx) => {
		const rawArgs = ctx.message?.text.split(" ").slice(1).join(" ") || "";
		const { pattern, remainder } = parsePatternAndRemainder(rawArgs);

		if (!pattern || !remainder) {
			return ctx.reply(
				fmt`Usage: ${code('/testidentityblock "pattern" sample text')}
${code("/testidentityblock /regex/i sample text")}`,
			);
		}

		const validation = validatePattern(pattern);
		if (!validation.isValid || !validation.sanitized) {
			return ctx.reply(`Invalid pattern: ${validation.error || "unknown"}`);
		}

		try {
			const compiled = compileSafeRegex(validation.sanitized);
			compiled.regex.lastIndex = 0;
			const matches = compiled.regex.test(remainder);

			await ctx.reply(
				fmt`${bold("Identity Block Pattern Test")}

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

	bot.command("identityblockhelp", adminOrHigher, async (ctx) => {
		await ctx.reply(
			fmt`${bold("Identity Block Guide")}

Identity block patterns are matched against first name, last name, full display name, and username. Matching non-admin users are banned on join, message, or chat-member updates.

${bold("Fields")}
${bold("name")} - first name, last name, or full display name
${bold("username")} - username with or without @
${bold("both")} - default; checks all identity fields

${bold("Examples")}
${code('/addidentityblock "spam name" name')}
${code("/addidentityblock /chi\\.?ld\\s*po\\.?rn\\s*gds81/i both")}
${code("/testidentityblock /chi\\.?ld\\s*po\\.?rn\\s*gds81/i CHI.LD PO.RN GDS81")}

${bold("Management")}
${code("/listidentityblocks")} - View active patterns
${code("/removeidentityblock <id>")} - Remove a custom pattern`,
		);
	});

	logger.info("Identity block pattern handlers registered");
}

async function addIdentityBlockPattern(
	ctx: Context,
	userId: number,
	pattern: string,
	field: IdentityBlockField,
	description?: string,
): Promise<void> {
	const validation = validatePattern(pattern);

	if (!validation.isValid || !validation.sanitized) {
		await ctx.reply(`Invalid pattern: ${validation.error || "unknown"}`);
		return;
	}

	const sanitized = validation.sanitized;

	try {
		compileSafeRegex(sanitized);
	} catch (error) {
		await ctx.reply(
			`Pattern compilation failed: ${error instanceof Error ? error.message : "unknown"}`,
		);
		return;
	}

	const existing = get<IdentityBlockRow>(
		"SELECT * FROM identity_block_patterns WHERE pattern = ?",
		[sanitized],
	);

	if (existing) {
		await ctx.reply(
			fmt`Pattern already exists as #${existing.id} [${existing.match_field}].`,
		);
		return;
	}

	execute(
		"INSERT INTO identity_block_patterns (pattern, match_field, description, added_by) VALUES (?, ?, ?, ?)",
		[sanitized, field, description || null, userId],
	);

	invalidateIdentityBlockCache();

	const inserted = get<IdentityBlockRow>(
		"SELECT * FROM identity_block_patterns WHERE pattern = ?",
		[sanitized],
	);

	StructuredLogger.logSecurityEvent("Identity block pattern added", {
		userId,
		operation: "add_identity_block",
		patternId: inserted?.id,
		pattern: sanitized,
		matchField: field,
		description,
	});

	await ctx.reply(
		fmt`Identity block pattern added (#${inserted?.id || "?"}).
Pattern: ${code(sanitized)}
Field: ${field}${description ? `\nDescription: ${description}` : ""}

Matching users will be banned on join, message, or chat-member updates.`,
	);
}

function parseIdentityBlockArgs(rawArgs: string): {
	pattern: string | null;
	field: IdentityBlockField;
	description?: string;
} {
	let pattern: string | null = null;
	let remaining = rawArgs.trim();
	let field: IdentityBlockField = "both";

	if (!remaining) return { pattern: null, field };

	if (remaining.startsWith('"')) {
		const endQuote = remaining.indexOf('"', 1);
		if (endQuote === -1) return { pattern: null, field };
		pattern = remaining.substring(1, endQuote);
		remaining = remaining.substring(endQuote + 1).trim();
	} else if (remaining.startsWith("/")) {
		const lastSlash = remaining.lastIndexOf("/");
		if (lastSlash <= 0) return { pattern: null, field };

		let endIdx = lastSlash + 1;
		while (endIdx < remaining.length && /[gimsu]/.test(remaining[endIdx])) {
			endIdx++;
		}

		pattern = remaining.substring(0, endIdx);
		remaining = remaining.substring(endIdx).trim();
	} else {
		const parts = remaining.split(/\s+/);
		pattern = parts[0];
		remaining = parts.slice(1).join(" ").trim();
	}

	const parts = remaining.split(/\s+/);
	if (parts[0] && ["name", "username", "both"].includes(parts[0])) {
		field = parts[0] as IdentityBlockField;
		remaining = parts.slice(1).join(" ").trim();
	}

	return { pattern, field, description: remaining || undefined };
}

function parsePatternAndRemainder(rawArgs: string): {
	pattern: string | null;
	remainder: string | null;
} {
	const remaining = rawArgs.trim();

	if (!remaining) return { pattern: null, remainder: null };

	if (remaining.startsWith('"')) {
		const endQuote = remaining.indexOf('"', 1);
		if (endQuote === -1) return { pattern: null, remainder: null };

		return {
			pattern: remaining.substring(1, endQuote),
			remainder: remaining.substring(endQuote + 1).trim() || null,
		};
	}

	if (remaining.startsWith("/")) {
		const lastSlash = remaining.lastIndexOf("/");
		if (lastSlash <= 0) return { pattern: null, remainder: null };

		let endIdx = lastSlash + 1;
		while (endIdx < remaining.length && /[gimsu]/.test(remaining[endIdx])) {
			endIdx++;
		}

		return {
			pattern: remaining.substring(0, endIdx),
			remainder: remaining.substring(endIdx).trim() || null,
		};
	}

	const spaceIdx = remaining.indexOf(" ");
	if (spaceIdx === -1) return { pattern: null, remainder: null };

	return {
		pattern: remaining.substring(0, spaceIdx),
		remainder: remaining.substring(spaceIdx + 1).trim() || null,
	};
}
