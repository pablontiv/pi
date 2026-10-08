#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalogData } from "../packages/ai/scripts/hydrate-model-catalog.ts";
import { MODEL_CATALOG_SNAPSHOT } from "./hydrate-pinned-model-catalog.mjs";

function sha256(bytes) {
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameBytes(path, bytes) {
	return existsSync(path) && readFileSync(path).equals(bytes);
}

function replaceCatalogFiles(nixDir, snapshotBytes, pinBytes) {
	mkdirSync(nixDir, { recursive: true });
	const snapshotPath = join(nixDir, MODEL_CATALOG_SNAPSHOT);
	const pinPath = join(nixDir, "model-catalog.json");
	const stagingDir = mkdtempSync(join(nixDir, ".model-catalog-update-"));
	const stagedSnapshot = join(stagingDir, MODEL_CATALOG_SNAPSHOT);
	const stagedPin = join(stagingDir, "model-catalog.json");
	const oldSnapshot = join(stagingDir, "old-snapshot");
	const oldPin = join(stagingDir, "old-pin");
	const hadSnapshot = existsSync(snapshotPath);
	const hadPin = existsSync(pinPath);
	try {
		writeFileSync(stagedSnapshot, snapshotBytes);
		writeFileSync(stagedPin, pinBytes);
		if (hadSnapshot) writeFileSync(oldSnapshot, readFileSync(snapshotPath));
		if (hadPin) writeFileSync(oldPin, readFileSync(pinPath));
		try {
			renameSync(stagedSnapshot, snapshotPath);
			renameSync(stagedPin, pinPath);
		} catch (error) {
			if (hadSnapshot) renameSync(oldSnapshot, snapshotPath);
			else rmSync(snapshotPath, { force: true });
			if (hadPin) renameSync(oldPin, pinPath);
			else rmSync(pinPath, { force: true });
			throw error;
		}
	} finally {
		rmSync(stagingDir, { force: true, recursive: true });
	}
}

/** Validate a local typed catalog and update the tracked snapshot and pin. */
export async function updateModelCatalogPin(root, catalogPath) {
	if (typeof catalogPath !== "string" || catalogPath.length === 0) throw new Error("A local catalog file is required");
	const bytes = readFileSync(catalogPath);
	const revision = sha256(bytes);
	/** @type {unknown} */
	const catalog = JSON.parse(bytes.toString("utf8"));
	hydrateModelCatalogData(join(root, "packages/ai"), catalog, { validateOnly: true });

	const nixDir = join(root, "nix");
	const snapshotPath = join(nixDir, MODEL_CATALOG_SNAPSHOT);
	const pinPath = join(nixDir, "model-catalog.json");
	const pinBytes = Buffer.from(`${JSON.stringify({ revision }, null, 2)}\n`);
	const updated = !sameBytes(snapshotPath, bytes) || !sameBytes(pinPath, pinBytes);
	if (updated) replaceCatalogFiles(nixDir, bytes, pinBytes);
	return { revision, updated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (args.length !== 1) throw new Error("Usage: node scripts/update-model-catalog-pin.mjs <catalog-file>");
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const { revision, updated } = await updateModelCatalogPin(root, resolve(args[0]));
	console.log(`${updated ? "Updated" : "Kept"} model catalog ${revision}`);
}
