import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "cacmin-deployment-test-"));
	temporaryRoots.push(root);
	return root;
}

function parseUnit(path: string): Map<string, string[]> {
	const values = new Map<string, string[]>();
	let section = "";
	for (const rawLine of readFileSync(path, "utf8").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1);
			continue;
		}
		const equals = line.indexOf("=");
		if (equals < 1) continue;
		const key = `${section}.${line.slice(0, equals)}`;
		const existing = values.get(key) || [];
		existing.push(line.slice(equals + 1));
		values.set(key, existing);
	}
	return values;
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

function createFakeCommands(root: string): {
	binDir: string;
	curlLog: string;
	systemctlLog: string;
	systemctlStateDir: string;
} {
	const binDir = join(root, "bin");
	const curlLog = join(root, "curl.log");
	const systemctlLog = join(root, "systemctl.log");
	const systemctlStateDir = join(root, "systemctl-state");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(systemctlStateDir, { recursive: true });
	writeExecutable(
		join(binDir, "systemctl"),
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CACMIN_SYSTEMCTL_LOG"
case "$1" in
	is-active)
		shift
		[ "\${1:-}" = "--quiet" ] && shift
		[ -f "$CACMIN_SYSTEMCTL_STATE_DIR/$1.active" ]
		;;
	is-enabled)
		shift
		[ "\${1:-}" = "--quiet" ] && shift
		[ -f "$CACMIN_SYSTEMCTL_STATE_DIR/$1.enabled" ]
		;;
	stop)
		shift
		for unit in "$@"; do rm -f "$CACMIN_SYSTEMCTL_STATE_DIR/$unit.active"; done
		;;
	start)
		shift
		for unit in "$@"; do : > "$CACMIN_SYSTEMCTL_STATE_DIR/$unit.active"; done
		;;
	disable)
		shift
		[ "\${1:-}" = "--now" ] && shift
		for unit in "$@"; do
			rm -f "$CACMIN_SYSTEMCTL_STATE_DIR/$unit.active"
			[ "\${CACMIN_DISABLE_LEAVES_ENABLED:-0}" = 1 ] || rm -f "$CACMIN_SYSTEMCTL_STATE_DIR/$unit.enabled"
		done
		;;
	enable)
		shift
		activate=false
		[ "\${1:-}" = "--now" ] && { activate=true; shift; }
		for unit in "$@"; do
			[ "\${CACMIN_FAIL_ENABLE_UNIT:-}" = "$unit" ] && exit 73
			: > "$CACMIN_SYSTEMCTL_STATE_DIR/$unit.enabled"
			[ "$activate" = true ] && : > "$CACMIN_SYSTEMCTL_STATE_DIR/$unit.active"
		done
		;;
esac
`,
	);
	writeExecutable(
		join(binDir, "curl"),
		`#!/bin/sh
set -eu
[ -z "\${CACMIN_CURL_LOG:-}" ] || printf '%s\\n' "$*" >> "$CACMIN_CURL_LOG"
output=''
previous=''
for argument in "$@"; do
	if [ "$previous" = '-o' ]; then output=$argument; break; fi
	previous=$argument
done
if [ -n "$output" ]; then
	cp "$CACMIN_RELEASE_ARCHIVE" "$output"
else
	cat "$CACMIN_RELEASE_FIXTURE"
fi
`,
	);
	return { binDir, curlLog, systemctlLog, systemctlStateDir };
}

function installMoveFailure(binDir: string): void {
	writeExecutable(
		join(binDir, "mv"),
		`#!/bin/sh
set -eu
if [ "$#" -eq 2 ]; then
	case "$2" in
		"$CACMIN_INSTALL_DIR/.rollback/"*)
			count=0
			[ ! -f "$CACMIN_MOVE_COUNT_FILE" ] || read -r count < "$CACMIN_MOVE_COUNT_FILE"
			count=$((count + 1))
			printf '%s\\n' "$count" > "$CACMIN_MOVE_COUNT_FILE"
			/usr/bin/mv "$@"
			[ "$count" -ne "$CACMIN_FAIL_MOVE_AT" ] || exit 91
			exit 0
			;;
	esac
