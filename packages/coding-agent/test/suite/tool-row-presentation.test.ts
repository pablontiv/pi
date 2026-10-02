import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component, Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import toolRowPresentation from "../../examples/extensions/tool-row-presentation.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type {
	ExtensionAPI,
	ExtensionSettingHandle,
	TranscriptPresentationPolicyRegistration,
} from "../../src/core/extensions/index.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarnessWithExtensions as createPersistentHarness } from "../test-harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const outputCapture = vi.hoisted(() => ({
	lines: [] as string[],
	rpcLineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => outputCapture.lines.push(line),
}));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		outputCapture.rpcLineHandler = onLine;
		return () => {
			outputCapture.rpcLineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const MODE_KEY = "pablontiv.tool-rows.mode";
const MIGRATION_KEY = "pablontiv.tool-rows.migrated-v1";
const TOOL_CALL_ID = "tool-row-parity-call";

type InteractiveInternals = {
	isInitialized: boolean;
	chatContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
	toolComponents: Set<ToolExecutionComponent>;
	presentedComponents: Map<Component, Component>;
	subscribeToAgent(): void;
	bindTranscriptPresentationInvalidation(): void;
	rebuildChatFromMessages(): void;
	setToolsExpanded(expanded: boolean): void;
	handleReloadCommand(): Promise<void>;
	stop(fullscreenExitOutput?: "transcript" | "resume-hint" | "none"): void;
};

function normalized(component: Component, width = 100): string {
	return stripAnsi(component.render(width).join("\n"))
		.replace(/[ \t]+$/gm, "")
		.trim();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for mounted interactive tool state");
}

function createRuntimeHost(harness: { session: Harness["session"] }): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setBeforeSessionInvalidate: vi.fn(),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function mountInteractive(harness: Harness): InteractiveInternals {
	const mode = new InteractiveMode(createRuntimeHost(harness), {
		terminal: new VirtualTerminal(100, 30),
	}) as unknown as InteractiveInternals;
	mode.isInitialized = true;
	mode.bindTranscriptPresentationInvalidation();
	mode.subscribeToAgent();
	return mode;
}

async function bindAndMount(harness: Harness): Promise<InteractiveInternals> {
	await harness.session.bindExtensions({});
	return mountInteractive(harness);
}

async function setMode(harness: { session: Harness["session"] }, mode: "full" | "compact" | "hidden") {
	const command = harness.session.extensionRunner.getCommand("tool-rows");
	if (!command) throw new Error("Expected /tool-rows command");
	await command.handler(mode, harness.session.extensionRunner.createCommandContext());
}

function mountedTool(mode: InteractiveInternals, id = TOOL_CALL_ID): ToolExecutionComponent {
	const pending = mode.pendingTools.get(id);
	if (pending) return pending;
	const completed = [...mode.toolComponents].find((component) => component.getTranscriptDescriptor().id === id);
	if (!completed) throw new Error(`Expected mounted tool ${id}`);
	return completed;
}

function mountedPresentation(mode: InteractiveInternals, tool: ToolExecutionComponent): Component {
	const presentation = mode.presentedComponents.get(tool);
	if (!presentation) throw new Error("Expected core-owned presentation wrapper");
	return presentation;
}

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo a value",
	parameters: Type.Object({ value: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `ECHO_RESULT:${String((params as { value: string }).value)}` }],
		details: {},
	}),
};

function toolResponses(name = "echo") {
	return [
		fauxAssistantMessage(fauxToolCall(name, { value: "alpha" }, { id: TOOL_CALL_ID }), { stopReason: "toolUse" }),
		fauxAssistantMessage("TOOL_TURN_DONE"),
	];
}

type NodeListener = Parameters<typeof process.on>[1];

function listenerSnapshot() {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ReturnType<typeof listenerSnapshot>): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previous] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
}

