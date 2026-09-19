/**
 * Price tracking service for JUNO token.
 * Fetches prices from CoinGecko API and maintains rolling averages
 * for USD-to-JUNO conversion in fine calculations.
 *
 * @module services/priceService
 */

import { execute, get, query } from "../database";
import { StructuredLogger } from "../utils/logger";

interface FineConfig {
	fine_type: string;
	amount_usd: number;
	description: string;
	updated_at: number;
	updated_by: number;
}

/**
 * Service for tracking JUNO price and converting USD to JUNO amounts.
 */
export class PriceService {
	private static cachedPrice: number | null = null;
	private static lastFetch: number = 0;
	private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
	private static readonly COINGECKO_ID = "juno-network";
	private static readonly ROLLING_AVERAGE_HOURS = 24;

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
				`https://api.coingecko.com/api/v3/simple/price?ids=${PriceService.COINGECKO_ID}&vs_currencies=usd`,
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

		// Clean up old entries (keep 7 days)
		const cutoff = timestamp - 7 * 24 * 60 * 60;
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
	 * Converts USD amount to JUNO tokens using rolling average price.
	 */
	static async usdToJuno(usdAmount: number): Promise<number> {
		const price = await PriceService.getRollingAveragePrice();
		if (price <= 0) {
			StructuredLogger.logError(new Error("Invalid JUNO price"), {
				operation: "usd_to_juno",
			});
			return usdAmount * 10; // Fallback: assume $0.10/JUNO
		}
		return usdAmount / price;
	}

	/**
	 * Gets the configured fine amount in USD for a fine type.
	 */
	static getFineConfigUsd(fineType: string): number {
		const config = get<FineConfig>(
			"SELECT * FROM fine_config WHERE fine_type = ?",
			[fineType],
		);

		if (config) {
			return config.amount_usd;
		}

		// Return defaults if not configured
		const defaults: Record<string, number> = {
			sticker: 0.1,
			url: 0.2,
			regex: 0.15,
			jail_per_minute: 0.01,
			jail_minimum: 0.1,
			auto_jail: 1.0,
		};

		return defaults[fineType] || 0.1;
	}

	/**
	 * Sets the fine amount in USD for a fine type.
	 */
	static setFineConfigUsd(
		fineType: string,
		amountUsd: number,
		description: string,
		updatedBy: number,
	): void {
		const now = Math.floor(Date.now() / 1000);

		execute(
			`INSERT INTO fine_config (fine_type, amount_usd, description, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fine_type) DO UPDATE SET
         amount_usd = excluded.amount_usd,
         description = excluded.description,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
			[fineType, amountUsd, description, now, updatedBy],
		);

		StructuredLogger.logUserAction("Fine config updated", {
			userId: updatedBy,
			operation: "set_fine_config",
			fineType,
			amount: amountUsd.toString(),
		});
	}

	/**
	 * Gets all fine configurations.
	 */
	static getAllFineConfigs(): FineConfig[] {
		return query<FineConfig>("SELECT * FROM fine_config ORDER BY fine_type");
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
	 * Calculates bail amount in JUNO based on duration and USD rate.
	 */
	static async calculateBailAmount(durationMinutes: number): Promise<number> {
		const perMinuteUsd = PriceService.getFineConfigUsd("jail_per_minute");
		const minimumUsd = PriceService.getFineConfigUsd("jail_minimum");

		const totalUsd = Math.max(minimumUsd, durationMinutes * perMinuteUsd);
		const junoAmount = await PriceService.usdToJuno(totalUsd);

		// Round to 2 decimal places
		return Math.round(junoAmount * 100) / 100;
	}

	/**
	 * Calculates violation fine in JUNO based on restriction type.
	 */
	static async calculateViolationFine(restriction: string): Promise<number> {
		let fineType: string;

		switch (restriction) {
			case "no_stickers":
				fineType = "sticker";
				break;
			case "no_urls":
				fineType = "url";
				break;
			case "regex_block":
				fineType = "regex";
				break;
			default:
				fineType = "sticker"; // Default fine type
		}

		const usdAmount = PriceService.getFineConfigUsd(fineType);
		const junoAmount = await PriceService.usdToJuno(usdAmount);

		// Round to 2 decimal places
		return Math.round(junoAmount * 100) / 100;
	}

	/**
	 * Updates price history periodically. Should be called via setInterval.
	 */
	static async updatePriceHistory(): Promise<void> {
		await PriceService.fetchCurrentPrice();
	}
}
