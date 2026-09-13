/**
 * Owner command to drive the identity crawl.
 *
 * @module commands/crawl
 */

import type { Context, Telegraf } from "telegraf";
import { ownerOnly } from "../middleware";
import { IdentityCrawlService } from "../services/identityCrawlService";

/**
 * Registers the identity crawl command.
 *
 * - `/crawlidentities [count]` probes up to count (1-1000, default 100) users
 *   missing a username and records their current Telegram profile.
 * - `/crawlidentities reset` starts a fresh pass on the next run.
 *
 * @param bot - Telegraf bot instance
 */
export function registerCrawlCommands(bot: Telegraf<Context>): void {
	bot.command("crawlidentities", ownerOnly, async (ctx) => {
		const args = ctx.message?.text.split(/\s+/).slice(1) || [];

		if (args[0]?.toLowerCase() === "reset") {
			IdentityCrawlService.reset();
			return ctx.reply(
				"Identity crawl reset. The next run starts a fresh pass over users without usernames.",
			);
		}

		if (IdentityCrawlService.isRunning()) {
			return ctx.reply("An identity crawl is already running.");
		}

		const requested = Number.parseInt(args[0] ?? "100", 10);
		const limit = Number.isFinite(requested)
			? Math.min(Math.max(requested, 1), 1000)
			: 100;

		const status = await ctx.reply(
			`Crawling up to ${limit} users missing usernames…`,
		);
		const result = await IdentityCrawlService.runBatch(bot, limit);
		const text = result.error
			? `Identity crawl error: ${result.error}`
			: result.skipped
				? "An identity crawl is already running."
				: `Identity crawl: attempted ${result.attempted}, filled ${result.filled}, unavailable ${result.unavailable}${result.done ? " — pass complete" : ""}.`;

		await ctx.telegram
			.editMessageText(ctx.chat.id, status.message_id, undefined, text)
			.catch(() => ctx.reply(text));
	});
}
