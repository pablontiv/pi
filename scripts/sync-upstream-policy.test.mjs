import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("./classify-upstream-merge.mjs", import.meta.url).pathname;
const WORKFLOW = new URL("../.github/workflows/sync-upstream.yml", import.meta.url).pathname;
const CANDIDATE_CHAIN = [
	"Publish merge candidate",
	"Run CI on merge candidate",
	"Promote tested candidate to dev",
	"Remove merge candidate branch",
];
const CANDIDATE_CONDITIONS = new Map([
	["Publish merge candidate", "${{ steps.candidate.outputs.candidate == 'true' }}"],
	["Run CI on merge candidate", "${{ steps.candidate.outputs.candidate == 'true' }}"],
	["Promote tested candidate to dev", "${{ steps.candidate.outputs.candidate == 'true' }}"],
	["Remove merge candidate branch", "${{ always() && steps.candidate.outputs.candidate == 'true' }}"],
]);

function git(root, args) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function write(root, path, content) {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}

function commit(root, message) {
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", message]);
	return git(root, ["rev-parse", "HEAD"]).trim();
}

function repository(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-sync-policy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, ["init", "--quiet", "--initial-branch=dev"]);
	git(root, ["config", "user.name", "Test User"]);
	git(root, ["config", "user.email", "test@example.com"]);
	write(root, "shared.txt", "base\n");
	const base = commit(root, "base");
	return { root, base };
}

function workflowStructure() {
	const lines = readFileSync(WORKFLOW, "utf8").split(/\r?\n/u);
	const jobsIndex = lines.findIndex((line) => line === "jobs:");
	assert.ok(jobsIndex >= 0, "production workflow must contain jobs");
	const jobStarts = lines.flatMap((line, index) => (index > jobsIndex && /^  [A-Za-z0-9_-]+:\s*$/u.test(line) ? [index] : []));
	const jobs = new Map();
	for (const [position, start] of jobStarts.entries()) {
		const end = jobStarts[position + 1] ?? lines.length;
		const block = lines.slice(start, end);
		const name = lines[start].trim().slice(0, -1);
		const needs = block.find((line) => /^    needs:\s*/u.test(line))?.replace(/^    needs:\s*/u, "").trim();
		const condition = block.find((line) => /^    if:\s*/u.test(line))?.replace(/^    if:\s*/u, "").trim();
		const stepStarts = block.flatMap((line, index) => (/^      - name:\s*/u.test(line) ? [index] : []));
		const steps = new Map();
		for (const [stepPosition, stepStart] of stepStarts.entries()) {
			const stepEnd = stepStarts[stepPosition + 1] ?? block.length;
			const stepBlock = block.slice(stepStart, stepEnd);
			const stepName = stepBlock[0].replace(/^      - name:\s*/u, "").trim();
			const stepCondition = stepBlock.find((line) => /^        if:\s*/u.test(line))?.replace(/^        if:\s*/u, "").trim();
			steps.set(stepName, { condition: stepCondition });
		}
		jobs.set(name, { condition, needs, steps });
	}
	return jobs;
}

function outputValues(output) {
	return Object.fromEntries(
		output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("=", 2)),
	);
}

function candidateGateAllows(name, condition, outputs, priorStepsSucceeded = true) {
	assert.equal(condition, CANDIDATE_CONDITIONS.get(name), `${name} must retain its exact candidate gate`);
	const always = condition.includes("always()");
	const expected = /steps\.candidate\.outputs\.candidate == '([^']+)'/u.exec(condition)?.[1];
	assert.ok(expected, `condition must reference the classifier candidate output: ${condition}`);
	return (priorStepsSucceeded || always) && outputs.candidate === expected;
}

