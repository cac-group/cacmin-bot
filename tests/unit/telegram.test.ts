import { describe, expect, it, vi } from "vitest";
import { config } from "../../src/config";
import {
	createTelegramBot,
	getTelegramFileUrl,
} from "../../src/utils/telegram";

const botToken = "12345:test-token";

function createTelegramClient(filePath: string) {
	const file = {
		file_id: "telegram-file-id",
		file_unique_id: "telegram-file-unique-id",
		file_path: filePath,
	};
	return {
		file,
		telegram: {
			getFile: vi.fn().mockResolvedValue(file),
			getFileLink: vi
				.fn()
				.mockResolvedValue(
					new URL(`https://api.telegram.org/file/bot${botToken}/${filePath}`),
				),
		},
	};
}

describe("configured Telegram client", () => {
	it("wires a local API origin into Telegraf", () => {
		const originalToken = config.botToken;
		const originalApiRoot = config.telegramApiRoot;
		config.botToken = botToken;
		config.telegramApiRoot = "http://tgbotapi.lxd:8081";

		try {
			const bot = createTelegramBot();
			expect(bot.telegram.options.apiRoot).toBe("http://tgbotapi.lxd:8081");
		} finally {
			config.botToken = originalToken;
			config.telegramApiRoot = originalApiRoot;
		}
	});
});

describe("Telegram file URL resolution", () => {
	it("retains Telegraf file links for relative Telegram file paths", async () => {
		const { file, telegram } = createTelegramClient("photos/file_10.jpg");

		const fileUrl = await getTelegramFileUrl(telegram, "telegram-file-id", {
			botToken,
			telegramFileRoot: undefined,
		});

		expect(fileUrl.href).toBe(
			`https://api.telegram.org/file/bot${botToken}/photos/file_10.jpg`,
		);
		expect(telegram.getFile).toHaveBeenCalledWith("telegram-file-id");
		expect(telegram.getFileLink).toHaveBeenCalledWith(file);
	});

	it("translates absolute paths to the configured HTTP file gateway", async () => {
		const { telegram } = createTelegramClient(
			"/var/lib/telegram-bot-api/12345/photos/file 10.jpg",
		);

		const fileUrl = await getTelegramFileUrl(telegram, "telegram-file-id", {
			botToken,
			telegramFileRoot: "http://tgbotapi.lxd:8082",
		});

		expect(fileUrl.href).toBe(
			`http://tgbotapi.lxd:8082/file/bot${botToken}?path=%2Fvar%2Flib%2Ftelegram-bot-api%2F12345%2Fphotos%2Ffile%2010.jpg`,
		);
	});

	it("never asks Telegraf to turn an absolute server path into a cross-host URL", async () => {
		const { telegram } = createTelegramClient(
			"/var/lib/telegram-bot-api/12345/photos/file_11.jpg",
		);

		const fileUrl = await getTelegramFileUrl(telegram, "telegram-file-id", {
			botToken,
			telegramFileRoot: "https://media-gateway.internal:8443",
		});

		expect(fileUrl.origin).toBe("https://media-gateway.internal:8443");
		expect(fileUrl.protocol).toBe("https:");
		expect(telegram.getFileLink).not.toHaveBeenCalled();
	});

	it("fails explicitly when an absolute path has no file gateway", async () => {
		const { telegram } = createTelegramClient(
			"/var/lib/telegram-bot-api/12345/photos/file_12.jpg",
		);

		await expect(
			getTelegramFileUrl(telegram, "telegram-file-id", {
				botToken,
				telegramFileRoot: undefined,
			}),
		).rejects.toMatchObject({
			code: "missing_file_gateway",
			message:
				"TELEGRAM_FILE_ROOT is required for absolute Telegram file paths",
		});
	});

	it("sanitizes Telegram lookup failures", async () => {
		const privatePath = "/var/lib/telegram-bot-api/12345/photos/private.jpg";
		const telegram = {
			getFile: vi
				.fn()
				.mockRejectedValue(
					new Error(
						`request to http://tgbotapi.lxd/file/bot${botToken}${privatePath} failed`,
					),
				),
			getFileLink: vi.fn(),
		};

		const error = await getTelegramFileUrl(telegram, "telegram-file-id", {
			botToken,
			telegramFileRoot: "http://tgbotapi.lxd:8082",
		}).catch((caught) => caught);

		expect(error).toMatchObject({
			code: "file_lookup_failed",
			message: "Telegram file lookup failed",
		});
		expect(String(error)).not.toContain(botToken);
		expect(String(error)).not.toContain(privatePath);
	});
});
