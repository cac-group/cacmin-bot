import { describe, expect, it } from "vitest";
import {
	calculateRolloverCapacity,
	RateLimitService,
} from "../../src/services/rateLimitService";

describe("RateLimitService", () => {
	it("calculates one-period rollover without compounding", () => {
		expect(calculateRolloverCapacity(10, 0, 0)).toEqual({
			limit: 20,
			rollover: 10,
		});
		expect(calculateRolloverCapacity(10, 5, 15)).toEqual({
			limit: 15,
			rollover: 0,
		});
		expect(calculateRolloverCapacity(10, 0, 5)).toEqual({
			limit: 20,
			rollover: 10,
		});
	});

	it("weights emoji as two and stickers as five characters", () => {
		expect(RateLimitService.countMessageCharacters({ text: "a😀" })).toBe(3);
		expect(RateLimitService.countMessageCharacters({ sticker: {} })).toBe(5);
	});
});
