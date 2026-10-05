/**
 * Owner-only JUNO price command.
 *
 * @module commands/price
 */

import type { Context, Telegraf } from "telegraf";
import { bold, fmt } from "telegraf/format";
import { ownerOnly } from "../middleware/index";
import { PriceService } from "../services/priceService";

/** Registers the price command with the bot. */
export function registerPriceCommands(bot: Telegraf<Context>): void {
	bot.command("junoprice", ownerOnly, async (ctx) => {
		const priceInfo = await PriceService.getPriceInfo();

		const lastUpdateTime = priceInfo.lastUpdate
			? new Date(priceInfo.lastUpdate).toLocaleString()
			: "Never";

		await ctx.reply(
			fmt`${bold("JUNO Price Information")}

Current: $${priceInfo.current?.toFixed(4) || "N/A"}
24h Average: $${priceInfo.average.toFixed(4)}

Last Updated: ${lastUpdateTime}

Prices from CoinGecko API`,
		);
	});
}
