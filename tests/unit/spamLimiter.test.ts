import { beforeEach, describe, expect, it } from "vitest";
import {
	clearTrackers,
	pruneTrackers,
	recordMessage,
} from "../../src/services/spamLimiterService";

const config = { maxMessages: 5, windowMs: 5000, deleteCount: 5 };

describe("spamLimiterService", () => {
	beforeEach(() => {
		clearTrackers();
	});

	it("allows messages up to the limit", () => {
		for (let index = 1; index <= 5; index++) {
			expect(recordMessage(1, 100, index, config, 0)).toBeNull();
		}
	});

	it("reports the last five message IDs on the sixth message in the window", () => {
		for (let index = 1; index <= 5; index++) {
			recordMessage(1, 100, index, config, 0);
		}
		expect(recordMessage(1, 100, 6, config, 1000)).toEqual({
			messageIds: [2, 3, 4, 5, 6],
		});
	});

	it("does not trigger when messages fall outside the window", () => {
		recordMessage(1, 100, 1, config, 0);
		recordMessage(1, 100, 2, config, 1000);
		recordMessage(1, 100, 3, config, 2000);
		recordMessage(1, 100, 4, config, 3000);
		recordMessage(1, 100, 5, config, 4000);
		expect(recordMessage(1, 100, 6, config, 10_000)).toBeNull();
	});

	it("tracks users and chats independently", () => {
		for (let index = 1; index <= 5; index++) {
			recordMessage(1, 100, index, config, 0);
		}
		recordMessage(1, 100, 6, config, 0); // user 1 bursts and resets
		expect(recordMessage(2, 100, 1, config, 0)).toBeNull();
		expect(recordMessage(1, 200, 1, config, 0)).toBeNull();
	});

	it("is disabled when maxMessages is not positive", () => {
		const disabled = { ...config, maxMessages: 0 };
		for (let index = 1; index <= 20; index++) {
			expect(recordMessage(1, 100, index, disabled, index)).toBeNull();
		}
	});

	it("prunes entries outside the window", () => {
		recordMessage(1, 100, 1, config, 0);
		pruneTrackers(config.windowMs, 10_000);
		expect(recordMessage(1, 100, 2, config, 10_000)).toBeNull();
	});
});
