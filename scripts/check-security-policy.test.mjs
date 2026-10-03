import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkCodeownersContract,
  checkDependabotContract,
  checkGitignoreContract,
  checkSecurityPolicy,
  checkWorkflow,
  parseDependabot,
} from "./check-security-policy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const ACTION_SHA = "0123456789abcdef0123456789abcdef01234567";

function workflow(extra = "") {
  return `name: test
on: push
permissions:
  contents: read
concurrency:
  group: test
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${ACTION_SHA}
        with:
          persist-credentials: false
${extra}`;
}

test("the repository security contract passes", () => {
  assert.doesNotThrow(() => checkSecurityPolicy(ROOT));
});

test("required secret-ignore patterns are enforced without ignoring tracked .npmrc", () => {
  assert.deepEqual(checkGitignoreContract(ROOT), []);
});

test("CODEOWNERS protects repository and security controls", () => {
  assert.deepEqual(checkCodeownersContract(ROOT), []);
});

test("Dependabot covers root npm, the install lock, and GitHub Actions", () => {
  assert.deepEqual(checkDependabotContract(ROOT), []);
});

test("the checker requires full SHA action pins", () => {
  const path = "/tmp/security-policy-unpinned.yml";
  writeFileSync(path, workflow().replace(ACTION_SHA, "main"));
  assert.match(checkWorkflow(path).join("\n"), /full 40-hex SHA/u);
});

test("the checker requires explicit permissions, concurrency, and job timeouts", () => {
  const path = "/tmp/security-policy-permissions.yml";
  writeFileSync(
    path,
    workflow()
      .replace("permissions:\n  contents: read", "permissions:\n  contents: write")
      .replace("concurrency:\n  group: test\n  cancel-in-progress: true\n", "")
      .replace("timeout-minutes: 5\n", ""),
  );
  const errors = checkWorkflow(path).join("\n");
  assert.match(errors, /top-level permissions/u);
  assert.match(errors, /top-level concurrency/u);
  assert.match(errors, /no positive timeout-minutes/u);
});

test("the checker requires nonpersistent checkout credentials on the checkout step", () => {
  const path = "/tmp/security-policy-checkout.yml";
  writeFileSync(
    path,
    workflow().replace(
      `        with:\n          persist-credentials: false`,
      `      - uses: actions/setup-node@${ACTION_SHA}\n        with:\n          node-version: "22.19.0"\n          persist-credentials: false`,
    ),
  );
  assert.match(checkWorkflow(path).join("\n"), /persist-credentials: false/u);
});

test("the checker requires an exact Node runtime pin", () => {
  const path = "/tmp/security-policy-node-version.yml";
  writeFileSync(
    path,
    workflow()
      .replace("actions/checkout", "actions/setup-node")
      .replace("persist-credentials: false", "node-version: 22"),
  );
  assert.match(checkWorkflow(path).join("\n"), /pin node-version 22\.19\.0/u);
});

test("pull_request_target is restricted to a trusted metadata-only gate", () => {
  const unsafe = "/tmp/unsafe-workflow.yml";
  writeFileSync(unsafe, workflow().replace("on: push", "on: [push, pull_request_target]"));
  assert.match(checkWorkflow(unsafe).join("\n"), /only allowed in pr-gate.yml/u);

  const gate = "/tmp/pr-gate.yml";
  writeFileSync(
    gate,
    workflow()
      .replace("on: push", "on:\n  pull_request_target:\n    types: [opened]")
      .replace(
        `      - uses: actions/checkout@${ACTION_SHA}\n        with:\n          persist-credentials: false`,
        "      - run: node ${{ github.event.pull_request.head.sha }}",
      ),
  );
  assert.match(checkWorkflow(gate).join("\n"), /must not execute pull request code/u);
});

test("upstream-only jobs require an explicit repository guard", () => {
  const path = "/tmp/approve-contributor.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/approve-contributor.yml`, "utf8");
  writeFileSync(path, source.replace("    if: ${{ github.repository == 'earendil-works/pi' }}\n", ""));
  assert.match(checkWorkflow(path).join("\n"), /must be guarded to earendil-works\/pi/u);
});

test("the upstream sync workflow can never push to upstream", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  writeFileSync(
    path,
    source.replace(
      "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git",
      "https://x-access-token:${GH_TOKEN}@github.com/earendil-works/pi.git",
    ),
  );
  assert.match(checkWorkflow(path).join("\n"), /must never push to upstream/u);
});

test("Dependabot coverage has only grouped npm and GitHub Actions updates", () => {
  const updates = parseDependabot(`version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    groups:
      npm-version:
        applies-to: version-updates
        patterns:
          - "*"
      npm-security:
        applies-to: security-updates
        patterns:
          - "*"
`);
  assert.deepEqual(updates.map((update) => update.ecosystem), ["npm"]);
  assert.equal(updates[0].cooldown, "7");
});
