# Tool-row visibility design

## Goal

Add a reversible, persistent interactive-TUI display mode for tool-call and tool-result rows while keeping tool execution, errors, session JSONL, and model context unchanged. Users can choose full rows, one compact status line per tool, or hidden rows. The working indicator remains visible during execution.

## Scope

`toolRowsMode` is a global setting with values `"full"`, `"compact"`, and `"hidden"`, defaulting to `"full"`. It is changed by the configurable application action `app.tools.toggleVisibility`, with default key `ctrl+alt+o`, which cycles `full → compact → hidden → full`. `app.tools.expand` remains bound to `ctrl+o` and continues to control output expansion.

The interactive mode owns the setting and applies it to every `ToolExecutionComponent`. Full mode uses the existing renderer. While tool output is collapsed, compact mode renders exactly one physical line containing the call header and `[running]`, `[ok]`, or `[error]`, preserving the full tool row's foreground and state-dependent background styling; it omits result output, diffs, images, duration, shells, and extra spacing. Hidden mode returns no rendered lines. Expanding tool output temporarily uses the full renderer from compact or hidden mode; collapsing restores the persisted mode. Components remain in the chat container and in `pendingTools`, so partial updates, completion, errors, mode changes, and row order use the normal lifecycle.

Tool call creation and result delivery remain unchanged. Rebuilding history creates the same components and applies the stored mode. No session entry, tool result, agent message, or context transformation is filtered or changed. Hidden mode continues to suppress orphaned collapsed-thinking labels; compact mode does not.

## Extension contract

`ExtensionUIContext` exposes `getToolRowsMode()` and `setToolRowsMode(mode)`. They read and set the same interactive state as the keybinding. The methods are TUI-only: RPC, print, and JSON return `"full"` and ignore setters. Extensions guard behavior that requires a visible change with `ctx.mode === "tui"`.

This avoids the current per-tool renderer workaround (`renderShell: "self"`), which requires extensions to replace built-in tools and duplicate their execution delegation.

## Validation

Tests cover:

- compact rows contain one call-header/status line and no result output;
- running, success, and error status transitions;
- generic-tool argument summaries and narrow-width truncation that preserves status;
- hidden rows render zero lines and full mode restores them;
- default mode and persisted compact mode;
- cycling `full → compact → hidden → full` for live and historical rows;
- hidden-only suppression of orphaned thinking labels;
- settings selector values;
- TUI extension API behavior and non-TUI `"full"` no-ops.

Documentation covers settings, keybindings, extension UI mode limits, and interactive usage. `CHANGELOG.md` remains out of scope.

## Local maintenance

The fix lives on local branch `local/tool-row-visibility` in `/Users/Shared/vendor/pi-tool-row-visibility`. To update it, fetch upstream and rebase the branch onto `origin/main`; resolve only conflicts in this change, then run `npm run check` and `./test.sh`.
