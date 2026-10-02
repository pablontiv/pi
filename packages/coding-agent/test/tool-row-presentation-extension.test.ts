import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import toolRowPresentation from "../examples/extensions/tool-row-presentation.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionFactory,
	ExtensionUIContext,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const MODE_KEY = "pablontiv.tool-rows.mode";
const MIGRATION_KEY = "pablontiv.tool-rows.migrated-v1";

type SettingWrite = { key: string; value: unknown; scope: "global" | "project" };

function createSettingState(globalValues: Record<string, unknown> = {}, projectValues: Record<string, unknown> = {}) {
	return {
		global: new Map(Object.entries(globalValues)),
		project: new Map(Object.entries(projectValues)),
		writes: [] as SettingWrite[],
	};
}

const contextActions: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

async function createHarness(
	options: {
		global?: Record<string, unknown>;
		project?: Record<string, unknown>;
		rawSettings?: Record<string, unknown>;
		extraFactories?: ExtensionFactory[];
		settingState?: ReturnType<typeof createSettingState>;
	} = {},
) {
	const settingState = options.settingState ?? createSettingState(options.global, options.project);
	const { global, project, writes } = settingState;
	const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
	const rawSettings = options.rawSettings ?? {};
	const runtime = createExtensionRuntime();
	const factories = [toolRowPresentation, ...(options.extraFactories ?? [])];
	const extensions = [];
	for (const [index, factory] of factories.entries()) {
		extensions.push(
			await loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime, `<tool-row-${index}>`),
		);
	}
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		{
			getExtensionSettingLayers: (key) => ({ global: global.get(key), project: project.get(key) }),
			setExtensionSetting: (key, value, scope) => {
				const write = { key, value, scope };
				writes.push(write);
				(scope === "global" ? global : project).set(key, value);
			},
		},
	);
	const actions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => rawSettings,
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};
	runner.bindCore(actions, contextActions);
	runner.setUIContext(
		{
			notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
		} as unknown as ExtensionUIContext,
		"tui",
	);

	return { runner, extensions, global, project, writes, notifications, rawSettings };
}

async function start(runner: ExtensionRunner): Promise<void> {
	await runner.emit({ type: "session_start", reason: "startup" });
}

async function runCommand(runner: ExtensionRunner, args: string): Promise<void> {
	const command = runner.getCommand("tool-rows");
	expect(command).toBeDefined();
	await command?.handler(args, runner.createCommandContext());
}

const block = (kind: "tool" | "thinking", subtype?: "orphaned-thinking-placeholder") => ({
	kind,
	...(subtype === undefined ? {} : { subtype }),
	capabilities: { summary: kind === "tool", expandable: true },
});

