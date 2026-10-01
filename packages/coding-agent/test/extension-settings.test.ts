import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionFactory,
	ExtensionSettingHandle,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	getSettings: () => ({}),
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
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

function stringSetting(key: string, defaultValue: string) {
	return {
		key,
		schema: Type.String(),
		defaultValue,
		title: key,
		description: `${key} description`,
	};
}

describe("extension setting runtime", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-settings-test-"));
		agentDir = path.join(tempDir, "agent");
		projectDir = path.join(tempDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createRunner(
		factories: Array<{ path: string; factory: ExtensionFactory }>,
		settings: { global?: Record<string, unknown>; project?: Record<string, unknown> } = {},
	) {
		if (settings.global) {
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensionSettings: settings.global }));
		}
		if (settings.project) {
			fs.writeFileSync(
				path.join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ extensionSettings: settings.project }),
			);
		}
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const runtime = createExtensionRuntime();
		const extensions = [];
		for (const item of factories) {
			extensions.push(
				await loadExtensionFromFactory(item.factory, projectDir, createEventBus(), runtime, item.path),
			);
		}
		const runner = new ExtensionRunner(
			extensions,
			runtime,
			projectDir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			{
				getExtensionSettingLayers: (key) => settingsManager.getExtensionSettingLayers(key),
				setExtensionSetting: (key, value, scope) => settingsManager.setExtensionSetting(key, value, scope),
			},
		);
		runner.bindCore(extensionActions, extensionContextActions);
		return { runner, settingsManager };
	}

	it("resolves project, global, and cloned defaults while invalid layers fall through independently", async () => {
		let projectHandle!: ExtensionSettingHandle<string>;
		let globalHandle!: ExtensionSettingHandle<string>;
		let defaultHandle!: ExtensionSettingHandle<{ nested: { enabled: boolean } }>;
		let fallbackHandle!: ExtensionSettingHandle<string>;
		let invalidGlobalHandle!: ExtensionSettingHandle<string>;
		let hiddenInvalidGlobalHandle!: ExtensionSettingHandle<string>;
		const { runner } = await createRunner(
			[
				{
					path: "<inline:settings>",
					factory: (pi) => {
						projectHandle = pi.registerSetting(stringSetting("acme.project", "default"));
						globalHandle = pi.registerSetting(stringSetting("acme.global", "default"));
						defaultHandle = pi.registerSetting({
							key: "acme.default",
							schema: Type.Object({ nested: Type.Object({ enabled: Type.Boolean() }) }),
							defaultValue: { nested: { enabled: true } },
							title: "Default",
							description: "Default",
						});
						fallbackHandle = pi.registerSetting(stringSetting("acme.fallback", "default"));
						invalidGlobalHandle = pi.registerSetting(stringSetting("acme.invalid-global", "default"));
						hiddenInvalidGlobalHandle = pi.registerSetting(
							stringSetting("acme.hidden-invalid-global", "default"),
						);
					},
				},
			],
			{
				global: {
					"acme.project": "global",
					"acme.global": "global",
					"acme.fallback": "valid-global",
					"acme.invalid-global": 42,
					"acme.hidden-invalid-global": 42,
				},
				project: {
					"acme.project": "project",
					"acme.fallback": 42,
					"acme.hidden-invalid-global": "valid-project",
				},
			},
		);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));

		expect(projectHandle.get()).toBe("project");
		expect(globalHandle.get()).toBe("global");
		expect(fallbackHandle.get()).toBe("valid-global");
		expect(invalidGlobalHandle.get()).toBe("default");
		expect(hiddenInvalidGlobalHandle.get()).toBe("valid-project");
		const firstDefault = defaultHandle.get();
		firstDefault.nested.enabled = false;
		expect(defaultHandle.get()).toEqual({ nested: { enabled: true } });
		expect(errors).toHaveLength(3);
		expect(errors[0]).toContain("acme.fallback");
		expect(errors[0]).toContain("project");
		expect(errors[1]).toContain("acme.invalid-global");
		expect(errors[1]).toContain("global");
		expect(errors[2]).toContain("acme.hidden-invalid-global");
		expect(errors[2]).toContain("global");
		expect(runner.getSettingDiagnostics()).toHaveLength(3);

		fallbackHandle.get();
		invalidGlobalHandle.get();
		expect(errors).toHaveLength(3);
	});

	it("rejects non-JSON and schema-invalid writes before persistence", async () => {
		let handle!: ExtensionSettingHandle<{ enabled: boolean }>;
		const { settingsManager } = await createRunner([
			{
				path: "<inline:owner>",
				factory: (pi) => {
					handle = pi.registerSetting({
						key: "acme.object",
						schema: Type.Object({ enabled: Type.Boolean() }),
						defaultValue: { enabled: false },
						title: "Object",
						description: "Object",
					});
				},
			},
		]);

		expect(() => handle.set({ enabled: "yes" } as unknown as { enabled: boolean })).toThrow(/schema/i);
		expect(() => handle.set({ enabled: true, extra: undefined } as unknown as { enabled: boolean })).toThrow(
			/strict JSON/i,
		);
		expect(settingsManager.getExtensionSettingLayers("acme.object")).toEqual({
			global: undefined,
			project: undefined,
		});
	});

	it("notifies once only for structural effective changes and detaches listener values", async () => {
		let handle!: ExtensionSettingHandle<{ nested: { count: number } }>;
		const { runner } = await createRunner(
			[
				{
					path: "<inline:owner>",
					factory: (pi) => {
						handle = pi.registerSetting({
							key: "acme.object",
							schema: Type.Object({ nested: Type.Object({ count: Type.Number() }) }),
							defaultValue: { nested: { count: 0 } },
							title: "Object",
							description: "Object",
						});
					},
				},
			],
			{ global: { "acme.object": { nested: { count: 1 } } }, project: { "acme.object": { nested: { count: 2 } } } },
		);
		const listener = vi.fn((value: { nested: { count: number } }) => {
			value.nested.count = 99;
		});
		const observer = vi.fn();
		const unsubscribe = handle.onChange(listener);
		const unsubscribeObserver = handle.onChange(observer);

		handle.set({ nested: { count: 3 } }, { scope: "global" });
		expect(listener).not.toHaveBeenCalled();
		handle.set({ nested: { count: 4 } }, { scope: "project" });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(observer).toHaveBeenCalledWith({ nested: { count: 4 } });
		expect(handle.get()).toEqual({ nested: { count: 4 } });
		handle.set({ nested: { count: 4 } }, { scope: "project" });
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		unsubscribeObserver();
		handle.set({ nested: { count: 5 } }, { scope: "project" });
		expect(listener).toHaveBeenCalledTimes(1);
		runner.invalidate();
	});

	it("keeps the first owner, diagnoses collisions, and rejects losing handles", async () => {
		let winner!: ExtensionSettingHandle<string>;
		let loser!: ExtensionSettingHandle<string>;
		const { runner, settingsManager } = await createRunner([
			{
				path: "<inline:first>",
				factory: (pi) => {
					winner = pi.registerSetting(stringSetting("acme.shared", "first"));
				},
			},
			{
				path: "<inline:second>",
				factory: (pi) => {
					loser = pi.registerSetting(stringSetting("acme.shared", "second"));
				},
			},
		]);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));

		expect(runner.getRegisteredSettings()).toHaveLength(1);
		expect(runner.getRegisteredSettings()[0]?.definition.defaultValue).toBe("first");
		expect(Object.isFrozen(runner.getRegisteredSettings())).toBe(true);
		expect(Object.isFrozen(runner.getRegisteredSettings()[0])).toBe(true);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("<inline:first>");
		expect(errors[0]).toContain("<inline:second>");
		expect(winner.get()).toBe("first");
		expect(() => loser.get()).toThrow(/owned by.*<inline:first>/i);
		expect(() => loser.set("bad")).toThrow(/owned by.*<inline:first>/i);
		expect(() => loser.onChange(() => {})).toThrow(/owned by.*<inline:first>/i);
		expect(settingsManager.getExtensionSettingLayers("acme.shared").global).toBeUndefined();
	});

	it("makes handles stale and removes subscriptions when the runner is invalidated", async () => {
		let handle!: ExtensionSettingHandle<string>;
		const { runner } = await createRunner([
			{
				path: "<inline:owner>",
				factory: (pi) => {
					handle = pi.registerSetting(stringSetting("acme.mode", "default"));
				},
			},
		]);
		const listener = vi.fn();
		handle.onChange(listener);
		runner.invalidate("stale runtime");

		expect(() => handle.get()).toThrow("stale runtime");
		expect(() => handle.set("next")).toThrow("stale runtime");
		expect(() => handle.onChange(listener)).toThrow("stale runtime");
		expect(() => runner.setExtensionSettingValue("acme.mode", "next")).toThrow("stale runtime");
		expect(listener).not.toHaveBeenCalled();
	});

	it("writes detached typed selector values through the winning owner at global scope", async () => {
		const { runner, settingsManager } = await createRunner([
			{
				path: "<inline:first>",
				factory: (pi) => {
					pi.registerSetting({
						key: "acme.mode",
						schema: Type.Object({ strategy: Type.String() }),
						defaultValue: { strategy: "first" },
						title: "Mode",
						description: "Mode",
						ui: {
							control: "select",
							choices: [
								{ label: "First label", value: { strategy: "first" } },
								{ label: "Selected label", value: { strategy: "selected" } },
							],
						},
					});
				},
			},
			{
				path: "<inline:second>",
				factory: (pi) => {
					pi.registerSetting(stringSetting("acme.mode", "second"));
				},
			},
		]);
		const selected = { strategy: "selected" };

		runner.setExtensionSettingValue("acme.mode", selected);
		selected.strategy = "mutated";

		expect(settingsManager.getExtensionSettingLayers("acme.mode")).toEqual({
			global: { strategy: "selected" },
			project: undefined,
		});
		expect(() => runner.setExtensionSettingValue("missing.key", "value")).toThrow(/not registered/i);
	});
});
