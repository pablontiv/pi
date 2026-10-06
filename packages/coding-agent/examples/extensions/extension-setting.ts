import type { ExtensionAPI, ExtensionSettingDefinition, SettingsScope } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const displayModeSchema = Type.Union([Type.Literal("compact"), Type.Literal("verbose"), Type.Literal("hidden")]);

type DisplayModeDefinition = ExtensionSettingDefinition<typeof displayModeSchema>;

function createDisplayModeDefinition(): DisplayModeDefinition {
	return {
		key: "example.display-mode",
		schema: displayModeSchema,
		defaultValue: "compact",
		title: "Display mode",
		description: "Choose how the example extension displays its output.",
		ui: {
			control: "select",
			choices: [
				{ label: "Compact", value: "compact" },
				{ label: "Verbose", value: "verbose" },
				{ label: "Hidden", value: "hidden" },
			],
		},
	};
}

export default function extensionSettingExample(pi: ExtensionAPI): void {
	const displayMode = pi.registerSetting(createDisplayModeDefinition());
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = displayMode.onChange((value) => {
			ctx.ui.notify(`Display mode changed to ${value}.`, "info");
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});

	pi.registerCommand("extension-setting", {
		description: "Set and read the extension-owned display mode",
		handler: async (args, ctx) => {
			const scope: SettingsScope = args.trim() === "project" ? "project" : "global";
			displayMode.set(scope === "project" ? "verbose" : "hidden", { scope });
			ctx.ui.notify(`Display mode is ${displayMode.get()}.`, "info");
		},
	});
}