describe("tool row presentation extension", () => {
	it("registers the exact visible mode setting and hidden migration marker with a full default", async () => {
		const { runner } = await createHarness();
		const settings = runner.getRegisteredSettings();
		const mode = settings.find((setting) => setting.definition.key === MODE_KEY)?.definition;
		const marker = settings.find((setting) => setting.definition.key === MIGRATION_KEY)?.definition;

		expect(mode).toMatchObject({
			key: MODE_KEY,
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
		expect(mode && Check(mode.schema, "full")).toBe(true);
		expect(mode && Check(mode.schema, "compact")).toBe(true);
		expect(mode && Check(mode.schema, "hidden")).toBe(true);
		expect(mode && Check(mode.schema, "other")).toBe(false);
		expect(marker).toMatchObject({ key: MIGRATION_KEY, defaultValue: false });
		expect(marker).not.toHaveProperty("ui");
		expect(marker && Check(marker.schema, true)).toBe(true);
		expect(marker && Check(marker.schema, "true")).toBe(false);
		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("full");
	});

	it("reports the current mode without writing when the command has no argument", async () => {
		const { runner, writes, notifications } = await createHarness({
			global: { [MODE_KEY]: "hidden", [MIGRATION_KEY]: true },
		});

		await runCommand(runner, "   ");

		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("hidden");
		expect(writes).toEqual([]);
		expect(notifications).toEqual([{ message: "Tool rows: hidden", type: "info" }]);
	});

	it("sets compact globally through the command and rejects invalid arguments", async () => {
		const { runner, writes, notifications } = await createHarness();
		await runCommand(runner, "compact");

		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
		expect(writes).toContainEqual({ key: MODE_KEY, value: "compact", scope: "global" });

		await runCommand(runner, "verbose");
		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
		expect(notifications.at(-1)).toEqual(
			expect.objectContaining({ type: "error", message: expect.stringContaining("full|compact|hidden") }),
		);
	});

	it("cycles full, compact, hidden, and full with the default shortcut", async () => {
		const { runner, notifications } = await createHarness();
		const shortcut = runner.getShortcuts(new KeybindingsManager().getEffectiveConfig()).get("ctrl+alt+o");
		expect(shortcut).toBeDefined();

		for (const expected of ["compact", "hidden", "full"] as const) {
			await shortcut?.handler(runner.createContext());
			expect(runner.getExtensionSettingValue(MODE_KEY)).toBe(expected);
			expect(notifications.at(-1)?.message).toContain(expected);
		}
	});

	it("maps tool density at evaluation time and hides only the orphaned thinking placeholder", async () => {
		const { runner } = await createHarness();
		expect(runner.resolveTranscriptPresentation(block("tool"))).toEqual({ density: "full" });

		runner.setExtensionSettingValue(MODE_KEY, "compact");
		expect(runner.resolveTranscriptPresentation(block("tool"))).toEqual({ density: "summary" });

		runner.setExtensionSettingValue(MODE_KEY, "hidden");
		expect(runner.resolveTranscriptPresentation(block("tool"))).toEqual({ density: "hidden" });
		expect(runner.resolveTranscriptPresentation(block("thinking", "orphaned-thinking-placeholder"))).toEqual({
			density: "hidden",
		});
		expect(runner.resolveTranscriptPresentation(block("thinking"))).toEqual({ density: "full" });
	});

	it("invalidates exactly once per mode change and manages its listener idempotently", async () => {
		const { runner } = await createHarness();
		const invalidated = vi.fn();
		runner.onTranscriptPresentationInvalidated(invalidated);
		await start(runner);
		await start(runner);

		runner.setExtensionSettingValue(MODE_KEY, "compact");
		expect(invalidated).toHaveBeenCalledTimes(1);

		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.setExtensionSettingValue(MODE_KEY, "hidden");
		expect(invalidated).toHaveBeenCalledTimes(1);
	});

	it("replaces the loaded runtime without retaining the old handle, listener, or policy", async () => {
		const settingState = createSettingState({ [MIGRATION_KEY]: true });
		const first = await createHarness({ settingState });
		const firstInvalidated = vi.fn();
		first.runner.onTranscriptPresentationInvalidated(firstInvalidated);
		await start(first.runner);
		const staleCommand = first.runner.getCommand("tool-rows");
		const staleContext = first.runner.createCommandContext();
		const stalePolicy = first.extensions[0]?.transcriptPresentationPolicies?.[0]?.policy;
		expect(staleCommand).toBeDefined();
		expect(stalePolicy).toBeDefined();
		expect(first.runner.resolveTranscriptPresentation(block("tool"))).toEqual({ density: "full" });

		await first.runner.emit({ type: "session_shutdown", reason: "reload" });
		first.runner.invalidate("stale tool-row runtime");

		const replacement = await createHarness({ settingState });
		const replacementInvalidated = vi.fn();
		replacement.runner.onTranscriptPresentationInvalidated(replacementInvalidated);
		await start(replacement.runner);
		const shortcut = replacement.runner.getShortcuts(new KeybindingsManager().getEffectiveConfig()).get("ctrl+alt+o");
		expect(shortcut).toBeDefined();
		await shortcut?.handler(replacement.runner.createContext());

		expect(replacement.extensions[0]).not.toBe(first.extensions[0]);
		expect(replacement.extensions[0]?.transcriptPresentationPolicies?.[0]?.policy).not.toBe(stalePolicy);
		expect(replacement.runner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
		expect(replacement.runner.resolveTranscriptPresentation(block("tool"))).toEqual({ density: "summary" });
		expect(replacementInvalidated).toHaveBeenCalledTimes(1);
		expect(firstInvalidated).not.toHaveBeenCalled();
		await expect(staleCommand?.handler("", staleContext)).rejects.toThrow("stale tool-row runtime");
		expect(() => stalePolicy?.(block("tool"), { density: "full" })).toThrow("stale tool-row runtime");
		expect(() => first.runner.resolveTranscriptPresentation(block("tool"))).toThrow("stale tool-row runtime");
	});

	it("migrates a valid legacy mode once, marks it globally, and retains the legacy field", async () => {
		const rawSettings: Record<string, unknown> = { toolRowsMode: "compact", unrelated: true };
		const { runner, writes } = await createHarness({ rawSettings });
		await start(runner);

		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
		expect(runner.getExtensionSettingValue(MIGRATION_KEY)).toBe(true);
		expect(writes).toContainEqual({ key: MODE_KEY, value: "compact", scope: "global" });
		expect(writes).toContainEqual({ key: MIGRATION_KEY, value: true, scope: "global" });
		expect(rawSettings).toEqual({ toolRowsMode: "compact", unrelated: true });

		rawSettings.toolRowsMode = "hidden";
		await start(runner);
		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
		expect(writes.filter((write) => write.key === MODE_KEY)).toHaveLength(1);
		expect(writes.filter((write) => write.key === MIGRATION_KEY)).toHaveLength(1);
	});

	it("does not overwrite a non-default new mode during migration", async () => {
		const { runner, writes } = await createHarness({
			global: { [MODE_KEY]: "hidden" },
			rawSettings: { toolRowsMode: "compact" },
		});
		await start(runner);

		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("hidden");
		expect(runner.getExtensionSettingValue(MIGRATION_KEY)).toBe(true);
		expect(writes.filter((write) => write.key === MODE_KEY)).toEqual([]);
		expect(writes).toContainEqual({ key: MIGRATION_KEY, value: true, scope: "global" });
	});

	it("does not rerun migration when the marker is already set", async () => {
		const { runner, writes } = await createHarness({
			global: { [MIGRATION_KEY]: true },
			rawSettings: { toolRowsMode: "compact" },
		});
		await start(runner);

		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("full");
		expect(writes).toEqual([]);
	});

	it("keeps the command usable when another extension collides with the shortcut", async () => {
		const collision: ExtensionFactory = (pi) => {
			pi.registerShortcut("ctrl+alt+o", { handler: () => {} });
		};
		const { runner } = await createHarness({ extraFactories: [collision] });
		const shortcuts = runner.getShortcuts(new KeybindingsManager().getEffectiveConfig());

		expect(runner.getShortcutDiagnostics()).toEqual([
			expect.objectContaining({ message: expect.stringContaining("shortcut conflict") }),
		]);
		expect(shortcuts.get("ctrl+alt+o")?.extensionPath).toBe("<tool-row-1>");
		await runCommand(runner, "compact");
		expect(runner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
	});
});
