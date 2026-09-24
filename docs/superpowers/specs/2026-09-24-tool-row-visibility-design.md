# Tool-row visibility design

## Goal

Add a reversible, persistent interactive-TUI mode that hides complete tool-call and tool-result rows while keeping tool execution, errors, session JSONL, and model context unchanged. The working indicator remains visible during execution.

## Scope

`hideToolRows` is a global `Settings` boolean, defaulting to `false`. It is changed by a configurable application action, `app.tools.toggleVisibility`, with default key `ctrl+alt+o`. `app.tools.expand` remains bound to `ctrl+o` and continues to control output expansion.

The interactive mode owns the setting and applies it to every `ToolExecutionComponent`. The component receives `setVisible(visible)` and returns no rendered lines while hidden. It stays in the chat container and in `pendingTools`, so partial updates, completion, errors, and a later visibility restore use the normal lifecycle and preserve row order. A hidden component contributes no spacer or padding because its top-level render returns `[]`.

Tool call creation and result delivery remain unchanged. Rebuilding history creates the same components and applies the stored visibility state. No session entry, tool result, agent message, or context transformation is filtered or changed.

## Extension contract

`ExtensionUIContext` exposes `getToolRowsVisible()` and `setToolRowsVisible(visible)`. They read and set the same interactive state as the keybinding. The methods are TUI-only: RPC, print, and JSON provide documented no-op behavior, and extensions guard behavior with `ctx.mode === "tui"` when they need a visible result.

This avoids the current per-tool renderer workaround (`renderShell: "self"`), which requires extensions to replace built-in tools and duplicate their execution delegation.

## Validation

Tests cover:

- hidden `ToolExecutionComponent` rendering zero lines and restoring its rows;
- no blank spacer or box padding while hidden;
- default visible behavior and persisted setting restoration;
- the configured action and its distinct default key;
- active tool call and result updates while hidden, with unchanged session/model data;
- TUI extension API behavior and non-TUI no-ops.

Documentation updates cover settings, keybindings, extension UI mode limits, and the interactive usage reference. `CHANGELOG.md` is out of scope.

## Local maintenance

The fix lives on local branch `local/tool-row-visibility` in `/Users/Shared/vendor/pi-tool-row-visibility`. To update it, fetch upstream and rebase the branch onto `origin/main`; resolve only conflicts in this change, then run `npm run check` and `./test.sh`.
