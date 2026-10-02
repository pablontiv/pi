import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionSettingDefinition } from "../src/core/extensions/types.ts";
import type {
	TranscriptBlockDescriptor,
	TranscriptBlockKind,
	TranscriptBlockSubtype,
	TranscriptDensity,
	TranscriptPresentation,
	TranscriptPresentationPolicy,
	TranscriptPresentationPolicyRegistration,
} from "../src/index.ts";

const publicTranscriptPresentationTypes: {
	kind: TranscriptBlockKind;
	subtype: TranscriptBlockSubtype;
	density: TranscriptDensity;
	descriptor: TranscriptBlockDescriptor;
	presentation: TranscriptPresentation;
	policy: TranscriptPresentationPolicy;
	registration: TranscriptPresentationPolicyRegistration;
} = {
	kind: "notice",
	subtype: "orphaned-thinking-placeholder",
	density: "full",
	descriptor: {
		kind: "notice",
		capabilities: { summary: false, expandable: false },
	},
	presentation: { density: "full" },
	policy: () => undefined,
	registration: { invalidate: () => {}, dispose: () => {} },
};
void publicTranscriptPresentationTypes;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("extensions discovery", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionCode = `
		export default function(pi) {
			pi.registerCommand("test", { handler: async () => {} });
		}
	`;

	const extensionCodeWithTool = (toolName: string) => `
		import { Type } from "typebox";
		export default function(pi) {
			pi.registerTool({
				name: "${toolName}",
				label: "${toolName}",
				description: "Test tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});
		}
	`;

	it("discovers direct .ts files in extensions/", async () => {
		fs.writeFileSync(path.join(extensionsDir, "foo.ts"), extensionCode);
		fs.writeFileSync(path.join(extensionsDir, "bar.ts"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
		expect(result.extensions.map((e) => path.basename(e.path)).sort()).toEqual(["bar.ts", "foo.ts"]);
	});

	it("loads the coding-agent entrypoint without rewriting pi-ai provider subpaths", async () => {
		fs.writeFileSync(
			path.join(extensionsDir, "coding-agent-import.ts"),
			`
				import { getAgentDir } from "@earendil-works/pi-coding-agent";
				void getAgentDir;
				export default function(pi) {
					pi.registerCommand("test", { handler: async () => {} });
				}
			`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
	});

	it("does not infer package ownership from ancestor manifests", async () => {
		// Regression for #9863.
		const dependencyDir = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");
		fs.mkdirSync(dependencyDir, { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				name: "application",
				type: "module",
				dependencies: { "@earendil-works/pi-coding-agent": "1.0.0" },
			}),
		);
		fs.writeFileSync(
			path.join(dependencyDir, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./index.js" }),
		);
		fs.writeFileSync(path.join(dependencyDir, "index.js"), "export const physicalDependency = true;");
		fs.writeFileSync(
			path.join(extensionsDir, "compiled-esm-extension.js"),
			`
				import { physicalDependency } from "@earendil-works/pi-coding-agent";
				export default function(pi) {
					if (physicalDependency) pi.registerCommand("physical-dependency", { handler: async () => {} });
				}
			`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("physical-dependency")).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("keeps the type-only pi-ai OAuth compatibility barrel resolvable", async () => {
		fs.writeFileSync(
			path.join(extensionsDir, "oauth-import.ts"),
			`
				import * as oauth from "@earendil-works/pi-ai/oauth";
				void oauth;
				export default function(pi) {
					pi.registerCommand("test", { handler: async () => {} });
				}
			`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});

	it("discovers direct .js files in extensions/", async () => {
		fs.writeFileSync(path.join(extensionsDir, "foo.js"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(path.basename(result.extensions[0].path)).toBe("foo.js");
	});

	it("discovers subdirectory with index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("my-extension");
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("discovers subdirectory with index.js", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.js"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.js");
	});

	it("prefers index.ts over index.js", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir, "index.js"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("discovers subdirectory with package.json pi field", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		const srcDir = path.join(subdir, "src");
		fs.mkdirSync(subdir);
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, "main.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				pi: {
					extensions: ["./src/main.ts"],
				},
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("src");
		expect(result.extensions[0].path).toContain("main.ts");
	});

	it("keeps package.json pi extension entries with leading tilde package-relative", async () => {
		const subdir = path.join(extensionsDir, "tilde-package");
		const directExtensionPath = path.join(subdir, "~entry.ts");
		const slashExtensionPath = path.join(subdir, "~", "entry.ts");
		fs.mkdirSync(path.join(subdir, "~"), { recursive: true });
		fs.writeFileSync(directExtensionPath, extensionCode);
		fs.writeFileSync(slashExtensionPath, extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "tilde-package",
				pi: {
					extensions: ["~entry.ts", "~/entry.ts"],
				},
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => extension.path).sort()).toEqual(
			[directExtensionPath, slashExtensionPath].sort(),
		);
	});

	it("package.json can declare multiple extensions", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "ext1.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir, "ext2.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				pi: {
					extensions: ["./ext1.ts", "./ext2.ts"],
				},
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
	});

	it("package.json with pi field takes precedence over index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCodeWithTool("from-index"));
		fs.writeFileSync(path.join(subdir, "custom.ts"), extensionCodeWithTool("from-custom"));
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				pi: {
					extensions: ["./custom.ts"],
				},
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("custom.ts");
		// Verify the right tool was registered
		expect(result.extensions[0].tools.has("from-custom")).toBe(true);
		expect(result.extensions[0].tools.has("from-index")).toBe(false);
	});

	it("ignores package.json without pi field, falls back to index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				version: "1.0.0",
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("ignores subdirectory without index or package.json", async () => {
		const subdir = path.join(extensionsDir, "not-an-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "helper.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir, "utils.ts"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("does not recurse beyond one level", async () => {
		const subdir = path.join(extensionsDir, "container");
		const nested = path.join(subdir, "nested");
		fs.mkdirSync(subdir);
		fs.mkdirSync(nested);
		fs.writeFileSync(path.join(nested, "index.ts"), extensionCode);
		// No index.ts or package.json in container/

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("handles mixed direct files and subdirectories", async () => {
		// Direct file
		fs.writeFileSync(path.join(extensionsDir, "direct.ts"), extensionCode);

		// Subdirectory with index
		const subdir1 = path.join(extensionsDir, "with-index");
		fs.mkdirSync(subdir1);
		fs.writeFileSync(path.join(subdir1, "index.ts"), extensionCode);

		// Subdirectory with package.json
		const subdir2 = path.join(extensionsDir, "with-manifest");
		fs.mkdirSync(subdir2);
		fs.writeFileSync(path.join(subdir2, "entry.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir2, "package.json"), JSON.stringify({ pi: { extensions: ["./entry.ts"] } }));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(3);
	});

	it("skips non-existent paths declared in package.json", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "exists.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: ["./exists.ts", "./missing.ts"],
				},
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("exists.ts");
	});

	it("loads extensions and registers commands", async () => {
		fs.writeFileSync(path.join(extensionsDir, "with-command.ts"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("test")).toBe(true);
	});

	it("loads extensions and registers tools", async () => {
		fs.writeFileSync(path.join(extensionsDir, "with-tool.ts"), extensionCodeWithTool("my-tool"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("my-tool")).toBe(true);
	});

	it("reports errors for invalid extension code", async () => {
		fs.writeFileSync(path.join(extensionsDir, "invalid.ts"), "this is not valid typescript export");

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toContain("invalid.ts");
		expect(result.extensions).toHaveLength(0);
	});

	it("handles explicitly configured paths", async () => {
		const customPath = path.join(tempDir, "custom-location", "my-ext.ts");
		fs.mkdirSync(path.dirname(customPath), { recursive: true });
		fs.writeFileSync(customPath, extensionCode);

		const result = await discoverAndLoadExtensions([customPath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("my-ext.ts");
	});

	it("resolves dependencies from extension's own node_modules", async () => {
		// Load extension that has its own package.json and node_modules with 'ms' package
		const extPath = path.resolve(__dirname, "../examples/extensions/with-deps");

		const result = await discoverAndLoadExtensions([extPath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("with-deps");
		// The extension registers a 'parse_duration' tool
		expect(result.extensions[0].tools.has("parse_duration")).toBe(true);
	});

	it("loads the generic transcript presentation policy example", async () => {
		const examplePath = path.resolve(__dirname, "../examples/extensions/transcript-presentation.ts");
		const result = await discoverAndLoadExtensions([examplePath], tempDir, tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].transcriptPresentationPolicies).toHaveLength(1);

		const policy = result.extensions[0].transcriptPresentationPolicies?.[0]?.policy;
		expect(
			policy?.({ kind: "notice", capabilities: { summary: true, expandable: false } }, { density: "full" }),
		).toEqual({ density: "hidden" });
		expect(
			policy?.({ kind: "custom-entry", capabilities: { summary: true, expandable: false } }, { density: "full" }),
		).toEqual({ density: "summary" });
		expect(
			policy?.({ kind: "custom-entry", capabilities: { summary: false, expandable: false } }, { density: "full" }),
		).toBeUndefined();
	});

	it("registers message and entry renderers", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerMarkdownTransformer((markdown) => {
					return markdown;
				});
				pi.registerMessageRenderer("my-custom-type", (message, options, theme) => {
					return null; // Use default rendering
				});
				pi.registerEntryRenderer("my-entry-type", (entry, options, theme) => {
					return null;
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-renderer.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].markdownTransformer).toBeDefined();
		expect(result.extensions[0].messageRenderers.has("my-custom-type")).toBe(true);
		expect(result.extensions[0].entryRenderers?.has("my-entry-type")).toBe(true);
	});

	it("stores transcript presentation policies in extension and registration order", async () => {
		const firstPath = path.join(tempDir, "first.ts");
		const secondPath = path.join(tempDir, "second.ts");
		fs.writeFileSync(
			firstPath,
			`
				export default function(pi) {
					pi.registerTranscriptPresentationPolicy(function firstFull() {
						return { density: "full" };
					});
					pi.registerTranscriptPresentationPolicy(function firstSummary() {
						return { density: "summary" };
					});
				}
			`,
		);
		fs.writeFileSync(
			secondPath,
			`
				export default function(pi) {
					pi.registerTranscriptPresentationPolicy(function secondHidden() {
						return { density: "hidden" };
					});
				}
			`,
		);

		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions([secondPath, firstPath], tempDir);

		expect(result.errors).toEqual([]);
		expect(
			result.extensions.flatMap((extension) =>
				(extension.transcriptPresentationPolicies ?? []).map((registration) => ({
					name: registration.policy.name,
					sourcePath: registration.sourceInfo.path,
				})),
			),
		).toEqual([
			{ name: "secondHidden", sourcePath: secondPath },
			{ name: "firstFull", sourcePath: firstPath },
			{ name: "firstSummary", sourcePath: firstPath },
		]);
	});

	it("reports error when extension throws during initialization", async () => {
		const extCode = `
			export default function(pi) {
				throw new Error("Initialization failed!");
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("Initialization failed!");
		expect(result.extensions).toHaveLength(0);
	});

	it("reports error when extension has no default export", async () => {
		const extCode = `
			export function notDefault(pi) {
				pi.registerCommand("test", { handler: async () => {} });
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "no-default.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("does not export a valid factory function");
		expect(result.extensions).toHaveLength(0);
	});

	it("allows multiple extensions to register different tools", async () => {
		fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), extensionCodeWithTool("tool-a"));
		fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), extensionCodeWithTool("tool-b"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);

		const allTools = new Set<string>();
		for (const ext of result.extensions) {
			for (const name of ext.tools.keys()) {
				allTools.add(name);
			}
		}
		expect(allTools.has("tool-a")).toBe(true);
		expect(allTools.has("tool-b")).toBe(true);
	});

	it("loads extension with event handlers", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("agent_start", async () => {});
				pi.on("tool_call", async (event) => undefined);
				pi.on("agent_end", async () => {});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-handlers.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].handlers.has("agent_start")).toBe(true);
		expect(result.extensions[0].handlers.has("tool_call")).toBe(true);
		expect(result.extensions[0].handlers.has("agent_end")).toBe(true);
	});

	it("loads the checked extension-owned setting example", async () => {
		const examplePath = path.resolve(__dirname, "../examples/extensions/extension-setting.ts");
		const result = await discoverAndLoadExtensions([examplePath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].settings?.has("example.display-mode")).toBe(true);
		expect(result.extensions[0].commands.has("extension-setting")).toBe(true);
		expect(result.extensions[0].handlers.has("session_start")).toBe(true);
		expect(result.extensions[0].handlers.has("session_shutdown")).toBe(true);
	});

	it("loads extension with shortcuts", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerShortcut("ctrl+t", {
					description: "Test shortcut",
					handler: async (ctx) => {},
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-shortcut.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].shortcuts.has("ctrl+t")).toBe(true);
	});

	it("loads extension with flags", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerFlag("my-flag", {
					description: "My custom flag",
					handler: async (value) => {},
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].flags.has("my-flag")).toBe(true);
	});

	it("loadExtensions only loads explicit paths without discovery", async () => {
		// Create discoverable extensions (would be found by discoverAndLoadExtensions)
		fs.writeFileSync(path.join(extensionsDir, "discovered.ts"), extensionCodeWithTool("discovered"));

		// Create explicit extension outside discovery path
		const explicitPath = path.join(tempDir, "explicit.ts");
		fs.writeFileSync(explicitPath, extensionCodeWithTool("explicit"));

		// Use loadExtensions directly to skip discovery
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions([explicitPath], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("explicit")).toBe(true);
		expect(result.extensions[0].tools.has("discovered")).toBe(false);
	});

	it("loadExtensions with no paths loads nothing", async () => {
		// Create discoverable extensions (would be found by discoverAndLoadExtensions)
		fs.writeFileSync(path.join(extensionsDir, "discovered.ts"), extensionCode);

		// Use loadExtensions directly with empty paths
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions([], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});
});

describe("extension setting registration", () => {
	const modeSchema = Type.Union([Type.Literal("full"), Type.Literal("compact"), Type.Literal("hidden")]);
	const modeDefinition = (): ExtensionSettingDefinition<typeof modeSchema> => ({
		key: "acme.tool-rows.mode",
		schema: modeSchema,
		defaultValue: "full",
		title: "Tool rows",
		description: "How tool calls appear",
		ui: {
			control: "select",
			choices: [
				{ label: "Full", value: "full" },
				{ label: "Compact", value: "compact" },
				{ label: "Hidden", value: "hidden" },
			],
		},
	});

	async function loadSettingExtension(
		register: (pi: ExtensionAPI) => void | Promise<void>,
	): Promise<Awaited<ReturnType<typeof loadExtensionFromFactory>>> {
		return loadExtensionFromFactory(
			register,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:settings>",
		);
	}

	it("registers a cloned immutable literal-union definition with source ownership", async () => {
		const definition = modeDefinition();
		const extension = await loadSettingExtension((pi) => {
			pi.registerSetting(definition);
		});

		const registration = extension.settings?.get(definition.key);
		expect(extension.settings).toHaveLength(1);
		expect(registration).toEqual({
			definition,
			sourceInfo: extension.sourceInfo,
		});
		expect(registration?.definition).not.toBe(definition);
		expect(registration?.definition.schema).not.toBe(definition.schema);
		expect(registration?.definition.ui?.choices).not.toBe(definition.ui?.choices);
		expect(Object.isFrozen(registration)).toBe(true);
		expect(Object.isFrozen(registration?.definition)).toBe(true);
		expect(Object.isFrozen(registration?.definition.schema)).toBe(true);
		expect(Object.isFrozen(registration?.definition.ui?.choices)).toBe(true);

		definition.defaultValue = "compact";
		const mutableChoice = definition.ui!.choices[0] as { label: string; value: "full" | "compact" | "hidden" };
		mutableChoice.label = "Changed";
		mutableChoice.value = "compact";
		expect(registration?.definition.defaultValue).toBe("full");
		expect(registration?.definition.ui?.choices[0]).toEqual({ label: "Full", value: "full" });
	});

	it("keeps setting storage lazy for extensions without registrations", async () => {
		const extension = await loadSettingExtension(() => {});
		expect(extension.settings).toBeUndefined();
	});

	it("preserves TypeBox schema metadata in the immutable clone", async () => {
		const schema = Type.Refine(Type.String(), (value) => value.length > 0);
		const extension = await loadSettingExtension((pi) => {
			pi.registerSetting({
				key: "acme.non-empty",
				schema,
				defaultValue: "value",
				title: "Non-empty value",
				description: "A refined setting",
			});
		});

		const clonedSchema = extension.settings?.get("acme.non-empty")?.definition.schema;
		expect(clonedSchema).toBeDefined();
		expect(clonedSchema).not.toBe(schema);
		expect(Check(clonedSchema!, "")).toBe(false);
		expect(Object.isFrozen(Reflect.get(clonedSchema!, "~refine"))).toBe(true);
	});

	it.each(["mode", "Acme.mode", "acme..mode", "acme.constructor.mode", "acme.prototype.mode"])(
		"rejects malformed or prototype-sensitive key %s",
		async (key) => {
			await expect(
				loadSettingExtension((pi) => {
					pi.registerSetting({ ...modeDefinition(), key });
				}),
			).rejects.toThrow(/invalid extension setting key/i);
		},
	);

	it("matches UI defaults structurally and detaches nested registered values", async () => {
		const schema = Type.Object({ mode: Type.String(), nested: Type.Object({ enabled: Type.Boolean() }) });
		const defaultValue = { mode: "full", nested: { enabled: true } };
		const choiceValue = { nested: { enabled: true }, mode: "full" };
		const extension = await loadSettingExtension((pi) => {
			pi.registerSetting({
				key: "acme.structured-mode",
				schema,
				defaultValue,
				title: "Structured mode",
				description: "A structured setting",
				ui: {
					control: "select",
					choices: [{ label: "Full", value: choiceValue }],
				},
			});
		});

		defaultValue.nested.enabled = false;
		choiceValue.nested.enabled = false;
		const definition = extension.settings?.get("acme.structured-mode")?.definition;
		expect(definition?.defaultValue).toEqual({ mode: "full", nested: { enabled: true } });
		expect(definition?.ui?.choices[0]?.value).toEqual({ mode: "full", nested: { enabled: true } });
		expect(definition?.defaultValue).not.toBe(defaultValue);
		expect(definition?.ui?.choices[0]?.value).not.toBe(choiceValue);
		expect(Object.isFrozen(definition?.defaultValue)).toBe(true);
		expect(Object.isFrozen((definition?.defaultValue as typeof defaultValue).nested)).toBe(true);
		expect(Object.isFrozen(definition?.ui?.choices[0]?.value)).toBe(true);
		expect(Object.isFrozen((definition?.ui?.choices[0]?.value as typeof choiceValue).nested)).toBe(true);
	});

	it.each([
		["an owner namespace", () => ({ ...modeDefinition(), key: "mode" }), /key.*namespace|invalid.*key/i],
		["a schema-valid default", () => ({ ...modeDefinition(), defaultValue: "unsupported" }), /default.*schema/i],
		[
			"schema-valid UI choices",
			() => ({
				...modeDefinition(),
				ui: { control: "select" as const, choices: [{ label: "Unsupported", value: "unsupported" }] },
			}),
			/choice.*schema/i,
		],
		[
			"a strict-JSON default",
			() => ({ ...modeDefinition(), defaultValue: Number.NaN }),
			/default.*strict JSON|strict JSON.*default/i,
		],
		[
			"strict-JSON UI choices",
			() => ({
				...modeDefinition(),
				ui: { control: "select" as const, choices: [{ label: "Invalid", value: BigInt(1) }] },
			}),
			/choice.*strict JSON|strict JSON.*choice/i,
		],
		[
			"unique UI choice labels",
			() => ({
				...modeDefinition(),
				ui: {
					control: "select" as const,
					choices: [
						{ label: "Mode", value: "full" },
						{ label: "Mode", value: "compact" },
					],
				},
			}),
			/duplicate.*label/i,
		],
		[
			"the UI default among its choices",
			() => ({
				...modeDefinition(),
				ui: { control: "select" as const, choices: [{ label: "Compact", value: "compact" }] },
			}),
			/default.*choice/i,
		],
	] as const)("requires %s", async (_description, createDefinition, expectedError) => {
		await expect(
			loadSettingExtension((pi) => {
				pi.registerSetting(createDefinition() as ExtensionSettingDefinition<typeof modeSchema>);
			}),
		).rejects.toThrow(expectedError);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["a non-schema object", { notASchema: true }],
		[
			"a schema whose validator throws",
			Type.Refine(Type.String(), () => {
				throw new Error("broken refinement");
			}),
		],
	])("rejects %s schemas with setting context and the original cause", async (_description, schema) => {
		let thrown: unknown;
		try {
			await loadSettingExtension((pi) => {
				pi.registerSetting({ ...modeDefinition(), schema: schema as unknown as typeof modeSchema });
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		const registrationError = thrown as Error;
		expect(registrationError.message).toMatch(/acme\.tool-rows\.mode.*invalid.*schema/i);
		expect(registrationError.cause).toBeDefined();
	});

	it("rejects null UI metadata with setting context", async () => {
		await expect(
			loadSettingExtension((pi) => {
				pi.registerSetting({
					...modeDefinition(),
					ui: null,
				} as unknown as ExtensionSettingDefinition<typeof modeSchema>);
			}),
		).rejects.toThrow(/acme\.tool-rows\.mode.*UI metadata/i);
	});

	it("rejects a duplicate key in one extension", async () => {
		await expect(
			loadSettingExtension((pi) => {
				pi.registerSetting(modeDefinition());
				pi.registerSetting(modeDefinition());
			}),
		).rejects.toThrow(/already registered/i);
	});

	it("rejects registration after extension initialization", async () => {
		let capturedApi: ExtensionAPI | undefined;
		await loadSettingExtension((pi) => {
			capturedApi = pi;
		});

		expect(capturedApi).toBeDefined();
		expect(() => capturedApi!.registerSetting(modeDefinition())).toThrow(/during extension initialization/i);
	});
});
