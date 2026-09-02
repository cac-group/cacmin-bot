import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/database", () => ({
	execute: vi.fn(),
	get: vi.fn(),
	query: vi.fn(),
}));

vi.mock("../../src/services/userService", () => ({
	ensureUserExists: vi.fn(),
}));

import {
	findHelpNode,
	helpTree,
	type HelpNode,
} from "../../src/commands/helpTree";
import { buildWalletHelpText } from "../../src/commands/wallet";

const repoRoot = path.resolve(__dirname, "../..");
const srcRoot = path.join(repoRoot, "src");
const readmePath = path.join(repoRoot, "README.md");

function walkFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return walkFiles(fullPath);
		}
		return fullPath.endsWith(".ts") ? [fullPath] : [];
	});
}

function extractRegisteredCommands(): Set<string> {
	const commandPattern = /bot\.command\("([^"]+)"/g;
	const commands = new Set<string>();

	for (const filePath of walkFiles(srcRoot)) {
		const source = fs.readFileSync(filePath, "utf8");
		for (const match of source.matchAll(commandPattern)) {
			commands.add(match[1]);
		}
	}

	return commands;
}

function extractDocumentedCommands(text: string): Set<string> {
	const commands = new Set<string>();

	for (const line of text.split("\n")) {
		if (!/^\s*(?:[-*]\s+)?`?\/[a-z]/.test(line)) {
			continue;
		}

		for (const match of line.matchAll(/\/([a-z][a-z0-9]+)/g)) {
			commands.add(match[1]);
		}
	}

	return commands;
}

/** Collect the plain text of every leaf node in the tree. */
function collectLeafText(nodes: readonly HelpNode[]): string[] {
	const texts: string[] = [];
	for (const node of nodes) {
		if (node.content) texts.push(node.content.text);
		if (node.children) texts.push(...collectLeafText(node.children));
	}
	return texts;
}

/** Concatenated leaf text of a node and its entire subtree. */
function textForSection(key: string): string {
	const node = findHelpNode(helpTree, key);
	if (!node) return "";
	return collectLeafText([node]).join("\n");
}

function getReadmeCommandsSection(): string {
	const readme = fs.readFileSync(readmePath, "utf8");
	const startMarker = "## Commands";
	const endMarker = "## Architecture";
	const start = readme.indexOf(startMarker);
	const end = readme.indexOf(endMarker);

	if (start === -1 || end === -1 || end <= start) {
		throw new Error("README command section markers not found");
	}

	return readme.slice(start, end);
}

describe("help documentation coverage", () => {
	it("keeps role-based help aligned with every registered command", () => {
		const registeredCommands = extractRegisteredCommands();
		registeredCommands.delete("help");

		const documentedCommands = new Set<string>();
		for (const text of collectLeafText(helpTree)) {
			for (const command of extractDocumentedCommands(text)) {
				documentedCommands.add(command);
			}
		}

		const missing = Array.from(registeredCommands)
			.filter((command) => !documentedCommands.has(command))
			.sort();
		const extras = Array.from(documentedCommands)
			.filter((command) => !registeredCommands.has(command))
			.sort();

		expect(missing).toEqual([]);
		expect(extras).toEqual([]);
	});

	it("keeps the README command reference aligned with every registered command", () => {
		const registeredCommands = extractRegisteredCommands();
		const documentedCommands = extractDocumentedCommands(
			getReadmeCommandsSection(),
		);

		const missing = Array.from(registeredCommands)
			.filter((command) => !documentedCommands.has(command))
			.sort();
		const extras = Array.from(documentedCommands)
			.filter((command) => !registeredCommands.has(command))
			.sort();

		expect(missing).toEqual([]);
		expect(extras).toEqual([]);
	});

	it("keeps key usage signatures aligned with the live handlers", () => {
		const readmeCommands = getReadmeCommandsSection();
		const payments = textForSection("payments");
		const shared = textForSection("shared");
		const owner = textForSection("owner");

		expect(payments).toContain("/payfine [id]");
		expect(payments).toContain("/verifypayment <violationId> <txhash>");
		expect(textForSection("games:duel")).toContain("/duelhistory [limit]");
		expect(textForSection("elevated")).toContain(
			"/createshared <name> <display_name> [description]",
		);
		expect(shared).toContain(
			"/grantaccess <account_name> <@username|user_id> <level> [spend_limit]",
		);
		expect(shared).toContain(
			"/updateaccess <account_name> <@username|user_id> <level> [spend_limit]",
		);
		expect(textForSection("admin")).toContain(
			"/claimdeposit <txhash> <userId|@username>",
		);
		expect(owner).toContain(
			"/claimdeposit <txhash> <userId|@username>",
		);
		expect(payments).toContain("/paybail <@username|userId>");
		expect(payments).toContain(
			"/verifybail <@username|userId> <txhash>",
		);
		expect(payments).toContain("/bailhelp");
		expect(shared).toContain(
			"/sharedsend <name> <@username|user_id> <amount> [description]",
		);
		expect(shared).toContain(
			"/revokeaccess <account_name> <@username|user_id>",
		);
		expect(owner).toContain(
			"/setfine <type> <amount_usd> [description]",
		);
		expect(owner).toContain(
			"/customjail <@username|userId> <minutes> <juno_amount> <reason>",
		);
		expect(owner).toContain(
			"/addidentityblock <pattern> [name|username|both]",
		);
		expect(readmeCommands).toContain(
			"`/setfine <type> <amount_usd> [description]`",
		);
		expect(readmeCommands).toContain(
			"`/grantaccess <account_name> <@username|user_id> <level> [spend_limit]`",
		);
		expect(readmeCommands).toContain(
			"`/updateaccess <account_name> <@username|user_id> <level> [spend_limit]`",
		);
		expect(readmeCommands).toContain("`/verifydeposit <txhash>`");
		expect(readmeCommands).toContain(
			"`/claimdeposit <txhash> <userId|@username>`",
		);
		expect(readmeCommands).toContain("`/processdeposit <txhash>`");
		expect(readmeCommands).toContain("`/paybail [<@username|userId>]`");
		expect(readmeCommands).toContain(
			"`/verifybail <@username|userId> <txhash>`",
		);
		expect(readmeCommands).toContain(
			"`/customjail <@username|userId> <minutes> <juno_amount> <reason>`",
		);
		expect(readmeCommands).toContain(
			"`/addidentityblock <pattern> [name|username|both]`",
		);
	});
});

describe("wallethelp text", () => {
	it("matches the live wallet and treasury command syntax", () => {
		const walletHelp = buildWalletHelpText("123456").text;

		expect(walletHelp).toContain("/verifydeposit <txhash>");
		expect(walletHelp).toContain("/transactions [@user|userId]");
		expect(walletHelp).toContain("/fundtreasury deposit");
		expect(walletHelp).toContain(
			"/walletstats - View system wallet statistics (owner only)",
		);
		expect(walletHelp).toContain(
			"/adjustbalance <amount> <debit|credit> [reason] - Correct ledger discrepancies (owner only)",
		);
		expect(walletHelp).not.toContain("/giveaway <@user|id> <amount>");
	});
});
