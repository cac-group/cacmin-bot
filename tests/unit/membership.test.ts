import { describe, expect, it, vi } from "vitest";

const { memberTags } = vi.hoisted(() => ({
	memberTags: new Map<number, string>([[1194167473, "Neil"]]),
}));

vi.mock("../../src/config", () => ({
	config: { memberTags },
}));

vi.mock("../../src/database", () => ({
	execute: vi.fn(),
	get: vi.fn(() => undefined),
}));

vi.mock("../../src/services/userService", () => ({
	ensureUserExists: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	applyMemberTag,
	isJoinTransition,
	isLeaveTransition,
	recordMembershipEvent,
} from "../../src/handlers/membership";
import { execute, get } from "../../src/database";

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

	it("treats any out-of-group transition, including from restricted, as a leave", () => {
		expect(isLeaveTransition("member", "left")).toBe(true);
		expect(isLeaveTransition("member", "kicked")).toBe(true);
		expect(isLeaveTransition("restricted", "left")).toBe(true);
		expect(isLeaveTransition("administrator", "kicked")).toBe(true);
		expect(isLeaveTransition("left", "left")).toBe(false);
		expect(isLeaveTransition("member", "member")).toBe(false);
		expect(isLeaveTransition("restricted", "member")).toBe(false);
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

describe("membership event log", () => {
	it("appends a join/leave row with the chat, source, and time", () => {
		vi.mocked(get).mockReturnValueOnce(undefined);
		recordMembershipEvent(
			70007,
			-100123,
			"join",
			"chat_member:left->member",
			1234,
		);
		expect(execute).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO user_membership_events"),
			[70007, -100123, "join", "chat_member:left->member", 1234],
		);
	});

	it("collapses a duplicate transition delivered as both a message and chat_member", () => {
		vi.mocked(execute).mockClear();
		vi.mocked(get).mockReturnValueOnce({
			event_type: "join",
			occurred_at: 1230,
		});
		recordMembershipEvent(70007, -100123, "join", "new_chat_members", 1234);
		expect(execute).not.toHaveBeenCalled();
	});
});
