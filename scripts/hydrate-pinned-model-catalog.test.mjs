import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { hydratePinnedModelCatalog, MODEL_CATALOG_SNAPSHOT } from "./hydrate-pinned-model-catalog.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
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

let root;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-pinned-hydration-test-"));
	mkdirSync(join(root, "nix"));
	mkdirSync(join(root, "packages/ai/src/providers"), { recursive: true });
	writeFileSync(
		join(root, "packages/ai/src/models.generated.ts"),
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(join(root, "packages/ai/src/providers/test-provider.models.ts"), "");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writePin(revision) {
	writeFileSync(join(root, "nix/model-catalog.json"), `${JSON.stringify({ revision })}\n`);
}

function writeSnapshot(body) {
	writeFileSync(join(root, "nix", MODEL_CATALOG_SNAPSHOT), body);
}

test("rejects a missing snapshot", async () => {
	writePin(revisionOf(catalog()));
	await assert.rejects(hydratePinnedModelCatalog(root), /ENOENT/);
});

test("rejects an invalid pinned revision", async () => {
	writePin("latest");
	writeSnapshot(catalog());
	await assert.rejects(hydratePinnedModelCatalog(root), /Invalid pin/);
});

test("rejects snapshot bytes with the wrong SHA-256 without mutation", async () => {
	writePin(revisionOf(catalog()));
	writeSnapshot("wrong");
	await assert.rejects(hydratePinnedModelCatalog(root), /does not match pin/);
	assert.equal(existsSync(join(root, "packages/ai/src/providers/data")), false);
});

test("rejects invalid JSON after verifying its SHA-256 without mutation", async () => {
	const body = "{";
	writePin(revisionOf(body));
	writeSnapshot(body);
	await assert.rejects(hydratePinnedModelCatalog(root), SyntaxError);
	assert.equal(existsSync(join(root, "packages/ai/src/providers/data")), false);
});

test("hydrates the verified local snapshot", async () => {
	const body = catalog();
	const revision = revisionOf(body);
	writePin(revision);
	writeSnapshot(body);
	assert.equal(await hydratePinnedModelCatalog(root), revision);
	assert.equal(
		readFileSync(join(root, "packages/ai/src/providers/data/test-provider.json"), "utf8"),
		`${JSON.stringify({ "openai-completions": { "chat:model-a": model } })}\n`,
	);
	assert.ok(readFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), "utf8").length > 0);
});

test("rejects an invalid catalog without mutation", async () => {
	const body = catalog({ "other-provider": [model] });
	writePin(revisionOf(body));
	writeSnapshot(body);
	await assert.rejects(hydratePinnedModelCatalog(root), /missing provider/);
	assert.equal(existsSync(join(root, "packages/ai/src/providers/data")), false);
});

test("release flows use the local snapshot and offline builds", () => {
	for (const relativePath of [
		"scripts/hydrate-pinned-model-catalog.mjs",
		"scripts/update-model-catalog-pin.mjs",
		"nix/package.nix",
	]) {
		const localCatalogFlow = readFileSync(join(repositoryRoot, relativePath), "utf8");
		assert.doesNotMatch(localCatalogFlow, /\bfetch(?:url)?\b|pi\.dev\/api\/models/);
	}

	for (const relativePath of [
		".github/workflows/release-pion.yml",
		".github/workflows/build-binaries.yml",
		"scripts/local-release.mjs",
		"scripts/release.mjs",
	]) {
		const releaseFlow = readFileSync(join(repositoryRoot, relativePath), "utf8");
		assert.doesNotMatch(releaseFlow, /pi\.dev\/api\/models/);
		assert.doesNotMatch(releaseFlow, /npm run generate:models/);
		assert.doesNotMatch(releaseFlow, /npm run hydrate:model-data(?:\s|$)/m);
		assert.doesNotMatch(releaseFlow, /npm run build(?:\s|$)/m);
	}

	const workflow = readFileSync(join(repositoryRoot, ".github/workflows/release-pion.yml"), "utf8");
	assert.match(workflow, /^\s*run: npm run hydrate:model-data:pinned\s*$/m);
	assert.match(workflow, /^\s*run: npm run build:offline\s*$/m);

	const nixWorkflow = readFileSync(join(repositoryRoot, ".github/workflows/nix.yml"), "utf8");
	assert.match(nixWorkflow, /^\s*npm run hydrate:model-data:pinned\s*$/m);
	assert.doesNotMatch(nixWorkflow, /update-model-catalog-pin\.mjs\s+\S+/);

	const nixPackage = readFileSync(join(repositoryRoot, "nix/package.nix"), "utf8");
	assert.match(nixPackage, /^\s*npm run hydrate:model-data:pinned\s*$/m);
	assert.doesNotMatch(nixPackage, /hydrate-model-catalog\.ts/);

	const localRelease = readFileSync(join(repositoryRoot, "scripts/local-release.mjs"), "utf8");
	assert.match(localRelease, /\["run", "hydrate:model-data:pinned"\]/);
	assert.match(localRelease, /offlineModelData: true/);
});
