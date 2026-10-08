import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageManagerUrl = pathToFileURL(join(packageRoot, "src/package-manager-cli.ts")).href;
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function runSelfUpdate(packageName: string): {
	fetchCalls: string[];
	handled: boolean;
	exitCode: string | number | null;
	stderr: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-pion-update-guard-"));
	temporaryRoots.push(root);
	const installedPackageRoot = join(root, "installed-package");
	const agentDir = join(root, "agent");
	mkdirSync(installedPackageRoot);
	mkdirSync(agentDir);
	writeFileSync(
		join(installedPackageRoot, "package.json"),
		`${JSON.stringify({ name: packageName, version: "1.1.0", piConfig: { configDir: ".pi" } })}\n`,
	);

	const runnerPath = join(root, "run-self-update.mjs");
	writeFileSync(
		runnerPath,
		`const fetchCalls = [];
` +
			`globalThis.fetch = async (input) => {
` +
			`  fetchCalls.push(String(input));
` +
			`  return Response.json({ version: "1.1.0" });
` +
			`};
` +
			`const { handlePackageCommand } = await import(${JSON.stringify(packageManagerUrl)});
` +
			`const handled = await handlePackageCommand(["update", "--self"]);
` +
			`const exitCode = process.exitCode ?? null;
` +
			`process.exitCode = undefined;
` +
			`console.log("SELF_UPDATE_RESULT=" + JSON.stringify({ fetchCalls, handled, exitCode }));
`,
	);

	const result = spawnSync(process.execPath, [runnerPath], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "",
			PI_PACKAGE_DIR: installedPackageRoot,
			PI_SKIP_VERSION_CHECK: "",
		},
		timeout: 10_000,
	});
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	const resultLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("SELF_UPDATE_RESULT="));
	expect(resultLine).toBeDefined();
	const parsed = JSON.parse(resultLine!.slice("SELF_UPDATE_RESULT=".length)) as {
		fetchCalls: string[];
		handled: boolean;
		exitCode: string | number | null;
	};
	return { ...parsed, stderr: result.stderr };
}

describe("Pion self-update guard", () => {
	it("blocks the upstream update channel for the canonical Pion package", () => {
		const result = runSelfUpdate("@pablontiv/pion");

		expect(result.handled).toBe(true);
		expect(result.fetchCalls).toEqual([]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Downstream build 1.1.0 does not use the Pi upstream update channel.");
	});

	it("keeps the upstream update check for the canonical upstream package", () => {
		const result = runSelfUpdate("@earendil-works/pi-coding-agent");

		expect(result.handled).toBe(true);
		expect(result.fetchCalls).toEqual(["https://pi.dev/api/latest-version"]);
		expect(result.exitCode).toBeNull();
		expect(result.stderr).toBe("");
	});
});
