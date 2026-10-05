#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

function git(args, options = {}) {
	return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function isAncestor(ancestor, descendant) {
	return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" }).status === 0;
}

function append(path, text) {
	if (!path) throw new Error("GITHUB_OUTPUT and GITHUB_STEP_SUMMARY are required");
	appendFileSync(path, text);
}

function emitOutputs(values) {
	append(process.env.GITHUB_OUTPUT, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function blockedSummary(detail) {
	append(
		process.env.GITHUB_STEP_SUMMARY,
		`## Upstream synchronization blocked\n\n${detail}\n\nA separately reviewed manual PR is required. Synchronization and release were not promoted.\n`,
	);
}

const [devSha, mainSha] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/u.test(devSha ?? "") || !/^[0-9a-f]{40}$/u.test(mainSha ?? "")) {
	throw new Error("Usage: classify-upstream-merge.mjs DEV_SHA MAIN_SHA");
}

if (isAncestor(mainSha, devSha)) {
	console.log(`dev already contains main at ${mainSha}.`);
	emitOutputs({ changed: "false", candidate: "false", release_eligible: "true", no_candidate: "true", dev_sha: devSha, main_sha: mainSha });
	process.exit(0);
}

git(["config", "user.name", "github-actions[bot]"]);
git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
git(["checkout", "--detach", devSha]);
const merge = spawnSync("git", ["merge", "--no-ff", "--no-edit", mainSha], { encoding: "utf8" });
if (merge.status !== 0) {
	const paths = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean).sort();
	blockedSummary(`The automatic merge has conflicts in:\n${paths.map((path) => `- \`${path.replaceAll("`", "\\`")}\``).join("\n")}`);
	console.error(`Upstream merge has conflicts in: ${paths.join(", ")}. A separately reviewed manual PR is required.`);
	process.exit(1);
}

const candidateSha = git(["rev-parse", "HEAD"]);
if (candidateSha === devSha) {
	console.log("Merge produced no new candidate; release eligibility will be evaluated on current dev.");
	emitOutputs({ changed: "false", candidate: "false", release_eligible: "true", no_candidate: "true", dev_sha: devSha, main_sha: mainSha });
	process.exit(0);
}

const workflowChanges = git(["diff", "--name-status", "--no-renames", devSha, candidateSha, "--", ".github/workflows"]);
if (workflowChanges) {
	blockedSummary(`The clean merge candidate changes workflow paths:\n\`\`\`text\n${workflowChanges}\n\`\`\``);
	console.error(`Merge candidate changes .github/workflows: ${workflowChanges.replaceAll("\n", ", ")}. A separately reviewed manual PR is required.`);
	process.exit(1);
}

emitOutputs({
	changed: "true",
	candidate: "true",
	release_eligible: "false",
	no_candidate: "false",
	dev_sha: devSha,
	main_sha: mainSha,
	candidate_sha: candidateSha,
});
console.log(`Merge candidate ${candidateSha} is eligible for CI publication.`);