function downstreamJobAllows(job, completedJobs) {
	assert.ok(job.needs, "downstream release job must declare needs");
	return completedJobs[job.needs] === "success" && !/\b(?:always|failure|cancelled)\s*\(/u.test(job.condition ?? "");
}

function runPolicy(root) {
	const output = join(root, "github-output");
	const summary = join(root, "github-summary");
	writeFileSync(output, "");
	writeFileSync(summary, "");
	const dev = git(root, ["rev-parse", "dev"]).trim();
	const main = git(root, ["rev-parse", "main"]).trim();
	const result = spawnSync(process.execPath, [SCRIPT, dev, main], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_OUTPUT: output,
			GITHUB_STEP_SUMMARY: summary,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
	const outputText = readFileSync(output, "utf8");
	return { result, output: outputText, outputs: outputValues(outputText), summary: readFileSync(summary, "utf8"), dev, main };
}

test("ordinary clean code-only merge emits a publishable candidate", (t) => {
	const { root, base } = repository(t);
	git(root, ["checkout", "--quiet", "-b", "main", base]);
	write(root, "upstream.txt", "upstream\n");
	commit(root, "upstream");
	git(root, ["checkout", "--quiet", "dev"]);
	write(root, "fork.txt", "fork\n");
	commit(root, "fork");

	const run = runPolicy(root);
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.match(run.output, /^changed=true$/mu);
	assert.match(run.output, /^candidate=true$/mu);
	assert.match(run.output, /^candidate_sha=[0-9a-f]{40}$/mu);
	assert.match(run.output, /^release_eligible=false$/mu);
	assert.equal(run.summary, "");
	assert.equal(git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1).join(" "), `${run.dev} ${run.main}`);
});

test("merge conflict fails with exact paths and manual-PR summary without publication outputs", (t) => {
	const { root, base } = repository(t);
	write(root, "shared.txt", "fork\n");
	commit(root, "fork");
	git(root, ["checkout", "--quiet", "-b", "main", base]);
	write(root, "shared.txt", "upstream\n");
	commit(root, "upstream");
	git(root, ["checkout", "--quiet", "dev"]);

	const run = runPolicy(root);
	assert.notEqual(run.result.status, 0);
	assert.equal(run.output, "");
	assert.equal(
		run.summary,
		"## Upstream synchronization blocked\n\nThe automatic merge has conflicts in:\n- `shared.txt`\n\nA separately reviewed manual PR is required. Synchronization and release were not promoted.\n",
	);
	assert.match(run.result.stderr, /shared\.txt.*manual PR is required/u);
});

test("clean workflow-tree change fails before publication with paths and manual-PR summary", (t) => {
	const { root, base } = repository(t);
	git(root, ["checkout", "--quiet", "-b", "main", base]);
	write(root, ".github/workflows/new.yml", "name: upstream\n");
	commit(root, "upstream workflow");
	git(root, ["checkout", "--quiet", "dev"]);

	const run = runPolicy(root);
	assert.notEqual(run.result.status, 0);
	assert.equal(run.output, "");
	assert.equal(
		run.summary,
		"## Upstream synchronization blocked\n\nThe clean merge candidate changes workflow paths:\n```text\nA\t.github/workflows/new.yml\n```\n\nA separately reviewed manual PR is required. Synchronization and release were not promoted.\n",
	);
	assert.match(run.result.stderr, /\.github\/workflows\/new\.yml.*manual PR is required/u);
});

test("already-integrated main emits release-eligible and no-candidate outputs", (t) => {
	const { root, base } = repository(t);
	git(root, ["branch", "main", base]);
	write(root, "fork.txt", "fork\n");
	commit(root, "fork");

	const run = runPolicy(root);
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.match(run.output, /^changed=false$/mu);
	assert.match(run.output, /^candidate=false$/mu);
	assert.match(run.output, /^release_eligible=true$/mu);
	assert.match(run.output, /^no_candidate=true$/mu);
	assert.doesNotMatch(run.output, /^candidate_sha=/mu);
	assert.equal(run.summary, "");
	assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), run.dev);
});

test("production workflow gates off the candidate chain while release preparation remains reachable on no-op", (t) => {
	const { root, base } = repository(t);
	git(root, ["branch", "main", base]);
	write(root, "fork.txt", "fork\n");
	commit(root, "fork");
	const run = runPolicy(root);
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.equal(run.outputs.candidate, "false");
	assert.equal(run.outputs.no_candidate, "true");
	assert.equal(run.outputs.release_eligible, "true");

	const jobs = workflowStructure();
	const syncDev = jobs.get("sync-dev");
	assert.ok(syncDev);
	for (const name of CANDIDATE_CHAIN) {
		assert.equal(candidateGateAllows(name, syncDev.steps.get(name)?.condition, run.outputs), false, `${name} must be gated off`);
	}
	const prepare = jobs.get("prepare-pion-tag");
	assert.ok(prepare);
	assert.equal(prepare.needs, "sync-dev");
	assert.equal(prepare.condition, "${{ github.repository == 'pablontiv/pi' }}");
	assert.equal(downstreamJobAllows(prepare, { "sync-dev": "success" }), true);
});

test("production workflow enables the intended candidate publication chain for candidate=true", (t) => {
	const { root, base } = repository(t);
	git(root, ["checkout", "--quiet", "-b", "main", base]);
	write(root, "upstream.txt", "upstream\n");
	commit(root, "upstream");
	git(root, ["checkout", "--quiet", "dev"]);
	write(root, "fork.txt", "fork\n");
	commit(root, "fork");
	const run = runPolicy(root);
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.equal(run.outputs.candidate, "true");

	const syncDev = workflowStructure().get("sync-dev");
	assert.ok(syncDev);
	for (const name of CANDIDATE_CHAIN) {
		assert.equal(candidateGateAllows(name, syncDev.steps.get(name)?.condition, run.outputs), true, `${name} must be enabled`);
	}
});

test("production workflow blocks downstream release jobs when classification fails", (t) => {
	const { root, base } = repository(t);
	write(root, "shared.txt", "fork\n");
	commit(root, "fork");
	git(root, ["checkout", "--quiet", "-b", "main", base]);
	write(root, "shared.txt", "upstream\n");
	commit(root, "upstream");
	git(root, ["checkout", "--quiet", "dev"]);
	const run = runPolicy(root);
	assert.notEqual(run.result.status, 0);
	assert.deepEqual(run.outputs, {});

	const jobs = workflowStructure();
	const prepare = jobs.get("prepare-pion-tag");
	const publish = jobs.get("publish-pion-tag");
	assert.ok(prepare);
	assert.ok(publish);
	assert.equal(downstreamJobAllows(prepare, { "sync-dev": "failure" }), false);
	assert.equal(downstreamJobAllows(publish, { "prepare-pion-tag": "skipped" }), false);
});
