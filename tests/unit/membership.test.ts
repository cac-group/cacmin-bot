import { describe, expect, it, vi } from "vitest";

const { memberTags } = vi.hoisted(() => ({
	memberTags: new Map<number, string>([[1194167473, "Neil"]]),
}));

vi.mock("../../src/config", () => ({
	config: { memberTags },
}));

vi.mock("../../src/database", () => ({
	execute: vi.fn(),
}));

vi.mock("../../src/services/userService", () => ({
	ensureUserExists: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyMemberTag, isJoinTransition } from "../../src/handlers/membership";

describe("membership join transitions", () => {
	it("treats entering from left/kicked as a join", () => {
		expect(isJoinTransition("left", "member")).toBe(true);
		expect(isJoinTransition("kicked", "member")).toBe(true);
		expect(isJoinTransition("left", "administrator")).toBe(true);
		expect(isJoinTransition("kicked", "creator")).toBe(true);
	});

	it("ignores staying, leaving, or being restricted/banned", () => {
		expect(isJoinTransition("member", "member")).toBe(false);
		expect(isJoinTransition("administrator", "administrator")).toBe(false);
		expect(isJoinTransition("member", "left")).toBe(false);
		expect(isJoinTransition("member", "kicked")).toBe(false);
		expect(isJoinTransition("member", "restricted")).toBe(false);
	});
});

describe("configured member tags on join", () => {
	const telegramWith = (callApi: ReturnType<typeof vi.fn>) =>
		({ callApi }) as never;

	it("applies the configured tag for a known user", async () => {
		const callApi = vi.fn().mockResolvedValue(true);
		await applyMemberTag(telegramWith(callApi), -100123, 1194167473);
		expect(callApi).toHaveBeenCalledWith("setChatMemberTag", {
			chat_id: -100123,
			user_id: 1194167473,
			tag: "Neil",
		});
	});

	it("does nothing for an untagged user", async () => {
		const callApi = vi.fn().mockResolvedValue(true);
		await applyMemberTag(telegramWith(callApi), -100123, 42);
		expect(callApi).not.toHaveBeenCalled();
	});

	it("does nothing without a chat id", async () => {
		const callApi = vi.fn().mockResolvedValue(true);
		await applyMemberTag(telegramWith(callApi), undefined, 1194167473);
		expect(callApi).not.toHaveBeenCalled();
	});

	it("swallows API failures so join tracking continues", async () => {
		const callApi = vi.fn().mockRejectedValue(new Error("not enough rights"));
		await expect(
			applyMemberTag(telegramWith(callApi), -100123, 1194167473),
		).resolves.toBeUndefined();
	});
});
