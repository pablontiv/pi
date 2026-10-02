import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MODES = ["full", "compact", "hidden"] as const;
type ToolRowsMode = (typeof MODES)[number];

function isToolRowsMode(value: unknown): value is ToolRowsMode {
	return typeof value === "string" && MODES.includes(value as ToolRowsMode);
}

export default function toolRowPresentation(pi: ExtensionAPI): void {
	const mode = pi.registerSetting({
		key: "pablontiv.tool-rows.mode",
		schema: Type.Union([Type.Literal("full"), Type.Literal("compact"), Type.Literal("hidden")]),
		defaultValue: "full",
		title: "Tool rows",
		description: "How tool calls appear in the interactive transcript",
		ui: {
			control: "select",
			choices: [
				{ label: "Full", value: "full" },
				{ label: "Compact", value: "compact" },
				{ label: "Hidden", value: "hidden" },
			],
		},
	});
	const migrated = pi.registerSetting({
		key: "pablontiv.tool-rows.migrated-v1",
		schema: Type.Boolean(),
		defaultValue: false,
		title: "Tool rows migration",
		description: "Whether the legacy tool row preference has been migrated",
	});
	const presentation = pi.registerTranscriptPresentationPolicy((block) => {
		const currentMode = mode.get();
		if (block.kind === "tool") {
			return { density: currentMode === "compact" ? "summary" : currentMode };
		}
		if (currentMode === "hidden" && block.kind === "thinking" && block.subtype === "orphaned-thinking-placeholder") {
			return { density: "hidden" };
		}
		return undefined;
	});
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", () => {
		unsubscribe?.();
		unsubscribe = mode.onChange(() => presentation.invalidate());

		if (migrated.get()) return;
		const snapshot: unknown = pi.getSettings();
		if (typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)) {
			const legacyMode = (snapshot as Record<string, unknown>).toolRowsMode;
			if (isToolRowsMode(legacyMode) && mode.get() === "full") {
				mode.set(legacyMode, { scope: "global" });
			}
		}
		migrated.set(true, { scope: "global" });
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});

	pi.registerCommand("tool-rows", {
		description: "Show or set tool row presentation (full, compact, or hidden)",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested === "") {
				ctx.ui.notify(`Tool rows: ${mode.get()}`, "info");
				return;
			}
			if (!isToolRowsMode(requested)) {
				ctx.ui.notify("Usage: /tool-rows [full|compact|hidden]", "error");
				return;
			}
			try {
				mode.set(requested, { scope: "global" });
			} catch (error) {
				ctx.ui.notify(
					`Could not save tool rows: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`Tool rows: ${requested}`, "info");
		},
	});

	pi.registerShortcut("ctrl+alt+o", {
		description: "Cycle tool row presentation",
		handler: (ctx) => {
			const currentIndex = MODES.indexOf(mode.get());
			const next = MODES[(currentIndex + 1) % MODES.length];
			try {
				mode.set(next, { scope: "global" });
			} catch (error) {
				ctx.ui.notify(
					`Could not save tool rows: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`Tool rows: ${next}`, "info");
		},
	});
}
