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
      ours: "6fbdef2b51c3f6948e4eb455123cb1987e1d4906",
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

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
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
  if (entries.length === 0) {
    throw new ReconciliationError("merge failed without any unmerged paths", "conflict-state", []);
  }

  const stagesByPath = new Map();
  for (const entry of entries) {
    if (!expectations.has(entry.path)) {
      throw new ReconciliationError(`unexpected merge conflict: ${entry.path}`, "allowlist", conflictPaths);
    }
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

  const paths = [...stagesByPath.keys()].sort();
  for (const path of paths) {
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
  return paths;
}

export function reconcile(mainSha) {
  if (!SHA_PATTERN.test(mainSha)) throw new Error(`invalid main SHA: ${mainSha}`);
  const expectedMain = git(["rev-parse", `${mainSha}^{commit}`]).trim();
  const mergeHead = git(["rev-parse", "MERGE_HEAD"]).trim();
  if (mergeHead !== expectedMain) {
    throw new Error(`MERGE_HEAD ${mergeHead} does not match expected main ${expectedMain}`);
  }

  const entries = parseUnmergedEntries(git(["ls-files", "--unmerged", "-z"]));
  const paths = planReconciliation(entries);
  for (const path of paths) {
    git(["checkout", "--ours", "--", path]);
    git(["add", "--", path]);
    const staged = git(["rev-parse", `:${path}`]).trim();
    const expected = EXPECTED_WORKFLOW_CONFLICTS.get(path).ours;
    if (staged !== expected) throw new Error(`failed to stage the verified candidate workflow for ${path}`);
  }

  const remaining = parseUnmergedEntries(git(["ls-files", "--unmerged", "-z"]));
  if (remaining.length > 0) throw new Error("unmerged paths remain after workflow reconciliation");
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
