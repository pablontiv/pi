#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageDirectories } from "./package-workspaces.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
export const EXPECTED_PUBLIC_PACKAGES = Object.freeze({
	"packages/agent": "@earendil-works/pi-agent-core",
	"packages/ai": "@earendil-works/pi-ai",
	"packages/chord": "@earendil-works/chord",
	"packages/client": "@earendil-works/pi-client",
	"packages/codemode": "@earendil-works/pi-codemode",
	"packages/coding-agent": "@earendil-works/pi-coding-agent",
	"packages/durable": "@earendil-works/pi-durable",
	"packages/env": "@earendil-works/pi-env",
	"packages/mcp": "@earendil-works/pi-mcp",
	"packages/protocol": "@earendil-works/pi-protocol",
	"packages/server": "@earendil-works/pi-server",
	"packages/telemetry": "@earendil-works/pi-telemetry",
	"packages/tui": "@earendil-works/pi-tui",
});

export function validatePionVersion(version) {
	if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) throw new Error(`Invalid Pion version: ${version}`);
	return version;
}

export function validateUpstreamTag(tag, version) {
	if (tag !== `v${validatePionVersion(version)}`) throw new Error(`Invalid upstream tag: ${tag}`);
	return tag;
}

export function createPionManifest(manifest, version) {
	if (manifest.version !== version) {
		throw new Error(`Pion version ${version} must match the upstream package version ${manifest.version}`);
	}
	return {
		...manifest,
		name: "@pablontiv/pion",
		version,
		private: true,
		description: "Pion coding agent, a personal downstream distribution of Pi",
		bin: { pion: "dist/bundle/cli.js" },
		repository: {
			type: "git",
			url: "git+https://github.com/pablontiv/pi.git",
			directory: "packages/coding-agent",
		},
	};
}

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: "utf8", ...options });
}