describe("tool row presentation extension parity", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		vi.restoreAllMocks();
		outputCapture.lines = [];
		outputCapture.rpcLineHandler = undefined;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps one mounted target through running, partial, mode changes, success, expansion, and history rebuild", async () => {
		let releaseTool = () => {};
		let markPartial = () => {};
		const partial = new Promise<void>((resolve) => {
			markPartial = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "PARTIAL_RESULT" }], details: {} });
				markPartial();
				await release;
				return { content: [{ type: "text", text: "FINAL_RESULT" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool], extensionFactories: [toolRowPresentation] });
		harnesses.push(harness);
		harness.setResponses(toolResponses("wait"));
		const mode = await bindAndMount(harness);
		await setMode(harness, "compact");

		const prompt = harness.session.prompt("run a partial tool");
		await partial;
		await waitUntil(() => mode.pendingTools.has(TOOL_CALL_ID));
		const tool = mountedTool(mode);
		const presentation = mountedPresentation(mode, tool);
		expect(presentation.render(100)).toHaveLength(1);
		expect(normalized(presentation)).toContain("[running]");
		expect(normalized(presentation)).not.toContain("PARTIAL_RESULT");
		expect(stripAnsi(presentation.render(4)[0] ?? "")).toBe("[running]");

		await setMode(harness, "full");
		expect(mode.pendingTools.get(TOOL_CALL_ID)).toBe(tool);
		expect(normalized(presentation)).toContain("PARTIAL_RESULT");
		await setMode(harness, "hidden");
		expect(presentation.render(100)).toEqual([]);

		releaseTool();
		await prompt;
		await setMode(harness, "compact");
		expect(mountedTool(mode)).toBe(tool);
		expect(normalized(presentation)).toContain("[ok]");
		expect(normalized(presentation)).not.toContain("FINAL_RESULT");

		mode.setToolsExpanded(true);
		expect(normalized(presentation)).toContain("FINAL_RESULT");
		mode.setToolsExpanded(false);
		expect(normalized(presentation)).toContain("[ok]");
		expect(normalized(presentation)).not.toContain("FINAL_RESULT");

		const liveSummary = presentation.render(100);
		mode.rebuildChatFromMessages();
		const historical = mountedTool(mode);
		expect(mountedPresentation(mode, historical).render(100)).toEqual(liveSummary);
	});

	it("restores hidden failed and aborted calls with their final error data", async () => {
		const failingTool: AgentTool = {
			name: "fail",
			label: "Fail",
			description: "Fail",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				throw new Error("EXPECTED_TOOL_FAILURE");
			},
		};
		const failed = await createHarness({ tools: [failingTool], extensionFactories: [toolRowPresentation] });
		harnesses.push(failed);
		failed.setResponses(toolResponses("fail"));
		const failedMode = await bindAndMount(failed);
		await setMode(failed, "hidden");
		await failed.session.prompt("fail");
		const failedPresentation = mountedPresentation(failedMode, mountedTool(failedMode));
		expect(failedPresentation.render(100)).toEqual([]);
		await setMode(failed, "compact");
		expect(normalized(failedPresentation)).toContain("[error]");
		await setMode(failed, "full");
		expect(normalized(failedPresentation)).toContain("EXPECTED_TOOL_FAILURE");

		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Block until aborted",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, _params, signal) => {
				markStarted();
				return await new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("ABORTED_TOOL_TRACE")), { once: true });
				});
			},
		};
		const aborted = await createHarness({ tools: [blockingTool], extensionFactories: [toolRowPresentation] });
		harnesses.push(aborted);
		aborted.setResponses([
			fauxAssistantMessage(fauxToolCall("block", { value: "alpha" }, { id: TOOL_CALL_ID }), {
				stopReason: "toolUse",
			}),
		]);
		const abortedMode = await bindAndMount(aborted);
		await setMode(aborted, "hidden");
		const abortedPrompt = aborted.session.prompt("abort");
		await started;
		await aborted.session.abort();
		await abortedPrompt;
		const abortedPresentation = mountedPresentation(abortedMode, mountedTool(abortedMode));
		expect(abortedPresentation.render(100)).toEqual([]);
		await setMode(aborted, "compact");
		expect(normalized(abortedPresentation)).toContain("[error]");
		await setMode(aborted, "full");
		const abortedResult = aborted.session.messages.find((message) => message.role === "toolResult");
		expect(abortedResult?.role).toBe("toolResult");
		if (abortedResult?.role !== "toolResult") throw new Error("Expected aborted tool result");
		const errorText = abortedResult.content.find((part) => part.type === "text")?.text;
		expect(errorText).toBeTruthy();
		expect(normalized(abortedPresentation)).toContain(errorText);
	});

	it("renders full mode byte-for-byte and line-for-line like the no-extension baseline", async () => {
		const render = async (withExtension: boolean): Promise<string[]> => {
			const harness = await createHarness({
				tools: [echoTool],
				extensionFactories: withExtension ? [toolRowPresentation] : undefined,
			});
			harnesses.push(harness);
			harness.setResponses(toolResponses());
			const mode = await bindAndMount(harness);
			await harness.session.prompt("exact full output");
			return mode.chatContainer.render(100);
		};

		const baseline = await render(false);
		const extensionFull = await render(true);
		expect(extensionFull).toEqual(baseline);
		expect(Buffer.from(extensionFull.join("\n"))).toEqual(Buffer.from(baseline.join("\n")));
	});

	it("reconstructs the same compact tool row from a replacement session using persisted history", async () => {
		const sessionManager = SessionManager.inMemory();
		const first = await createHarness({
			tools: [echoTool],
			sessionManager,
			extensionFactories: [toolRowPresentation],
		});
		harnesses.push(first);
		first.setResponses(toolResponses());
		const firstMode = await bindAndMount(first);
		await setMode(first, "compact");
		await first.session.prompt("persist history");
		const firstLines = mountedPresentation(firstMode, mountedTool(firstMode)).render(100);

		first.cleanup();
		harnesses.splice(harnesses.indexOf(first), 1);
		const replacement = await createHarness({
			tools: [echoTool],
			sessionManager,
			extensionFactories: [toolRowPresentation],
		});
		harnesses.push(replacement);
		const replacementMode = await bindAndMount(replacement);
		await setMode(replacement, "compact");
		replacementMode.rebuildChatFromMessages();
		expect(mountedPresentation(replacementMode, mountedTool(replacementMode)).render(100)).toEqual(firstLines);
	});

	it("hidden mode suppresses only orphaned thinking while preserving ordinary thinking", async () => {
		const responses = [
			fauxAssistantMessage(
				[fauxThinking("PRIVATE_REASONING"), fauxToolCall("echo", { value: "alpha" }, { id: TOOL_CALL_ID })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		];
		const orphaned = await createHarness({
			tools: [echoTool],
			settings: { hideThinkingBlock: true },
			extensionFactories: [toolRowPresentation],
		});
		harnesses.push(orphaned);
		orphaned.setResponses(responses);
		const orphanedMode = await bindAndMount(orphaned);
		await setMode(orphaned, "hidden");
		await orphaned.session.prompt("orphaned thinking");
		expect(normalized(orphanedMode.chatContainer)).not.toContain("Thinking...");
		expect(normalized(orphanedMode.chatContainer)).not.toContain("ECHO_RESULT");

		const ordinary = await createHarness({
			tools: [echoTool],
			settings: { hideThinkingBlock: false },
			extensionFactories: [toolRowPresentation],
		});
		harnesses.push(ordinary);
		ordinary.setResponses(responses);
		const ordinaryMode = await bindAndMount(ordinary);
		await setMode(ordinary, "hidden");
		await ordinary.session.prompt("ordinary thinking");
		expect(normalized(ordinaryMode.chatContainer)).toContain("PRIVATE_REASONING");
		expect(normalized(ordinaryMode.chatContainer)).not.toContain("ECHO_RESULT");
	});
});

