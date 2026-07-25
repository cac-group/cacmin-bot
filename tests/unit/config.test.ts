import { describe, expect, it } from "vitest";
import { parseTelegramEndpointConfig } from "../../src/config";

describe("Telegram endpoint configuration", () => {
	it("uses Telegram's public API without requiring a file gateway", () => {
		expect(parseTelegramEndpointConfig({})).toEqual({
			telegramApiRoot: "https://api.telegram.org",
			telegramFileRoot: undefined,
		});
	});

	it("normalizes configured API and file gateway origins", () => {
		expect(
			parseTelegramEndpointConfig({
				TELEGRAM_API_ROOT: "http://tgbotapi.lxd:8081/",
				TELEGRAM_FILE_ROOT: "http://tgbotapi.lxd:8082///",
			}),
		).toEqual({
			telegramApiRoot: "http://tgbotapi.lxd:8081",
			telegramFileRoot: "http://tgbotapi.lxd:8082",
		});
	});

	it.each([
		["malformed", "not a URL"],
		["unsupported scheme", "ftp://tgbotapi.lxd:8081"],
		["credentials", "http://user:password@tgbotapi.lxd:8081"],
		["path", "http://tgbotapi.lxd:8081/bot-api"],
		["query", "http://tgbotapi.lxd:8081?mode=local"],
		["fragment", "http://tgbotapi.lxd:8081#local"],
	])("rejects a %s Telegram API root", (_scenario, root) => {
		expect(() =>
			parseTelegramEndpointConfig({ TELEGRAM_API_ROOT: root }),
		).toThrow("TELEGRAM_API_ROOT must be an HTTP(S) origin");
	});

	it("rejects an invalid optional Telegram file root", () => {
		expect(() =>
			parseTelegramEndpointConfig({
				TELEGRAM_FILE_ROOT: "file:///srv/telegram",
			}),
		).toThrow("TELEGRAM_FILE_ROOT must be an HTTP(S) origin");
	});
});