function parseJson(text, description) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid ${description}`, { cause: error });
	}
}

function readJson(path, description = path) {
	return parseJson(readFileSync(path, "utf8"), description);
}

function pack(directory, outputDirectory) {
	const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", outputDirectory], {
		cwd: directory,
	});
	const parsed = parseJson(output, "npm pack output");
	const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (!result?.filename) throw new Error("npm pack did not report an artifact filename");
	return join(outputDirectory, result.filename);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function meaningfulMarkdown(markdown) {
	return markdown
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.some((line) => line && !line.startsWith("#"));
}

function isValidCalendarDate(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

export function validateReleaseSnapshot(root, version) {
	validatePionVersion(version);
	const packages = findPackageDirectories(join(root, "packages"))
		.map((absoluteDirectory) => {
			const directory = relative(root, absoluteDirectory);
			return { directory, ...readJson(join(root, directory, "package.json")) };
		})
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version: packageVersion }) => ({ directory, name, version: packageVersion }));
	const discoveredByDirectory = new Map(packages.map((pkg) => [pkg.directory, pkg]));
	const packageSetErrors = [];
	for (const [directory, expectedName] of Object.entries(EXPECTED_PUBLIC_PACKAGES)) {
		const pkg = discoveredByDirectory.get(directory);
		if (!pkg) packageSetErrors.push(`missing ${directory} (${expectedName})`);
		else if (pkg.name !== expectedName) {
			packageSetErrors.push(`${directory} has name ${pkg.name}; expected ${expectedName}`);
		}
	}
	for (const pkg of packages) {
		if (!(pkg.directory in EXPECTED_PUBLIC_PACKAGES)) {
			packageSetErrors.push(`unexpected ${pkg.directory} (${pkg.name})`);
		}
	}
	if (packageSetErrors.length > 0) {
		throw new Error(`Public package set does not match the expected path/name map: ${packageSetErrors.join("; ")}`);
	}

	for (const pkg of packages) {
		if (pkg.version !== version) {
			throw new Error(`${pkg.directory}/package.json has version ${pkg.version}; expected ${version}`);
		}
	}

	const lock = readJson(join(root, "package-lock.json"), "package-lock.json");
	for (const pkg of packages) {
		const lockEntry = lock.packages?.[pkg.directory];
		if (!lockEntry) throw new Error(`package-lock.json is missing workspace ${pkg.directory}`);
		if (lockEntry.name !== pkg.name) {
			throw new Error(`package-lock.json workspace ${pkg.directory} has name ${lockEntry.name}; expected ${pkg.name}`);
		}
		if (lockEntry.version !== version) {
			throw new Error(`package-lock.json workspace ${pkg.directory} has version ${lockEntry.version}; expected ${version}`);
		}
	}

	const changelogPackages = packages.filter((pkg) => pkg.directory !== "packages/chord");

	let releaseDate;
	const unreleased = [];
	for (const pkg of changelogPackages) {
		const path = join(root, pkg.directory, "CHANGELOG.md");
		if (!existsSync(path)) throw new Error(`Missing changelog: ${path}`);
		const text = readFileSync(path, "utf8");
		const unreleasedMatches = [...text.matchAll(/^## \[Unreleased\]\s*$/gmu)];
		if (unreleasedMatches.length !== 1) {
			throw new Error(`${path} must contain exactly one Unreleased heading`);
		}
		const start = unreleasedMatches[0].index + unreleasedMatches[0][0].length;
		const following = text.slice(start);
		const nextVersion = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/mu.exec(following);
		if (!nextVersion || nextVersion[1] !== version || !nextVersion[2]) {
			throw new Error(`${path} first release after Unreleased must be [${version}] - YYYY-MM-DD`);
		}
		const targetVersionHeadings = [...text.matchAll(/^## \[([^\]]+)\](?:[ \t].*)?$/gmu)].filter(
			(match) => match[1] === version,
		);
		if (targetVersionHeadings.length !== 1) {
			throw new Error(`${path} must contain exactly one [${version}] release heading`);
		}
		if (!isValidCalendarDate(nextVersion[2])) {
			throw new Error(`${path} release date ${nextVersion[2]} is not a valid calendar date`);
		}
		if (releaseDate && nextVersion[2] !== releaseDate) {
			throw new Error(`${path} release date ${nextVersion[2]} does not match ${releaseDate}`);
		}
		releaseDate ??= nextVersion[2];
		const unreleasedText = following.slice(0, nextVersion.index).trim();
		if (meaningfulMarkdown(unreleasedText)) unreleased.push({ name: pkg.name, markdown: unreleasedText });

		if (pkg.directory === "packages/coding-agent") {
			const releaseStart = nextVersion.index + nextVersion[0].length;
			const releaseTail = following.slice(releaseStart);
			const nextHeading = /^## /mu.exec(releaseTail);
			const releaseText = releaseTail.slice(0, nextHeading?.index ?? releaseTail.length);
			if (!meaningfulMarkdown(releaseText)) {
				throw new Error(`${path} [${version}] release section must be nonempty`);
			}
		}
	}

	return { packages, releaseDate, unreleased };
}

export function createReleaseMetadata({ version, sourceCommit, upstreamTag }) {
	validatePionVersion(version);
	validateUpstreamTag(upstreamTag, version);
	if (!SHA_PATTERN.test(sourceCommit)) throw new Error(`Invalid source commit: ${sourceCommit}`);
	return {
		tag: `pion-v${version}`,
		package: `@pablontiv/pion@${version}`,
		executable: "pion",
		sourceRepository: "https://github.com/pablontiv/pi",
		sourceBranch: "dev",
		sourceCommit,
		upstreamTag,
		upstreamVersion: version,
		artifact: `pablontiv-pion-${version}.tgz`,
		npmRegistryPublished: false,
	};
}

export function renderReleaseNotes({ version, artifact, snapshot, commitSubjects }) {
	const tag = `pion-v${version}`;
	let notes =
		`Pion is a personal downstream distribution of Pi ${version}.\n\n` +
		`Install directly from this GitHub Release; it is not published to the npm registry:\n\n` +
		"```sh\n" +
		`npm install -g https://github.com/pablontiv/pi/releases/download/${tag}/${artifact}\n` +
		"pion --version\n```\n";
	if (snapshot.unreleased.length > 0) {
		notes += "\n## Source-snapshot changes after the upstream release notes\n";
		for (const section of snapshot.unreleased) {
			notes += `\n### ${section.name}\n\n${section.markdown}\n`;
		}
	}
	notes += `\n## Commit subjects for v${version}..HEAD\n\n`;
	notes += commitSubjects.length > 0 ? `${commitSubjects.map((subject) => `- ${subject}`).join("\n")}\n` : "- No additional commits.\n";
	return notes;
}

