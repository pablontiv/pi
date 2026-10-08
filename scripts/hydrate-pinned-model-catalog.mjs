#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalogData } from "../packages/ai/scripts/hydrate-model-catalog.ts";

const REVISION_RE = /^sha256-[0-9a-f]{64}$/;
const MODEL_TYPES = "types=chat,image,classifier";

export async function hydratePinnedModelCatalog(root, { fetchImpl = globalThis.fetch } = {}) {
	const pinPath = join(root, "nix/model-catalog.json");
	const revision = JSON.parse(readFileSync(pinPath, "utf8")).revision;
	if (typeof revision !== "string" || !REVISION_RE.test(revision)) throw new Error(`Invalid pin in ${pinPath}`);

	const url = new URL(`https://pi.dev/api/models/revisions/${revision}?${MODEL_TYPES}`);
	if (url.protocol !== "https:") throw new Error(`Model catalog URL must use HTTPS: ${url}`);
	const response = await fetchImpl(url, { redirect: "error" });
	if (!response.ok) throw new Error(`Catalog revision ${revision} is unavailable: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const actualRevision = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
	if (actualRevision !== revision) throw new Error(`Catalog revision ${revision} does not match its content`);

	/** @type {unknown} */
	const catalog = JSON.parse(bytes.toString("utf8"));
	hydrateModelCatalogData(join(root, "packages/ai"), catalog);
	return revision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 2) throw new Error("Usage: node scripts/hydrate-pinned-model-catalog.mjs");
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	console.log(`Hydrated model catalog ${await hydratePinnedModelCatalog(root)}`);
}
