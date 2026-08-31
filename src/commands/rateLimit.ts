import type { Context, Telegraf } from "telegraf";
import { bold, code, fmt } from "telegraf/format";
import { config } from "../config";
import { execute, get, query } from "../database";
import { adminOrHigher } from "../middleware/index";
import { JunoService } from "../services/junoService";
import {
	RateLimitService,
	type RateLimitWindow,
} from "../services/rateLimitService";
import { ensureUserExists, getUserById } from "../services/userService";
import type { User } from "../types";
import { rateLimitResetKeyboard } from "../utils/keyboards";
import { AmountPrecision } from "../utils/precision";
import { formatUserIdDisplay, resolveUserId } from "../utils/userResolver";

const windows: RateLimitWindow[] = ["15m", "1h", "24h"];
const windowText = (window: RateLimitWindow): string =>
	window === "15m" ? "15-minute" : window === "1h" ? "1-hour" : "24-hour";

function parseWindow(value?: string): RateLimitWindow | null {
	return windows.includes(value as RateLimitWindow)
		? (value as RateLimitWindow)
		: null;
}

function statusText(userId: number): string {
	const status = RateLimitService.getStatus(userId);
	if (!status) return "No message rate limit is configured for this user.";
	return windows
		.map(
			(window) =>
				`${window}: ${status.usage[window]}/${status.limits[window]} characters (rollover ${status.rollover[window]}, resets ${new Date(status.resetsAt[window] * 1000).toLocaleString()})`,
		)
		.join("\n");
}

