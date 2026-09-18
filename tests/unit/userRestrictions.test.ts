import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../../src/database";
import {
	addUserRestriction,
	ensureUserExists,
	getUserRestrictions,
} from "../../src/services/userService";

const USER = 99887766;

function cleanup(): void {
	execute("DELETE FROM user_restrictions WHERE user_id = ?", [USER]);
	execute("DELETE FROM users WHERE id = ?", [USER]);
}

describe("user_restrictions upsert", () => {
	afterEach(cleanup);

	it("updates instead of stacking when the same restriction is re-added", () => {
		ensureUserExists(USER, "resttest");
		addUserRestriction(USER, "no_specific_gif", "gifid", undefined, undefined, "delete");
		addUserRestriction(USER, "no_specific_gif", "gifid", undefined, undefined, "jail");

		const matching = getUserRestrictions(USER).filter(
			(r) => r.restriction === "no_specific_gif" && r.restrictedAction === "gifid",
		);
		expect(matching.length).toBe(1);
		expect(matching[0].severity).toBe("jail");
	});

	it("keeps distinct actions of the same type separate", () => {
		ensureUserExists(USER, "resttest");
		addUserRestriction(USER, "regex_block", "one");
		addUserRestriction(USER, "regex_block", "two");

		const rows = getUserRestrictions(USER).filter(
			(r) => r.restriction === "regex_block",
		);
		expect(rows.length).toBe(2);
	});
});
