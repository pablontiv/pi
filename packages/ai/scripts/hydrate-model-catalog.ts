import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createModelDataManifest,
	groupProviderModelData,
	MODEL_DATA_MANIFEST_FILE,
	type ModelCatalogEntry,
	type ModelDataStructure,
	readModelDataProviderIds,
	validateModelDataDirectory,
} from "./model-data.ts";

type CatalogEntry = ModelCatalogEntry & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.id === "string" &&
		typeof value.api === "string" &&
		value.api.length > 0
	);
}

/**
 * Hydrate the checkout's provider data files from a published typed catalog
 * (`models.all.json`) without network access. With `validateOnly`, stage and
 * validate the data without replacing the checkout's current data.
 */
export function hydrateModelCatalogData(
	packageRoot: string,
	catalog: unknown,
	options: { validateOnly?: boolean } = {},
): void {
	if (!isRecord(catalog)) throw new Error("Model catalog must be an object");

	const files: Record<string, string> = {};
	const structure: ModelDataStructure = {};
	for (const provider of readModelDataProviderIds(packageRoot)) {
		const models = catalog[provider];
		if (models === undefined) throw new Error(`Model catalog is missing provider: ${provider}`);
		if (!Array.isArray(models) || models.length === 0) {
			throw new Error(`Model catalog has no typed model list for provider: ${provider}`);
		}
		const entries: CatalogEntry[] = [];
		for (const model of models) {
			if (!isCatalogEntry(model)) throw new Error(`Model catalog has an invalid entry for provider ${provider}`);
			entries.push(model);
		}
		const grouped = groupProviderModelData(provider, entries);
		structure[provider] = grouped.structure;
		files[`${provider}.json`] = `${JSON.stringify(grouped.groups)}\n`;
	}

	// Public catalogs have no generation timestamp. Use a fixed stamp so hydration
	// produces identical bytes for identical input, regardless of build time.
	const manifest = createModelDataManifest(structure, files, "1970-01-01T00:00:00.000Z");
	const providersDir = join(packageRoot, "src", "providers");
	const stagingRoot = mkdtempSync(join(providersDir, ".model-hydration-"));
	const stagedData = join(stagingRoot, "data");
	try {
		mkdirSync(stagedData);
		for (const [name, content] of Object.entries(files)) writeFileSync(join(stagedData, name), content);
		writeFileSync(join(stagedData, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		validateModelDataDirectory(structure, stagedData);
		if (options.validateOnly) return;
		const dataDir = join(providersDir, "data");
		rmSync(dataDir, { recursive: true, force: true });
		renameSync(stagedData, dataDir);
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}
