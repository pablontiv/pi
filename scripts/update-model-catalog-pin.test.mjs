import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MODEL_CATALOG_SNAPSHOT } from "./hydrate-pinned-model-catalog.mjs";
import { updateModelCatalogPin } from "./update-model-catalog-pin.mjs";

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
let root;
let inputPath;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-catalog-pin-"));
	inputPath = join(root, "input.json");
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

test("updates the snapshot and pin from one local catalog", async () => {
	const body = catalog();
	const revision = revisionOf(body);
	writeFileSync(inputPath, body);
	assert.deepEqual(await updateModelCatalogPin(root, inputPath), { revision, updated: true });
	assert.deepEqual(readTrackedCatalog(), { snapshot: body, pin: pinFile(revision) });
});

test("keeps a coherent snapshot and pin when the local catalog is unchanged", async () => {
	writeFileSync(inputPath, oldBody);
	assert.deepEqual(await updateModelCatalogPin(root, inputPath), { revision: oldRevision, updated: false });
	assert.deepEqual(readTrackedCatalog(), { snapshot: oldBody, pin: pinFile(oldRevision) });
});

test("does not update either tracked file when local JSON is invalid", async () => {
	const before = readTrackedCatalog();
	writeFileSync(inputPath, "{");
	await assert.rejects(updateModelCatalogPin(root, inputPath), SyntaxError);
	assert.deepEqual(readTrackedCatalog(), before);
});

test("does not update either tracked file when the local catalog is invalid", async () => {
	const before = readTrackedCatalog();
	writeFileSync(inputPath, catalog({ "other-provider": [model] }));
	await assert.rejects(updateModelCatalogPin(root, inputPath), /missing provider/);
	assert.deepEqual(readTrackedCatalog(), before);
});

test("requires a local catalog file", async () => {
	await assert.rejects(updateModelCatalogPin(root), /local catalog file is required/);
});
