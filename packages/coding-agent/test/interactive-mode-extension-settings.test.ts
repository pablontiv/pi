import type { Component } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface TestRunner {
	getRegisteredSettings: () => readonly TestRegistration[];
	setExtensionSettingValue: (key: string, value: unknown) => void;
}

interface TestRegistration {
	definition: {
		key: string;
		schema: TSchema;
		defaultValue: unknown;
		title: string;
		description: string;
		ui?: {
			control: "select";
			choices: readonly { label: string; value: unknown }[];
		};
	};
	sourceInfo: {
		path: string;
		source: string;
		scope: "temporary";
		origin: "top-level";
	};
}

const registrations: readonly TestRegistration[] = [
	{
		definition: {
			key: "first.mode",
			schema: Type.Object({ mode: Type.String() }),
			defaultValue: { mode: "careful" },
			title: "First mode",
			description: "First extension setting",
			ui: {
				control: "select",
				choices: [
					{ label: "Careful", value: { mode: "careful" } },
					{ label: "Quick", value: { mode: "quick" } },
				],
			},
		},
		sourceInfo: {
			path: "<inline:first>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		},
	},
	{
		definition: {
			key: "hidden.value",
			schema: Type.String(),
			defaultValue: "hidden",
			title: "Hidden value",
			description: "Not exposed in settings UI",
		},
		sourceInfo: {
			path: "<inline:hidden>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		},
	},
	{
		definition: {
			key: "second.enabled",
			schema: Type.Boolean(),
			defaultValue: false,
			title: "Second enabled",
			description: "Second extension setting",
			ui: {
				control: "select",
				choices: [
					{ label: "Disabled", value: false },
					{ label: "Enabled", value: true },
				],
			},
		},
		sourceInfo: {
			path: "<inline:second>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		},
	},
];

function createFixture(firstMode: { mode: string } = { mode: "careful" }) {
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setExtensionSetting("first.mode", firstMode);
	settingsManager.setExtensionSetting("second.enabled", true);
	let active = true;
	let writeError: Error | undefined;
	const setExtensionSettingValue = vi.fn((key: string, value: unknown) => {
		if (!active) throw new Error("stale runtime");
		if (writeError) throw writeError;
		settingsManager.setExtensionSetting(key, value, "global");
	});
	const runner: TestRunner = {
		getRegisteredSettings: () => registrations,
		setExtensionSettingValue,
	};
	const session: {
		extensionRunner: TestRunner;
		autoCompactionEnabled: boolean;
		model: undefined;
		modelRuntime: { getAvailableSnapshot: () => [] };
		steeringMode: "all";
		followUpMode: "all";
	} = {
		extensionRunner: runner,
		autoCompactionEnabled: true,
		model: undefined,
		modelRuntime: { getAvailableSnapshot: () => [] },
		steeringMode: "all",
		followUpMode: "all",
	};
	let selector: SettingsSelectorComponent | undefined;
	const done = vi.fn();
	const showError = vi.fn();
	const fakeThis = {
		session,
		settingsManager,
		themeController: {
			getThemeSelection: () => "dark",
			getTerminalTheme: () => "dark" as const,
		},
		hideThinkingBlock: false,
		ui: { mode: "fullscreen" as const, requestRender: vi.fn() },
		showError,
		showSelector: (
			create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
		) => {
			const created = create(done);
			selector = created.component as SettingsSelectorComponent;
		},
	};
	const showSettingsSelector = Reflect.get(InteractiveMode.prototype, "showSettingsSelector") as (
		this: object,
	) => void;
	showSettingsSelector.call(fakeThis);

	return {
		done,
		fakeThis,
		runner,
		selector: selector!,
		setExtensionSettingValue,
		showError,
		failWrites(error: Error) {
			writeError = error;
		},
		invalidateRunner() {
			active = false;
		},
	};
}

function getItems(selector: SettingsSelectorComponent) {
	return Reflect.get(selector.getSettingsList(), "items") as Array<{
		id: string;
		label: string;
		currentValue: string;
	}>;
}

describe("InteractiveMode extension settings selector", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("maps UI registrations in order and writes typed choices through the captured runner", () => {
		const fixture = createFixture();
		const items = getItems(fixture.selector);

		expect(items.slice(-2)).toMatchObject([
			{ id: "extension-setting:first.mode", label: "First mode", currentValue: "Careful" },
			{ id: "extension-setting:second.enabled", label: "Second enabled", currentValue: "Enabled" },
		]);
		expect(items.some((item) => item.id === "extension-setting:hidden.value")).toBe(false);

		const list = fixture.selector.getSettingsList();
		list.selectItem("extension-setting:first.mode");
		list.handleInput("\r");

		expect(fixture.setExtensionSettingValue).toHaveBeenCalledWith("first.mode", { mode: "quick" });
		expect(getItems(fixture.selector).at(-2)?.currentValue).toBe("Quick");
	});

	it("shows a valid value outside the choices as custom and cycles it to the first choice", () => {
		const fixture = createFixture({ mode: "outside-current-choices" });
		const item = getItems(fixture.selector).find((candidate) => candidate.id === "extension-setting:first.mode");
		expect(item?.currentValue).toBe("(custom)");

		const list = fixture.selector.getSettingsList();
		list.selectItem("extension-setting:first.mode");
		list.handleInput("\r");

		expect(fixture.setExtensionSettingValue).toHaveBeenCalledWith("first.mode", { mode: "careful" });
		expect(item?.currentValue).toBe("Careful");
	});

	it("rolls back the prior effective label after a failed write and leaves the selector open", () => {
		const fixture = createFixture();
		const list = fixture.selector.getSettingsList();
		list.selectItem("extension-setting:first.mode");
		list.handleInput("\r");
		fixture.failWrites(new Error("settings file is read-only"));

		list.handleInput("\r");

		expect(getItems(fixture.selector).at(-2)?.currentValue).toBe("Quick");
		expect(fixture.showError).toHaveBeenCalledWith("settings file is read-only");
		expect(fixture.done).not.toHaveBeenCalled();
	});

	it("does not route a stale selector choice into the replacement runner after reload", () => {
		const fixture = createFixture();
		fixture.invalidateRunner();
		const replacementWrite = vi.fn();
		fixture.fakeThis.session.extensionRunner = {
			getRegisteredSettings: () => registrations,
			setExtensionSettingValue: replacementWrite,
		};
		const list = fixture.selector.getSettingsList();
		list.selectItem("extension-setting:second.enabled");

		list.handleInput("\r");

		expect(fixture.setExtensionSettingValue).toHaveBeenCalledWith("second.enabled", false);
		expect(replacementWrite).not.toHaveBeenCalled();
		expect(getItems(fixture.selector).at(-1)?.currentValue).toBe("Enabled");
		expect(fixture.showError).toHaveBeenCalledWith("stale runtime");
		expect(fixture.done).not.toHaveBeenCalled();
	});
});
