import { describe, expect, it } from "vitest";
import { isJoinTransition } from "../../src/handlers/membership";

describe("membership join transitions", () => {
	it("treats entering from left/kicked as a join", () => {
		expect(isJoinTransition("left", "member")).toBe(true);
		expect(isJoinTransition("kicked", "member")).toBe(true);
		expect(isJoinTransition("left", "administrator")).toBe(true);
		expect(isJoinTransition("kicked", "creator")).toBe(true);
	});

	it("ignores staying, leaving, or being restricted/banned", () => {
		expect(isJoinTransition("member", "member")).toBe(false);
		expect(isJoinTransition("administrator", "administrator")).toBe(false);
		expect(isJoinTransition("member", "left")).toBe(false);
		expect(isJoinTransition("member", "kicked")).toBe(false);
		expect(isJoinTransition("member", "restricted")).toBe(false);
	});
});
