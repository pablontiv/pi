import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createPionManifest,
	createReleaseMetadata,
	deriveUpstreamVersion,
	EXPECTED_PUBLIC_PACKAGES,
	renderReleaseNotes,
	validatePackageExports,
	validatePionVersion,
	validateReleaseAssets,
	validateReleaseSnapshot,
	validateUpstreamTag,
} from "./create-pion-release.mjs";

const UPSTREAM_VERSION = "1.2.3";
const PION_VERSION = "1.2.3-pion.1";
const DATE = "2026-10-04";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pion-release-test-"));
	const lock = { packages: {} };
	for (const [directory, packageName] of Object.entries(EXPECTED_PUBLIC_PACKAGES)) {
		const shortName = directory.slice("packages/".length);
		mkdirSync(join(root, directory), { recursive: true });
		writeFileSync(join(root, directory, "package.json"), JSON.stringify({ name: packageName, version: UPSTREAM_VERSION }));
		lock.packages[directory] = { name: packageName, version: UPSTREAM_VERSION };
		if (shortName !== "chord") {
			const released = shortName === "coding-agent" ? "\n### Added\n\n- A release feature.\n" : "\n- Released.\n";
			writeFileSync(join(root, directory, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${UPSTREAM_VERSION}] - ${DATE}\n${released}\n## [1.2.2] - 2026-10-03\n`);
		}
	}
	writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
	return root;
}

function withFixture(run) {
	const root = fixture();
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function replace(root, path, from, to) {
	const fullPath = join(root, path);
	writeFileSync(fullPath, readFileSync(fullPath, "utf8").replace(from, to));
}

test("creates a registry-free Pion manifest with separate Pion and upstream versions", () => {
	const source = {
		name: "@earendil-works/pi-coding-agent",
		version: "1.0.4",
		bin: { pi: "dist/bundle/cli.js" },
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./client": { source: "./src/client/index.ts" },
			"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
			"./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
		},
		repository: { type: "git", url: "git+https://github.com/earendil-works/pi.git" },
		dependencies: { "@earendil-works/pi-ai": "^1.0.4" },
	};
	const result = createPionManifest(source, "1.0.4-pion.1", "1.0.4");
	assert.equal(result.name, "@pablontiv/pion");
	assert.equal(result.version, "1.0.4-pion.1");
	assert.equal(result.private, true);
	assert.deepEqual(result.bin, { pion: "dist/bundle/cli.js" });
	assert.deepEqual(result.exports, {
		".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
		"./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
	});
	assert.equal(result.repository.url, "git+https://github.com/pablontiv/pi.git");
	assert.equal(result.dependencies["@earendil-works/pi-ai"], "^1.0.4");
	assert.equal(createPionManifest(source, "1.0.4").version, "1.0.4");
	assert.equal(source.name, "@earendil-works/pi-coding-agent");
	assert.ok("./client" in source.exports);
});

test("rejects every packaged export target that points to a missing file", () => {
	const root = mkdtempSync(join(tmpdir(), "pion-package-test-"));
	try {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist/index.js"), "export {};\n");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				exports: {
					".": { import: "./dist/index.js" },
					"./client": { source: "./src/client/index.ts" },
					"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
				},
			}),
		);
		assert.throws(
			() => validatePackageExports(root),
			/\.\/src\/client\/index\.ts.*\.\/src\/experimental\/plugin\.ts/iu,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("accepts canonical and numbered Pion versions only", () => {
	for (const version of ["1.0.4", "1.0.4-pion.1", "1.0.4-pion.2", "1.0.4-pion.42"]) {
		assert.equal(validatePionVersion(version), version);
	}
	for (const version of [
		"v1.0.4",
		"1.0",
		"1.0.4-pion.0",
		"1.0.4-pion.01",
		"1.0.4-rc.1",
		"1.0.4+build",
		"1.0.4-pion.1+build",
		"01.2.3x",
	]) {
		assert.throws(() => validatePionVersion(version), /Invalid Pion version/u);
	}
	assert.equal(deriveUpstreamVersion("1.0.4"), "1.0.4");
	assert.equal(deriveUpstreamVersion("1.0.4-pion.1"), "1.0.4");
	assert.equal(validateUpstreamTag("v1.0.4", "1.0.4"), "v1.0.4");
	assert.throws(() => validateUpstreamTag("pion-v1.0.4-pion.1", "1.0.4"), /Invalid upstream tag/u);
	assert.throws(() => createPionManifest({ version: "1.0.3" }, "1.0.4-pion.1", "1.0.4"), /must match/u);
});

test("validates the complete lockstep public workspace and package-lock set", () => withFixture((root) => {
	const result = validateReleaseSnapshot(root, UPSTREAM_VERSION);
	assert.equal(result.packages.length, 13);
	assert.equal(result.releaseDate, DATE);
	replace(root, "packages/ai/package.json", UPSTREAM_VERSION, "1.2.2");
	assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /package\.json has version 1\.2\.2/u);
}));

