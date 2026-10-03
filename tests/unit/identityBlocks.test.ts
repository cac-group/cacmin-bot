import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "telegraf/types";
import {
	detectBlockedIdentity,
	invalidateIdentityBlockCache,
	jailIfBlockedIdentity,
} from "../../src/handlers/identityBlocks";

const {
	applyTelegramMuteMock,
	executeMock,
	isAdminMock,
	isOwnerMock,
	queryMock,
} = vi.hoisted(() => ({
	applyTelegramMuteMock: vi.fn().mockResolvedValue(undefined),
	executeMock: vi.fn(),
	isAdminMock: vi.fn(),
	isOwnerMock: vi.fn(),
	queryMock: vi.fn(),
}));

vi.mock("../../src/database", () => ({
	execute: executeMock,
	get: vi.fn(),
	query: queryMock,
}));

vi.mock("../../src/utils/roles", () => ({
	isAdmin: isAdminMock,
	isOwner: isOwnerMock,
}));

vi.mock("../../src/services/jailService", () => ({
	JailService: {
		jailUser: vi.fn(() => ({ mutedUntil: 1234567890, bailAmount: 0 })),
		applyTelegramMute: applyTelegramMuteMock,
	},
}));

vi.mock("../../src/services/userService", () => ({
	ensureUserExists: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
	StructuredLogger: {
		logSecurityEvent: vi.fn(),
	},
}));

const user = (overrides: Partial<User>): User => ({
	id: 123,
	is_bot: false,
	first_name: "Ordinary",
	...overrides,
});

describe("identity block detection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryMock.mockReturnValue([]);
		isOwnerMock.mockReturnValue(false);
		isAdminMock.mockReturnValue(false);
		invalidateIdentityBlockCache();
	});

	it("matches the built-in exploitation spam signature in display names", () => {
		const match = detectBlockedIdentity(
			user({
				first_name: "CHI.LD",
				last_name: "PO.RN GDS81",
			}),
		);

		expect(match).toEqual({
			field: "display_name",
			patternSource: "builtin",
			matchedValue: "CHI.LD PO.RN GDS81",
		});
	});

	it("matches DB patterns only against their configured identity field", () => {
		queryMock.mockReturnValue([
			{
				id: 7,
				pattern: "/spam[_-]?user\\d+/i",
				match_field: "username",
				description: null,
				added_by: 1,
				created_at: 1,
			},
		]);

		expect(
			detectBlockedIdentity(
				user({
					first_name: "spam_user42",
					username: undefined,
				}),
			),
		).toBeNull();

		invalidateIdentityBlockCache();

		expect(
			detectBlockedIdentity(
				user({
					first_name: "Normal",
					username: "spam_user42",
				}),
			),
		).toMatchObject({
			field: "username",
			patternSource: "db#7:/spam[_-]?user\\d+/i",
			matchedValue: "spam_user42",
		});
	});
});

describe("identity block jails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryMock.mockReturnValue([]);
		isOwnerMock.mockReturnValue(false);
		isAdminMock.mockReturnValue(false);
		invalidateIdentityBlockCache();
	});

	it("jails matching non-admin users", async () => {
		const jailed = await jailIfBlockedIdentity(
			-100123,
			user({
				id: 456,
				first_name: "Child",
				last_name: "Porn GDS81",
			}),
			"join",
		);

		expect(jailed).toBe(true);
		expect(applyTelegramMuteMock).toHaveBeenCalledWith(
			456,
			-100123,
			1234567890,
			"identity_block",
		);
	});

	it("does not jail configured owners", async () => {
		isOwnerMock.mockReturnValue(true);

		const jailed = await jailIfBlockedIdentity(
			-100123,
			user({
				id: 789,
				first_name: "Child",
				last_name: "Porn GDS81",
			}),
			"message",
		);

		expect(jailed).toBe(false);
		expect(applyTelegramMuteMock).not.toHaveBeenCalled();
		expect(queryMock).not.toHaveBeenCalled();
	});

	it("does not jail configured admins", async () => {
		isOwnerMock.mockReturnValue(false);
		isAdminMock.mockReturnValue(true);

		const jailed = await jailIfBlockedIdentity(
			-100123,
			user({
				id: 789,
				first_name: "Child",
				last_name: "Porn GDS81",
			}),
			"message",
		);

		expect(jailed).toBe(false);
		expect(applyTelegramMuteMock).not.toHaveBeenCalled();
		expect(queryMock).not.toHaveBeenCalled();
	});
});
