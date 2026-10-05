/**
 * Price tracking service for JUNO token.
 * Fetches prices from CoinGecko API and maintains rolling averages.
 *
 * @module services/priceService
 */

import { config } from "../config";
import { execute, get } from "../database";
import { StructuredLogger } from "../utils/logger";

/**
 * Service for tracking JUNO price and converting USD to JUNO amounts.
 */
export class PriceService {
	private static cachedPrice: number | null = null;
	private static lastFetch: number = 0;
	private static readonly CACHE_DURATION = config.price.cacheDurationMs;
	private static readonly COINGECKO_ID = config.price.coingeckoId;
	private static readonly ROLLING_AVERAGE_HOURS =
		config.price.rollingAverageHours;

	/**
	 * Fetches current JUNO price from CoinGecko API.
	 * Uses caching to avoid rate limits.
	 */
	static async fetchCurrentPrice(): Promise<number | null> {
		const now = Date.now();

		// Return cached price if still valid
		if (
			PriceService.cachedPrice &&
			now - PriceService.lastFetch < PriceService.CACHE_DURATION
		) {
			return PriceService.cachedPrice;
		}

		try {
			const response = await fetch(
				`${config.price.apiUrl}?ids=${PriceService.COINGECKO_ID}&vs_currencies=usd`,
			);

			if (!response.ok) {
				StructuredLogger.logError(
					new Error(`CoinGecko API error: ${response.status}`),
					{
						operation: "fetch_price",
					},
				);
				return PriceService.cachedPrice; // Return stale cache on error
			}

			const data = (await response.json()) as Record<string, { usd?: number }>;
			const price = data[PriceService.COINGECKO_ID]?.usd;

			if (typeof price === "number" && price > 0) {
				PriceService.cachedPrice = price;
				PriceService.lastFetch = now;

				// Store in database for historical tracking
				PriceService.storePriceHistory(price);

				StructuredLogger.logDebug("JUNO price fetched", {
					price: price.toString(),
				});

				return price;
			}

			return PriceService.cachedPrice;
		} catch (error) {
			StructuredLogger.logError(error as Error, {
				operation: "fetch_price",
			});
			return PriceService.cachedPrice;
		}
	}

	/**
	 * Stores price in history table for rolling average calculations.
	 */
	private static storePriceHistory(price: number): void {
		const timestamp = Math.floor(Date.now() / 1000);
		execute("INSERT INTO price_history (price_usd, timestamp) VALUES (?, ?)", [
			price,
			timestamp,
		]);

		// Clean up old entries beyond the retention window
		const cutoff = timestamp - config.price.historyRetentionDays * 24 * 60 * 60;
		execute("DELETE FROM price_history WHERE timestamp < ?", [cutoff]);
	}

	/**
	 * Calculates rolling average price over the last 24 hours.
	 * Falls back to current price if no history available.
	 */
	static async getRollingAveragePrice(): Promise<number> {
		const cutoff =
			Math.floor(Date.now() / 1000) -
			PriceService.ROLLING_AVERAGE_HOURS * 60 * 60;

		const result = get<{ avg_price: number; count: number }>(
			"SELECT AVG(price_usd) as avg_price, COUNT(*) as count FROM price_history WHERE timestamp > ?",
			[cutoff],
		);

		if (result && result.count > 0 && result.avg_price > 0) {
			return result.avg_price;
		}

		// Fall back to current price if no history
		const currentPrice = await PriceService.fetchCurrentPrice();
		return currentPrice || 0.1; // Default fallback price
	}

	/**
	 * Gets the current and average JUNO price for display.
	 */
	static async getPriceInfo(): Promise<{
		current: number | null;
		average: number;
		lastUpdate: number;
	}> {
		const current = await PriceService.fetchCurrentPrice();
		const average = await PriceService.getRollingAveragePrice();

		return {
			current,
			average,
			lastUpdate: PriceService.lastFetch,
		};
	}

	/**
	 * Updates price history periodically. Should be called via setInterval.
	 */
	static async updatePriceHistory(): Promise<void> {
		await PriceService.fetchCurrentPrice();
	}
}
