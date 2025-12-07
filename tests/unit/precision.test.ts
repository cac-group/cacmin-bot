/**
 * Unit tests for AmountPrecision utility class
 * Tests exact 6-decimal JUNO arithmetic using micro-units
 */

import { describe, it, expect } from "vitest";
import { AmountPrecision } from "../../src/utils/precision";

describe("AmountPrecision", () => {
	describe("sanitize", () => {
		it("should round to 6 decimals", () => {
			expect(AmountPrecision.sanitize(1.1234567)).toBe(1.123457);
			expect(AmountPrecision.sanitize(1.123456)).toBe(1.123456);
			expect(AmountPrecision.sanitize(1.12345)).toBe(1.12345);
		});

		it("should handle floating-point representation errors", () => {
			// 0.1 + 0.2 = 0.30000000000000004 in JS
			const imprecise = 0.1 + 0.2;
			expect(AmountPrecision.sanitize(imprecise)).toBe(0.3);
		});

		it("should preserve whole numbers", () => {
			expect(AmountPrecision.sanitize(100)).toBe(100);
			expect(AmountPrecision.sanitize(0)).toBe(0);
		});
	});

	describe("validateAmount", () => {
		it("should accept valid amounts with <= 6 decimals", () => {
			expect(AmountPrecision.validateAmount(1.123456)).toBe(1.123456);
			expect(AmountPrecision.validateAmount(1.12345)).toBe(1.12345);
			expect(AmountPrecision.validateAmount(1)).toBe(1);
			expect(AmountPrecision.validateAmount(0.000001)).toBe(0.000001);
		});

		it("should reject amounts with > 6 decimals", () => {
			expect(() => AmountPrecision.validateAmount(1.1234567)).toThrow(
				"Invalid amount precision",
			);
			// Note: 0.00000001 becomes 0.000000 after sanitize, so use a value
			// that clearly has 7+ significant decimals
			expect(() => AmountPrecision.validateAmount(1.00000001)).toThrow(
				"Invalid amount precision",
			);
		});
	});

	describe("toMicroJuno", () => {
		it("should convert JUNO to uJUNO correctly", () => {
			expect(AmountPrecision.toMicroJuno(1)).toBe(1_000_000);
			expect(AmountPrecision.toMicroJuno(0.5)).toBe(500_000);
			expect(AmountPrecision.toMicroJuno(1.123456)).toBe(1_123_456);
			expect(AmountPrecision.toMicroJuno(0.000001)).toBe(1);
		});

		it("should handle the problematic value 4.05195 from logs", () => {
			// This was causing "Precision loss detected" errors
			expect(AmountPrecision.toMicroJuno(4.05195)).toBe(4_051_950);
		});

		it("should handle floating-point representation errors", () => {
			// Values that have imprecise IEEE 754 representations
			expect(AmountPrecision.toMicroJuno(0.1)).toBe(100_000);
			expect(AmountPrecision.toMicroJuno(0.2)).toBe(200_000);
			expect(AmountPrecision.toMicroJuno(0.3)).toBe(300_000);

			// More problematic values
			expect(AmountPrecision.toMicroJuno(1.05)).toBe(1_050_000);
			expect(AmountPrecision.toMicroJuno(2.55)).toBe(2_550_000);
		});

		it("should handle values read from SQLite REAL columns", () => {
			// Simulating values that might come back slightly imprecise from DB
			const dbValue = 4.051949999999999; // Close to 4.05195
			expect(AmountPrecision.toMicroJuno(dbValue)).toBe(4_051_950);

			const dbValue2 = 10.000000000000001; // Close to 10
			expect(AmountPrecision.toMicroJuno(dbValue2)).toBe(10_000_000);
		});

		it("should handle edge cases", () => {
			expect(AmountPrecision.toMicroJuno(0)).toBe(0);
			expect(AmountPrecision.toMicroJuno(100)).toBe(100_000_000);
			expect(AmountPrecision.toMicroJuno(999.999999)).toBe(999_999_999);
		});
	});

	describe("fromMicroJuno", () => {
		it("should convert uJUNO to JUNO correctly", () => {
			expect(AmountPrecision.fromMicroJuno(1_000_000)).toBe(1);
			expect(AmountPrecision.fromMicroJuno(500_000)).toBe(0.5);
			expect(AmountPrecision.fromMicroJuno(1_123_456)).toBe(1.123456);
			expect(AmountPrecision.fromMicroJuno(1)).toBe(0.000001);
		});

		it("should reject non-integer micro amounts", () => {
			expect(() => AmountPrecision.fromMicroJuno(1.5)).toThrow(
				"Micro amount must be an integer",
			);
		});

		it("should handle zero", () => {
			expect(AmountPrecision.fromMicroJuno(0)).toBe(0);
		});
	});

	describe("round-trip conversions", () => {
		it("should preserve value through toMicroJuno -> fromMicroJuno", () => {
			const testValues = [
				0, 0.000001, 0.1, 0.123456, 1, 1.5, 4.05195, 10.123456, 100, 999.999999,
			];

			for (const value of testValues) {
				const micro = AmountPrecision.toMicroJuno(value);
				const back = AmountPrecision.fromMicroJuno(micro);
				expect(back).toBeCloseTo(value, 6);
			}
		});
	});

	describe("add", () => {
		it("should add amounts with exact precision", () => {
			expect(AmountPrecision.add(1, 2)).toBe(3);
			expect(AmountPrecision.add(0.1, 0.2)).toBe(0.3);
			expect(AmountPrecision.add(1.123456, 2.876544)).toBe(4);
		});

		it("should handle floating-point inputs from DB", () => {
			// Simulating values with representation errors
			const a = 0.1 + 0.2; // 0.30000000000000004
			const b = 0.4;
			expect(AmountPrecision.add(a, b)).toBe(0.7);
		});
	});

	describe("subtract", () => {
		it("should subtract amounts with exact precision", () => {
			expect(AmountPrecision.subtract(3, 2)).toBe(1);
			expect(AmountPrecision.subtract(0.3, 0.1)).toBe(0.2);
			expect(AmountPrecision.subtract(10, 0.000001)).toBe(9.999999);
		});

		it("should throw on negative result", () => {
			expect(() => AmountPrecision.subtract(1, 2)).toThrow(
				"would result in negative amount",
			);
		});
	});

	describe("multiply", () => {
		it("should multiply amount by integer multiplier", () => {
			expect(AmountPrecision.multiply(1, 9)).toBe(9);
			expect(AmountPrecision.multiply(0.45022, 9)).toBe(4.05198);
			expect(AmountPrecision.multiply(0.1, 10)).toBe(1);
		});

		it("should handle the gambling WIN_MULTIPLIER case", () => {
			// Common gambling scenario: bet * 9 = profit
			const bet = 0.5;
			const profit = AmountPrecision.multiply(bet, 9);
			expect(profit).toBe(4.5);
		});

		it("should reject non-integer multipliers", () => {
			expect(() => AmountPrecision.multiply(1, 1.5)).toThrow(
				"Multiplier must be a non-negative integer",
			);
		});

		it("should reject negative multipliers", () => {
			expect(() => AmountPrecision.multiply(1, -1)).toThrow(
				"Multiplier must be a non-negative integer",
			);
		});
	});

	describe("comparison methods", () => {
		describe("equals", () => {
			it("should compare amounts at micro precision", () => {
				expect(AmountPrecision.equals(1, 1)).toBe(true);
				expect(AmountPrecision.equals(1, 2)).toBe(false);
				expect(AmountPrecision.equals(0.1, 0.1)).toBe(true);
			});

			it("should handle floating-point representation differences", () => {
				// These might differ at higher precision but should be equal at 6 decimals
				const a = 0.1 + 0.2;
				expect(AmountPrecision.equals(a, 0.3)).toBe(true);
			});
		});

		describe("isGreaterThan", () => {
			it("should compare amounts correctly", () => {
				expect(AmountPrecision.isGreaterThan(2, 1)).toBe(true);
				expect(AmountPrecision.isGreaterThan(1, 2)).toBe(false);
				expect(AmountPrecision.isGreaterThan(1, 1)).toBe(false);
			});
		});

		describe("isGreaterOrEqual", () => {
			it("should compare amounts correctly", () => {
				expect(AmountPrecision.isGreaterOrEqual(2, 1)).toBe(true);
				expect(AmountPrecision.isGreaterOrEqual(1, 2)).toBe(false);
				expect(AmountPrecision.isGreaterOrEqual(1, 1)).toBe(true);
			});

			it("should handle the gambling balance check case", () => {
				// User balance vs bet amount
				const balance = 4.05195;
				const bet = 0.5;
				expect(AmountPrecision.isGreaterOrEqual(balance, bet)).toBe(true);
			});
		});
	});

	describe("parseUserInput", () => {
		it("should parse valid user input", () => {
			expect(AmountPrecision.parseUserInput("1")).toBe(1);
			expect(AmountPrecision.parseUserInput("1.5")).toBe(1.5);
			expect(AmountPrecision.parseUserInput("0.123456")).toBe(0.123456);
			expect(AmountPrecision.parseUserInput("  10.5  ")).toBe(10.5);
		});

		it("should reject invalid input", () => {
			expect(() => AmountPrecision.parseUserInput("abc")).toThrow(
				"Invalid amount",
			);
			expect(() => AmountPrecision.parseUserInput("")).toThrow("Invalid amount");
		});

		it("should reject non-positive amounts", () => {
			expect(() => AmountPrecision.parseUserInput("0")).toThrow(
				"Amount must be positive",
			);
			expect(() => AmountPrecision.parseUserInput("-1")).toThrow(
				"Amount must be positive",
			);
		});

		it("should reject too many decimals", () => {
			expect(() => AmountPrecision.parseUserInput("1.1234567")).toThrow(
				"Invalid amount precision",
			);
		});
	});

	describe("format", () => {
		it("should format amounts as 6-decimal strings", () => {
			expect(AmountPrecision.format(1)).toBe("1.000000");
			expect(AmountPrecision.format(1.5)).toBe("1.500000");
			expect(AmountPrecision.format(0.000001)).toBe("0.000001");
			expect(AmountPrecision.format(123.456789)).toBe("123.456789");
		});
	});
});
