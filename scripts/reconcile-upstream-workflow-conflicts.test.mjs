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

function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["pipe", "pipe", "pipe"],
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

function createConflictedRepository(t, { additionalConflictPaths = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-upstream-reconcile-"));
  const allConflictPaths = [...CONFLICT_PATHS, ...additionalConflictPaths].sort();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet", "--initial-branch=dev"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);

  write(root, CONFLICT_PATHS[0], "base build workflow\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();

  for (const path of allConflictPaths) write(root, path, `candidate ${path}\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "candidate"]);
  const candidate = git(root, ["rev-parse", "HEAD"]).trim();

  git(root, ["checkout", "--quiet", "-b", "main", base]);
  for (const path of allConflictPaths) write(root, path, `upstream ${path}\n`);
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
    allConflictPaths,
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

test("real CLI reconciliation rejects and reports an unknown conflicted path", (t) => {
  const unknownPath = ".github/workflows/unexpected.yml";
  const { root, main, expectations } = createConflictedRepository(t, {
    additionalConflictPaths: [unknownPath],
  });
  let summary = "";
  const status = runCli(["--main", main], {
    reconcileFn: (sha) => reconcile(sha, { root, expectations }),
    summaryPath: "/tmp/summary",
    appendSummary: (_path, text) => {
      summary += text;
    },
    logError: () => {},
  });
  assert.equal(status, 1);
  assert.ok(summary.includes("`" + unknownPath + "`"));
  assert.match(summary, /allowlist check failed/u);
  assert.match(summary, /synchronization and release were not promoted/u);
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

test("real CLI reconciliation rejects and reports a changed upstream tree blob", (t) => {
  const { root, main, expectations } = createConflictedRepository(t);
  const before = git(root, ["ls-files", "--unmerged", "-z"]);
  const changed = new Map(expectations);
  const path = CONFLICT_PATHS[1];
  const previouslyPinnedBlob = git(root, ["hash-object", "-w", "--stdin"], "previous upstream workflow\n").trim();
  changed.set(path, { ...changed.get(path), theirs: previouslyPinnedBlob });
  let summary = "";
  const status = runCli(["--main", main], {
    reconcileFn: (sha) => reconcile(sha, { root, expectations: changed }),
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
  assert.equal(git(root, ["ls-files", "--unmerged", "-z"]), before);
});

test("real CLI reconciliation reports a post-stage blob-integrity failure", (t) => {
  const { root, main, expectations } = createConflictedRepository(t);
  const path = CONFLICT_PATHS[0];
  const wrongBlob = git(root, ["hash-object", "-w", "--stdin"], "incorrect staged workflow\n").trim();
  const gitFn = (args) => {
    const result = git(root, args);
    if (args[0] === "add" && args.at(-1) === path) {
      git(root, ["update-index", "--cacheinfo", `100644,${wrongBlob},${path}`]);
    }
    return result;
  };
  let summary = "";
  const status = runCli(["--main", main], {
    reconcileFn: (sha) => reconcile(sha, { root, expectations, gitFn }),
    summaryPath: "/tmp/summary",
    appendSummary: (_path, text) => {
      summary += text;
    },
    logError: () => {},
  });
  assert.equal(status, 1);
  assert.equal(git(root, ["rev-parse", `:${path}`]).trim(), wrongBlob);
  assert.match(summary, /`\.github\/workflows\/build-binaries\.yml`/u);
  assert.match(summary, /staging-integrity check failed/u);
  assert.match(summary, /synchronization and release were not promoted/u);
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
