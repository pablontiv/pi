import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { hydratePinnedModelCatalog } from "./hydrate-pinned-model-catalog.mjs";

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
let temporaryDirectory;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-pinned-hydration-test-"));
	temporaryDirectory = join(root, "tmp");
	mkdirSync(join(root, "nix"));
	mkdirSync(join(root, "packages/ai/src/providers"), { recursive: true });
	mkdirSync(temporaryDirectory);
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

function responseFor(body, status = 200) {
	return async () => new Response(body, { status });
}

test("rejects an invalid pinned revision before fetching", async () => {
	writePin("latest");
	let fetched = false;
	await assert.rejects(
		hydratePinnedModelCatalog(root, {
			fetchImpl: async () => {
				fetched = true;
				return new Response();
			},
			temporaryDirectory,
		}),
		/Invalid pin/,
	);
	assert.equal(fetched, false);
});

test("rejects a failed immutable revision response", async () => {
	const body = catalog();
	writePin(revisionOf(body));
	await assert.rejects(
		hydratePinnedModelCatalog(root, { fetchImpl: responseFor(null, 503), temporaryDirectory }),
		/HTTP 503/,
	);
});

test("rejects catalog bytes with the wrong SHA-256", async () => {
	writePin(revisionOf(catalog()));
	await assert.rejects(
		hydratePinnedModelCatalog(root, { fetchImpl: responseFor("wrong"), temporaryDirectory }),
		/does not match its content/,
	);
});

test("downloads only the pinned HTTPS revision and hydrates it", async () => {
	const body = catalog();
	const revision = revisionOf(body);
	writePin(revision);
	const requests = [];
	assert.equal(
		await hydratePinnedModelCatalog(root, {
			fetchImpl: async (url, options) => {
				requests.push([String(url), options]);
				return new Response(body);
			},
			temporaryDirectory,
		}),
		revision,
	);
	assert.deepEqual(requests, [
		[`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`, { redirect: "error" }],
	]);
	assert.equal(
		readFileSync(join(root, "packages/ai/src/providers/data/test-provider.json"), "utf8"),
		`${JSON.stringify({ "openai-completions": { "chat:model-a": model } })}\n`,
	);
	assert.ok(readFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), "utf8").length > 0);
	assert.deepEqual(readdirSync(temporaryDirectory), []);
});

test("cleans the temporary directory when hydration fails", async () => {
	const body = catalog({ "other-provider": [model] });
	writePin(revisionOf(body));
	await assert.rejects(
		hydratePinnedModelCatalog(root, { fetchImpl: responseFor(body), temporaryDirectory }),
		/missing provider/,
	);
	assert.deepEqual(readdirSync(temporaryDirectory), []);
});

test("release flows use pinned hydration and offline builds", () => {
	const workflow = readFileSync(join(repositoryRoot, ".github/workflows/release-pion.yml"), "utf8");
	assert.match(workflow, /^\s*run: npm run hydrate:model-data:pinned\s*$/m);
	assert.match(workflow, /^\s*run: npm run build:offline\s*$/m);
	assert.doesNotMatch(workflow, /^\s*run: npm run hydrate:model-data\s*$/m);
	assert.doesNotMatch(workflow, /^\s*run: npm run build\s*$/m);

	const localRelease = readFileSync(join(repositoryRoot, "scripts/local-release.mjs"), "utf8");
	assert.match(localRelease, /\["run", "hydrate:model-data:pinned"\]/);
	assert.doesNotMatch(localRelease, /\["run", "(?:generate:models|hydrate:model-data)"\]/);
	assert.match(localRelease, /offlineModelData: true/);
});
