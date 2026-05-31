/**
 * SQLite runtime adapter.
 *
 * Production runs under Bun and uses Bun's native SQLite driver. Node-based
 * tooling and Vitest use better-sqlite3 as a dev-only compatibility fallback
 * because Node cannot load the bun:sqlite module.
 */

export interface Changes {
	changes: number;
	lastInsertRowid: number | bigint;
}

export interface Statement<T = unknown> {
	all(...params: unknown[]): T[];
	get(...params: unknown[]): T | undefined;
	run(...params: unknown[]): Changes;
}

export interface SqliteDatabase {
	exec(sql: string): unknown;
	prepare<T = unknown>(sql: string): Statement<T>;
	transaction<A extends unknown[], T>(
		fn: (...args: A) => T,
	): ((...args: A) => T) & {
		deferred?: (...args: A) => T;
		immediate?: (...args: A) => T;
		exclusive?: (...args: A) => T;
	};
	close(throwOnError?: boolean): void;
}

type DatabaseConstructor = new (
	filename?: string,
	options?: { readonly?: boolean; create?: boolean; readwrite?: boolean },
) => SqliteDatabase;

declare const Bun: unknown;

function loadDatabase(): DatabaseConstructor {
	if (typeof Bun !== "undefined") {
		return require("bun:sqlite").Database;
	}

	return require("better-sqlite3");
}

export const Database = loadDatabase();
