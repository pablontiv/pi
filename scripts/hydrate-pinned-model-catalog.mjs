#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalogData } from "../packages/ai/scripts/hydrate-model-catalog.ts";

const REVISION_RE = /^sha256-[0-9a-f]{64}$/;
export const MODEL_CATALOG_SNAPSHOT = "model-catalog.snapshot.json";

function sha256(bytes) {
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function hydratePinnedModelCatalog(root) {
	const pinPath = join(root, "nix/model-catalog.json");
	const snapshotPath = join(root, "nix", MODEL_CATALOG_SNAPSHOT);
	const revision = JSON.parse(readFileSync(pinPath, "utf8")).revision;
	if (typeof revision !== "string" || !REVISION_RE.test(revision)) throw new Error(`Invalid pin in ${pinPath}`);

	const bytes = readFileSync(snapshotPath);
	if (sha256(bytes) !== revision) throw new Error(`Model catalog snapshot does not match pin ${revision}`);

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
