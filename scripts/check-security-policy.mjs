import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

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
  "nix.yml": ["pin", "build", "update-stable"],
  "pr-gate.yml": ["check-contributor"],
  "publish-model-catalog.yml": ["generate", "publish"],
  "remove-inprogress-on-close.yml": ["remove-label"],
};
const FORK_ONLY_JOBS = {
  "release-pion.yml": ["build", "stage-github-release", "publish-github-release", "cleanup-draft-github-release"],
  "sync-upstream.yml": ["sync-main", "sync-dev", "prepare-pion-tag", "publish-pion-tag"],
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

function parseStepLines(lines) {
  if (lines.some((line) => line.trim() && !line.startsWith("      "))) return undefined;
  const source = lines.map((line) => (line.startsWith("      ") ? line.slice(6) : line)).join("\n");
  let document;
  try {
    document = parseDocument(source, {
      keepSourceTokens: true,
      logLevel: "silent",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch {
    return undefined;
  }
  if (document.errors.length > 0 || document.warnings.length > 0 || !isSeq(document.contents)) return undefined;
  const sequence = document.contents;
  if (sequence.items.length !== 1 || !isMap(sequence.items[0])) return undefined;
  const mapping = sequence.items[0];
  if (mapping.items.some((pair) => !isScalar(pair.key) || typeof pair.key.value !== "string")) return undefined;
  const keys = mapping.items.map((pair) => pair.key.value);
  if (new Set(keys).size !== keys.length) return undefined;
  return { mapping, sequence };
}

function jobSteps(lines, job) {
  const starts = [];
  for (let index = job.start + 1; index < job.end; index += 1) {
    if (/^      -\s+/u.test(lines[index])) starts.push(index);
  }
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? job.end;
    const stepLines = lines.slice(start, end);
    const parsed = parseStepLines(stepLines);
    const namePair = parsed?.mapping.items.find((pair) => pair.key.value === "name");
    const name = namePair && isScalar(namePair.value) && typeof namePair.value.value === "string" ? namePair.value.value : undefined;
    return { start, end, name, lines: stepLines, parsed };
  });
}

function activeRunLines(step) {
  const parsed = step.parsed ?? parseStepLines(step.lines);
  const runPair = parsed?.mapping.items.find((pair) => pair.key.value === "run");
  if (!runPair || !isScalar(runPair.value) || typeof runPair.value.value !== "string") return [];
  return runPair.value.value
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
}

function scalarMatches(node, value, type) {
  return isScalar(node) && node.value === value && (!type || node.type === type) && !node.anchor && !node.tag;
}

function mappingMatches(mapping, expectedEntries) {
  if (!isMap(mapping) || mapping.flow || mapping.anchor || mapping.tag || mapping.items.length !== expectedEntries.length) return false;
  return mapping.items.every((pair, index) => {
    const [expectedKey, expectedValue] = expectedEntries[index];
    return scalarMatches(pair.key, expectedKey) && scalarMatches(pair.value, expectedValue);
  });
}

function criticalStepMatches(step, contract) {
  const parsed = step.parsed ?? parseStepLines(step.lines);
  if (!parsed || parsed.sequence.flow || parsed.sequence.anchor || parsed.sequence.tag || parsed.mapping.flow) return false;
  const keys = parsed.mapping.items.map((pair) => pair.key.value);
  if (keys.join("\n") !== contract.keys.join("\n")) return false;
  for (const pair of parsed.mapping.items) {
    const key = pair.key.value;
    if (!scalarMatches(pair.key, key)) return false;
    if (key === "name" && !scalarMatches(pair.value, contract.name)) return false;
    if (key === "id" && !scalarMatches(pair.value, contract.id)) return false;
    if (key === "env" && !mappingMatches(pair.value, contract.env)) return false;
    if (key === "run" && !scalarMatches(pair.value, pair.value?.value, "BLOCK_LITERAL")) return false;
  }
  return createHash("sha256").update(activeRunLines(step).join("\n")).digest("hex") === contract.bodyDigest;
}

function checkSyncUpstreamContract(lines, jobs, fileName, errors) {
  const expectedJobNames = ["sync-main", "sync-dev", "prepare-pion-tag", "publish-pion-tag"];
  if (jobs.map((job) => job.name).join("\n") !== expectedJobNames.join("\n")) {
    errors.push(`${fileName}: jobs must exactly match the security-reviewed order`);
  }
  const secretReferenceLines = lines.filter((line) => /\bsecrets(?:\.|\[)/u.test(line));
  if (
    secretReferenceLines.length !== 1 ||
    secretReferenceLines[0].trim() !== "PION_SYNC_DEPLOY_KEY: ${{ secrets.PION_SYNC_DEPLOY_KEY }}"
  ) {
    errors.push(`${fileName}: workflow secret references must be limited to the exact deploy-key injection`);
  }

  const expectedSteps = {
    "sync-main": ["Checkout fork product branch", "Fast-forward fork main from upstream"],
    "sync-dev": [
      "Checkout Pion product branch",
      "Classify merge candidate",
      "Publish merge candidate",
      "Run CI on merge candidate",
      "Promote tested candidate to dev",
      "Remove merge candidate branch",
    ],
    "prepare-pion-tag": ["Checkout current Pion dev source", "Setup Node.js", "Prepare Pion tag publication"],
    "publish-pion-tag": ["Prepare trusted tag publication state", "Publish exact Pion tag"],
  };
  const stepsByJob = new Map();
  for (const [jobName, expected] of Object.entries(expectedSteps)) {
    const job = jobs.find((candidate) => candidate.name === jobName);
    if (!job) continue;
    const steps = jobSteps(lines, job);
    stepsByJob.set(jobName, steps);
    if (steps.some((step) => !step.name)) {
      errors.push(`${fileName}: job ${jobName} contains an unnamed step`);
    }
    if (steps.map((step) => step.name ?? "<unnamed>").join("\n") !== expected.join("\n")) {
      errors.push(`${fileName}: job ${jobName} steps must exactly match the security-reviewed order`);
    }
  }

  const allSteps = [...stepsByJob.entries()].flatMap(([jobName, steps]) => steps.map((step) => ({ jobName, ...step })));
  const criticalStepContracts = [
    {
      jobName: "sync-dev",
      name: "Classify merge candidate",
      keys: ["name", "id", "env", "run"],
      id: "candidate",
      env: [["SYNCED_MAIN_SHA", "${{ needs.sync-main.outputs.main_sha }}"]],
      bodyDigest: "9f950a78888f3df66873c947235dd0227e8b03aab99a2f78b0ca9fae8f709b96",
    },
    {
      jobName: "prepare-pion-tag",
      name: "Prepare Pion tag publication",
      keys: ["name", "id", "env", "run"],
      id: "prepare",
      env: [["GH_TOKEN", "${{ github.token }}"]],
      bodyDigest: "b5775348f4f9be20057244461032553e5a010715b56e36306c52f6707b2cbd1c",
    },
    {
      jobName: "publish-pion-tag",
      name: "Prepare trusted tag publication state",
      keys: ["name", "env", "run"],
      env: [
        ["DEV_SHA", "${{ needs.prepare-pion-tag.outputs.dev_sha }}"],
        ["UPSTREAM_SHA", "${{ needs.prepare-pion-tag.outputs.upstream_sha }}"],
        ["UPSTREAM_TAG", "${{ needs.prepare-pion-tag.outputs.upstream_tag }}"],
        ["VERSION", "${{ needs.prepare-pion-tag.outputs.version }}"],
        ["PION_TAG", "${{ needs.prepare-pion-tag.outputs.pion_tag }}"],
        ["SOURCE_VALIDATED", "${{ needs.prepare-pion-tag.outputs.source_validated }}"],
        ["RELEASE_ELIGIBLE", "${{ needs.prepare-pion-tag.outputs.release_eligible }}"],
        ["PUBLISH_REQUIRED", "${{ needs.prepare-pion-tag.outputs.publish_required }}"],
      ],
      bodyDigest: "0295ad4dae23eb65c43d36deef83f81ec9d2213eb2f209726947b4728646f730",
    },
    {
      jobName: "publish-pion-tag",
      name: "Publish exact Pion tag",
      keys: ["name", "env", "run"],
      env: [
        ["DEV_SHA", "${{ needs.prepare-pion-tag.outputs.dev_sha }}"],
        ["PION_TAG", "${{ needs.prepare-pion-tag.outputs.pion_tag }}"],
        ["PION_SYNC_DEPLOY_KEY", "${{ secrets.PION_SYNC_DEPLOY_KEY }}"],
      ],
      bodyDigest: "e536ce601a692897e26ea03a301d359deab2bdb2c88be3c48ccfb8951cff1473",
    },
  ];
  for (const contract of criticalStepContracts) {
    const matches = allSteps.filter((step) => step.jobName === contract.jobName && step.name === contract.name);
    const step = matches[0];
    if (
      matches.length !== 1 ||
      !criticalStepMatches(step, contract)
    ) {
      errors.push(`${fileName}: ${contract.name} must exactly match its security-reviewed structure and active command body`);
    }
  }
  if (allSteps.some((step) => activeRunLines(step).some((line) => /\bGITHUB_(?:ENV|STATE)\b/u.test(line)))) {
    errors.push(`${fileName}: sync steps must not persist environment or state for later credential-bearing steps`);
  }

  const deployKeyConsumers = allSteps.filter((step) => step.lines.some((line) => /secrets\.PION_SYNC_DEPLOY_KEY/u.test(line)));
  if (
    deployKeyConsumers.length !== 1 ||
    deployKeyConsumers[0].jobName !== "publish-pion-tag" ||
    deployKeyConsumers[0].name !== "Publish exact Pion tag"
  ) {
    errors.push(`${fileName}: PION_SYNC_DEPLOY_KEY must have exactly one approved consumer`);
  }

  const sourceValidationSteps = allSteps.filter((step) => step.lines.some((line) => /create-pion-release\.mjs/u.test(line)));
  if (
    sourceValidationSteps.length !== 1 ||
    sourceValidationSteps[0].jobName !== "prepare-pion-tag" ||
    sourceValidationSteps[0].name !== "Prepare Pion tag publication" ||
    !activeRunLines(sourceValidationSteps[0]).includes('node scripts/create-pion-release.mjs --validate-source --version "${version}"') ||
    sourceValidationSteps[0].lines.some((line) => /\bsecrets\./u.test(line))
  ) {
    errors.push(`${fileName}: release source validation must run exactly once in the secretless preparation job`);
  }

  const classifier = stepsByJob.get("sync-dev")?.find((step) => step.name === "Classify merge candidate");
  if (
    !classifier ||
    !activeRunLines(classifier).includes('node scripts/classify-upstream-merge.mjs "${dev_sha}" "${main_sha}"') ||
    classifier.lines.some((line) => /\b(?:GH_TOKEN|PION_SYNC_DEPLOY_KEY|secrets\.)/u.test(line))
  ) {
    errors.push(`${fileName}: merge classification must use the production policy script without credentials`);
  }

  const trusted = stepsByJob.get("publish-pion-tag")?.find((step) => step.name === "Prepare trusted tag publication state");
  const trustedLines = trusted ? activeRunLines(trusted) : [];
  const requiredTrustedLines = [
    '[[ "${DEV_SHA}" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "${UPSTREAM_SHA}" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "${UPSTREAM_TAG}" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]',
    '[[ "${VERSION}" == "${UPSTREAM_TAG#v}" ]]',
    '[[ "${PION_TAG}" == "pion-${UPSTREAM_TAG}" ]]',
    '[[ "${SOURCE_VALIDATED}" == "true" ]]',
    '[[ "${RELEASE_ELIGIBLE}" == "true" ]]',
    '[[ "${PUBLISH_REQUIRED}" == "true" ]]',
    '[[ "$(git -C "${publish_root}" rev-parse refs/remotes/origin/dev)" == "${DEV_SHA}" ]]',
    '[[ "$(git -C "${publish_root}" rev-list -n 1 refs/pion-upstream-release)" == "${UPSTREAM_SHA}" ]]',
    'git -C "${publish_root}" merge-base --is-ancestor "${UPSTREAM_SHA}" "${DEV_SHA}"',
    '[[ "${tag_status}" == "2" ]]',
    '[[ -s "${known_hosts}" ]]',
  ];
  if (
    !trusted ||
    requiredTrustedLines.some((line) => !trustedLines.includes(line)) ||
    !trustedLines.some((line) => line.includes('ls-remote --exit-code --refs origin "refs/tags/${PION_TAG}"')) ||
    !trustedLines.some((line) => line.includes("https://api.github.com/meta")) ||
    trusted.lines.some((line) => /\b(?:GH_TOKEN|PION_SYNC_DEPLOY_KEY|secrets\.)/u.test(line))
  ) {
    errors.push(`${fileName}: trusted tag preparation must independently and exactly revalidate publication state`);
  }

  const publisher = stepsByJob.get("publish-pion-tag")?.find((step) => step.name === "Publish exact Pion tag");
  const expectedPublisherLines = [
    "set -euo pipefail",
    'key_path="${RUNNER_TEMP}/pion-sync-deploy-key"',
    'known_hosts="${RUNNER_TEMP}/pion-sync-known-hosts"',
    "trap 'rm -f \"${key_path}\"' EXIT",
    'test -n "${PION_SYNC_DEPLOY_KEY}"',
    "printf '%s\\n' \"${PION_SYNC_DEPLOY_KEY}\" > \"${key_path}\"",
    'chmod 0600 "${key_path}"',
    'GIT_SSH_COMMAND="ssh -i ${key_path} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${known_hosts}" \\',
    '  git -c core.hooksPath=/dev/null -C "${RUNNER_TEMP}/pion-tag-publish" push "git@github.com:pablontiv/pi.git" \\',
    '    "${DEV_SHA}:refs/tags/${PION_TAG}"',
  ];
  if (
    !publisher ||
    activeRunLines(publisher).join("\n") !== expectedPublisherLines.join("\n") ||
    publisher.lines.some((line) => /\bGH_TOKEN\b|\buses:|git\s+send-pack|https?:\/\//u.test(line)) ||
    publisher.lines.filter((line) => /secrets\.PION_SYNC_DEPLOY_KEY/u.test(line)).length !== 1
  ) {
    errors.push(`${fileName}: secret-bearing tag step must contain only the exact SSH tag push contract`);
  }
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
    checkSyncUpstreamContract(lines, jobs, fileName, errors);
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