/** Register rate-limit status, administration, and JUNO reset commands. */
export function registerRateLimitCommands(bot: Telegraf<Context>): void {
	bot.command("ratelimit", async (ctx) => {
		const requester = ctx.from?.id;
		if (!requester) return;
		const args = ctx.message?.text.split(/\s+/).slice(1) || [];
		const target = args[0] ? resolveUserId(args[0]) : requester;
		if (!target)
			return ctx.reply("User not found. Use a valid @username or user ID.");
		const user = get<User>("SELECT * FROM users WHERE id = ?", [requester]);
		if (target !== requester && !["admin", "owner"].includes(user?.role || ""))
			return ctx.reply(
				"Only admins and owners can view another user's rate limit.",
			);
		return ctx.reply(
			fmt`${bold(`Rate limit status for ${formatUserIdDisplay(target)}`)}\n\n${statusText(target)}`,
		);
	});

	bot.command("setratelimit", adminOrHigher, async (ctx) => {
		const args = ctx.message?.text.split(/\s+/).slice(1) || [];
		const target = resolveUserId(args[0] || "");
		const limits = args.slice(1).map((value) => Number(value));
		if (
			!target ||
			limits.length !== 1 ||
			limits.some((value) => !Number.isSafeInteger(value) || value < 1)
		)
			return ctx.reply(
				"Usage: /setratelimit <user> <15m_chars> (1h=4x, 24h=24x)",
			);
		const targetUser = get<User>("SELECT * FROM users WHERE id = ?", [target]);
		if (!targetUser) return ctx.reply("User not found in database.");
		if (["admin", "owner"].includes(targetUser.role))
			return ctx.reply("Admins and owners are immune to rate limits.");
		RateLimitService.setLimits(target, limits[0]);
		return ctx.reply(
			`Rate limit set for ${formatUserIdDisplay(target)}: ${limits[0]} / ${limits[0] * 4} / ${limits[0] * 96} characters (15m / 1h / 24h).`,
		);
	});

	bot.command("clearratelimit", adminOrHigher, async (ctx) => {
		const target = resolveUserId(ctx.message?.text.split(/\s+/)[1] || "");
		if (!target) return ctx.reply("Usage: /clearratelimit <user>");
		RateLimitService.clearLimits(target);
		return ctx.reply(`Rate limit cleared for ${formatUserIdDisplay(target)}.`);
	});

	bot.command("ratelimitreset", async (ctx) => {
		const payer = ctx.from?.id;
		if (!payer) return;
		const args = ctx.message?.text.split(/\s+/).slice(1) || [];
		if (args.length === 0 && ctx.chat?.type === "private") {
			return ctx.reply("Select the usage window to reset:", {
				reply_markup: rateLimitResetKeyboard,
			});
		}
		let target = payer;
		let window = parseWindow(args[0]);
		if (!window) {
			target = resolveUserId(args[0] || "") || 0;
			window = parseWindow(args[1]);
		}
		if (!target || !window)
			return ctx.reply("Usage: /ratelimitreset [user] <15m|1h|24h>");
		if (!RateLimitService.getStatus(target))
			return ctx.reply("That user has no configured rate limit.");
		const fee = config.rateLimitResetFees[window];
		ensureUserExists(payer, ctx.from.username || `user_${payer}`);
		ensureUserExists(target, getUserById(target)?.username || `user_${target}`);
		const message = await ctx.reply(
			fmt`${bold(`Reset ${windowText(window)} rate-limit usage`)}\n\nSend exactly ${fee.toFixed(6)} JUNO to:\n${code(JunoService.getPaymentAddress())}\n\nThen reply to this message with the transaction hash, or send the hash in a DM. The bot will verify the successful transfer before clearing the ${windowText(window)} window.`,
		);
		execute(
			`INSERT INTO rate_limit_reset_payments (payer_user_id, target_user_id, window, amount_micro, instruction_chat_id, instruction_message_id) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				payer,
				target,
				window,
				RateLimitService.feeMicro(window),
				ctx.chat?.id || null,
				message.message_id,
			],
		);
	});

	bot.action(/^ratelimit_reset_(15m|1h|24h)$/, async (ctx) => {
		const payer = ctx.from?.id;
		const window = parseWindow(ctx.match[1]);
		if (!payer || !window) return;
		await ctx.answerCbQuery();
		if (!RateLimitService.getStatus(payer)) {
			await ctx.editMessageText("You have no configured rate limit.");
			return;
		}
		const fee = config.rateLimitResetFees[window];
		ensureUserExists(payer, ctx.from.username || `user_${payer}`);
		const message = await ctx.reply(
			fmt`${bold(`Reset ${windowText(window)} rate-limit usage`)}\n\nSend exactly ${fee.toFixed(6)} JUNO to:\n${code(JunoService.getPaymentAddress())}\n\nThen reply to this message with the transaction hash, or send the hash in a DM.`,
		);
		execute(
			"INSERT INTO rate_limit_reset_payments (payer_user_id, target_user_id, window, amount_micro, instruction_chat_id, instruction_message_id) VALUES (?, ?, ?, ?, ?, ?)",
			[
				payer,
				payer,
				window,
				RateLimitService.feeMicro(window),
				ctx.chat?.id || null,
				message.message_id,
			],
		);
	});

	bot.command("verifyratelimitreset", async (ctx) => {
		const payer = ctx.from?.id;
		if (!payer) return;
		const args = ctx.message?.text.split(/\s+/).slice(1) || [];
		const pending = query<{
			id: number;
			target_user_id: number;
			window: RateLimitWindow;
			amount_micro: number;
		}>(
			"SELECT id, target_user_id, window, amount_micro FROM rate_limit_reset_payments WHERE payer_user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
			[payer],
		)[0];
		const txHash = args[0];
		if (!pending || !txHash)
			return ctx.reply(
				"Usage: /verifyratelimitreset <txhash> after /ratelimitreset.",
			);
		if (RateLimitService.isPaymentHashUsed(txHash))
			return ctx.reply(
				"This transaction hash has already been used for a payment.",
			);
		const verified = await JunoService.verifyPayment(
			txHash,
			AmountPrecision.fromDbMicro(pending.amount_micro),
		);
		if (!verified)
			return ctx.reply(
				"Payment could not be verified. Check the transaction hash and exact amount.",
			);
		try {
			execute(
				"UPDATE rate_limit_reset_payments SET status = 'verified', payment_tx = ?, verified_at = ? WHERE id = ? AND status = 'pending'",
				[txHash, Math.floor(Date.now() / 1000), pending.id],
			);
			RateLimitService.resetWindow(pending.target_user_id, pending.window);
			if (config.groupChatId)
				await RateLimitService.releaseMuteIfAllowed(
					bot,
					config.groupChatId,
					pending.target_user_id,
				).catch(() => false);
			return ctx.reply(
				`Payment verified. The ${pending.window} rate-limit usage was cleared for ${formatUserIdDisplay(pending.target_user_id)}.`,
			);
		} catch {
			return ctx.reply(
				"This transaction hash has already been used or the reset could not be recorded.",
			);
		}
	});

	bot.on("text", async (ctx, next) => {
		const payer = ctx.from?.id;
		const text =
			ctx.message && "text" in ctx.message ? ctx.message.text.trim() : "";
		const reply =
			ctx.message && "reply_to_message" in ctx.message
				? ctx.message.reply_to_message
				: undefined;
		if (!payer || !text || text.startsWith("/")) return next();
		const isInstructionReply = Boolean(
			reply &&
				query<{ id: number }>(
					"SELECT id FROM rate_limit_reset_payments WHERE payer_user_id = ? AND status = 'pending' AND instruction_message_id = ?",
					[payer, reply.message_id],
				)[0],
		);
		const isPendingDm =
			ctx.chat?.type === "private" &&
			Boolean(
				query<{ id: number }>(
					"SELECT id FROM rate_limit_reset_payments WHERE payer_user_id = ? AND status = 'pending' LIMIT 1",
					[payer],
				)[0],
			);
		if (!isInstructionReply && !isPendingDm) return next();
		const pending = query<{
			id: number;
			target_user_id: number;
			window: RateLimitWindow;
			amount_micro: number;
		}>(
			"SELECT id, target_user_id, window, amount_micro FROM rate_limit_reset_payments WHERE payer_user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
			[payer],
		)[0];
		if (!pending) return next();
		if (RateLimitService.isPaymentHashUsed(text)) {
			await ctx.reply(
				"This transaction hash has already been used for a payment.",
			);
			return;
		}
		const verified = await JunoService.verifyPayment(
			text,
			AmountPrecision.fromDbMicro(pending.amount_micro),
		);
		if (!verified)
			return ctx
				.reply(
					"Payment could not be verified. Please send the transaction hash for the exact amount.",
				)
				.then(() => undefined);
		try {
			execute(
				"UPDATE rate_limit_reset_payments SET status = 'verified', payment_tx = ?, verified_at = ? WHERE id = ? AND status = 'pending'",
				[text, Math.floor(Date.now() / 1000), pending.id],
			);
			RateLimitService.resetWindow(pending.target_user_id, pending.window);
			if (config.groupChatId)
				await RateLimitService.releaseMuteIfAllowed(
					bot,
					config.groupChatId,
					pending.target_user_id,
				).catch(() => false);
			await ctx.reply(
				`Payment verified. The ${pending.window} rate-limit usage was cleared for ${formatUserIdDisplay(pending.target_user_id)}.`,
			);
		} catch {
			await ctx.reply(
				"This transaction hash has already been used or the reset could not be recorded.",
			);
		}
	});
}
