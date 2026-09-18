import { afterEach, describe, expect, it } from "vitest";
import { execute, query } from "../../src/database";

const RESTRICTION = "no_specific_gif";
const ACTION = "unit-test-gif-id";

function clear(): void {
	execute(
		"DELETE FROM global_restrictions WHERE restriction = ? AND restricted_action = ?",
		[RESTRICTION, ACTION],
	);
}

describe("global_restrictions upsert", () => {
	afterEach(clear);

	it("keeps a repeated global ban to a single row", () => {
		clear();
		const insert = `INSERT INTO global_restrictions (restriction, restricted_action) VALUES (?, ?)
			ON CONFLICT(restriction, restricted_action) DO NOTHING`;

		execute(insert, [RESTRICTION, ACTION]);
		execute(insert, [RESTRICTION, ACTION]);

		const row = query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM global_restrictions WHERE restriction = ? AND restricted_action = ?",
			[RESTRICTION, ACTION],
		)[0];
		expect(row.n).toBe(1);
	});
});
