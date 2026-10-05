import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("./classify-upstream-merge.mjs", import.meta.url).pathname;

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
	return { result, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8"), dev, main };
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
