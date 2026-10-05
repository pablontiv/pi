import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const WORKFLOW_PATTERN = /\.(?:yml|yaml)$/;
const REQUIRED_IGNORED_PATHS = [
  ".env",
  ".env.local",
  ".pypirc",
  ".netrc",
  ".authinfo",
  "private.agekey",
  "id_ed25519",
  "certificate.pem",
  "signing.key",
  "credentials.json",
  "service-account-production.json",
  "secret.decrypted.yaml",
];
const ALLOWED_ENV_EXAMPLES = [".env.example", ".env.local.example"];
const UPSTREAM_ONLY_JOBS = {
  "approve-contributor.yml": ["approve"],
  "build-binaries.yml": [
    "build",
    "smoke-test-binaries",
    "stage-github-release",
    "env-daemons",
    "publish-npm",
    "announce-pi-dev-release",
    "publish-github-release",
    "cleanup-draft-github-release",
  ],
  "issue-analysis.yml": ["authorize", "analyze"],
  "issue-gate.yml": ["check-contributor"],
  "issue-triage-labels.yml": ["update-labels"],
  "nix.yml": ["pin", "build", "update-stable", "commit-pin"],
  "pr-gate.yml": ["check-contributor"],
  "publish-model-catalog.yml": ["generate", "publish"],
  "remove-inprogress-on-close.yml": ["remove-label"],
};
const FORK_ONLY_JOBS = {
  "release-pion.yml": ["build", "stage-github-release", "publish-github-release", "cleanup-draft-github-release"],
  "sync-upstream.yml": ["sync-main", "sync-dev", "tag-pion-release"],
};
const SCHEDULE_GUARD_EXEMPT_WORKFLOWS = new Set(["npm-audit.yml"]);
const REQUIRED_CODEOWNERS = [
  "* @pablontiv",
  "/.github/** @pablontiv",
  "/.gitignore @pablontiv",
  "/.husky/** @pablontiv",
  "/.npmrc @pablontiv",
  "/CONTRIBUTING.md @pablontiv",
  "/LICENSE @pablontiv",
  "/SECURITY.md @pablontiv",
];

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indentation(line) {
  return line.match(/^\s*/u)?.[0].length ?? 0;
}

function workflowFiles(root) {
  const workflowRoot = join(root, ".github", "workflows");
  if (!statSafe(workflowRoot)?.isDirectory()) {
    throw new Error(`${workflowRoot} is missing`);
  }
  return readdirSync(workflowRoot)
    .filter((name) => WORKFLOW_PATTERN.test(name))
    .sort()
    .map((name) => join(workflowRoot, name));
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function topLevelPermissions(lines, fileName, errors) {
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^permissions:\s*/u.test(line));
  if (matches.length !== 1) {
    errors.push(`${fileName}: expected exactly one top-level permissions declaration`);
    return;
  }

  const { line, index } = matches[0];
  const inline = line.slice("permissions:".length).trim();
  if (inline === "{}") return;
  if (inline && !/^\{[^}]*\}$/u.test(inline)) {
    errors.push(`${fileName}: top-level permissions must be a mapping of read or none`);
    return;
  }

  const values = [];
  if (inline) {
    for (const pair of inline.slice(1, -1).split(",")) {
      const match = pair.match(/:\s*([^,]+)$/u);
      if (match) values.push(unquote(match[1]));
    }
  } else {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim() && indentation(candidate) === 0) break;
      const permission = candidate.match(/^\s{2}[\w-]+:\s*(\S+)\s*(?:#.*)?$/u);
      if (permission) values.push(unquote(permission[1]));
    }
  }

  if (values.length === 0 || values.some((value) => value !== "read" && value !== "none")) {
    errors.push(`${fileName}: top-level permissions must be explicit read-only values or {}`);
  }
}

function topLevelConcurrency(lines, fileName, errors) {
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^concurrency:\s*/u.test(line));
  if (matches.length !== 1) {
    errors.push(`${fileName}: expected exactly one top-level concurrency declaration`);
    return;
  }

  const { line, index } = matches[0];
  if (line.slice("concurrency:".length).trim()) {
    errors.push(`${fileName}: top-level concurrency must declare group and cancel-in-progress`);
    return;
  }

  const block = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const candidate = lines[cursor];
    if (candidate.trim() && indentation(candidate) === 0) break;
    block.push(candidate);
  }
  if (!block.some((candidate) => /^\s{2}group:\s*\S/u.test(candidate))) {
    errors.push(`${fileName}: top-level concurrency must declare a group`);
  }
  if (!block.some((candidate) => /^\s{2}cancel-in-progress:\s*(?:true|false|\$\{\{.+\}\})\s*(?:#.*)?$/u.test(candidate))) {
    errors.push(`${fileName}: top-level concurrency must declare cancel-in-progress`);
  }
}

function jobBlocks(lines) {
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex < 0) return [];
  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (/^\S/u.test(lines[index]) && lines[index].trim()) break;
    if (/^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/u.test(lines[index])) starts.push(index);
  }
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? lines.length;
    return { start, end, name: lines[start].trim().slice(0, -1) };
  });
}

