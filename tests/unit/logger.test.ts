import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, StructuredLogger } from "../../src/utils/logger";

const lastWrite = (spy: ReturnType<typeof vi.spyOn>): string =>
	(spy.mock.calls.at(-1)?.[0] as string) ?? "";

describe("logger", () => {
	const originalLevel = process.env.LOG_LEVEL;
	let out: ReturnType<typeof vi.spyOn>;
	let err: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		out.mockRestore();
		err.mockRestore();
		process.env.LOG_LEVEL = originalLevel;
	});

	it("renders level, tags, and metadata", () => {
		process.env.LOG_LEVEL = "info";
		logger.info("hello", { tag: "user", subtag: "deposit", userId: 5 });

		const line = lastWrite(out);
		expect(line).toContain("[INFO]");
		expect(line).toContain("[USER]");
		expect(line).toContain("[DEPOSIT]");
		expect(line).toContain("hello");
		expect(line).toContain('"userId":5');
	});

	it("filters debug when the level is info", () => {
		process.env.LOG_LEVEL = "info";
		logger.debug("nope");
		expect(out.mock.calls.length).toBe(0);
	});

	it("preserves a bare Error's message and stack", () => {
		process.env.LOG_LEVEL = "debug";
		logger.error("failed", new Error("boom"));

		const line = lastWrite(err);
		expect(line).toContain("failed boom");
		expect(line).toContain("Error: boom");
	});

	it("redacts sensitive context keys", () => {
		process.env.LOG_LEVEL = "debug";
		StructuredLogger.logSecurityEvent("sec", { userId: 1, mnemonic: "x" });

		const line = lastWrite(out);
		expect(line).toContain("[REDACTED]");
		expect(line).not.toContain('"mnemonic":"x"');
	});
});
