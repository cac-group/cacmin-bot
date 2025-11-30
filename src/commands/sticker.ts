/**
 * Sticker command handlers for the CAC Admin Bot.
 * Provides commands for sending stickers from specified packs.
 *
 * @module commands/sticker
 */

import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { logger } from "../utils/logger";

/**
 * Sticker file IDs from CACGifs pack
 * Note: These need to be obtained by having the bot receive stickers from the pack
 * To get file_id: Send a sticker to the bot and it will be logged
 */
const STICKER_PACK = {
	// CACGifs pack stickers
	cacgifs: {
		first:
			"CAACAgIAAxkBAAICIGkIxVYID2ee6Z3t3fzMKGyrzCLlAAJmNgACfvIoSL_cdmEGklS0NgQ", // satellite sticker
	},
};

/**
 * Registers sticker-related commands with the bot
 */
export function registerStickerCommands(bot: Telegraf<Context>): void {
	/**
	 * Command: /sendsticker
	 * Send a specific sticker from the CACGifs pack
	 *
	 * Permission: Any user (can be restricted to elevated/admin if needed)
	 * Syntax: /sendsticker [name]
	 */
	bot.command("sendsticker", async (ctx) => {
		try {
			const args = ctx.message?.text.split(" ").slice(1);
			const _stickerName = args?.[0] || "first";

			// For now, send a message with the sticker pack link
			// Once we have the file_id, we can send the actual sticker
			await ctx.reply(
				fmt`${bold("CACGifs Sticker Pack")}

To send stickers from this pack, I need the sticker file_id.

Pack link: https://t.me/addstickers/CACGifs

To get the file_id:
1. Send me any sticker from this pack in a DM
2. I will log the file_id
3. Update the code with the file_id
4. Then I can send stickers directly!`,
			);
		} catch (error) {
			logger.error("Error sending sticker", { error });
			await ctx.reply("Failed to send sticker.");
		}
	});

	/**
	 * Command: /getsticker
	 * Get file_id from a sticker (send this command as a reply to a sticker)
	 *
	 * Permission: Any user
	 * Usage: Reply to a sticker with /getsticker
	 */
	bot.command("getsticker", async (ctx) => {
		try {
			const replyMessage = ctx.message.reply_to_message;

			if (!replyMessage || !("sticker" in replyMessage)) {
				return ctx.reply(
					"Please reply to a sticker with /getsticker to get its file\\_id",
				);
			}

			const sticker = replyMessage.sticker;
			const fileId = sticker.file_id;
			const fileUniqueId = sticker.file_unique_id;
			const stickerSetName = sticker.set_name;
			const emoji = sticker.emoji;

			await ctx.reply(
				fmt`${bold("Sticker Information")}

File ID: ${code(fileId)}
Unique ID: ${code(fileUniqueId)}
Set Name: ${stickerSetName || "N/A"}
Emoji: ${emoji || "N/A"}

Use this file_id to send this sticker programmatically.`,
			);

			logger.info("Sticker file_id retrieved", {
				fileId,
				fileUniqueId,
				stickerSetName,
				emoji,
				userId: ctx.from?.id,
			});
		} catch (error) {
			logger.error("Error getting sticker info", { error });
			await ctx.reply("Failed to get sticker information.");
		}
	});

	/**
	 * Listen for stickers sent to the bot to log their file_ids
	 */
	bot.on("sticker", async (ctx) => {
		try {
			const sticker = ctx.message.sticker;
			const fileId = sticker.file_id;
			const stickerSetName = sticker.set_name;
			const emoji = sticker.emoji;

			// Log sticker info for CACGifs pack specifically
			if (stickerSetName === "CACGifs") {
				logger.info("CACGifs sticker received", {
					fileId,
					emoji,
					userId: ctx.from?.id,
					username: ctx.from?.username,
				});

				// Optionally notify in DM
				if (ctx.chat.type === "private") {
					await ctx.reply(
						fmt`CACGifs sticker logged!

File ID: ${code(fileId)}
Emoji: ${emoji || "N/A"}`,
					);
				}
			}
		} catch (error) {
			logger.error("Error processing sticker", { error });
		}
	});

	/**
	 * Command: /cac
	 * Send the first sticker from CACGifs pack (once file_id is set)
	 *
	 * Permission: Any user
	 * Syntax: /cac
	 */
	bot.command("cac", async (ctx) => {
		try {
			// Check if we have the file_id
			if (!STICKER_PACK.cacgifs.first) {
				return ctx.reply(
					"Sticker not configured yet\\!\n\n" +
						"Please send me the first sticker from https://t\\.me/addstickers/CACGifs\n" +
						"in a DM, and I will save it for this command\\.",
				);
			}

			// Send the sticker
			await ctx.replyWithSticker(STICKER_PACK.cacgifs.first);
		} catch (error) {
			logger.error("Error sending CAC sticker", { error });
			await ctx.reply("Failed to send sticker.");
		}
	});
}

/**
 * Update sticker file_id (for use in bot initialization or admin command)
 * This function can be called to update the stored file_id
 */
export function setStickerFileId(
	pack: "cacgifs",
	sticker: "first",
	fileId: string,
): void {
	if (pack === "cacgifs") {
		STICKER_PACK.cacgifs[sticker] = fileId;
		logger.info("Sticker file_id updated", { pack, sticker, fileId });
	}
}
