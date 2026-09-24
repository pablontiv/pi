import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { ToolRowsMode } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("non-interactive extension tool-row mode", () => {
	test("reports full mode and ignores setters without a TUI", async () => {
		const loaded = await discoverAndLoadExtensions([], process.cwd(), process.cwd());
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		const ui = runner.getUIContext();

		expect("getToolRowsMode" in ui).toBe(true);
		const modeUI = ui as unknown as {
			getToolRowsMode(): ToolRowsMode;
			setToolRowsMode(mode: ToolRowsMode): void;
		};
		expect(modeUI.getToolRowsMode()).toBe("full");

		modeUI.setToolRowsMode("compact");

		expect(modeUI.getToolRowsMode()).toBe("full");
	});
});
