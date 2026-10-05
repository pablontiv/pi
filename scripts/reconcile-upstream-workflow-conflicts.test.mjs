import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EXPECTED_WORKFLOW_CONFLICTS,
  parseUnmergedEntries,
  planReconciliation,
  runCli,
} from "./reconcile-upstream-workflow-conflicts.mjs";

function conflictEntries(paths = [...EXPECTED_WORKFLOW_CONFLICTS.keys()]) {
  return paths.flatMap((path) => {
    const expected = EXPECTED_WORKFLOW_CONFLICTS.get(path);
    return [
      { mode: "100644", object: expected.ours, stage: 2, path },
      { mode: "100644", object: expected.theirs, stage: 3, path },
    ];
  });
}

test("parses NUL-delimited unmerged index entries", () => {
  const [path, expected] = EXPECTED_WORKFLOW_CONFLICTS.entries().next().value;
  const output = `100644 ${expected.ours} 2\t${path}\0`;
  assert.deepEqual(parseUnmergedEntries(output), [
    { mode: "100644", object: expected.ours, stage: 2, path },
  ]);
});

test("accepts the complete verified workflow conflict set", () => {
  assert.deepEqual(planReconciliation(conflictEntries()), [...EXPECTED_WORKFLOW_CONFLICTS.keys()].sort());
});

test("accepts a verified subset when Git merges other allowlisted paths normally", () => {
  const path = ".github/workflows/env.yml";
  assert.deepEqual(planReconciliation(conflictEntries([path])), [path]);
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
  const entries = conflictEntries([".github/workflows/env-daemons.yml"]);
  entries.find((entry) => entry.stage === 3).object = "0123456789abcdef0123456789abcdef01234567";
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
  const entries = conflictEntries([".github/workflows/build-binaries.yml"]);
  entries.find((entry) => entry.stage === 2).object = "0123456789abcdef0123456789abcdef01234567";
  assert.throws(() => planReconciliation(entries), /candidate workflow blob changed/u);
});

test("rejects a conflict without both candidate and upstream stages", () => {
  const entries = conflictEntries([".github/workflows/env.yml"]).filter((entry) => entry.stage !== 3);
  assert.throws(() => planReconciliation(entries), /expected both candidate and upstream stages/u);
});
