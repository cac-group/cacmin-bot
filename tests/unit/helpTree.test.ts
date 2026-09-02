import { describe, expect, it } from "vitest";
import {
	ALL_ROLES,
	ADMIN_ROLES,
	ELEVATED_ROLES,
	OWNER_ROLES,
	canAccessHelpNode,
	findHelpNode,
	helpTree,
	parentHelpKey,
	type HelpNode,
	type HelpRole,
} from "../../src/commands/helpTree";

function collectNodes(nodes: readonly HelpNode[]): HelpNode[] {
	return nodes.flatMap((node) => [
		node,
		...(node.children ? collectNodes(node.children) : []),
	]);
}

describe("helpTree structure", () => {
	it("gives every node a unique key", () => {
		const keys = collectNodes(helpTree).map((node) => node.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("gives every node either content or children, never both", () => {
		for (const node of collectNodes(helpTree)) {
			expect(Boolean(node.content) !== Boolean(node.children)).toBe(true);
		}
	});

	it("gates each role level off the appropriate categories", () => {
		const topLevel = helpTree.map((node) => node.key);
		const topLevelRoles: Record<string, readonly HelpRole[]> = {};
		for (const node of helpTree) topLevelRoles[node.key] = node.roles;

		expect(topLevelRoles["wallet"]).toEqual(ALL_ROLES);
		expect(topLevelRoles["shared"]).toEqual(ALL_ROLES);
		expect(topLevelRoles["user"]).toEqual(ALL_ROLES);
		expect(topLevelRoles["giveaways"]).toEqual(ALL_ROLES);
		expect(topLevelRoles["payments"]).toEqual(ALL_ROLES);
		expect(topLevelRoles["games"]).toEqual(ALL_ROLES);
		expect(topLevelRoles["elevated"]).toEqual(ELEVATED_ROLES);
		expect(topLevelRoles["admin"]).toEqual(ADMIN_ROLES);
		expect(topLevelRoles["owner"]).toEqual(OWNER_ROLES);
		expect(topLevel).toContain("elevated");
		expect(topLevel).toContain("admin");
		expect(topLevel).toContain("owner");
	});

	it("hides sensitive categories from lower-tier users", () => {
		const owner = findHelpNode(helpTree, "owner");
		const admin = findHelpNode(helpTree, "admin");
		const elevated = findHelpNode(helpTree, "elevated");

		expect(owner).not.toBeNull();
		expect(admin).not.toBeNull();
		expect(elevated).not.toBeNull();

		expect(canAccessHelpNode(owner!, "owner")).toBe(true);
		expect(canAccessHelpNode(owner!, "admin")).toBe(false);
		expect(canAccessHelpNode(owner!, "pleb")).toBe(false);

		expect(canAccessHelpNode(admin!, "admin")).toBe(true);
		expect(canAccessHelpNode(admin!, "owner")).toBe(true);
		expect(canAccessHelpNode(admin!, "elevated")).toBe(false);

		expect(canAccessHelpNode(elevated!, "elevated")).toBe(true);
		expect(canAccessHelpNode(elevated!, "pleb")).toBe(false);
	});

	it("never offers admin or owner menu options to pleb or elevated users", () => {
		const visibleTopLevel = (role: HelpRole): string[] =>
			helpTree
				.filter((node) => canAccessHelpNode(node, role))
				.map((node) => node.key);

		expect(visibleTopLevel("pleb")).toEqual([
			"wallet",
			"shared",
			"user",
			"giveaways",
			"payments",
			"games",
		]);
		expect(visibleTopLevel("elevated")).not.toContain("admin");
		expect(visibleTopLevel("elevated")).not.toContain("owner");
		expect(visibleTopLevel("admin")).not.toContain("owner");
		expect(visibleTopLevel("owner")).toEqual([
			"wallet",
			"shared",
			"user",
			"giveaways",
			"payments",
			"games",
			"elevated",
			"admin",
			"owner",
		]);
	});

	it("keeps every admin and owner section hidden from lower tiers", () => {
		const collectLeafKeys = (nodes: readonly HelpNode[]): string[] =>
			nodes.flatMap((node) => [
				node.key,
				...(node.children ? collectLeafKeys(node.children) : []),
			]);

		const adminLeafKeys = collectLeafKeys(
			findHelpNode(helpTree, "admin")!.children!,
		);
		const ownerLeafKeys = collectLeafKeys(
			findHelpNode(helpTree, "owner")!.children!,
		);

		for (const key of adminLeafKeys) {
			const node = findHelpNode(helpTree, key)!;
			expect(canAccessHelpNode(node, "elevated")).toBe(false);
			expect(canAccessHelpNode(node, "pleb")).toBe(false);
		}
		for (const key of ownerLeafKeys) {
			const node = findHelpNode(helpTree, key)!;
			expect(canAccessHelpNode(node, "admin")).toBe(false);
			expect(canAccessHelpNode(node, "elevated")).toBe(false);
			expect(canAccessHelpNode(node, "pleb")).toBe(false);
		}
	});

	it("computes parent keys for back navigation", () => {
		expect(parentHelpKey("wallet")).toBeNull();
		expect(parentHelpKey("wallet:account")).toBe("wallet");
		expect(parentHelpKey("owner:wallet-tests")).toBe("owner");
	});

	it("resolves nested node lookups", () => {
		expect(findHelpNode(helpTree, "wallet:account")?.title).toBe(
			"Balance & History",
		);
		expect(findHelpNode(helpTree, "admin:ratelimits")?.title).toBe(
			"Rate Limits",
		);
		expect(findHelpNode(helpTree, "owner:wallet-tests")?.title).toBe(
			"Wallet Test Suite",
		);
		expect(findHelpNode(helpTree, "missing")).toBeNull();
	});
});