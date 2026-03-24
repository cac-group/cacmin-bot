import { describe, expect, it } from "vitest";
import {
	computeActiveTime,
	formatActiveTime,
} from "../../src/utils/activeTime";

/** Helper: convert "HH:MM" to a unix timestamp on an arbitrary fixed day */
function t(time: string): number {
	const [h, m] = time.split(":").map(Number);
	return h * 3600 + m * 60;
}

describe("computeActiveTime", () => {
	it("returns 0 for empty timestamps", () => {
		expect(computeActiveTime([])).toBe(0);
	});

	it("returns 10 minutes for a single message (forward-only)", () => {
		expect(computeActiveTime([t("12:01")])).toBe(600);
	});

	it("example 1: messages at 12:01 and 12:10 → 20 minutes", () => {
		// 12:10 backward activates (12:01 forward [12:01,12:11] overlaps [12:00,12:10])
		// merged: [12:00, 12:20] = 20 min
		const result = computeActiveTime([t("12:01"), t("12:10")]);
		expect(result).toBe(1200);
	});

	it("example 2: messages at 12:01, 12:05, 12:30 → 30 minutes", () => {
		// 12:05 backward activates, 12:30 does not
		// merged: [11:55, 12:15] + [12:30, 12:40] = 20 + 10 = 30 min
		const result = computeActiveTime([t("12:01"), t("12:05"), t("12:30")]);
		expect(result).toBe(1800);
	});

	it("isolated messages each get 10 minutes only", () => {
		// Messages 25 minutes apart — no backward activation
		const result = computeActiveTime([t("12:00"), t("12:25")]);
		expect(result).toBe(1200); // 10 + 10
	});

	it("handles unsorted input", () => {
		const result = computeActiveTime([t("12:10"), t("12:01")]);
		expect(result).toBe(1200); // same as sorted
	});

	it("continuous chatter extends the window", () => {
		// Messages every 5 minutes for 30 minutes: 12:00, 12:05, ..., 12:30
		const timestamps = [];
		for (let m = 0; m <= 30; m += 5) {
			timestamps.push(t(`12:${String(m).padStart(2, "0")}`));
		}
		// Each message after the first activates backward (prev is within 20 min)
		// Intervals: [12:00,12:10], [11:55,12:15], [11:55,12:20], ..., [12:20,12:40]
		// All merge into one big interval
		const result = computeActiveTime(timestamps);
		// First message: [12:00, 12:10]
		// Second (12:05): backward activates → [11:55, 12:15]
		// Merged so far: [11:55, 12:15]
		// Third (12:10): backward activates → [12:00, 12:20], merged → [11:55, 12:20]
		// ... continues merging
		// Last (12:30): backward activates → [12:20, 12:40], merged → [11:55, 12:40]
		// Total: 45 min = 2700 sec
		expect(result).toBe(2700);
	});

	it("messages exactly 20 minutes apart do not activate backward", () => {
		// sorted[i-1] = t, sorted[i] = t + 20min
		// condition: sorted[i-1] > sorted[i] - 2*10min → t > t, false
		const result = computeActiveTime([t("12:00"), t("12:20")]);
		expect(result).toBe(1200); // 10 + 10 = 20 min, no backward
	});

	it("messages just under 20 minutes apart activate backward", () => {
		// 19 minutes apart
		const ts1 = t("12:00");
		const ts2 = ts1 + 19 * 60;
		const result = computeActiveTime([ts1, ts2]);
		// ts2 backward activates: [ts2-10, ts2+10]
		// merged with [ts1, ts1+10] = [ts1, ts2+10]
		// = 29 minutes
		expect(result).toBe(29 * 60);
	});

	it("respects custom window size", () => {
		// Single message with 5-minute window
		expect(computeActiveTime([t("12:00")], 5)).toBe(300);

		// Two messages 8 min apart with 5-min window
		// 12:00 → [12:00, 12:05], 12:08 backward activates → [12:03, 12:13]
		// merged: [12:00, 12:13] = 13 min
		const result = computeActiveTime([t("12:00"), t("12:08")], 5);
		expect(result).toBe(13 * 60);
	});

	it("handles duplicate timestamps", () => {
		const result = computeActiveTime([t("12:00"), t("12:00")]);
		// sorted[0] > sorted[1] - 2*window → t > t - 1200 → true, backward activates
		// intervals: [12:00, 12:10], [11:50, 12:10] → merged [11:50, 12:10] = 20 min
		expect(result).toBe(1200);
	});
});

describe("formatActiveTime", () => {
	it("formats zero", () => {
		expect(formatActiveTime(0)).toBe("0m");
	});

	it("formats minutes only", () => {
		expect(formatActiveTime(2700)).toBe("45m");
	});

	it("formats hours and minutes", () => {
		expect(formatActiveTime(5400)).toBe("1h 30m");
	});

	it("formats days, hours, and minutes", () => {
		expect(formatActiveTime(90060)).toBe("1d 1h 1m");
	});

	it("omits zero components", () => {
		expect(formatActiveTime(86400)).toBe("1d");
		expect(formatActiveTime(3600)).toBe("1h");
	});

	it("shows 0m for sub-minute durations", () => {
		expect(formatActiveTime(30)).toBe("0m");
	});
});
