import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export const EXPECTED_WORKFLOW_CONFLICTS = new Map([
  [
    ".github/workflows/build-binaries.yml",
    {
      ours: "ad08ebb8a06c2d50798d997a17519ec0b25af955",
      theirs: "5bafe00efabef2ca87bc0ef9b89b0b0981255a66",
    },
  ],
  [
    ".github/workflows/env-daemons.yml",
    {
      ours: "b8643c42eab72ee9fafe7b102351c8fc7ff320e2",
      theirs: "2164628d15effad2748455d3d76bbf9aed8c401d",
    },
  ],
  [
    ".github/workflows/env.yml",
    {
      ours: "087853ad8aa2310a93ce6b452ec019295bbdf9e1",
      theirs: "fc866f62b02d87c09631a450a8e88e7416911d46",
    },
  ],
]);

function gitAt(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function parseUnmergedEntries(output) {
  if (!output) return [];
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^([0-7]{6}) ([0-9a-f]{40}) ([123])\t(.+)$/su);
      if (!match) throw new Error(`invalid unmerged index entry: ${JSON.stringify(record)}`);
      return { mode: match[1], object: match[2], stage: Number(match[3]), path: match[4] };
    });
}

class ReconciliationError extends Error {
  constructor(message, kind, paths) {
    super(message);
    this.kind = kind;
    this.paths = paths;
  }
}

export function planReconciliation(entries, expectations = EXPECTED_WORKFLOW_CONFLICTS) {
  const conflictPaths = [...new Set(entries.map((entry) => entry.path))].sort();
  const expectedPaths = [...expectations.keys()].sort();
  if (entries.length === 0) {
    throw new ReconciliationError("merge failed without any unmerged paths", "conflict-set", []);
  }
  if (
    conflictPaths.length !== expectedPaths.length ||
    conflictPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new ReconciliationError(
      `merge conflict set changed; expected ${expectedPaths.join(", ")}; found ${conflictPaths.join(", ")}`,
      "allowlist",
      conflictPaths,
    );
  }

  const stagesByPath = new Map();
  for (const entry of entries) {
    const stages = stagesByPath.get(entry.path) ?? new Map();
    if (stages.has(entry.stage)) {
      throw new ReconciliationError(
        `duplicate merge stage ${entry.stage} for ${entry.path}`,
        "blob-integrity",
        conflictPaths,
      );
    }
    stages.set(entry.stage, entry.object);
    stagesByPath.set(entry.path, stages);
  }

  for (const path of expectedPaths) {
    const stages = stagesByPath.get(path);
    const expected = expectations.get(path);
    if (!stages.has(2) || !stages.has(3)) {
      throw new ReconciliationError(
        `expected both candidate and upstream stages for ${path}`,
        "blob-integrity",
        conflictPaths,
      );
    }
    if (stages.get(2) !== expected.ours) {
      throw new ReconciliationError(
        `candidate workflow blob changed for ${path}: ${stages.get(2)}`,
        "blob-integrity",
        conflictPaths,
      );
    }
    if (stages.get(3) !== expected.theirs) {
      throw new ReconciliationError(
        `upstream workflow blob changed for ${path}: ${stages.get(3)}`,
        "blob-integrity",
        conflictPaths,
      );
    }
  }
  return expectedPaths;
}

function verifyPinnedTrees(mainSha, expectations, gitFn, conflictPaths) {
  for (const [path, expected] of expectations) {
    let ours;
    let theirs;
    try {
      ours = gitFn(["rev-parse", `HEAD:${path}`]).trim();
      theirs = gitFn(["rev-parse", `${mainSha}:${path}`]).trim();
    } catch {
      throw new ReconciliationError(`pinned workflow is absent from candidate or upstream: ${path}`, "blob-integrity", conflictPaths);
    }
    if (ours !== expected.ours) {
      throw new ReconciliationError(`candidate tree blob changed for ${path}: ${ours}`, "blob-integrity", conflictPaths);
    }
    if (theirs !== expected.theirs) {
      throw new ReconciliationError(`upstream tree blob changed for ${path}: ${theirs}`, "blob-integrity", conflictPaths);
    }
  }
}

export function reconcile(
  mainSha,
  {
    root = ROOT,
    expectations = EXPECTED_WORKFLOW_CONFLICTS,
    gitFn = (args) => gitAt(root, args),
  } = {},
) {
  if (!SHA_PATTERN.test(mainSha)) throw new Error(`invalid main SHA: ${mainSha}`);
  const expectedMain = gitFn(["rev-parse", `${mainSha}^{commit}`]).trim();
  const mergeHead = gitFn(["rev-parse", "MERGE_HEAD"]).trim();
  if (mergeHead !== expectedMain) {
    throw new Error(`MERGE_HEAD ${mergeHead} does not match expected main ${expectedMain}`);
  }

  const entries = parseUnmergedEntries(gitFn(["ls-files", "--unmerged", "-z"]));
  const conflictPaths = [...new Set(entries.map((entry) => entry.path))].sort();
  verifyPinnedTrees(expectedMain, expectations, gitFn, conflictPaths);
  const paths = planReconciliation(entries, expectations);
  for (const path of paths) {
    gitFn(["checkout", "--ours", "--", path]);
    gitFn(["add", "--", path]);
    const staged = gitFn(["rev-parse", `:${path}`]).trim();
    const expected = expectations.get(path).ours;
    if (staged !== expected) {
      throw new ReconciliationError(
        `failed to stage the verified candidate workflow for ${path}`,
        "staging-integrity",
        conflictPaths,
      );
    }
  }

  const remaining = parseUnmergedEntries(gitFn(["ls-files", "--unmerged", "-z"]));
  if (remaining.length > 0) {
    throw new ReconciliationError(
      "unmerged paths remain after workflow reconciliation",
      "residual-conflict",
      [...new Set(remaining.map((entry) => entry.path))].sort(),
    );
  }
  console.log(`Reconciled verified workflow conflicts: ${paths.join(", ")}`);
}

export function runCli(
  args,
  {
    reconcileFn = reconcile,
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    appendSummary = appendFileSync,
    logError = console.error,
  } = {},
) {
  if (args.length !== 2 || args[0] !== "--main") {
    logError("usage: node scripts/reconcile-upstream-workflow-conflicts.mjs --main <sha>");
    return 2;
  }

  try {
    reconcileFn(args[1]);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof ReconciliationError ? error.kind : "reconciliation";
    const paths = error instanceof ReconciliationError ? error.paths : [];
    if (summaryPath) {
      const files = paths.length > 0 ? paths.map((path) => `\`${path}\``).join(", ") : "unavailable";
      appendSummary(
        summaryPath,
        `## Upstream synchronization blocked\n\n- Conflicting files: ${files}\n- Safety check: ${kind} check failed\n- Result: synchronization and release were not promoted.\n`,
      );
    }
    logError(message);
    return 1;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  process.exitCode = runCli(process.argv.slice(2));
}
