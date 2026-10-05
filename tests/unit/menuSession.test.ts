import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupMenuByMessage,
	createMenuSession,
	getActiveMenuSession,
	getMenuSessionByMessage,
	validateMenuInteraction,
} from "../../src/utils/menuSession";

/** Minimal callback context for menu-ownership checks. */
const ctxFor = (userId: number, chatId: number, messageId: number) =>
	({
		from: { id: userId },
		chat: { id: chatId },
		callbackQuery: { message: { message_id: messageId } },
	}) as never;

describe("menuSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates a session and blocks a duplicate menu of the same type", () => {
		expect(createMenuSession(1, 100, 10, "giveaway_setup")).not.toBeNull();
		expect(createMenuSession(1, 100, 11, "giveaway_setup")).toBeNull();
		expect(getMenuSessionByMessage(100, 10)?.userId).toBe(1);
		expect(getActiveMenuSession(100, "giveaway_setup")?.messageId).toBe(10);
	});

	it("only lets the owner interact and expires old menus on read", async () => {
		createMenuSession(1, 200, 20, "duel_setup");

		expect(
			await validateMenuInteraction(ctxFor(1, 200, 20), "duel_setup"),
		).toBeNull();
		expect(
			await validateMenuInteraction(ctxFor(2, 200, 20), "duel_setup"),
		).toContain("person who started");

		vi.advanceTimersByTime(31_000);
		expect(getMenuSessionByMessage(200, 20)).toBeNull();
		expect(
			await validateMenuInteraction(ctxFor(1, 200, 20), "duel_setup"),
		).toBe("This menu has expired.");
	});

	it("cleanupMenuByMessage removes the session", () => {
		createMenuSession(1, 300, 30, "giveaway_setup");
		cleanupMenuByMessage(300, 30);
		expect(getMenuSessionByMessage(300, 30)).toBeNull();
		expect(getActiveMenuSession(300, "giveaway_setup")).toBeNull();
	});
});
