import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createPionManifest,
	createReleaseMetadata,
	EXPECTED_PUBLIC_PACKAGES,
	renderReleaseNotes,
	validatePionVersion,
	validateReleaseAssets,
	validateReleaseSnapshot,
	validateUpstreamTag,
} from "./create-pion-release.mjs";

const VERSION = "1.2.3";
const DATE = "2026-10-04";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pion-release-test-"));
	const lock = { packages: {} };
	for (const [directory, packageName] of Object.entries(EXPECTED_PUBLIC_PACKAGES)) {
		const shortName = directory.slice("packages/".length);
		mkdirSync(join(root, directory), { recursive: true });
		writeFileSync(join(root, directory, "package.json"), JSON.stringify({ name: packageName, version: VERSION }));
		lock.packages[directory] = { name: packageName, version: VERSION };
		if (shortName !== "chord") {
			const released = shortName === "coding-agent" ? "\n### Added\n\n- A release feature.\n" : "\n- Released.\n";
			writeFileSync(join(root, directory, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${VERSION}] - ${DATE}\n${released}\n## [1.2.2] - 2026-10-03\n`);
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

test("creates a registry-free Pion manifest with the upstream version", () => {
	const source = {
		name: "@earendil-works/pi-coding-agent",
		version: "1.0.2",
		bin: { pi: "dist/bundle/cli.js" },
		repository: { type: "git", url: "git+https://github.com/earendil-works/pi.git" },
	};
	const result = createPionManifest(source, "1.0.2");
	assert.equal(result.name, "@pablontiv/pion");
	assert.equal(result.version, "1.0.2");
	assert.equal(result.private, true);
	assert.deepEqual(result.bin, { pion: "dist/bundle/cli.js" });
	assert.equal(result.repository.url, "git+https://github.com/pablontiv/pi.git");
	assert.equal(source.name, "@earendil-works/pi-coding-agent");
});

test("accepts only canonical versions and matching canonical upstream tags", () => {
	assert.equal(validatePionVersion("1.0.2"), "1.0.2");
	for (const version of ["v1.0.2", "1.0", "1.0.2-rc.1", "1.0.2+build", "01.2.3x"]) {
		assert.throws(() => validatePionVersion(version), /Invalid Pion version/u);
	}
	assert.equal(validateUpstreamTag("v1.0.2", "1.0.2"), "v1.0.2");
	assert.throws(() => validateUpstreamTag("pion-v1.0.2", "1.0.2"), /Invalid upstream tag/u);
	assert.throws(() => createPionManifest({ version: "1.0.1" }, "1.0.2"), /must match/u);
});

test("validates the complete lockstep public workspace and package-lock set", () => withFixture((root) => {
	const result = validateReleaseSnapshot(root, VERSION);
	assert.equal(result.packages.length, 13);
	assert.equal(result.releaseDate, DATE);
	replace(root, "packages/ai/package.json", VERSION, "1.2.2");
	assert.throws(() => validateReleaseSnapshot(root, VERSION), /package\.json has version 1\.2\.2/u);
}));

test("rejects missing and extra public packages", () => {
	withFixture((root) => {
		rmSync(join(root, "packages/agent"), { recursive: true });
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /missing packages\/agent/u);
	});
	withFixture((root) => {
		mkdirSync(join(root, "packages/extra"));
		writeFileSync(
			join(root, "packages/extra/package.json"),
			JSON.stringify({ name: "@earendil-works/pi-extra", version: VERSION }),
		);
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /unexpected packages\/extra/u);
	});
});

test("rejects wrong package names and path substitutions", () => {
	withFixture((root) => {
		replace(root, "packages/ai/package.json", "@earendil-works/pi-ai", "@earendil-works/pi-substitute");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /packages\/ai has name .* expected @earendil-works\/pi-ai/u);
	});
	withFixture((root) => {
		replace(root, "packages/env/package.json", "@earendil-works/pi-env", "@earendil-works/pi-substitute");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /packages\/env has name .* expected @earendil-works\/pi-env/u);
	});
	withFixture((root) => {
		rmSync(join(root, "packages/agent"), { recursive: true });
		mkdirSync(join(root, "packages/agent-substitute"));
		writeFileSync(
			join(root, "packages/agent-substitute/package.json"),
			JSON.stringify({ name: "@earendil-works/pi-agent-core", version: VERSION }),
		);
		assert.throws(
			() => validateReleaseSnapshot(root, VERSION),
			/missing packages\/agent .* unexpected packages\/agent-substitute/u,
		);
	});
});

test("rejects package-lock workspace name and version mismatches", () => {
	withFixture((root) => {
		replace(root, "package-lock.json", "@earendil-works/pi-agent-core", "@earendil-works/pi-wrong");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /package-lock\.json workspace packages\/agent has name/u);
	});
	withFixture((root) => {
		replace(root, "package-lock.json", `"version":"${VERSION}"`, '"version":"1.2.2"');
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /package-lock\.json workspace .* has version 1\.2\.2/u);
	});
});

