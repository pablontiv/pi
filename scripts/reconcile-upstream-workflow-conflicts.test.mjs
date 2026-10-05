import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  EXPECTED_WORKFLOW_CONFLICTS,
  parseUnmergedEntries,
  planReconciliation,
  reconcile,
  runCli,
} from "./reconcile-upstream-workflow-conflicts.mjs";

const CONFLICT_PATHS = [
  ".github/workflows/build-binaries.yml",
  ".github/workflows/env-daemons.yml",
  ".github/workflows/env.yml",
];

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

function conflictEntries(paths = [...EXPECTED_WORKFLOW_CONFLICTS.keys()]) {
  return paths.flatMap((path) => {
    const expected = EXPECTED_WORKFLOW_CONFLICTS.get(path);
    return [
      { mode: "100644", object: expected.ours, stage: 2, path },
      { mode: "100644", object: expected.theirs, stage: 3, path },
    ];
  });
}

function createConflictedRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-upstream-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet", "--initial-branch=dev"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);

  write(root, CONFLICT_PATHS[0], "base build workflow\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();

  for (const path of CONFLICT_PATHS) write(root, path, `candidate ${path}\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "candidate"]);
  const candidate = git(root, ["rev-parse", "HEAD"]).trim();

  git(root, ["checkout", "--quiet", "-b", "main", base]);
  for (const path of CONFLICT_PATHS) write(root, path, `upstream ${path}\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "upstream"]);
  const main = git(root, ["rev-parse", "HEAD"]).trim();

  const expectations = new Map(
    CONFLICT_PATHS.map((path) => [
      path,
      {
        ours: git(root, ["rev-parse", `${candidate}:${path}`]).trim(),
        theirs: git(root, ["rev-parse", `${main}:${path}`]).trim(),
      },
    ]),
  );

  git(root, ["checkout", "--quiet", "dev"]);
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-edit", main], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  assert.equal(merge.status, 1);
  assert.deepEqual(
    [...new Set(parseUnmergedEntries(git(root, ["ls-files", "--unmerged", "-z"])).map((entry) => entry.path))].sort(),
    CONFLICT_PATHS,
  );
  return { root, candidate, main, expectations };
}

test("parses NUL-delimited unmerged index entries", () => {
  const [path, expected] = EXPECTED_WORKFLOW_CONFLICTS.entries().next().value;
  const output = `100644 ${expected.ours} 2\t${path}\0`;
  assert.deepEqual(parseUnmergedEntries(output), [
    { mode: "100644", object: expected.ours, stage: 2, path },
  ]);
});

test("accepts only the complete verified workflow conflict set", () => {
  assert.deepEqual(planReconciliation(conflictEntries()), [...EXPECTED_WORKFLOW_CONFLICTS.keys()].sort());
  assert.throws(
    () => planReconciliation(conflictEntries([".github/workflows/env.yml"])),
    /merge conflict set changed/u,
  );
});

test("an unknown conflict exits nonzero and reports that promotion was blocked", () => {
  const entries = conflictEntries();
  entries.push({
    mode: "100644",
    object: "0123456789abcdef0123456789abcdef01234567",
    stage: 2,
    path: "package.json",
  });
  let summary = "";
  const status = runCli(["--main", "0123456789abcdef0123456789abcdef01234567"], {
    reconcileFn: () => planReconciliation(entries),
    summaryPath: "/tmp/summary",
    appendSummary: (_path, text) => {
      summary += text;
    },
    logError: () => {},
  });
  assert.equal(status, 1);
  assert.match(summary, /`package\.json`/u);
  assert.match(summary, /allowlist check failed/u);
  assert.match(summary, /synchronization and release were not promoted/u);
});

test("a changed upstream blob exits nonzero and reports the integrity failure", () => {
  const entries = conflictEntries();
  entries.find((entry) => entry.path === ".github/workflows/env-daemons.yml" && entry.stage === 3).object =
    "0123456789abcdef0123456789abcdef01234567";
  let summary = "";
  const status = runCli(["--main", "0123456789abcdef0123456789abcdef01234567"], {
    reconcileFn: () => planReconciliation(entries),
    summaryPath: "/tmp/summary",
    appendSummary: (_path, text) => {
      summary += text;
    },
    logError: () => {},
  });
  assert.equal(status, 1);
  assert.match(summary, /`\.github\/workflows\/env-daemons\.yml`/u);
  assert.match(summary, /blob-integrity check failed/u);
  assert.match(summary, /synchronization and release were not promoted/u);
});

test("rejects a changed candidate workflow blob", () => {
  const entries = conflictEntries();
  entries.find((entry) => entry.path === ".github/workflows/build-binaries.yml" && entry.stage === 2).object =
    "0123456789abcdef0123456789abcdef01234567";
  assert.throws(() => planReconciliation(entries), /candidate workflow blob changed/u);
});

test("real reconciliation stages verified files and permits a two-parent merge commit", (t) => {
  const { root, candidate, main, expectations } = createConflictedRepository(t);
  reconcile(main, { root, expectations });
  assert.equal(git(root, ["ls-files", "--unmerged"]).trim(), "");
  for (const [path, expected] of expectations) {
    assert.equal(git(root, ["rev-parse", `:${path}`]).trim(), expected.ours);
  }
  git(root, ["commit", "--quiet", "--no-edit"]);
  assert.equal(git(root, ["show", "-s", "--format=%P", "HEAD"]).trim(), `${candidate} ${main}`);
});

test("real reconciliation rejects a MERGE_HEAD mismatch", (t) => {
  const { root, candidate, expectations } = createConflictedRepository(t);
  assert.throws(() => reconcile(candidate, { root, expectations }), /MERGE_HEAD .* does not match/u);
});

test("real reconciliation rejects an incomplete conflict set", (t) => {
  const { root, main, expectations } = createConflictedRepository(t);
  const resolvedEarly = CONFLICT_PATHS[2];
  git(root, ["checkout", "--ours", "--", resolvedEarly]);
  git(root, ["add", "--", resolvedEarly]);
  assert.throws(() => reconcile(main, { root, expectations }), /merge conflict set changed/u);
});

test("real reconciliation rejects changed pinned tree blobs before staging", (t) => {
  const { root, main, expectations } = createConflictedRepository(t);
  const before = git(root, ["ls-files", "--unmerged", "-z"]);
  const changed = new Map(expectations);
  const path = CONFLICT_PATHS[1];
  changed.set(path, { ...changed.get(path), theirs: "0123456789abcdef0123456789abcdef01234567" });
  assert.throws(() => reconcile(main, { root, expectations: changed }), /upstream tree blob changed/u);
  assert.equal(git(root, ["ls-files", "--unmerged", "-z"]), before);
});

test("real reconciliation rejects residual conflicts after attempted staging", (t) => {
  const { root, main, expectations } = createConflictedRepository(t);
  const skipped = CONFLICT_PATHS[2];
  const gitFn = (args) => {
    if (args[0] === "add" && args.at(-1) === skipped) return "";
    if (args[0] === "rev-parse" && args[1] === `:${skipped}`) return `${expectations.get(skipped).ours}\n`;
    return git(root, args);
  };
  assert.throws(
    () => reconcile(main, { root, expectations, gitFn }),
    /unmerged paths remain after workflow reconciliation/u,
  );
  assert.match(git(root, ["ls-files", "--unmerged"]), new RegExp(skipped.replaceAll(".", "\\."), "u"));
});