function hasRepositoryGuard(lines, job, repositories) {
  return lines.slice(job.start + 1, job.end).some((line) => {
    const match = line.match(
      /^\s{4}if:\s*\$\{\{\s*github\.repository\s*==\s*(['"])([^'"]+)\1\s*(?:&&|\}\})/u,
    );
    return match ? repositories.includes(match[2]) : false;
  });
}

function checkRepositoryGuards(filePath, lines, jobs, errors) {
  const fileName = basename(filePath);
  for (const [repository, contracts] of [
    ["earendil-works/pi", UPSTREAM_ONLY_JOBS],
    ["pablontiv/pi", FORK_ONLY_JOBS],
  ]) {
    for (const jobName of contracts[fileName] ?? []) {
      const job = jobs.find((candidate) => candidate.name === jobName);
      if (!job) {
        errors.push(`${fileName}: required guarded job ${jobName} is missing`);
        continue;
      }
      if (!hasRepositoryGuard(lines, job, [repository])) {
        errors.push(`${fileName}: job ${jobName} must be guarded to ${repository}`);
      }
    }
  }

  const jobsStart = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  const workflowHeader = lines.slice(0, jobsStart < 0 ? lines.length : jobsStart);
  const hasSchedule = workflowHeader.some((line) => {
    return /^\s*schedule\s*:/u.test(line) || /^\s*on:\s*(?:\[[^\]]*\bschedule\b|\{[^}]*\bschedule\s*:)/u.test(line);
  });
  if (hasSchedule && !SCHEDULE_GUARD_EXEMPT_WORKFLOWS.has(fileName)) {
    for (const job of jobs) {
      if (!hasRepositoryGuard(lines, job, ["earendil-works/pi", "pablontiv/pi"])) {
        errors.push(`${fileName}: scheduled job ${job.name} must have a repository guard`);
      }
    }
  }
}

function checkoutBlock(lines, index) {
  const useIndent = indentation(lines[index]);
  const block = [];
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    const lineIndent = indentation(line);
    const startsSiblingStep = lineIndent === useIndent && /^\s*-\s+/u.test(line);
    if (cursor > index && line.trim() && (lineIndent < useIndent || startsSiblingStep)) break;
    block.push(line);
  }
  return block;
}

export function checkWorkflow(filePath) {
  const fileName = relative(dirname(dirname(filePath)), filePath);
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/u);
  const errors = [];
  topLevelPermissions(lines, fileName, errors);
  topLevelConcurrency(lines, fileName, errors);

  const jobs = jobBlocks(lines);
  if (jobs.length === 0) errors.push(`${fileName}: no jobs found`);
  checkRepositoryGuards(filePath, lines, jobs, errors);
  for (const job of jobs) {
    const jobLines = lines.slice(job.start + 1, job.end);
    const callsReusableWorkflow = jobLines.some((line) => /^    uses:\s*\S+/u.test(line));
    const hasTimeout = jobLines.some((line) => /^    timeout-minutes:\s*[1-9][0-9]*\s*(?:#.*)?$/u.test(line));
    // GitHub does not support timeout-minutes on jobs that call reusable workflows.
    // Their concrete jobs must carry timeouts in the called workflow instead.
    if (!callsReusableWorkflow && !hasTimeout) {
      errors.push(`${fileName}: job ${job.name} has no positive timeout-minutes`);
    }
  }

  const actionReferences = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(?:-\s*)?uses:\s*(\S+)/u);
    if (!match) continue;
    const reference = match[1].split("#", 1)[0];
    actionReferences.push(reference);
    if (reference.startsWith("./")) continue;
    const at = reference.lastIndexOf("@");
    if (at < 1 || !SHA_PATTERN.test(reference.slice(at + 1))) {
      errors.push(`${fileName}: action ${reference} is not pinned to a full 40-hex SHA`);
    }
    const actionName = reference.slice(0, at);
    const block = checkoutBlock(lines, index);
    if (actionName === "actions/checkout") {
      if (!block.some((line) => /^\s+persist-credentials:\s*false\s*(?:#.*)?$/u.test(line))) {
        errors.push(`${fileName}: actions/checkout must set persist-credentials: false`);
      }
    }
    if (actionName === "actions/setup-node") {
      if (!block.some((line) => /^\s+node-version:\s*["']?22\.19\.0["']?\s*(?:#.*)?$/u.test(line))) {
        errors.push(`${fileName}: actions/setup-node must pin node-version 22.19.0`);
      }
    }
  }
  if (actionReferences.length === 0) errors.push(`${fileName}: workflow has no actions to pin`);

  const workflowHeaderEnd = lines.findIndex((line) => /^(?:permissions|jobs):\s*/u.test(line));
  const workflowHeader = lines.slice(0, workflowHeaderEnd < 0 ? lines.length : workflowHeaderEnd).join("\n");
  const hasPullRequestTarget = /\bpull_request_target\b/u.test(workflowHeader);
  if (hasPullRequestTarget && filePath.endsWith("/pr-gate.yml") === false) {
    errors.push(`${fileName}: pull_request_target is only allowed in pr-gate.yml`);
  }
  if (filePath.endsWith("/sync-upstream.yml")) {
    if (!/git fetch --no-tags https:\/\/github\.com\/earendil-works\/pi\.git/u.test(text)) {
      errors.push(`${fileName}: must fetch upstream over the public read-only URL`);
    }
    if (!/git merge-base --is-ancestor/u.test(text)) {
      errors.push(`${fileName}: must refuse non-fast-forward main updates`);
    }
    const logicalShellText = text.replace(/\\\r?\n[ \t]*/gu, " ");
    if (
      /git push(?:\s+-{1,2}\S+)*\s+["']?(?:upstream\b|https:\/\/[^\s"']*github\.com\/earendil-works\/pi(?:\.git)?\b|git@github\.com:earendil-works\/pi(?:\.git)?\b)/u.test(
        logicalShellText,
      )
    ) {
      errors.push(`${fileName}: must never push to upstream`);
    }
    const checkoutRefs = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\s*(?:-\s*)?uses:\s*actions\/checkout@/u.test(lines[index])) continue;
      const ref = checkoutBlock(lines, index).find((line) => /^\s+ref:\s*\S+\s*(?:#.*)?$/u.test(line));
      if (ref) checkoutRefs.push(ref.replace(/^\s+ref:\s*/u, "").split(/\s+#/u, 1)[0]);
    }
    if (checkoutRefs.length !== 3 || checkoutRefs.some((ref) => unquote(ref) !== "dev")) {
      errors.push(`${fileName}: all three product checkout refs must be exactly dev`);
    }
  }
  if (filePath.endsWith("/pr-gate.yml")) {
    if (!hasPullRequestTarget) errors.push(`${fileName}: expected pull_request_target trigger`);
    if (actionReferences.some((reference) => !reference.startsWith("actions/github-script@"))) {
      errors.push(`${fileName}: pull_request_target may only use actions/github-script`);
    }
    if (/actions\/checkout@/u.test(text)) errors.push(`${fileName}: must not check out pull request code`);
    if (/pull_request\.(?:head|merge_commit_sha)\b/u.test(text)) {
      errors.push(`${fileName}: must not reference pull request source code or source ref`);
    }
    if (/^\s*(?:-\s*)?run:\s*/mu.test(text)) errors.push(`${fileName}: must not execute pull request code`);
    if (/\bsecrets\.|^\s*environment:\s*/mu.test(text)) {
      errors.push(`${fileName}: pull_request_target must not access secrets or environments`);
    }
  }

  return errors;
}

function gitOutput(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function checkGitignoreContract(root) {
  const errors = [];
  const sandbox = mkdtempSync(join(tmpdir(), "pi-security-ignore-"));
  try {
    writeFileSync(join(sandbox, ".gitignore"), readFileSync(join(root, ".gitignore")));
    gitOutput(sandbox, ["init", "--quiet"]);
    const candidates = `${REQUIRED_IGNORED_PATHS.join("\n")}\n`;
    const ignored = gitOutput(sandbox, ["check-ignore", "--no-index", "--stdin"], candidates)
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    if (ignored.join("\n") !== REQUIRED_IGNORED_PATHS.join("\n")) {
      errors.push(".gitignore does not ignore every required credential or secret path");
    }
    for (const example of ALLOWED_ENV_EXAMPLES) {
      try {
        const result = gitOutput(sandbox, ["check-ignore", "--no-index", example]).trim();
        if (result) errors.push(`.gitignore must allow ${example}`);
      } catch (error) {
        if (!(error && typeof error === "object" && "status" in error && error.status === 1)) {
          errors.push(`could not check whether .gitignore allows ${example}`);
        }
      }
    }
  } catch (error) {
    errors.push(`could not check .gitignore with isolated git: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  try {
    gitOutput(root, ["ls-files", "--error-unmatch", ".npmrc"]);
  } catch {
    errors.push("tracked .npmrc is missing");
  }
  return errors;
}

export function checkCodeownersContract(root) {
  const path = join(root, ".github", "CODEOWNERS");
  let lines;
  try {
    lines = new Set(
      readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  } catch (error) {
    return [`invalid CODEOWNERS contract: ${error instanceof Error ? error.message : String(error)}`];
  }
  const missing = REQUIRED_CODEOWNERS.filter((line) => !lines.has(line));
  return missing.map((line) => `.github/CODEOWNERS is missing: ${line}`);
}

function parseGroup(block) {
  const appliesTo = block.find((line) => /^\s{8}applies-to:/u.test(line))?.split(":").slice(1).join(":");
  const patterns = block
    .filter((line) => /^\s{10}-\s*/u.test(line))
    .map((line) => unquote(line.replace(/^\s{10}-\s*/u, "")));
  return { appliesTo: appliesTo ? unquote(appliesTo) : undefined, patterns };
}

export function parseDependabot(text) {
  const lines = text.split(/\r?\n/u);
  if (!/^version:\s*2\s*$/u.test(lines.find((line) => line.trim()) ?? "")) {
    throw new Error("dependabot.yml must declare version: 2");
  }
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^  - package-ecosystem:\s*(\S+)\s*$/u);
    if (match) starts.push({ index, ecosystem: unquote(match[1]) });
  }
  if (starts.length === 0) throw new Error("dependabot.yml must contain updates");
  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    const block = lines.slice(start.index, end);
    const groups = [];
    for (let index = 0; index < block.length; index += 1) {
      if (!/^      [A-Za-z0-9_-]+:\s*$/u.test(block[index])) continue;
      const groupEnd = block.slice(index + 1).findIndex((line) => /^      [A-Za-z0-9_-]+:\s*$/u.test(line));
      groups.push(parseGroup(block.slice(index + 1, groupEnd < 0 ? block.length : index + 1 + groupEnd)));
    }
    return {
      ecosystem: start.ecosystem,
      directory: block.find((line) => /^    directory:/u.test(line))?.split(":").slice(1).join(":").trim(),
      interval: block.find((line) => /^      interval:/u.test(line))?.split(":").slice(1).join(":").trim(),
      cooldown: block.find((line) => /^      default-days:/u.test(line))?.split(":").slice(1).join(":").trim(),
      groups,
    };
  });
}

export function checkDependabotContract(root) {
  const path = join(root, ".github", "dependabot.yml");
  const errors = [];
  let updates;
  try {
    updates = parseDependabot(readFileSync(path, "utf8"));
  } catch (error) {
    return [`invalid Dependabot contract: ${error instanceof Error ? error.message : String(error)}`];
  }
  const expected = new Set([
    "npm:/",
    "npm:/packages/coding-agent/install-lock",
    "github-actions:/",
  ]);
  const actual = new Set(updates.map((update) => `${update.ecosystem}:${update.directory}`));
  if (updates.length !== expected.size || actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry))) {
    errors.push("Dependabot must cover root npm, the coding-agent install lock, and GitHub Actions");
  }
  for (const update of updates) {
    if (update.interval !== "weekly") errors.push(`Dependabot ${update.ecosystem} schedule must be weekly`);
    if (update.cooldown !== "7") errors.push(`Dependabot ${update.ecosystem} cooldown must be 7 days`);
    if (update.groups.length !== 2 || new Set(update.groups.map((group) => group.appliesTo)).size !== 2 || update.groups.some((group) => !["version-updates", "security-updates"].includes(group.appliesTo) || group.patterns.length !== 1 || group.patterns[0] !== "*")) {
      errors.push(`Dependabot ${update.ecosystem} must group version and security updates for all packages`);
    }
  }
  return errors;
}

export function checkSecurityPolicy(root = ROOT) {
  const errors = [];
  for (const workflow of workflowFiles(root)) errors.push(...checkWorkflow(workflow));
  errors.push(...checkGitignoreContract(root));
  errors.push(...checkCodeownersContract(root));
  errors.push(...checkDependabotContract(root));
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    checkSecurityPolicy(ROOT);
    console.log("Security policy checks passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
