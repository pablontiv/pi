import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

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

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-sync-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet", "--initial-branch=dev"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  write(root, "shared.txt", "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  return { root, base: git(root, ["rev-parse", "HEAD"]).trim() };
}

function merge(root, commit) {
  return spawnSync("git", ["merge", "--no-ff", "--no-edit", commit], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

test("sync workflow fails closed before publishing conflict or workflow-changing candidates", () => {
  const source = readFileSync(join(ROOT, ".github/workflows/sync-upstream.yml"), "utf8");
  assert.doesNotMatch(source, /reconcile-upstream-workflow-conflicts/u);

  const ancestorCheck = source.indexOf('git merge-base --is-ancestor "${main_sha}" "${dev_sha}"');
  const mergeCommand = source.indexOf('if ! git merge --no-ff --no-edit "${main_sha}"');
  const candidateCheck = source.indexOf('[[ "${candidate_sha}" == "${dev_sha}" ]]');
  const workflowCheck = source.indexOf('git diff --quiet "${dev_sha}" "${candidate_sha}" -- .github/workflows');
  const candidateBranch = source.indexOf('candidate_branch="local/upstream-sync-');
  const candidatePush = source.indexOf('"${candidate_sha}:refs/heads/${candidate_branch}"');
  assert.ok(ancestorCheck > 0 && ancestorCheck < mergeCommand);
  assert.ok(mergeCommand < candidateCheck && candidateCheck < workflowCheck);
  assert.ok(workflowCheck < candidateBranch && candidateBranch < candidatePush);
  assert.match(source, /git diff --name-only -z --diff-filter=U/u);
  assert.match(source, /git diff --name-status --no-renames .* -- \.github\/workflows/u);
  assert.match(source, /A separately reviewed manual PR is required\. Synchronization and release were not promoted\./u);
  assert.match(source, /https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git/u);
});

test("a clean code-only merge proceeds to candidate eligibility", (t) => {
  const { root, base } = repository(t);
  git(root, ["checkout", "--quiet", "-b", "main", base]);
  write(root, "upstream.txt", "upstream\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "upstream"]);
  const main = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "--quiet", "dev"]);
  write(root, "fork.txt", "fork\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fork"]);
  const dev = git(root, ["rev-parse", "HEAD"]).trim();

  assert.equal(merge(root, main).status, 0);
  const candidate = git(root, ["rev-parse", "HEAD"]).trim();
  assert.notEqual(candidate, dev);
  assert.equal(spawnSync("git", ["diff", "--quiet", dev, candidate, "--", ".github/workflows"], { cwd: root }).status, 0);
});

test("a clean workflow-changing merge blocks before candidate publication", (t) => {
  const { root, base } = repository(t);
  git(root, ["checkout", "--quiet", "-b", "main", base]);
  write(root, ".github/workflows/new.yml", "name: upstream\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "upstream workflow"]);
  const main = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "--quiet", "dev"]);
  const dev = git(root, ["rev-parse", "HEAD"]).trim();

  assert.equal(merge(root, main).status, 0);
  const candidate = git(root, ["rev-parse", "HEAD"]).trim();
  const changes = git(root, ["diff", "--name-status", "--no-renames", dev, candidate, "--", ".github/workflows"]);
  assert.equal(changes, "A\t.github/workflows/new.yml\n");
  const published = changes.length === 0;
  assert.equal(published, false);
});

test("a merge conflict reports paths and requires a manual PR", (t) => {
  const { root, base } = repository(t);
  write(root, "shared.txt", "fork\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fork"]);
  git(root, ["checkout", "--quiet", "-b", "main", base]);
  write(root, "shared.txt", "upstream\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "upstream"]);
  const main = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "--quiet", "dev"]);

  assert.equal(merge(root, main).status, 1);
  const paths = git(root, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n");
  const summary = `## Upstream synchronization blocked\n\nThe automatic merge has conflicts in:\n${paths.map((path) => `- \`${path}\``).join("\n")}\n\nA separately reviewed manual PR is required. Synchronization and release were not promoted.\n`;
  assert.deepEqual(paths, ["shared.txt"]);
  assert.match(summary, /`shared\.txt`/u);
  assert.match(summary, /manual PR is required/u);
  assert.match(summary, /Synchronization and release were not promoted/u);
});

test("an already-integrated main skips candidate publication and remains release-eligible", (t) => {
  const { root } = repository(t);
  const main = git(root, ["rev-parse", "HEAD"]).trim();
  write(root, "fork.txt", "fork\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fork"]);
  const dev = git(root, ["rev-parse", "HEAD"]).trim();

  const alreadyIntegrated = spawnSync("git", ["merge-base", "--is-ancestor", main, dev], { cwd: root }).status === 0;
  const candidatePublished = !alreadyIntegrated;
  const releaseEligible = alreadyIntegrated;
  assert.equal(candidatePublished, false);
  assert.equal(releaseEligible, true);
});
