import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../src/database";
import { JailService } from "../../src/services/jailService";
import { ensureUserExists } from "../../src/services/userService";

const USER_ID = 990000001;
const PAYER_ID = 990000002;

describe("JailService.jailings", () => {
	beforeEach(() => {
		ensureUserExists(USER_ID, "jailtest");
		ensureUserExists(PAYER_ID, "payer");
	});
	afterEach(() => {
		execute("DELETE FROM jailings WHERE user_id IN (?, ?)", [
			USER_ID,
			PAYER_ID,
		]);
		execute("DELETE FROM jail_events WHERE user_id IN (?, ?)", [
			USER_ID,
			PAYER_ID,
		]);
		execute("DELETE FROM users WHERE id IN (?, ?)", [USER_ID, PAYER_ID]);
	});

	it("creates a jailing with an id and pays it once", () => {
		const { jailingId, bailAmount } = JailService.jailUser({
			userId: USER_ID,
			durationMinutes: 60,
		});
		expect(jailingId).toMatch(/^[A-Z][A-Z0-9]{7}$/);
		expect(bailAmount).toBe(69.42);

		const active = JailService.getActiveJailing(USER_ID);
		expect(active?.jailingId).toBe(jailingId);
		expect(JailService.getCurrentBailAmount(USER_ID)).toBe(69.42);

		const paid = JailService.payJailing(jailingId, PAYER_ID, "TX-TEST-1");
		expect(paid.success).toBe(true);
		expect(paid.userId).toBe(USER_ID);
		expect(JailService.getActiveJailing(USER_ID)).toBeNull();
		expect(JailService.isBailPaymentUsed("TX-TEST-1")).toBe(true);
	});

	it("rejects reusing a tx hash", () => {
		const first = JailService.jailUser({
			userId: USER_ID,
			durationMinutes: 60,
		});
		expect(
			JailService.payJailing(first.jailingId, PAYER_ID, "TX-REUSE").success,
		).toBe(true);

		const second = JailService.jailUser({
			userId: USER_ID,
			durationMinutes: 60,
		});
		const reuse = JailService.payJailing(
			second.jailingId,
			PAYER_ID,
			"TX-REUSE",
		);
		expect(reuse.success).toBe(false);
		expect(reuse.duplicate).toBe(true);
	});

	it("matches the jailing id case-insensitively", () => {
		const { jailingId } = JailService.jailUser({
			userId: USER_ID,
			durationMinutes: 60,
		});
		expect(
			JailService.getJailingByPublicId(jailingId.toLowerCase())?.jailingId,
		).toBe(jailingId);
	});

	it("does not pay an expired jailing", () => {
		const { jailingId } = JailService.jailUser({
			userId: USER_ID,
			durationMinutes: -1,
		});
		expect(JailService.getJailingByPublicId(jailingId)).toBeNull();
		expect(JailService.getActiveJailing(USER_ID)).toBeNull();

		const paid = JailService.payJailing(jailingId, PAYER_ID, "TX-EXPIRED");
		expect(paid.success).toBe(false);
		expect(paid.notFound).toBe(true);
	});
});
