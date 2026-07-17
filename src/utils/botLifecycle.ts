export type BotLaunchResult = "completed" | "stopped";

export async function waitForBotLaunch(
	launch: () => Promise<void>,
	isShutdownRequested: () => boolean,
): Promise<BotLaunchResult> {
	try {
		await launch();
	} catch (error) {
		if (!isShutdownRequested()) throw error;
	}

	return isShutdownRequested() ? "stopped" : "completed";
}
