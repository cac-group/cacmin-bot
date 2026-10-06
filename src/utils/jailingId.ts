/**
 * Jailing id helpers.
 *
 * A jailing id is the user-facing code a payer puts in the transaction memo to
 * release a specific jailing. It is uppercase alphanumeric and always starts with
 * a letter, so it can never be mistaken for a numeric Telegram user id. Matching
 * is exact and case-insensitive.
 *
 * @module utils/jailingId
 */

import { randomInt } from "node:crypto";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Generate a fresh jailing id (default 8 chars, first char always a letter). */
export function generateJailingId(length = 8): string {
	let id = LETTERS[randomInt(LETTERS.length)];
	for (let i = 1; i < length; i++) {
		id += ALNUM[randomInt(ALNUM.length)];
	}
	return id;
}

/** Normalize a memo for case-insensitive exact matching against a jailing id. */
export function normalizeJailingId(value: string): string {
	return value.trim().toUpperCase();
}

/** True when a memo is shaped like a jailing id (alphanumeric, leading letter). */
export function looksLikeJailingId(value: string): boolean {
	return /^[A-Z][A-Z0-9]{5,}$/.test(normalizeJailingId(value));
}
