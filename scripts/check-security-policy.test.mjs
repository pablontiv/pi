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

test("the checker permits reusable workflow call jobs without unsupported timeouts", () => {
  const path = "/tmp/security-policy-reusable-workflow.yml";
  writeFileSync(
    path,
    `name: reusable caller
on: workflow_dispatch
permissions:
  contents: read
concurrency:
  group: reusable-caller
  cancel-in-progress: true
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
`,
  );
  assert.doesNotMatch(checkWorkflow(path).join("\n"), /no positive timeout-minutes/u);
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

  writeFileSync(
    path,
    source.replace(
      "    if: ${{ github.repository == 'earendil-works/pi' }}",
      "    if: ${{ github.repository == 'earendil-works/pi' || github.repository_owner != '' }}",
    ),
  );
  assert.match(checkWorkflow(path).join("\n"), /must be guarded to earendil-works\/pi/u);
});

test("scheduled workflows require repository guards", () => {
  const path = "/tmp/security-policy-scheduled.yml";
  for (const trigger of ['on:\n  schedule:\n    - cron: "17 4 * * *"', "on: [push, schedule]"]) {
    writeFileSync(path, workflow().replace("on: push", trigger));
    assert.match(checkWorkflow(path).join("\n"), /scheduled job test must have a repository guard/u);
  }
});

test("the upstream sync workflow requires all three product checkouts to use dev", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  assert.doesNotMatch(checkWorkflow(`${ROOT}/.github/workflows/sync-upstream.yml`).join("\n"), /product checkout refs/u);
  let replacements = 0;
  for (const driftedCheckout of [0, 1, 2]) {
    replacements = 0;
    const drifted = source.replace(/^          ref: dev$/gmu, () => {
      const replacement = replacements === driftedCheckout ? "          ref: local/tool-row-visibility" : "          ref: dev";
      replacements += 1;
      return replacement;
    });
    assert.equal(replacements, 3);
    writeFileSync(path, drifted);
    assert.match(checkWorkflow(path).join("\n"), /all three product checkout refs must be exactly dev/u);
  }
});

test("the upstream sync workflow rejects a fourth inline checkout", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  const fourthCheckout = `      - uses: actions/checkout@${ACTION_SHA}
        with:
          ref: dev
          persist-credentials: false
`;
  writeFileSync(path, source.replace("      - name: Fast-forward fork main from upstream\n", fourthCheckout + "      - name: Fast-forward fork main from upstream\n"));
  assert.match(checkWorkflow(path).join("\n"), /all three product checkout refs must be exactly dev/u);
});

test("the upstream sync workflow rejects unnamed and extra action steps", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  writeFileSync(
    path,
    source.replace(
      "      - name: Prepare trusted tag publication state\n",
      `      - uses: actions/cache@${ACTION_SHA}\n      - name: Prepare trusted tag publication state\n`,
    ),
  );
  const errors = checkWorkflow(path).join("\n");
  assert.match(errors, /unnamed step/u);
  assert.match(errors, /security-reviewed order/u);
});

test("critical sync steps reject unexpected control attributes and execution combinations", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  const quotedAttributes = [
    ["'if'", "${{ github.repository != github.repository }}"],
    ['"if"', "${{ github.repository != github.repository }}"],
    ["'continue-on-error'", "true"],
    ['"continue-on-error"', "true"],
    ["'shell'", "bash"],
    ['"shell"', "bash"],
  ];
  const mutations = [
    source.replace("      - name: Classify merge candidate\n", "      - name: Classify merge candidate\n        if: ${{ false }}\n"),
    source.replace("      - name: Classify merge candidate\n", "      - name: Classify merge candidate\n        continue-on-error: true\n"),
    ...quotedAttributes.map(([key, value]) =>
      source.replace("      - name: Classify merge candidate\n", `      - name: Classify merge candidate\n        ${key}: ${value}\n`),
    ),
    source.replace("        id: candidate\n", "        id: candidate\n        with:\n          unsafe: true\n"),
    source.replace(
      "          SYNCED_MAIN_SHA: ${{ needs.sync-main.outputs.main_sha }}\n",
      "          SYNCED_MAIN_SHA: ${{ needs.sync-main.outputs.main_sha }}\n          UNEXPECTED_ENV: true\n",
    ),
  ];
  for (const mutated of mutations) {
    writeFileSync(path, mutated);
    assert.match(checkWorkflow(path).join("\n"), /Classify merge candidate must exactly match/u);
  }
});

test("critical step schema normalizes allowed quoted name and run keys", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  const start = source.indexOf("      - name: Classify merge candidate\n");
  const end = source.indexOf("\n      - name: Publish merge candidate", start);
  assert.ok(start >= 0 && end > start);
  const quotedStep = source
    .slice(start, end)
    .replace("      - name:", "      - 'name':")
    .replace("        run: |", '        "run": |');
  writeFileSync(path, `${source.slice(0, start)}${quotedStep}${source.slice(end)}`);
  assert.deepEqual(checkWorkflow(path), []);
});