test("rejects missing and extra public packages", () => {
	withFixture((root) => {
		rmSync(join(root, "packages/agent"), { recursive: true });
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /missing packages\/agent/u);
	});
	withFixture((root) => {
		mkdirSync(join(root, "packages/extra"));
		writeFileSync(
			join(root, "packages/extra/package.json"),
			JSON.stringify({ name: "@earendil-works/pi-extra", version: UPSTREAM_VERSION }),
		);
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /unexpected packages\/extra/u);
	});
});

test("rejects wrong package names and path substitutions", () => {
	withFixture((root) => {
		replace(root, "packages/ai/package.json", "@earendil-works/pi-ai", "@earendil-works/pi-substitute");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /packages\/ai has name .* expected @earendil-works\/pi-ai/u);
	});
	withFixture((root) => {
		replace(root, "packages/env/package.json", "@earendil-works/pi-env", "@earendil-works/pi-substitute");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /packages\/env has name .* expected @earendil-works\/pi-env/u);
	});
	withFixture((root) => {
		rmSync(join(root, "packages/agent"), { recursive: true });
		mkdirSync(join(root, "packages/agent-substitute"));
		writeFileSync(
			join(root, "packages/agent-substitute/package.json"),
			JSON.stringify({ name: "@earendil-works/pi-agent-core", version: UPSTREAM_VERSION }),
		);
		assert.throws(
			() => validateReleaseSnapshot(root, UPSTREAM_VERSION),
			/missing packages\/agent .* unexpected packages\/agent-substitute/u,
		);
	});
});

test("rejects package-lock workspace name and version mismatches", () => {
	withFixture((root) => {
		replace(root, "package-lock.json", "@earendil-works/pi-agent-core", "@earendil-works/pi-wrong");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /package-lock\.json workspace packages\/agent has name/u);
	});
	withFixture((root) => {
		replace(root, "package-lock.json", `"version":"${UPSTREAM_VERSION}"`, '"version":"1.2.2"');
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /package-lock\.json workspace .* has version 1\.2\.2/u);
	});
});

test("rejects missing changelogs and missing or duplicate Unreleased headings", () => {
	withFixture((root) => {
		rmSync(join(root, "packages/agent/CHANGELOG.md"));
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /Missing changelog/u);
	});
	withFixture((root) => {
		replace(root, "packages/agent/CHANGELOG.md", "## [Unreleased]\n", "");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /exactly one Unreleased/u);
	});
	withFixture((root) => {
		replace(root, "packages/agent/CHANGELOG.md", "## [Unreleased]\n", "## [Unreleased]\n\n## [Unreleased]\n");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /exactly one Unreleased/u);
	});
});

test("rejects stale releases and mismatched changelog dates", () => {
	withFixture((root) => {
		replace(root, "packages/agent/CHANGELOG.md", `[${UPSTREAM_VERSION}]`, "[1.2.2]");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /first release after Unreleased/u);
	});
	withFixture((root) => {
		replace(root, "packages/ai/CHANGELOG.md", DATE, "2026-10-05");
		assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /release date .* does not match/u);
	});
});

test("rejects duplicate target-version headings", () => withFixture((root) => {
	const path = "packages/agent/CHANGELOG.md";
	writeFileSync(join(root, path), `${readFileSync(join(root, path), "utf8")}\n## [${UPSTREAM_VERSION}] - ${DATE}\n\n- Duplicate.\n`);
	assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /exactly one \[1\.2\.3\] release heading/u);
}));

