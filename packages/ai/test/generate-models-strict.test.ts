import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});

	it("uses the canonical Claude Sonnet 5.5 cache-read cost in the fallback catalog", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-fallback-"));
		temporaryRoots.push(fixtureRoot);
		const preloadPath = join(fixtureRoot, "mock-empty-catalogs.mjs");
		const outputPath = join(fixtureRoot, "catalog");
		writeFileSync(
			preloadPath,
			`globalThis.fetch = async (input) => {
` +
				`  const url = String(input);
` +
				`  if (url === "https://models.dev/api.json") return Response.json({});
` +
				`  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000 } } });
` +
				`  if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });
` +
				`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });
` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);
` +
				`};
`,
		);

		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputPath,
			],
			{
				cwd: packageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const anthropicModels = JSON.parse(
			readFileSync(join(outputPath, "providers", "anthropic.json"), "utf8"),
		) as Record<string, { cost: { cacheRead: number } }>;
		expect(anthropicModels["claude-sonnet-5-5"].cost.cacheRead).toBe(0.1);
	});
});