describe("tool row setting persistence and runtime replacement", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.restoreAllMocks());

	function capturingFactory(capture: {
		handles: ExtensionSettingHandle<unknown>[];
		listeners: Array<ReturnType<typeof vi.fn<(value: unknown) => void>>>;
		registrations: TranscriptPresentationPolicyRegistration[];
		policies: Parameters<ExtensionAPI["registerTranscriptPresentationPolicy"]>[0][];
	}) {
		return (pi: ExtensionAPI) => {
			const proxy = new Proxy(pi, {
				get(target, property, receiver) {
					if (property === "registerSetting") {
						return (definition: Parameters<ExtensionAPI["registerSetting"]>[0]) => {
							const handle = target.registerSetting(definition);
							const trackedHandle: ExtensionSettingHandle<unknown> = {
								key: handle.key,
								get: () => handle.get(),
								set: (value, options) => handle.set(value, options),
								onChange: (listener) => {
									const trackedListener = vi.fn(listener);
									capture.listeners.push(trackedListener);
									return handle.onChange(trackedListener);
								},
							};
							capture.handles.push(trackedHandle);
							return trackedHandle;
						};
					}
					if (property === "registerTranscriptPresentationPolicy") {
						return (policy: Parameters<ExtensionAPI["registerTranscriptPresentationPolicy"]>[0]) => {
							const registration = target.registerTranscriptPresentationPolicy(policy);
							capture.policies.push(policy);
							capture.registrations.push(registration);
							return registration;
						};
					}
					return Reflect.get(target, property, receiver);
				},
			});
			toolRowPresentation(proxy);
		};
	}

	async function createReloadingResources(factory: (pi: ExtensionAPI) => void): Promise<ResourceLoader> {
		let result = await createTestExtensionsResult([{ path: "<tool-row-reload>", factory }]);
		const base = createTestResourceLoader({ extensionsResult: result });
		return {
			...base,
			getExtensions: () => result,
			reload: async () => {
				result = await createTestExtensionsResult([{ path: "<tool-row-reload>", factory }]);
			},
		};
	}

	it("flushes compact mode and restores it through production reload while every old owner is stale", async () => {
		const capture = {
			handles: [] as ExtensionSettingHandle<unknown>[],
			listeners: [] as Array<ReturnType<typeof vi.fn<(value: unknown) => void>>>,
			registrations: [] as TranscriptPresentationPolicyRegistration[],
			policies: [] as Parameters<ExtensionAPI["registerTranscriptPresentationPolicy"]>[0][],
		};
		const resourceLoader = await createReloadingResources(capturingFactory(capture));
		const harness = await createPersistentHarness({ resourceLoader });
		await harness.session.bindExtensions({});
		const mode = new InteractiveMode(createRuntimeHost(harness as unknown as { session: Harness["session"] }), {
			terminal: new VirtualTerminal(100, 30),
		}) as unknown as InteractiveInternals;
		await (mode as unknown as { init(): Promise<void> }).init();
		const oldRunner = harness.session.extensionRunner;
		const oldHandle = capture.handles.find((handle) => handle.key === MODE_KEY);
		const oldRegistration = capture.registrations[0];
		const oldPolicy = capture.policies[0];
		const oldInvalidated = vi.fn();
		oldRunner.onTranscriptPresentationInvalidated(oldInvalidated);
		if (!oldHandle || !oldRegistration || !oldPolicy) throw new Error("Expected captured old extension owners");

		try {
			await setMode(harness as unknown as { session: Harness["session"] }, "compact");
			const oldListener = capture.listeners.at(-1);
			expect(oldListener).toHaveBeenCalledOnce();
			await harness.settingsManager.flush();
			const persisted = JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf8"));
			expect(persisted.extensionSettings[MODE_KEY]).toBe("compact");

			await mode.handleReloadCommand();
			const replacementRunner = harness.session.extensionRunner;
			expect(replacementRunner).not.toBe(oldRunner);
			expect(replacementRunner.getExtensionSettingValue(MODE_KEY)).toBe("compact");
			expect(capture.handles.filter((handle) => handle.key === MODE_KEY)).toHaveLength(2);
			expect(capture.registrations).toHaveLength(2);
			expect(() => oldHandle.get()).toThrow(/stale/i);
			expect(() => oldRegistration.invalidate()).toThrow(/stale/i);
			expect(() =>
				oldPolicy({ kind: "tool", capabilities: { summary: true, expandable: true } }, { density: "full" }),
			).toThrow(/stale/i);
			oldInvalidated.mockClear();
			oldListener?.mockClear();
			await setMode(harness as unknown as { session: Harness["session"] }, "hidden");
			expect(oldListener).not.toHaveBeenCalled();
			expect(oldInvalidated).not.toHaveBeenCalled();
		} finally {
			mode.stop("none");
			harness.cleanup();
		}
	});

	it.each([
		{
			name: "legacy-only",
			fixture: { toolRowsMode: "compact", unrelated: true },
			expectedMode: "compact",
			expectedLegacy: "compact",
		},
		{
			name: "new-only",
			fixture: { extensionSettings: { [MODE_KEY]: "hidden" }, unrelated: true },
			expectedMode: "hidden",
			expectedLegacy: undefined,
		},
		{
			name: "already-migrated",
			fixture: {
				toolRowsMode: "hidden",
				extensionSettings: { [MODE_KEY]: "compact", [MIGRATION_KEY]: true },
				unrelated: true,
			},
			expectedMode: "compact",
			expectedLegacy: "hidden",
		},
	])(
		"migrates the $name real settings fixture once without deleting legacy ownership",
		async ({ fixture, expectedMode, expectedLegacy }) => {
			const resourceLoader = await createReloadingResources(toolRowPresentation);
			const harness = await createPersistentHarness({ resourceLoader });
			const settingsPath = join(harness.tempDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify(fixture));
			await harness.settingsManager.reload();
			await harness.session.bindExtensions({});
			await harness.settingsManager.flush();
			const afterFirst = readFileSync(settingsPath, "utf8");
			const parsed = JSON.parse(afterFirst);
			expect(harness.session.extensionRunner.getExtensionSettingValue(MODE_KEY)).toBe(expectedMode);
			expect(parsed.extensionSettings[MIGRATION_KEY]).toBe(true);
			expect(parsed.toolRowsMode).toBe(expectedLegacy);
			expect(parsed.unrelated).toBe(true);

			await harness.session.reload();
			await harness.settingsManager.flush();
			expect(readFileSync(settingsPath, "utf8")).toBe(afterFirst);
			expect(harness.session.extensionRunner.getExtensionSettingValue(MODE_KEY)).toBe(expectedMode);
			harness.cleanup();
		},
	);
});