test("rejects impossible changelog calendar dates", () => withFixture((root) => {
	for (const directory of Object.keys(EXPECTED_PUBLIC_PACKAGES).filter((name) => name !== "packages/chord")) {
		replace(root, `${directory}/CHANGELOG.md`, DATE, "2026-02-30");
	}
	assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /not a valid calendar date/u);
}));

test("rejects an empty coding-agent release section", () => withFixture((root) => {
	const path = "packages/coding-agent/CHANGELOG.md";
	replace(root, path, "\n### Added\n\n- A release feature.\n", "\n");
	assert.throws(() => validateReleaseSnapshot(root, UPSTREAM_VERSION), /release section must be nonempty/u);
}));

test("discloses nonempty Unreleased sections and commit subjects", () => withFixture((root) => {
	replace(root, "packages/ai/CHANGELOG.md", "## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- Snapshot fix.\n");
	const snapshot = validateReleaseSnapshot(root, UPSTREAM_VERSION);
	const notes = renderReleaseNotes({
		pionVersion: PION_VERSION,
		upstreamVersion: UPSTREAM_VERSION,
		upstreamTag: `v${UPSTREAM_VERSION}`,
		artifact: `pablontiv-pion-${PION_VERSION}.tgz`,
		snapshot,
		commitSubjects: ["downstream fix"],
	});
	assert.match(notes, /Source-snapshot changes/u);
	assert.match(notes, /Snapshot fix/u);
	assert.match(notes, /Commit subjects for v1\.2\.3\.\.HEAD/u);
	assert.match(notes, /downstream fix/u);
}));

test("validates exact downstream metadata, payload names, and checksum coverage", () => {
	const out = mkdtempSync(join(tmpdir(), "pion-assets-test-"));
	const sourceCommit = "a".repeat(40);
	const upstreamTag = `v${UPSTREAM_VERSION}`;
	const artifact = `pablontiv-pion-${PION_VERSION}.tgz`;
	const release = { pionVersion: PION_VERSION, upstreamVersion: UPSTREAM_VERSION, sourceCommit, upstreamTag };
	try {
		writeFileSync(join(out, artifact), "tarball");
		writeFileSync(join(out, "RELEASE_NOTES.md"), "notes\n");
		const expectedMetadata = createReleaseMetadata(release);
		assert.equal(expectedMetadata.tag, `pion-v${PION_VERSION}`);
		assert.equal(expectedMetadata.upstreamTag, upstreamTag);
		assert.equal(expectedMetadata.upstreamVersion, UPSTREAM_VERSION);
		assert.equal(expectedMetadata.package, `@pablontiv/pion@${PION_VERSION}`);
		assert.equal(expectedMetadata.artifact, artifact);
		writeFileSync(join(out, "PION_RELEASE.json"), `${JSON.stringify(expectedMetadata, null, 2)}\n`);
		const names = [artifact, "PION_RELEASE.json", "RELEASE_NOTES.md"];
		writeFileSync(join(out, "SHA256SUMS"), `${names.map((name) => `${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`).join("\n")}\n`);
		assert.equal(validateReleaseAssets({ out, ...release }).metadata.upstreamTag, upstreamTag);
		writeFileSync(join(out, "extra.txt"), "unexpected");
		assert.throws(() => validateReleaseAssets({ out, ...release }), /Unexpected release payload files/u);
		rmSync(join(out, "extra.txt"));

		const metadataPath = join(out, "PION_RELEASE.json");
		const metadata = readFileSync(metadataPath, "utf8");
		writeFileSync(metadataPath, metadata.replace("@pablontiv/pion", "@pablontiv/wrong"));
		assert.throws(() => validateReleaseAssets({ out, ...release }), /exact expected metadata/u);
		writeFileSync(metadataPath, metadata);
		writeFileSync(join(out, "SHA256SUMS"), "not exact\n");
		assert.throws(() => validateReleaseAssets({ out, ...release }), /does not exactly cover/u);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
