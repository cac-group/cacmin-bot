import { isAbsolute } from "node:path";
import { Telegraf, type Telegram } from "telegraf";
import { config } from "../config";

interface TelegramFileSettings {
	botToken: string;
	telegramFileRoot?: string;
}

type TelegramFileClient = Pick<Telegram, "getFile" | "getFileLink">;

type TelegramFileErrorCode =
	| "file_lookup_failed"
	| "invalid_file_response"
	| "missing_file_gateway"
	| "file_link_failed";

export class TelegramFileError extends Error {
	constructor(
		public readonly code: TelegramFileErrorCode,
		message: string,
	) {
		super(message);
		this.name = "TelegramFileError";
	}
}

export function createTelegramBot(): Telegraf {
	return new Telegraf(config.botToken, {
		telegram: {
			apiRoot: config.telegramApiRoot,
		},
	});
}

export async function getTelegramFileUrl(
	telegram: TelegramFileClient,
	fileId: string,
	settings: TelegramFileSettings = config,
): Promise<URL> {
	let file: Awaited<ReturnType<TelegramFileClient["getFile"]>>;
	try {
		file = await telegram.getFile(fileId);
	} catch {
		throw new TelegramFileError(
			"file_lookup_failed",
			"Telegram file lookup failed",
		);
	}

	if (!file.file_path) {
		throw new TelegramFileError(
			"invalid_file_response",
			"Telegram file response did not include a file path",
		);
	}

	if (isAbsolute(file.file_path)) {
		if (!settings.telegramFileRoot) {
			throw new TelegramFileError(
				"missing_file_gateway",
				"TELEGRAM_FILE_ROOT is required for absolute Telegram file paths",
			);
		}

		const gatewayUrl = new URL(
			`/file/bot${settings.botToken}`,
			settings.telegramFileRoot,
		);
		gatewayUrl.search = `path=${encodeURIComponent(file.file_path)}`;
		return gatewayUrl;
	}

	try {
		return await telegram.getFileLink(file);
	} catch {
		throw new TelegramFileError(
			"file_link_failed",
			"Telegram file link generation failed",
		);
	}
}