fi
exec /usr/bin/mv "$@"
`,
	);
}

function createInstallFixture(root: string): string {
	const source = join(root, "source");
	mkdirSync(join(source, "dist"), { recursive: true });
	mkdirSync(join(source, "node_modules", "fixture"), { recursive: true });
	writeFileSync(join(source, "dist", "bot.js"), "console.log('fixture');\n");
	writeFileSync(join(source, "node_modules", "fixture", "index.js"), "\n");
	writeFileSync(join(source, "package.json"), '{"name":"fixture"}\n');
	writeFileSync(join(source, "bun.lock"), "fixture\n");
	for (const file of [
		"cacmin-bot.service",
		"cacmin-bot-update.service",
		"cacmin-bot-update.timer",
		"auto-update.sh",
	]) {
		cpSync(join(REPO_ROOT, file), join(source, file));
	}
	return source;
}

function createReleaseFixture(root: string): {
	archive: string;
	releaseInfo: string;
} {
	const releaseTree = createInstallFixture(join(root, "release"));
	writeFileSync(join(releaseTree, "dist", "bot.js"), "new-dist\n");
	writeFileSync(
		join(releaseTree, "node_modules", "fixture", "index.js"),
		"new-module\n",
	);
	writeFileSync(join(releaseTree, "package.json"), '{"name":"new"}\n');
	writeFileSync(join(releaseTree, "bun.lock"), "new-lock\n");
	const archive = join(root, "cacmin-bot-dist.tar.gz");
	const tarResult = spawnSync(
		"tar",
		[
			"-czf",
			archive,
			"-C",
			releaseTree,
			"dist",
			"node_modules",
			"package.json",
			"bun.lock",
		],
		{ encoding: "utf8" },
	);
	expect(tarResult.status, tarResult.stderr).toBe(0);
	const releaseInfo = join(root, "release.json");
	writeFileSync(
		releaseInfo,
		JSON.stringify({
			updated_at: "2030-01-01T00:00:00Z",
			assets: [
				{
					name: "cacmin-bot-dist.tar.gz",
					browser_download_url: "https://example.invalid/release.tar.gz",
				},
			],
		}),
	);
	return { archive, releaseInfo };
}

function createOldInstall(installDir: string): Record<string, string> {
	mkdirSync(join(installDir, "dist"), { recursive: true });
	mkdirSync(join(installDir, "node_modules", "fixture"), { recursive: true });
	writeFileSync(join(installDir, "dist", "bot.js"), "old-dist\n");
	writeFileSync(
		join(installDir, "node_modules", "fixture", "index.js"),
		"old-module\n",
	);
	writeFileSync(join(installDir, "package.json"), '{"name":"old"}\n');
	writeFileSync(join(installDir, "bun.lock"), "old-lock\n");
	writeFileSync(join(installDir, "version.txt"), "1\n");
	return releaseSnapshot(installDir);
}

function releaseSnapshot(installDir: string): Record<string, string> {
	const contents = (path: string): string =>
		existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
	return {
		dist: contents(join(installDir, "dist", "bot.js")),
		module: contents(join(installDir, "node_modules", "fixture", "index.js")),
		package: contents(join(installDir, "package.json")),
		lock: contents(join(installDir, "bun.lock")),
		version: contents(join(installDir, "version.txt")),
	};
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("CACMin deployment contracts", () => {
	it("runs the bot as the dedicated user with only explicit mutable paths", () => {
		const unit = parseUnit(join(REPO_ROOT, "cacmin-bot.service"));

		expect(unit.get("Service.User")).toEqual(["cacmin-bot"]);
		expect(unit.get("Service.Group")).toEqual(["cacmin-bot"]);
		expect(unit.get("Service.SupplementaryGroups")).toEqual([
			"teleindexer-data",
		]);
		expect(unit.get("Service.EnvironmentFile")).toEqual([
			"/etc/cacmin-bot/cacmin-bot.env",
		]);
		expect(unit.get("Service.ExecStart")).toEqual([
			"/opt/bun/bin/bun dist/bot.js",
		]);
		expect(unit.get("Service.UMask")).toEqual(["0007"]);
		expect(unit.get("Service.ProtectSystem")).toEqual(["strict"]);
		expect(unit.get("Service.NoNewPrivileges")).toEqual(["true"]);
		expect(unit.get("Service.ReadWritePaths")).toEqual(
			expect.arrayContaining([
				"/opt/cacmin-bot/data",
				"/opt/cacmin-bot/logs",
				"/opt/telegram-chat-explorer/data",
				"/opt/telegram-chat-explorer/state",
			]),
		);
	});

	it("runs the updater from a root-owned path and installs a persistent timer", () => {
		const service = parseUnit(join(REPO_ROOT, "cacmin-bot-update.service"));
		const timer = parseUnit(join(REPO_ROOT, "cacmin-bot-update.timer"));

		expect(service.get("Service.ExecStart")).toEqual([
			"/usr/local/libexec/cacmin-bot-auto-update",
		]);
		expect(service.get("Service.User")).toBeUndefined();
		expect(service.get("Service.ProtectSystem")).toEqual(["strict"]);
		expect(service.get("Service.ReadWritePaths")).toEqual(["/opt/cacmin-bot"]);
		expect(timer.get("Timer.Persistent")).toEqual(["true"]);
		expect(timer.get("Install.WantedBy")).toEqual(["timers.target"]);
	});

	it("checks for updates without mutating the install or calling systemctl", () => {
		const root = temporaryRoot();
		const installDir = join(root, "opt", "cacmin-bot");
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "version.txt"), "1\n");
		const initialEntries = readdirSync(installDir);
		const fixture = join(root, "release.json");
		writeFileSync(
			fixture,
			JSON.stringify({
				updated_at: "2026-07-12T00:00:00Z",
				assets: [
					{
						name: "cacmin-bot-dist.tar.gz",
						browser_download_url: "https://example.invalid/release.tar.gz",
					},
				],
			}),
		);
		const { binDir, systemctlLog } = createFakeCommands(root);

		const result = spawnSync(
			"bash",
			[join(REPO_ROOT, "auto-update.sh"), "--check"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}:/usr/bin:/bin`,
					CACMIN_TEST_MODE: "1",
					CACMIN_HOSTNAME: "tgbot",
					CACMIN_EXPECTED_HOSTNAME: "tgbot",
					CACMIN_INSTALL_DIR: installDir,
					CACMIN_RELEASE_FIXTURE: fixture,
					CACMIN_SYSTEMCTL_LOG: systemctlLog,
				},
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("update_available=yes");
		expect(readdirSync(installDir)).toEqual(initialEntries);
		expect(readFileSync(join(installDir, "version.txt"), "utf8")).toBe("1\n");
		expect(existsSync(systemctlLog)).toBe(false);
	});

	it("routes timer checks to latest and tag deployments to the requested release", () => {
		const root = temporaryRoot();
		const installDir = join(root, "opt", "cacmin-bot");
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "version.txt"), "1\n");
		const { archive, releaseInfo } = createReleaseFixture(root);
		const { binDir, curlLog, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);
		const env = {
			...process.env,
			PATH: `${binDir}:/usr/bin:/bin`,
			CACMIN_TEST_MODE: "1",
			CACMIN_HOSTNAME: "tgbot",
			CACMIN_EXPECTED_HOSTNAME: "tgbot",
			CACMIN_INSTALL_DIR: installDir,
			CACMIN_RELEASE_FIXTURE: releaseInfo,
			CACMIN_RELEASE_ARCHIVE: archive,
			CACMIN_CURL_LOG: curlLog,
			CACMIN_SYSTEMCTL_LOG: systemctlLog,
			CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
		};

		const timerCheck = spawnSync(
			"bash",
			[join(REPO_ROOT, "auto-update.sh"), "--check"],
			{ cwd: REPO_ROOT, encoding: "utf8", env },
		);
		const tagCheck = spawnSync(
			"bash",
			[join(REPO_ROOT, "auto-update.sh"), "--check", "--release", "v2.14.2"],
			{ cwd: REPO_ROOT, encoding: "utf8", env },
		);

		expect(timerCheck.status, timerCheck.stderr).toBe(0);
		expect(tagCheck.status, tagCheck.stderr).toBe(0);
		const calls = readFileSync(curlLog, "utf8").trim().split("\n");
		expect(calls[0]).toContain("/releases/tags/latest");
		expect(calls[1]).toContain("/releases/tags/v2.14.2");
		const workflow = readFileSync(
			join(REPO_ROOT, ".github", "workflows", "build.yml"),
			"utf8",
		);
		expect(workflow).toContain("RELEASE_TAG: $" + "{{ github.ref_name }}");
		expect(workflow).toContain("runs-on: [self-hosted, X64]");
		expect(workflow).toContain("lxc exec tgbot");
		expect(workflow).toContain(
			'cacmin-bot-auto-update --release "$RELEASE_TAG" --force',
		);
		expect(workflow).not.toContain("envs: RELEASE_TAG");
	});

	it.each([
		{ label: "first", failMoveAt: 1 },
		{ label: "middle", failMoveAt: 3 },
	])("restores the updater release and active service after the $label destructive move fails", ({
		failMoveAt,
	}) => {
		const root = temporaryRoot();
		const installDir = join(root, "opt", "cacmin-bot");
		const before = createOldInstall(installDir);
		const { archive, releaseInfo } = createReleaseFixture(root);
		const { binDir, curlLog, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);
		installMoveFailure(binDir);
		writeFileSync(join(systemctlStateDir, "cacmin-bot.service.active"), "");

		const result = spawnSync("bash", [join(REPO_ROOT, "auto-update.sh")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:/usr/bin:/bin`,
				CACMIN_TEST_MODE: "1",
				CACMIN_HOSTNAME: "tgbot",
				CACMIN_EXPECTED_HOSTNAME: "tgbot",
				CACMIN_INSTALL_DIR: installDir,
				CACMIN_RELEASE_FIXTURE: releaseInfo,
				CACMIN_RELEASE_ARCHIVE: archive,
				CACMIN_CURL_LOG: curlLog,
				CACMIN_SYSTEMCTL_LOG: systemctlLog,
				CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
				CACMIN_MOVE_COUNT_FILE: join(root, "move-count"),
				CACMIN_FAIL_MOVE_AT: String(failMoveAt),
			},
		});

		expect(result.status).toBe(91);
		expect(releaseSnapshot(installDir)).toEqual(before);
		expect(
			existsSync(join(systemctlStateDir, "cacmin-bot.service.active")),
		).toBe(true);
	});

	it("prepares code and both updater units without activating services", () => {
		const root = temporaryRoot();
		const sourceDir = createInstallFixture(root);
		const installDir = join(root, "opt", "cacmin-bot");
		const systemdDir = join(root, "etc", "systemd", "system");
		const envDir = join(root, "etc", "cacmin-bot");
		const libexecDir = join(root, "usr", "local", "libexec");
		const { binDir, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);
		for (const unit of [
			"cacmin-bot.service",
			"cacmin-bot-update.service",
			"cacmin-bot-update.timer",
			"unrelated.service",
		]) {
			writeFileSync(join(systemctlStateDir, `${unit}.active`), "");
			writeFileSync(join(systemctlStateDir, `${unit}.enabled`), "");
		}
		mkdirSync(envDir, { recursive: true });
		const envFile = join(envDir, "cacmin-bot.env");
		writeFileSync(envFile, "BOT_TOKEN=must-not-appear-in-output\n");
		chmodSync(envFile, 0o666);

		const result = spawnSync("bash", [join(REPO_ROOT, "install.sh")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:/usr/bin:/bin`,
				CACMIN_TEST_MODE: "1",
				CACMIN_HOSTNAME: "tgbot",
				CACMIN_EXPECTED_HOSTNAME: "tgbot",
				CACMIN_SOURCE_DIR: sourceDir,
				CACMIN_INSTALL_DIR: installDir,
				CACMIN_SYSTEMD_DIR: systemdDir,
				CACMIN_ENV_DIR: envDir,
				CACMIN_LIBEXEC_DIR: libexecDir,
				CACMIN_BUN_BIN: "/bin/true",
				CACMIN_SKIP_BUILD: "1",
				CACMIN_SKIP_IDENTITY_SETUP: "1",
				CACMIN_SKIP_CHOWN: "1",
				CACMIN_SYSTEMCTL_LOG: systemctlLog,
				CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
				CACMIN_ENV_OWNER: String(process.getuid?.() ?? 0),
				CACMIN_ENV_GROUP: String(process.getgid?.() ?? 0),
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(join(installDir, "dist", "bot.js"))).toBe(true);
		expect(existsSync(join(installDir, "data"))).toBe(true);
		expect(existsSync(join(installDir, "logs"))).toBe(true);
		expect(existsSync(join(systemdDir, "cacmin-bot.service"))).toBe(true);
		expect(existsSync(join(systemdDir, "cacmin-bot-update.service"))).toBe(
			true,
		);
		expect(existsSync(join(systemdDir, "cacmin-bot-update.timer"))).toBe(true);
		expect(existsSync(join(libexecDir, "cacmin-bot-auto-update"))).toBe(true);
		expect(statSync(join(installDir, "dist")).mode & 0o022).toBe(0);
		const systemctlCalls = readFileSync(systemctlLog, "utf8")
			.trim()
			.split("\n");
		expect(systemctlCalls).toContain("daemon-reload");
		expect(
			systemctlCalls.some((call) =>
				/(^| )(start|restart|enable)( |$)/.test(call),
			),
		).toBe(false);
		expect(result.stdout).toContain("Services are installed but inactive");
		expect(result.stderr).toContain("Insecure environment file metadata");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain(
			"must-not-appear-in-output",
		);
		for (const unit of [
			"cacmin-bot.service",
			"cacmin-bot-update.service",
			"cacmin-bot-update.timer",
		]) {
			expect(existsSync(join(systemctlStateDir, `${unit}.active`))).toBe(false);
		}
		expect(
			existsSync(join(systemctlStateDir, "cacmin-bot.service.enabled")),
		).toBe(false);
		expect(
			existsSync(join(systemctlStateDir, "cacmin-bot-update.timer.enabled")),
		).toBe(false);
		expect(
			existsSync(join(systemctlStateDir, "unrelated.service.active")),
		).toBe(true);
		expect(
			existsSync(join(systemctlStateDir, "unrelated.service.enabled")),
		).toBe(true);
		expect(
			systemctlCalls.some((call) => call.includes("unrelated.service")),
		).toBe(false);
		expect(basename(installDir)).toBe("cacmin-bot");
	});

	it("secures the environment file before activating the bot", () => {
		const root = temporaryRoot();
		const sourceDir = createInstallFixture(root);
		const installDir = join(root, "opt", "cacmin-bot");
		const envDir = join(root, "etc", "cacmin-bot");
		mkdirSync(envDir, { recursive: true });
		const envFile = join(envDir, "cacmin-bot.env");
		writeFileSync(envFile, "BOT_TOKEN=must-not-appear-in-output\n");
		chmodSync(envFile, 0o666);
		const { binDir, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);

		const result = spawnSync(
			"bash",
			[join(REPO_ROOT, "install.sh"), "--activate"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}:/usr/bin:/bin`,
					CACMIN_TEST_MODE: "1",
					CACMIN_HOSTNAME: "tgbot",
					CACMIN_EXPECTED_HOSTNAME: "tgbot",
					CACMIN_SOURCE_DIR: sourceDir,
					CACMIN_INSTALL_DIR: installDir,
					CACMIN_SYSTEMD_DIR: join(root, "systemd"),
					CACMIN_ENV_DIR: envDir,
					CACMIN_LIBEXEC_DIR: join(root, "libexec"),
					CACMIN_BUN_BIN: "/bin/true",
					CACMIN_SKIP_BUILD: "1",
					CACMIN_SKIP_IDENTITY_SETUP: "1",
					CACMIN_SKIP_CHOWN: "1",
					CACMIN_SYSTEMCTL_LOG: systemctlLog,
					CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
					CACMIN_ENV_OWNER: String(process.getuid?.() ?? 0),
					CACMIN_ENV_GROUP: String(process.getgid?.() ?? 0),
				},
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(statSync(envFile).mode & 0o777).toBe(0o640);
		expect(statSync(envFile).uid).toBe(process.getuid?.() ?? 0);
		expect(statSync(envFile).gid).toBe(process.getgid?.() ?? 0);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain(
			"must-not-appear-in-output",
		);
		expect(
			existsSync(join(systemctlStateDir, "cacmin-bot.service.active")),
		).toBe(true);
		expect(
			existsSync(join(systemctlStateDir, "cacmin-bot-update.timer.active")),
		).toBe(true);
	});

	it("leaves every CACMin unit safely inactive if timer activation fails", () => {
		const root = temporaryRoot();
		const sourceDir = createInstallFixture(root);
		const installDir = join(root, "opt", "cacmin-bot");
		const before = createOldInstall(installDir);
		const envDir = join(root, "etc", "cacmin-bot");
		mkdirSync(envDir, { recursive: true });
		const envFile = join(envDir, "cacmin-bot.env");
		writeFileSync(envFile, "BOT_TOKEN=not-printed\n");
		chmodSync(envFile, 0o640);
		const { binDir, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);

		const result = spawnSync(
			"bash",
			[join(REPO_ROOT, "install.sh"), "--activate"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}:/usr/bin:/bin`,
					CACMIN_TEST_MODE: "1",
					CACMIN_HOSTNAME: "tgbot",
					CACMIN_EXPECTED_HOSTNAME: "tgbot",
					CACMIN_SOURCE_DIR: sourceDir,
					CACMIN_INSTALL_DIR: installDir,
					CACMIN_SYSTEMD_DIR: join(root, "systemd"),
					CACMIN_ENV_DIR: envDir,
					CACMIN_LIBEXEC_DIR: join(root, "libexec"),
					CACMIN_BUN_BIN: "/bin/true",
					CACMIN_SKIP_BUILD: "1",
					CACMIN_SKIP_IDENTITY_SETUP: "1",
					CACMIN_SKIP_CHOWN: "1",
					CACMIN_SYSTEMCTL_LOG: systemctlLog,
					CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
					CACMIN_FAIL_ENABLE_UNIT: "cacmin-bot-update.timer",
					CACMIN_ENV_OWNER: String(process.getuid?.() ?? 0),
					CACMIN_ENV_GROUP: String(process.getgid?.() ?? 0),
				},
			},
		);

		expect(result.status).toBe(73);
		expect(releaseSnapshot(installDir)).toEqual(before);
		for (const unit of [
			"cacmin-bot.service",
			"cacmin-bot-update.service",
			"cacmin-bot-update.timer",
		]) {
			expect(existsSync(join(systemctlStateDir, `${unit}.active`))).toBe(false);
			expect(existsSync(join(systemctlStateDir, `${unit}.enabled`))).toBe(
				false,
			);
		}
	});

	it.each([
		{ label: "first", failMoveAt: 1 },
		{ label: "middle", failMoveAt: 3 },
	])("restores the prepared install after the $label destructive move fails", ({
		failMoveAt,
	}) => {
		const root = temporaryRoot();
		const sourceDir = createInstallFixture(root);
		const installDir = join(root, "opt", "cacmin-bot");
		const before = createOldInstall(installDir);
		const { binDir, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);
		installMoveFailure(binDir);
		for (const unit of [
			"cacmin-bot.service",
			"cacmin-bot-update.service",
			"cacmin-bot-update.timer",
		]) {
			writeFileSync(join(systemctlStateDir, `${unit}.active`), "");
			writeFileSync(join(systemctlStateDir, `${unit}.enabled`), "");
		}

		const result = spawnSync("bash", [join(REPO_ROOT, "install.sh")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:/usr/bin:/bin`,
				CACMIN_TEST_MODE: "1",
				CACMIN_HOSTNAME: "tgbot",
				CACMIN_EXPECTED_HOSTNAME: "tgbot",
				CACMIN_SOURCE_DIR: sourceDir,
				CACMIN_INSTALL_DIR: installDir,
				CACMIN_SYSTEMD_DIR: join(root, "systemd"),
				CACMIN_ENV_DIR: join(root, "env"),
				CACMIN_LIBEXEC_DIR: join(root, "libexec"),
				CACMIN_BUN_BIN: "/bin/true",
				CACMIN_SKIP_BUILD: "1",
				CACMIN_SKIP_IDENTITY_SETUP: "1",
				CACMIN_SKIP_CHOWN: "1",
				CACMIN_SYSTEMCTL_LOG: systemctlLog,
				CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
				CACMIN_MOVE_COUNT_FILE: join(root, "move-count"),
				CACMIN_FAIL_MOVE_AT: String(failMoveAt),
				CACMIN_ENV_OWNER: String(process.getuid?.() ?? 0),
				CACMIN_ENV_GROUP: String(process.getgid?.() ?? 0),
			},
		});

		expect(result.status).toBe(91);
		expect(releaseSnapshot(installDir)).toEqual(before);
		for (const unit of [
			"cacmin-bot.service",
			"cacmin-bot-update.service",
			"cacmin-bot-update.timer",
		]) {
			expect(existsSync(join(systemctlStateDir, `${unit}.active`))).toBe(false);
		}
	});

	it("refuses to claim a waiting state when the update timer remains enabled", () => {
		const root = temporaryRoot();
		const sourceDir = createInstallFixture(root);
		const installDir = join(root, "opt", "cacmin-bot");
		const { binDir, systemctlLog, systemctlStateDir } =
			createFakeCommands(root);
		writeFileSync(
			join(systemctlStateDir, "cacmin-bot-update.timer.enabled"),
			"",
		);

		const result = spawnSync("bash", [join(REPO_ROOT, "install.sh")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:/usr/bin:/bin`,
				CACMIN_TEST_MODE: "1",
				CACMIN_HOSTNAME: "tgbot",
				CACMIN_EXPECTED_HOSTNAME: "tgbot",
				CACMIN_SOURCE_DIR: sourceDir,
				CACMIN_INSTALL_DIR: installDir,
				CACMIN_SYSTEMD_DIR: join(root, "systemd"),
				CACMIN_ENV_DIR: join(root, "env"),
				CACMIN_LIBEXEC_DIR: join(root, "libexec"),
				CACMIN_BUN_BIN: "/bin/true",
				CACMIN_SKIP_BUILD: "1",
				CACMIN_SKIP_IDENTITY_SETUP: "1",
				CACMIN_SKIP_CHOWN: "1",
				CACMIN_SYSTEMCTL_LOG: systemctlLog,
				CACMIN_SYSTEMCTL_STATE_DIR: systemctlStateDir,
				CACMIN_DISABLE_LEAVES_ENABLED: "1",
				CACMIN_ENV_OWNER: String(process.getuid?.() ?? 0),
				CACMIN_ENV_GROUP: String(process.getgid?.() ?? 0),
			},
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("cacmin-bot-update.timer remains enabled");
	});

	it("accepts safe package-manager symlinks in a release archive", () => {
		const root = temporaryRoot();
		const releaseTree = createInstallFixture(join(root, "release"));
		mkdirSync(join(releaseTree, "node_modules", ".bin"), { recursive: true });
		symlinkSync(
			"../fixture/index.js",
			join(releaseTree, "node_modules", ".bin", "fixture"),
		);
		const sourceDir = join(root, "download");
		mkdirSync(sourceDir, { recursive: true });
		const archive = join(sourceDir, "cacmin-bot-dist.tar.gz");
		const tarResult = spawnSync(
			"tar",
			[
				"-czf",
				archive,
				"-C",
				releaseTree,
				"dist",
				"node_modules",
				"package.json",
				"bun.lock",
				"cacmin-bot.service",
				"cacmin-bot-update.service",
				"cacmin-bot-update.timer",
				"auto-update.sh",
			],
			{ encoding: "utf8" },
		);
		expect(tarResult.status, tarResult.stderr).toBe(0);

		const installDir = join(root, "opt", "cacmin-bot");
		const { binDir, systemctlLog } = createFakeCommands(root);
		const result = spawnSync("bash", [join(REPO_ROOT, "install.sh")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:/usr/bin:/bin`,
				CACMIN_TEST_MODE: "1",
				CACMIN_HOSTNAME: "tgbot",
				CACMIN_EXPECTED_HOSTNAME: "tgbot",
				CACMIN_SOURCE_DIR: sourceDir,
				CACMIN_INSTALL_DIR: installDir,
				CACMIN_SYSTEMD_DIR: join(root, "systemd"),
				CACMIN_ENV_DIR: join(root, "env"),
				CACMIN_LIBEXEC_DIR: join(root, "libexec"),
				CACMIN_BUN_BIN: "/bin/true",
				CACMIN_SKIP_IDENTITY_SETUP: "1",
				CACMIN_SKIP_CHOWN: "1",
				CACMIN_SYSTEMCTL_LOG: systemctlLog,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(
			statSync(join(installDir, "node_modules", ".bin", "fixture")).isFile(),
		).toBe(true);
	});

	it("builds a clean source checkout before preparing production dependencies", () => {
		const root = temporaryRoot();
		const sourceDir = createInstallFixture(root);
		rmSync(join(sourceDir, "dist"), { recursive: true });
		rmSync(join(sourceDir, "node_modules"), { recursive: true });
		const { binDir, systemctlLog } = createFakeCommands(root);
		const bunLog = join(root, "bun.log");
		const fakeBun = join(binDir, "bun");
		writeExecutable(
			fakeBun,
			`#!/bin/sh
printf '%s|%s\n' "$PWD" "$*" >> "$CACMIN_BUN_LOG"
if [ "$1 $2" = "run build" ]; then
	mkdir -p dist
	printf '%s\n' "console.log('built');" > dist/bot.js
elif [ "$1" = "install" ]; then
	mkdir -p node_modules/fixture
	: > node_modules/fixture/index.js
fi
`,
		);
		const installDir = join(root, "opt", "cacmin-bot");

		const result = spawnSync("bash", [join(REPO_ROOT, "install.sh")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:/usr/bin:/bin`,
				CACMIN_TEST_MODE: "1",
				CACMIN_HOSTNAME: "tgbot",
				CACMIN_EXPECTED_HOSTNAME: "tgbot",
				CACMIN_SOURCE_DIR: sourceDir,
				CACMIN_INSTALL_DIR: installDir,
				CACMIN_SYSTEMD_DIR: join(root, "systemd"),
				CACMIN_ENV_DIR: join(root, "env"),
				CACMIN_LIBEXEC_DIR: join(root, "libexec"),
				CACMIN_BUN_BIN: fakeBun,
				CACMIN_SKIP_IDENTITY_SETUP: "1",
				CACMIN_SKIP_CHOWN: "1",
				CACMIN_SYSTEMCTL_LOG: systemctlLog,
				CACMIN_BUN_LOG: bunLog,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(installDir, "dist", "bot.js"), "utf8")).toContain(
			"built",
		);
		const bunCalls = readFileSync(bunLog, "utf8");
		expect(bunCalls).toContain("install --frozen-lockfile");
		expect(bunCalls).toContain("run build");
		expect(bunCalls).toContain("install --production --frozen-lockfile");
	});
});
