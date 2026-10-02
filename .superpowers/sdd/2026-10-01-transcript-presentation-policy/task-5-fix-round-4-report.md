# Task 5 fix round 4 report

## Status

Completed both Important findings from review round 4.

## Finding 1: prior-session pending bash lifecycle

### Code

`InteractiveMode` now performs targeted pending-bash cleanup from the runtime's `setBeforeSessionInvalidate` boundary, before a replacement session is bound and rendered.

The cleanup:

- removes each pending bash presentation wrapper from the pending and chat containers;
- removes only those wrappers' `presentedComponents` and expandable tracking;
- clears the pending component list and pending identity metadata;
- disconnects `bashComponent` if it points at one of those components.

Ordinary same-session `clearChatContainer()`, rebuild, reload, and compaction behavior is unchanged: pending bash wrappers remain tracked so a same-session complete history can reconcile the live component.

### Regression

`drops prior-session pending bash identity at the runtime session boundary before rebuilding` creates deferred bash UI in one faux session, invokes the real runtime boundary callback, swaps the harness to a replacement faux session, performs the bind-time render, and then invokes a delayed flush. It verifies that the old component, metadata, pending UI, wrapper tracking, and output do not enter the replacement session.

This failed on base because `renderCurrentSessionState()` cleared pending UI but left the component list, metadata, and wrapper mapping available to the later flush.

## Finding 2: stable persisted bash identity

### Concrete API trace before the change

The normal path was:

1. `InteractiveMode.handleBashCommand()` created the live `BashExecutionComponent`.
2. `AgentSession.executeBash()` completed execution.
3. `AgentSession.executeBash()` called `recordBashResult()`.
4. `recordBashResult()` alone constructed `BashExecutionMessage`, assigning `timestamp: Date.now()`, then queued or persisted that message.
5. `recordBashResult()` returned `void`, and `executeBash()` returned only `BashResult`.

Therefore the interactive caller could not capture the timestamp actually assigned to the persisted message. Generating a timestamp in `InteractiveMode` would have produced a separate heuristic identity.

The extension-intercepted path called `recordBashResult()` directly, but that API likewise returned `void`.

### Minimal typed API change and exact identity trace

`AgentSession.recordBashResult()` now returns the same `Readonly<BashExecutionMessage>` object that it queues or persists. `AgentSession.executeBash()` adds an optional typed `onMessageRecorded` callback and invokes it with that exact returned object immediately after creation.

- Extension-intercepted result: `InteractiveMode` reads `timestamp` from the exact message returned by `recordBashResult()` and stores it with the pending live component.
- Normal execution: `InteractiveMode` captures the live component, and `onMessageRecorded` stores the timestamp from the exact message created by `recordBashResult()` with that component.
- No timestamp is generated in `InteractiveMode`.
- Reconciliation indexes pending components by persisted timestamp and matches only `BashExecutionMessage.timestamp`; command, output, result fields, and reverse position are no longer used.

### Regression

`keeps identical pending bash wrappers bound to their exact persisted identity across partial and complete history` covers:

- an older historical result identical in command and every result field;
- two identical pending results;
- exact pending metadata equal to the timestamps in persisted history;
- partial history omitting both pending entries, which leaves both wrappers pending and cannot claim either for the older entry;
- later complete history, which reconciles both original wrappers in persisted order;
- live component/wrapper identity preservation;
- repeated flush idempotence;
- hidden policy followed by invalidation to full, with each historical result rendered exactly once.

This failed on base because no timestamp was retained and the content/reverse-position matcher could claim an older identical entry.

## RED and GREEN

### Intended RED

Command:

```bash
cd packages/coding-agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/transcript-presentation-integration.test.ts \
  test/interactive-tui.test.ts \
  test/interactive-mode-status.test.ts
```

Observed on base plus the new regressions: 2 failures, 61 passes.

- Exact identity regression received `[undefined, undefined]` instead of the two persisted timestamps.
- Session-boundary regression retained the old pending component after boundary teardown and rebuild.

### GREEN

The same focused command passes: 3 files, 63 tests.

`npm run check` passes, including Biome, dependency checks, TypeScript, lock/shrinkwrap checks, entry graph checks, and browser smoke.

## Files changed

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/test/transcript-presentation-integration.test.ts`
- `.superpowers/sdd/2026-10-01-transcript-presentation-policy/task-5-fix-round-4-report.md`

## Scope

Only the two round-4 Important findings were addressed. The core session change is the minimal typed change required to expose the timestamp from the existing message-construction point. The tests use the faux harness. No `any` was added. Deferred Minor findings and unrelated refactors remain out of scope.

## Concerns

None known.
