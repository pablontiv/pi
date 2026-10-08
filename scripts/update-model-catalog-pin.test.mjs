import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { MODEL_CATALOG_SNAPSHOT } from "./hydrate-pinned-model-catalog.mjs";
import { MODEL_CATALOG_INPUT, updateModelCatalogPin } from "./update-model-catalog-pin.mjs";

const model = {
	type: "chat",
	id: "model-a",
	name: "Model A",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const catalog = (value = { "test-provider": [model] }) => `${JSON.stringify(value)}\n`;
const revisionOf = (body) => `sha256-${createHash("sha256").update(body).digest("hex")}`;
const pinFile = (revision) => `${JSON.stringify({ revision }, null, 2)}\n`;

const oldBody = catalog({ "test-provider": [{ ...model, id: "old-model" }] });
const oldRevision = revisionOf(oldBody);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const updaterPath = fileURLToPath(new URL("./update-model-catalog-pin.mjs", import.meta.url));
let root;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-catalog-pin-"));
	mkdirSync(join(root, "packages/ai/src/providers"), { recursive: true });
	mkdirSync(join(root, "nix"));
	writeFileSync(
		join(root, "packages/ai/src/models.generated.ts"),
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(join(root, "packages/ai/src/providers/test-provider.models.ts"), "");
	writeFileSync(join(root, "nix", MODEL_CATALOG_SNAPSHOT), oldBody);
	writeFileSync(join(root, "nix/model-catalog.json"), pinFile(oldRevision));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function readTrackedCatalog() {
	return {
		snapshot: readFileSync(join(root, "nix", MODEL_CATALOG_SNAPSHOT), "utf8"),
		pin: readFileSync(join(root, "nix/model-catalog.json"), "utf8"),
	};
}

test("updates the snapshot and pin from catalog bytes", async () => {
	const body = catalog();
	const revision = revisionOf(body);
	assert.deepEqual(await updateModelCatalogPin(root, Buffer.from(body)), { revision, updated: true });
	assert.deepEqual(readTrackedCatalog(), { snapshot: body, pin: pinFile(revision) });
});

test("keeps a coherent snapshot and pin when the local catalog is unchanged", async () => {
	assert.deepEqual(await updateModelCatalogPin(root, Buffer.from(oldBody)), { revision: oldRevision, updated: false });
	assert.deepEqual(readTrackedCatalog(), { snapshot: oldBody, pin: pinFile(oldRevision) });
});

test("does not update either tracked file when local JSON is invalid", async () => {
	const before = readTrackedCatalog();
	await assert.rejects(updateModelCatalogPin(root, Buffer.from("{")), SyntaxError);
	assert.deepEqual(readTrackedCatalog(), before);
});

test("does not update either tracked file when the local catalog is invalid", async () => {
	const before = readTrackedCatalog();
	await assert.rejects(updateModelCatalogPin(root, Buffer.from(catalog({ "other-provider": [model] }))), /missing provider/);
	assert.deepEqual(readTrackedCatalog(), before);
});

test("requires local catalog bytes", async () => {
	await assert.rejects(updateModelCatalogPin(root), /Local catalog bytes are required/);
});

test("uses one fixed ignored maintenance input", () => {
	assert.equal(MODEL_CATALOG_INPUT, ".artifacts/model-catalog/models.all.json");
	const result = spawnSync(process.execPath, [updaterPath, join(root, "input.json")], {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Usage: node scripts\/update-model-catalog-pin\.mjs/);
});

test("does not pass process.argv to a file read", () => {
	for (const relativePath of [
		"scripts/update-model-catalog-pin.mjs",
		"packages/ai/scripts/hydrate-model-catalog.ts",
	]) {
		const source = readFileSync(join(repositoryRoot, relativePath), "utf8");
		for (const readCall of source.matchAll(/readFileSync\(([^\n;]+)/g)) {
			assert.doesNotMatch(readCall[1], /process\.argv/);
		}
	}
	const hydrationSource = readFileSync(join(repositoryRoot, "packages/ai/scripts/hydrate-model-catalog.ts"), "utf8");
	assert.doesNotMatch(hydrationSource, /process\.argv/);
});
