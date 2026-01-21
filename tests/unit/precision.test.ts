/**
 * Core precision tests for JUNO arithmetic
 * Critical for financial accuracy - tests micro-unit conversions
 */

import { describe, it, expect } from "vitest";
import { AmountPrecision } from "../../src/utils/precision";

describe("AmountPrecision", () => {
	describe("toMicroJuno / fromMicroJuno", () => {
		it("should convert JUNO to micro-units correctly", () => {
			expect(AmountPrecision.toMicroJuno(1)).toBe(1_000_000);
			expect(AmountPrecision.toMicroJuno(0.5)).toBe(500_000);
			expect(AmountPrecision.toMicroJuno(1.123456)).toBe(1_123_456);
			expect(AmountPrecision.toMicroJuno(0.000001)).toBe(1);
		});

		it("should convert micro-units to JUNO correctly", () => {
			expect(AmountPrecision.fromMicroJuno(1_000_000)).toBe(1);
			expect(AmountPrecision.fromMicroJuno(500_000)).toBe(0.5);
			expect(AmountPrecision.fromMicroJuno(1_123_456)).toBe(1.123456);
			expect(AmountPrecision.fromMicroJuno(1)).toBe(0.000001);
		});

		it("should handle floating-point representation errors", () => {
			// Values that have imprecise IEEE 754 representations
			expect(AmountPrecision.toMicroJuno(0.1)).toBe(100_000);
			expect(AmountPrecision.toMicroJuno(0.2)).toBe(200_000);
			expect(AmountPrecision.toMicroJuno(0.3)).toBe(300_000);
		});
	});

	describe("toDbMicro / fromDbMicro", () => {
		it("should convert for database storage", () => {
			expect(AmountPrecision.toDbMicro(1.5)).toBe(1_500_000);
			expect(AmountPrecision.fromDbMicro(1_500_000)).toBe(1.5);
		});
	});

	describe("add / subtract", () => {
		it("should perform precise arithmetic", () => {
			expect(AmountPrecision.add(0.1, 0.2)).toBe(0.3);
			expect(AmountPrecision.subtract(1, 0.1)).toBe(0.9);
		});

		it("should handle edge cases", () => {
			expect(AmountPrecision.add(0, 0)).toBe(0);
			expect(AmountPrecision.subtract(0, 0)).toBe(0);
		});
	});

	describe("sanitize", () => {
		it("should round to 6 decimals", () => {
			expect(AmountPrecision.sanitize(1.123456789)).toBe(1.123457);
			expect(AmountPrecision.sanitize(0.0000001)).toBe(0);
			expect(AmountPrecision.sanitize(1)).toBe(1);
		});
	});

	describe("format", () => {
		it("should format amounts for display", () => {
			expect(AmountPrecision.format(1.5)).toBe("1.500000");
			expect(AmountPrecision.format(0.123456)).toBe("0.123456");
		});
	});
});
