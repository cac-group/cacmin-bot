import type { Telegram } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import { prepareResponse, recordResponse } from "../../src/utils/autoDelete";

describe("autoDelete response dedupe", () => {
	it("skips concurrent duplicate sends while one is in flight", async () => {
		const telegram = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Telegram;

		const first = prepareResponse(telegram, 1, 2, "rate-limit-warning");
		const second = prepareResponse(telegram, 1, 2, "rate-limit-warning");

		expect(await first).toBe(true);
		expect(await second).toBe(false);
		expect(telegram.deleteMessage).not.toHaveBeenCalled();
		recordResponse(1, 2, "rate-limit-warning", 111);
	});

	it("replaces a recent response before resending", async () => {
		const telegram = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Telegram;

		recordResponse(1, 2, "rate-limit-warning", 111);
		expect(await prepareResponse(telegram, 1, 2, "rate-limit-warning")).toBe(
			true,
		);
		expect(telegram.deleteMessage).toHaveBeenCalledWith(1, 111);
		recordResponse(1, 2, "rate-limit-warning", 222);
	});

	it("allows a new send once the in-flight send has been recorded", async () => {
		const telegram = {
			deleteMessage: vi.fn().mockResolvedValue(true),
		} as unknown as Telegram;

		expect(await prepareResponse(telegram, 1, 2, "rate-limit-warning")).toBe(
			true,
		);
		recordResponse(1, 2, "rate-limit-warning", 222);
		expect(await prepareResponse(telegram, 1, 2, "rate-limit-warning")).toBe(
			true,
		);
	});
});
