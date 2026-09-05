/**
 * Global test setup
 * Runs once before all tests
 */

import { vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { config } from "../src/config";

// Create test data directory if it doesn't exist
const testDataDir = path.join(__dirname, "../data");
if (!fs.existsSync(testDataDir)) {
	fs.mkdirSync(testDataDir, { recursive: true });
}

// Mock environment variables for testing
process.env.BOT_TOKEN = "test-bot-token";
process.env.GROUP_CHAT_ID = "-100123456789";
process.env.BOT_TREASURY_ADDRESS = "juno1testtreasuryaddress";
process.env.USER_FUNDS_ADDRESS = "juno1testuserfundsaddress";
process.env.USER_FUNDS_MNEMONIC = "test mnemonic for user funds wallet";
process.env.ADMIN_CHAT_ID = "123456789";

// Suppress console output during tests
global.console = {
	...console,
	log: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};