describe("non-interactive tool row transparency", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		outputCapture.lines = [];
		outputCapture.rpcLineHandler = undefined;
	});

	function normalizeSessionHeader(output: string): string {
		return output
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value.type === "session") {
					value.id = "<session-id>";
					value.timestamp = "<session-timestamp>";
				}
				return JSON.stringify(value);
			})
			.join("\n");
	}

	async function runPrint(withExtension: boolean, mode: "text" | "json") {
		outputCapture.lines = [];
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: withExtension ? [toolRowPresentation] : undefined,
		});
		harness.setResponses(toolResponses());
		const runtimeHost = createRuntimeHost(harness);
		const exitCode = await runPrintMode(runtimeHost, { mode, initialMessage: "non-interactive tool" });
		const rawOutput = outputCapture.lines.join("");
		const result = {
			exitCode,
			output: mode === "json" ? normalizeSessionHeader(rawOutput) : rawOutput,
			messages: JSON.stringify(harness.session.messages),
		};
		harness.cleanup();
		return result;
	}

	async function runRpc(withExtension: boolean) {
		outputCapture.lines = [];
		const listeners = listenerSnapshot();
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: withExtension ? [toolRowPresentation] : undefined,
		});
		harness.setResponses(toolResponses());
		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(outputCapture.rpcLineHandler).toBeDefined());
			outputCapture.rpcLineHandler?.(
				JSON.stringify({
					id: "prompt-1",
					type: "prompt",
					message: "non-interactive tool",
				}),
			);
			await vi.waitFor(() => {
				expect(outputCapture.lines.join("")).toContain('"type":"agent_end"');
			});
			return {
				output: outputCapture.lines.join(""),
				messages: JSON.stringify(harness.session.messages),
			};
		} finally {
			outputCapture.rpcLineHandler = undefined;
			harness.cleanup();
			restoreListeners(listeners);
		}
	}

	it("leaves print, JSON, and RPC session/tool data identical with no presentation consumer", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		vi.spyOn(Math, "random").mockReturnValue(0.125);
		for (const mode of ["text", "json"] as const) {
			const baseline = await runPrint(false, mode);
			const withExtension = await runPrint(true, mode);
			expect(withExtension).toEqual(baseline);
		}
		const baselineRpc = await runRpc(false);
		const extensionRpc = await runRpc(true);
		expect(extensionRpc).toEqual(baselineRpc);
	});
});
