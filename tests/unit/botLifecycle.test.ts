import { describe, expect, it } from "vitest";
import { waitForBotLaunch } from "../../src/utils/botLifecycle";

describe("waitForBotLaunch", () => {
	it("preserves launch failures before shutdown", async () => {
		const launchError = new Error("polling failed");

		await expect(
			waitForBotLaunch(
				async () => {
					throw launchError;
				},
				() => false,
			),
		).rejects.toBe(launchError);
	});

	it("treats a launch rejection during shutdown as a clean stop", async () => {
		let shutdownRequested = false;
		let rejectLaunch: (error: Error) => void = () => undefined;
		const launch = new Promise<void>((_resolve, reject) => {
			rejectLaunch = reject;
		});
		const result = waitForBotLaunch(
			() => launch,
			() => shutdownRequested,
		);

		shutdownRequested = true;
		rejectLaunch(new TypeError("Attempted to assign to readonly property."));

		await expect(result).resolves.toBe("stopped");
	});

	it("reports a normal launch completion", async () => {
		await expect(
			waitForBotLaunch(
				async () => undefined,
				() => false,
			),
		).resolves.toBe("completed");
	});

	it("reports a normal launch completion after shutdown as a clean stop", async () => {
		let shutdownRequested = false;
		let resolveLaunch: () => void = () => undefined;
		const launch = new Promise<void>((resolve) => {
			resolveLaunch = resolve;
		});
		const result = waitForBotLaunch(
			() => launch,
			() => shutdownRequested,
		);

		shutdownRequested = true;
		resolveLaunch();

		await expect(result).resolves.toBe("stopped");
	});
});
