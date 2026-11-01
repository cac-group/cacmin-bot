import { describe, expect, it } from "vitest";
import { buildMainMenuKeyboard } from "../../src/handlers/callbacks";

const callbacks = (role: "pleb" | "elevated" | "admin" | "owner") =>
	buildMainMenuKeyboard(role).inline_keyboard.flat().map((button) =>
		"callback_data" in button ? button.callback_data : "",
	);

describe("role-filtered main menu", () => {
	it("shows only wallet, shared, and help to plebs", () => {
		expect(callbacks("pleb")).toEqual([
			"menu_wallet",
			"menu_shared",
			"menu_help",
		]);
	});

	it("adds moderation for elevated users", () => {
		expect(callbacks("elevated")).toContain("menu_moderation");
		expect(callbacks("elevated")).not.toContain("menu_lists");
		expect(callbacks("elevated")).not.toContain("menu_stats");
	});

	it("adds lists and roles for admins, statistics only for owners", () => {
		expect(callbacks("admin")).toEqual(
			expect.arrayContaining(["menu_lists", "menu_roles", "menu_moderation"]),
		);
		expect(callbacks("admin")).not.toContain("menu_stats");
		expect(callbacks("owner")).toContain("menu_stats");
	});
});
