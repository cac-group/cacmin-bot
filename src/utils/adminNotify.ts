/**
 * @module utils/adminNotify
 * @description Sends user-facing errors via DM with a brief group fallback.
 */

import type { Context } from "telegraf";
import { logger } from "./logger";

/**
 * Sends an error message to a user via DM, with fallback to a brief group reply.
 * Detailed errors go to DM, the group gets a hyperlink to the bot DM.
 *
 * @param ctx - Telegraf context
 * @param detailedMessage - Full error message for DM
 * @param briefMessage - Optional short message for group fallback
 */
export async function sendUserError(
	ctx: Context,
	detailedMessage: string,
	briefMessage = "An error occurred.",
): Promise<void> {
	const userId = ctx.from?.id;
	if (!userId) {
		await ctx.reply(briefMessage);
		return;
	}

	const dmLink =
		'<a href="https://t.me/banbabybot">Check DM for full error details</a>';

	try {
		await ctx.telegram.sendMessage(
			userId,
			`${detailedMessage}\n\nIf this persists, forward this message to @BasementNodes`,
		);
		if (ctx.chat && ctx.chat.type !== "private") {
			await ctx.reply(dmLink, {
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
		}
	} catch {
		// DM failed (user hasn't started the bot or blocked it); reply in group.
		await ctx.reply(briefMessage);
		logger.debug("Could not DM user, replied in group", { userId });
	}
}
