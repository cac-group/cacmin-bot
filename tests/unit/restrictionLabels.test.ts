import { describe, expect, it } from "vitest";
import { violationResponseKey } from "../../src/services/restrictionService";
import { restrictionLabel } from "../../src/utils/restrictionLabels";

describe("restrictionLabel", () => {
	it("renders user-facing names for stored identifiers", () => {
		expect(restrictionLabel("no_specific_gif")).toBe("banned gif");
		expect(restrictionLabel("no_gifs")).toBe("no GIFs");
		expect(restrictionLabel("no_stickers")).toBe("no stickers");
	});

	it("falls back to the identifier with underscores spaced", () => {
		expect(restrictionLabel("some_new_restriction")).toBe(
			"some new restriction",
		);
	});
});

describe("violationResponseKey", () => {
	it("is class-based, never content-based", () => {
		// Same class -> same key regardless of the message text (e.g. counts).
		expect(violationResponseKey("no_specific_gif")).toBe(
			violationResponseKey("no_specific_gif"),
		);
		expect(violationResponseKey("no_specific_gif")).toBe(
			"restriction:no_specific_gif",
		);
		// Different classes stay distinct.
		expect(violationResponseKey("mute")).not.toBe(
			violationResponseKey("immediate_jail"),
		);
	});
});