export function validateReleaseAssets({ out, version, sourceCommit, upstreamTag }) {
	const artifact = `pablontiv-pion-${validatePionVersion(version)}.tgz`;
	const expectedNames = ["PION_RELEASE.json", "RELEASE_NOTES.md", "SHA256SUMS", artifact].sort();
	const actualNames = readdirSync(out).sort();
	if (actualNames.join("\n") !== expectedNames.join("\n")) {
		throw new Error(`Unexpected release payload files: ${actualNames.join(", ")}`);
	}
	const expectedMetadata = createReleaseMetadata({ version, sourceCommit, upstreamTag });
	const actualMetadata = readJson(join(out, "PION_RELEASE.json"), "PION_RELEASE.json");
	if (JSON.stringify(actualMetadata) !== JSON.stringify(expectedMetadata)) {
		throw new Error("PION_RELEASE.json does not contain the exact expected metadata");
	}
	const covered = [artifact, "PION_RELEASE.json", "RELEASE_NOTES.md"];
	const expectedChecksums = `${covered.map((name) => `${sha256(join(out, name))}  ${name}`).join("\n")}\n`;
	if (readFileSync(join(out, "SHA256SUMS"), "utf8") !== expectedChecksums) {
		throw new Error("SHA256SUMS does not exactly cover the tarball, metadata, and release notes");
	}
	return { artifact: join(out, artifact), metadata: actualMetadata };
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--validate-source" || argument === "--validate-assets") result[argument.slice(2)] = true;
		else if (["--out", "--version", "--upstream-tag", "--upstream-ref", "--source-commit"].includes(argument)) {
			result[argument.slice(2)] = args[++index];
		} else throw new Error(`Unknown argument: ${argument}`);
	}
	if (!result.version) throw new Error("--version X.Y.Z is required");
	result.version = validatePionVersion(result.version);
	if (result.out) result.out = resolve(result.out);
	return result;
}

export function createPionRelease({ out, version, upstreamTag, upstreamRef }) {
	validateUpstreamTag(upstreamTag, version);
	if (!upstreamRef) throw new Error("An upstream ref is required to generate commit disclosure");
	const snapshot = validateReleaseSnapshot(ROOT, version);
	const packageDirectory = join(ROOT, "packages", "coding-agent");
	const sourceManifest = readJson(join(packageDirectory, "package.json"), "packages/coding-agent/package.json");
	const manifest = createPionManifest(sourceManifest, version);
	if (!existsSync(join(packageDirectory, "dist", "bundle", "cli.js"))) {
		throw new Error("Build packages/coding-agent before creating a Pion release");
	}

	mkdirSync(out, { recursive: true });
	const expectedArtifact = join(out, `pablontiv-pion-${version}.tgz`);
	if (existsSync(expectedArtifact)) throw new Error(`Release artifact already exists: ${expectedArtifact}`);

	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pion-release-"));
	try {
		const sourceTarballs = join(temporaryDirectory, "source-tarballs");
		const stagedRoot = join(temporaryDirectory, "staged");
		mkdirSync(sourceTarballs);
		mkdirSync(stagedRoot);
		const sourceTarball = pack(packageDirectory, sourceTarballs);
		run("tar", ["-xzf", sourceTarball, "-C", stagedRoot]);
		const stagedPackage = join(stagedRoot, "package");
		writeFileSync(join(stagedPackage, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		const artifact = pack(stagedPackage, out);
		if (resolve(artifact) !== expectedArtifact) throw new Error(`Unexpected artifact filename: ${basename(artifact)}`);

		const sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: ROOT }).trim();
		const metadataPath = join(out, "PION_RELEASE.json");
		writeFileSync(metadataPath, `${JSON.stringify(createReleaseMetadata({ version, sourceCommit, upstreamTag }), null, 2)}\n`);
		const commitSubjects = run("git", ["log", "--format=%s", `${upstreamRef}..HEAD`], { cwd: ROOT })
			.trim()
			.split("\n")
			.filter(Boolean);
		const notesPath = join(out, "RELEASE_NOTES.md");
		writeFileSync(notesPath, renderReleaseNotes({ version, artifact: basename(artifact), snapshot, commitSubjects }));
		const checksumFiles = [artifact, metadataPath, notesPath];
		writeFileSync(
			join(out, "SHA256SUMS"),
			`${checksumFiles.map((path) => `${sha256(path)}  ${basename(path)}`).join("\n")}\n`,
		);
		validateReleaseAssets({ out, version, sourceCommit, upstreamTag });
		return { artifact, tag: `pion-v${version}` };
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
	const args = parseArgs(process.argv.slice(2));
	if (args["validate-source"]) {
		validateReleaseSnapshot(ROOT, args.version);
		console.log(`Validated public workspace release ${args.version}.`);
	} else if (args["validate-assets"]) {
		if (!args.out || !args["source-commit"] || !args["upstream-tag"]) {
			throw new Error("--validate-assets requires --out, --source-commit, and --upstream-tag");
		}
		validateReleaseAssets({
			out: args.out,
			version: args.version,
			sourceCommit: args["source-commit"],
			upstreamTag: args["upstream-tag"],
		});
		console.log(`Validated Pion release assets for ${args.version}.`);
	} else {
		if (!args.out || !args["upstream-tag"] || !args["upstream-ref"]) {
			throw new Error("Creation requires --out, --upstream-tag, and --upstream-ref");
		}
		const result = createPionRelease({
			out: args.out,
			version: args.version,
			upstreamTag: args["upstream-tag"],
			upstreamRef: args["upstream-ref"],
		});
		console.log(`Created ${result.artifact}`);
	}
}