test("rejects missing changelogs and missing or duplicate Unreleased headings", () => {
	withFixture((root) => {
		rmSync(join(root, "packages/agent/CHANGELOG.md"));
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /Missing changelog/u);
	});
	withFixture((root) => {
		replace(root, "packages/agent/CHANGELOG.md", "## [Unreleased]\n", "");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /exactly one Unreleased/u);
	});
	withFixture((root) => {
		replace(root, "packages/agent/CHANGELOG.md", "## [Unreleased]\n", "## [Unreleased]\n\n## [Unreleased]\n");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /exactly one Unreleased/u);
	});
});

test("rejects stale releases and mismatched changelog dates", () => {
	withFixture((root) => {
		replace(root, "packages/agent/CHANGELOG.md", `[${VERSION}]`, "[1.2.2]");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /first release after Unreleased/u);
	});
	withFixture((root) => {
		replace(root, "packages/ai/CHANGELOG.md", DATE, "2026-10-05");
		assert.throws(() => validateReleaseSnapshot(root, VERSION), /release date .* does not match/u);
	});
});

test("rejects duplicate target-version headings", () => withFixture((root) => {
	const path = "packages/agent/CHANGELOG.md";
	writeFileSync(join(root, path), `${readFileSync(join(root, path), "utf8")}\n## [${VERSION}] - ${DATE}\n\n- Duplicate.\n`);
	assert.throws(() => validateReleaseSnapshot(root, VERSION), /exactly one \[1\.2\.3\] release heading/u);
}));

test("rejects impossible changelog calendar dates", () => withFixture((root) => {
	for (const directory of Object.keys(EXPECTED_PUBLIC_PACKAGES).filter((name) => name !== "packages/chord")) {
		replace(root, `${directory}/CHANGELOG.md`, DATE, "2026-02-30");
	}
	assert.throws(() => validateReleaseSnapshot(root, VERSION), /not a valid calendar date/u);
}));

test("rejects an empty coding-agent release section", () => withFixture((root) => {
	const path = "packages/coding-agent/CHANGELOG.md";
	replace(root, path, "\n### Added\n\n- A release feature.\n", "\n");
	assert.throws(() => validateReleaseSnapshot(root, VERSION), /release section must be nonempty/u);
}));

test("discloses nonempty Unreleased sections and commit subjects", () => withFixture((root) => {
	replace(root, "packages/ai/CHANGELOG.md", "## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- Snapshot fix.\n");
	const snapshot = validateReleaseSnapshot(root, VERSION);
	const notes = renderReleaseNotes({ version: VERSION, artifact: "pablontiv-pion-1.2.3.tgz", snapshot, commitSubjects: ["downstream fix"] });
	assert.match(notes, /Source-snapshot changes/u);
	assert.match(notes, /Snapshot fix/u);
	assert.match(notes, /Commit subjects for v1\.2\.3\.\.HEAD/u);
	assert.match(notes, /downstream fix/u);
}));

test("validates exact metadata, payload names, and checksum coverage", () => {
	const out = mkdtempSync(join(tmpdir(), "pion-assets-test-"));
	const sourceCommit = "a".repeat(40);
	const upstreamTag = `v${VERSION}`;
	const artifact = `pablontiv-pion-${VERSION}.tgz`;
	try {
		writeFileSync(join(out, artifact), "tarball");
		writeFileSync(join(out, "RELEASE_NOTES.md"), "notes\n");
		writeFileSync(join(out, "PION_RELEASE.json"), `${JSON.stringify(createReleaseMetadata({ version: VERSION, sourceCommit, upstreamTag }), null, 2)}\n`);
		const names = [artifact, "PION_RELEASE.json", "RELEASE_NOTES.md"];
		writeFileSync(join(out, "SHA256SUMS"), `${names.map((name) => `${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`).join("\n")}\n`);
		assert.equal(validateReleaseAssets({ out, version: VERSION, sourceCommit, upstreamTag }).metadata.upstreamTag, upstreamTag);
		writeFileSync(join(out, "extra.txt"), "unexpected");
		assert.throws(() => validateReleaseAssets({ out, version: VERSION, sourceCommit, upstreamTag }), /Unexpected release payload files/u);
		rmSync(join(out, "extra.txt"));

		const metadataPath = join(out, "PION_RELEASE.json");
		const metadata = readFileSync(metadataPath, "utf8");
		writeFileSync(metadataPath, metadata.replace("@pablontiv/pion", "@pablontiv/wrong"));
		assert.throws(() => validateReleaseAssets({ out, version: VERSION, sourceCommit, upstreamTag }), /exact expected metadata/u);
		writeFileSync(metadataPath, metadata);
		writeFileSync(join(out, "SHA256SUMS"), "not exact\n");
		assert.throws(() => validateReleaseAssets({ out, version: VERSION, sourceCommit, upstreamTag }), /does not exactly cover/u);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