test("critical step schema rejects flow-style and duplicate-key forms", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  const start = source.indexOf("      - name: Classify merge candidate\n");
  const end = source.indexOf("\n      - name: Publish merge candidate", start);
  assert.ok(start >= 0 && end > start);
  const flowStep = '      - { name: Classify merge candidate, id: candidate, env: { SYNCED_MAIN_SHA: "${{ needs.sync-main.outputs.main_sha }}" }, run: "node scripts/classify-upstream-merge.mjs" }';
  writeFileSync(path, `${source.slice(0, start)}${flowStep}${source.slice(end)}`);
  assert.match(checkWorkflow(path).join("\n"), /Classify merge candidate must exactly match/u);

  const duplicate = source.replace(
    "      - name: Classify merge candidate\n",
    "      - name: Classify merge candidate\n        'name': Classify merge candidate\n",
  );
  writeFileSync(path, duplicate);
  assert.match(checkWorkflow(path).join("\n"), /unnamed step|security-reviewed order/u);

  const malformed = source.replace("      - name: Classify merge candidate\n", "      - name: [\n");
  writeFileSync(path, malformed);
  assert.match(checkWorkflow(path).join("\n"), /unnamed step|security-reviewed order/u);
});

test("critical sync steps reject extra active commands and persisted runner state", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  const mutations = [
    {
      replacement: '          [[ -s "${known_hosts}" ]]\n          echo unexpected',
      expected: /Prepare trusted tag publication state must exactly match/u,
    },
    {
      replacement: '          [[ -s "${known_hosts}" ]]\n          echo "PATH=/tmp/unsafe:${PATH}" >> "${GITHUB_ENV}"',
      expected: /must not persist environment or state/u,
    },
  ];
  for (const mutation of mutations) {
    writeFileSync(path, source.replace('          [[ -s "${known_hosts}" ]]', mutation.replacement));
    assert.match(checkWorkflow(path).join("\n"), mutation.expected);
  }
});

test("critical sync steps reject altered exact active command bodies", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  const mutations = [
    source.replace("node scripts/classify-upstream-merge.mjs", "node scripts/alternate-classifier.mjs"),
    source.replace("gh api repos/earendil-works/pi/releases/latest", "gh api repos/pablontiv/pi/releases/latest"),
    source.replace("https://api.github.com/meta", "https://github.com/meta"),
  ];
  for (const mutated of mutations) {
    writeFileSync(path, mutated);
    assert.match(checkWorkflow(path).join("\n"), /must exactly match its security-reviewed structure and active command body/u);
  }
});

test("the upstream sync workflow rejects commented or dead-code release validation", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  for (const replacement of [
    '          # node scripts/create-pion-release.mjs --validate-source --version "${version}"',
    '          false && node scripts/create-pion-release.mjs --validate-source --version "${version}"',
  ]) {
    writeFileSync(
      path,
      source.replace(
        '          node scripts/create-pion-release.mjs --validate-source --version "${version}"',
        replacement,
      ),
    );
    assert.match(checkWorkflow(path).join("\n"), /release source validation must run exactly once/u);
  }
});

test("the upstream sync workflow rejects altered trusted comparisons", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  writeFileSync(
    path,
    source.replace('          [[ "${VERSION}" == "${UPSTREAM_TAG#v}" ]]', '          [[ "${VERSION}" != "${UPSTREAM_TAG#v}" ]]'),
  );
  assert.match(checkWorkflow(path).join("\n"), /independently and exactly revalidate publication state/u);
});

test("the secret-bearing tag step rejects alternate transports and repository code", () => {
  const path = "/tmp/sync-upstream.yml";
  const source = readFileSync(`${ROOT}/.github/workflows/sync-upstream.yml`, "utf8");
  for (const mutated of [
    source.replace('git -c core.hooksPath=/dev/null -C "${RUNNER_TEMP}/pion-tag-publish" push', 'git -c core.hooksPath=/dev/null -C "${RUNNER_TEMP}/pion-tag-publish" send-pack'),
    source.replace('          chmod 0600 "${key_path}"', '          chmod 0600 "${key_path}"\n          node scripts/create-pion-release.mjs --validate-source --version 1.0.4'),
    source.replace('"git@github.com:pablontiv/pi.git"', '"https://github.com/pablontiv/pi.git"'),
  ]) {
    writeFileSync(path, mutated);
    assert.match(checkWorkflow(path).join("\n"), /secret-bearing tag step must contain only the exact SSH tag push contract/u);
  }
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

  writeFileSync(
    path,
    source.replace(
      'git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" \\\n',
      'git push \\\n            "https://x-access-token:${GH_TOKEN}@github.com/earendil-works/pi.git" \\\n',
    ),
  );
  assert.match(checkWorkflow(path).join("\n"), /must never push to upstream/u);

  writeFileSync(
    path,
    source.replace(
      'git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" \\\n',
      "git push -f git@github.com:earendil-works/pi.git \\\n",
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
