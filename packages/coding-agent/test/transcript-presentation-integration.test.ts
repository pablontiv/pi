import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type {
	TranscriptBlockDescriptor,
	TranscriptDensity,
	TranscriptPresentation,
} from "../src/core/extensions/transcript-presentation.ts";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

function normalized(container: Component, width = 100): string {
	return container
		.render(width)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/[ \t]+$/gm, "")
		.trim();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for interactive transcript state");
}

type InteractiveInternals = {
	isInitialized: boolean;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
	toolComponents: Set<ToolExecutionComponent>;
	pendingBashComponents: Component[];
	pendingBashMessages: Map<Component, Pick<BashExecutionMessage, "id">>;
	presentedComponents: Map<Component, Component>;
	subscribeToAgent(): void;
	bindTranscriptPresentationInvalidation(): void;
	clearChatContainer(): void;
	renderCurrentSessionState(): void;
	renderSessionItems(items: readonly AgentMessage[]): void;
	rebuildChatFromMessages(): void;
	setToolsExpanded(expanded: boolean): void;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	flushPendingBashComponents(): void;
	showError(message: string): void;
	handleReloadCommand(): Promise<void>;
};

function createInteractive(
	harness: Harness,
	hooks: {
		captureBeforeSessionInvalidate?: (callback: () => void) => void;
		getSession?: () => Harness["session"];
	} = {},
): InteractiveInternals {
	const runtimeHost = {
		get session() {
			return hooks.getSession?.() ?? harness.session;
		},
		setBeforeSessionInvalidate: (callback: () => void) => hooks.captureBeforeSessionInvalidate?.(callback),
		setRebindSession: () => {},
	};
	const mode = new InteractiveMode(runtimeHost as unknown as AgentSessionRuntime, {
		terminal: new VirtualTerminal(100, 30),
	}) as unknown as InteractiveInternals;
	mode.isInitialized = true;
	mode.bindTranscriptPresentationInvalidation();
	return mode;
}

describe("interactive transcript presentation integration", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("hides a live cache-miss notice as one unit and restores the existing unit through invalidation", async () => {
		let density: TranscriptDensity = "hidden";
		let invalidatePolicy = () => {};
		const noticeDescriptors: TranscriptBlockDescriptor[] = [];
		const harness = await createHarnessWithExtensions({
			settings: { showCacheMissNotices: true },
			responses: [
				{
					text: "LIVE_NOTICE_RESPONSE",
					usage: {
						input: 60_000,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 60_010,
						cost: { input: 0.3, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
					},
				},
			],
			extensionFactories: [
				{
					path: "<notice-presentation-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) => {
							if (block.kind !== "notice") return undefined;
							noticeDescriptors.push({ ...block, capabilities: { ...block.capabilities } });
							return { density };
						});
						invalidatePolicy = () => registration.invalidate();
					},
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "prior cached response" }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 10,
				cacheRead: 0,
				cacheWrite: 60_000,
				totalTokens: 60_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.4, total: 0.4 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1_000,
		});
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();
		const componentsBeforePrompt = new Set(mode.presentedComponents.keys());

		await harness.session.prompt("trigger a cache miss");

		expect(normalized(mode.chatContainer)).toContain("LIVE_NOTICE_RESPONSE");
		expect(normalized(mode.chatContainer)).not.toContain("Cache miss");
		const noticeUnit = [...mode.presentedComponents.keys()].find(
			(component) =>
				!componentsBeforePrompt.has(component) &&
				normalized(component).includes("Cache miss: 60k tokens re-billed (~$0.30)"),
		);
		expect(noticeUnit).toBeDefined();
		if (!noticeUnit) throw new Error("Expected a presented live notice unit");
		const noticePresentation = mode.presentedComponents.get(noticeUnit);
		expect(noticePresentation).toBeDefined();
		expect(mode.chatContainer.render(100).at(-1)).not.toBe("");
		expect(noticeDescriptors).toContainEqual({
			kind: "notice",
			capabilities: { summary: false, expandable: false },
		});

		density = "full";
		invalidatePolicy();
		expect(mode.presentedComponents.get(noticeUnit)).toBe(noticePresentation);
		const full = normalized(mode.chatContainer);
		expect(full).toContain("LIVE_NOTICE_RESPONSE\n\n Cache miss: 60k tokens re-billed (~$0.30)");
	});

	it("hides a reconstructed cache-warming notice without a spacer and restores its existing unit", async () => {
		let density: TranscriptDensity = "hidden";
		let invalidatePolicy = () => {};
		const harness = await createHarnessWithExtensions({
			settings: { showCacheMissNotices: true },
			extensionFactories: [
				{
					path: "<historical-notice-presentation-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "notice" ? { density } : undefined,
						);
						invalidatePolicy = () => registration.invalidate();
					},
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendUsage(
			"cache_warm",
			"faux",
			"faux-1",
			{
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 100,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
			},
			"history",
		);
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.render(100)).toEqual([]);
		const noticeUnit = [...mode.presentedComponents.keys()].find((component) =>
			normalized(component).includes("Cache warmed (history): $0.125"),
		);
		expect(noticeUnit).toBeDefined();
		if (!noticeUnit) throw new Error("Expected a presented historical notice unit");
		const noticePresentation = mode.presentedComponents.get(noticeUnit);

		density = "full";
		invalidatePolicy();
		expect(mode.presentedComponents.get(noticeUnit)).toBe(noticePresentation);
		expect(normalized(mode.chatContainer)).toBe("Cache warmed (history): $0.125");
		expect(mode.chatContainer.render(100)).toHaveLength(2);
	});

	it("keeps one live tool target through pending, partial, hidden, summary, and final states, then reconstructs the same presentation", async () => {
		let density: TranscriptDensity = "summary";
		let invalidatePolicy = () => {};
		let releaseTool = () => {};
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "PARTIAL_RESULT" }], details: {} });
				markToolStarted();
				await toolRelease;
				return { content: [{ type: "text", text: "FINAL_RESULT" }], details: {} };
			},
		};
		const harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ id: "live-tool", name: "wait", args: { value: "x" } }] }, "finished"],
			baseToolsOverride: { wait: waitTool },
			extensionFactories: [
				{
					path: "<presentation-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "tool" ? { density } : undefined,
						);
						invalidatePolicy = () => registration.invalidate();
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();

		const prompt = harness.session.prompt("run the tool");
		await toolStarted;
		await waitUntil(() => mode.pendingTools.has("live-tool"));
		const liveTool = mode.pendingTools.get("live-tool");
		expect(liveTool).toBeInstanceOf(ToolExecutionComponent);
		expect(normalized(mode.chatContainer)).toContain("[running]");
		expect(normalized(mode.chatContainer)).not.toContain("PARTIAL_RESULT");

		density = "full";
		invalidatePolicy();
		expect(mode.pendingTools.get("live-tool")).toBe(liveTool);
		expect(normalized(mode.chatContainer)).toContain("PARTIAL_RESULT");

		density = "hidden";
		invalidatePolicy();
		expect(mode.pendingTools.get("live-tool")).toBe(liveTool);
		expect(normalized(mode.chatContainer)).not.toContain("PARTIAL_RESULT");
		releaseTool();
		await prompt;

		density = "summary";
		invalidatePolicy();
		expect(normalized(mode.chatContainer)).toContain("[ok]");
		expect(normalized(mode.chatContainer)).not.toContain("FINAL_RESULT");
		density = "full";
		invalidatePolicy();
		expect(normalized(mode.chatContainer)).toContain("FINAL_RESULT");
		expect(mode.toolComponents.has(liveTool!)).toBe(true);

		density = "summary";
		invalidatePolicy();
		const liveSummary = normalized(mode.chatContainer)
			.split("\n")
			.find((line) => line.includes("[ok]"));
		mode.rebuildChatFromMessages();
		const historicalSummary = normalized(mode.chatContainer)
			.split("\n")
			.find((line) => line.includes("[ok]"));
		expect(historicalSummary).toBe(liveSummary);
	});

	it("preserves failed results while hidden and restores the historical and live error presentation", async () => {
		let density: TranscriptDensity = "hidden";
		let invalidatePolicy = () => {};
		const failingTool: AgentTool = {
			name: "fail",
			label: "Fail",
			description: "Fail for the test",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("EXPECTED_TOOL_FAILURE");
			},
		};
		const harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ id: "failed-tool", name: "fail", args: {} }] }, "recovered"],
			baseToolsOverride: { fail: failingTool },
			extensionFactories: [
				{
					path: "<hidden-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "tool" ? { density } : undefined,
						);
						invalidatePolicy = () => registration.invalidate();
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();
		await harness.session.prompt("fail");

		expect(normalized(mode.chatContainer)).not.toContain("EXPECTED_TOOL_FAILURE");
		density = "summary";
		invalidatePolicy();
		expect(normalized(mode.chatContainer)).toContain("[error]");
		density = "full";
		invalidatePolicy();
		expect(normalized(mode.chatContainer)).toContain("EXPECTED_TOOL_FAILURE");
		mode.rebuildChatFromMessages();
		expect(normalized(mode.chatContainer)).toContain("EXPECTED_TOOL_FAILURE");
	});

	it("applies the bash policy identically to every live creation path and reconstructed history", async () => {
		let density: TranscriptDensity = "hidden";
		let invalidatePolicy = () => {};
		const harness = await createHarnessWithExtensions({
			responses: [{ text: "streaming", delayMs: 50 }],
			extensionFactories: [
				{
					path: "<bash-presentation-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "bash" ? { density } : undefined,
						);
						invalidatePolicy = () => registration.invalidate();
						pi.on("user_bash", async (event) =>
							event.command === "intercepted"
								? {
										result: {
											output: "INTERCEPTED_BASH_OUTPUT",
											exitCode: 0,
											cancelled: false,
											truncated: false,
										},
									}
								: undefined,
						);
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockImplementation(async (_command, onOutput) => {
			const result = {
				output: "LOCAL_BASH_OUTPUT",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			};
			onOutput?.("LOCAL_BASH_OUTPUT");
			harness.session.recordBashResult("local", result);
			return result;
		});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();

		await mode.handleBashCommand("intercepted");
		await mode.handleBashCommand("local");
		expect(executeBash).toHaveBeenCalledOnce();
		expect(normalized(mode.chatContainer)).not.toContain("INTERCEPTED_BASH_OUTPUT");
		expect(normalized(mode.chatContainer)).not.toContain("LOCAL_BASH_OUTPUT");

		const prompt = harness.session.prompt("keep the session streaming");
		await waitUntil(() => harness.session.isStreaming);
		await mode.handleBashCommand("intercepted");
		expect(normalized(mode.pendingMessagesContainer)).not.toContain("INTERCEPTED_BASH_OUTPUT");
		mode.flushPendingBashComponents();
		expect(normalized(mode.chatContainer)).not.toContain("INTERCEPTED_BASH_OUTPUT");
		await prompt;

		density = "full";
		invalidatePolicy();
		const live = normalized(mode.chatContainer);
		expect(live).toContain("INTERCEPTED_BASH_OUTPUT");
		expect(live).toContain("LOCAL_BASH_OUTPUT");
		mode.rebuildChatFromMessages();
		const historical = normalized(mode.chatContainer);
		expect(historical).toContain("INTERCEPTED_BASH_OUTPUT");
		expect(historical).toContain("LOCAL_BASH_OUTPUT");
	});

	it("reconciles the exact persisted pending bash wrapper across a historical rebuild and flush", async () => {
		let density: TranscriptDensity = "hidden";
		let invalidatePolicy = () => {};
		const harness = await createHarnessWithExtensions({
			responses: [{ text: "ASSISTANT_STREAM_FINISHED", delayMs: 50 }],
			extensionFactories: [
				{
					path: "<pending-bash-presentation-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "bash" ? { density } : undefined,
						);
						invalidatePolicy = () => registration.invalidate();
						pi.on("user_bash", async (event) => ({
							result: {
								output:
									event.command === "ordinary"
										? "ORDINARY_HISTORICAL_BASH_OUTPUT"
										: "RETAINED_PENDING_BASH_OUTPUT",
								exitCode: 0,
								cancelled: false,
								truncated: false,
							},
						}));
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();

		await mode.handleBashCommand("ordinary");
		const prompt = harness.session.prompt("keep the session streaming");
		await waitUntil(() => harness.session.isStreaming);
		await mode.handleBashCommand("retained");
		const pendingBash = mode.pendingBashComponents[0];
		if (!pendingBash) throw new Error("Expected a pending bash component");
		const pendingWrapper = mode.presentedComponents.get(pendingBash);
		if (!pendingWrapper) throw new Error("Expected a pending bash presentation wrapper");
		expect(mode.pendingMessagesContainer.children.filter((child) => child === pendingWrapper)).toHaveLength(1);

		await prompt;
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "bashExecution" &&
						entry.message.command === "retained",
				),
		).toBe(true);

		// Exercise the production rebuild shape: clear chat and reconstruct persisted session items.
		mode.rebuildChatFromMessages();
		expect(mode.pendingBashComponents).toEqual([pendingBash]);
		expect(mode.presentedComponents.get(pendingBash)).toBe(pendingWrapper);
		expect(mode.pendingMessagesContainer.children).not.toContain(pendingWrapper);
		expect(mode.chatContainer.children.filter((child) => child === pendingWrapper)).toHaveLength(1);

		mode.flushPendingBashComponents();
		expect(mode.pendingBashComponents).toEqual([]);
		expect(mode.presentedComponents.get(pendingBash)).toBe(pendingWrapper);
		expect(mode.pendingMessagesContainer.children).not.toContain(pendingWrapper);
		expect(mode.chatContainer.children.filter((child) => child === pendingWrapper)).toHaveLength(1);
		expect(
			[...mode.presentedComponents.keys()].filter(
				(component) => component instanceof BashExecutionComponent && component.getCommand() === "retained",
			),
		).toEqual([pendingBash]);
		expect(normalized(mode.chatContainer)).not.toContain("RETAINED_PENDING_BASH_OUTPUT");

		mode.flushPendingBashComponents();
		expect(mode.chatContainer.children.filter((child) => child === pendingWrapper)).toHaveLength(1);
		density = "full";
		invalidatePolicy();
		const rendered = normalized(mode.chatContainer);
		expect(rendered.match(/RETAINED_PENDING_BASH_OUTPUT/g)).toHaveLength(1);
		expect(rendered.match(/ORDINARY_HISTORICAL_BASH_OUTPUT/g)).toHaveLength(1);
		expect(rendered.indexOf("ORDINARY_HISTORICAL_BASH_OUTPUT")).toBeLessThan(
			rendered.indexOf("keep the session streaming"),
		);
		expect(rendered.indexOf("keep the session streaming")).toBeLessThan(
			rendered.indexOf("ASSISTANT_STREAM_FINISHED"),
		);
		expect(rendered.indexOf("ASSISTANT_STREAM_FINISHED")).toBeLessThan(
			rendered.indexOf("RETAINED_PENDING_BASH_OUTPUT"),
		);
	});

	it("reconciles colliding pending bash messages only by persisted id across partial and complete history", async () => {
		let density: TranscriptDensity = "hidden";
		let invalidatePolicy = () => {};
		const timestamp = 1_800_000_000_000;
		const now = vi.spyOn(Date, "now").mockReturnValue(timestamp);
		const harness = await createHarnessWithExtensions({
			responses: [{ text: "IDENTITY_STREAM_FINISHED", delayMs: 50 }],
			extensionFactories: [
				{
					path: "<pending-bash-identity-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "bash" ? { density } : undefined,
						);
						invalidatePolicy = () => registration.invalidate();
						pi.on("user_bash", async (event) =>
							event.command === "intercepted"
								? {
										result: {
											output: "IDENTICAL_BASH_OUTPUT",
											exitCode: 0,
											cancelled: false,
											truncated: false,
										},
									}
								: undefined,
						);
					},
				},
			],
		});
		harnesses.push(harness);
		try {
			await harness.session.bindExtensions({});
			const mode = createInteractive(harness);
			mode.subscribeToAgent();

			const prompt = harness.session.prompt("keep identity pending");
			await waitUntil(() => harness.session.isStreaming);
			await mode.handleBashCommand("intercepted");
			await mode.handleBashCommand("printf DISTINCT_PENDING_OUTPUT");
			const pendingBash = [...mode.pendingBashComponents];
			const pendingWrappers = pendingBash.map((component) => {
				const wrapper = mode.presentedComponents.get(component);
				if (!wrapper) throw new Error("Expected a pending bash presentation wrapper");
				return wrapper;
			});
			expect(pendingBash).toHaveLength(2);

			await prompt;
			const bashHistory = harness.session.messages.filter(
				(message): message is BashExecutionMessage => message.role === "bashExecution",
			);
			expect(bashHistory).toHaveLength(2);
			expect(bashHistory.map((message) => message.timestamp)).toEqual([timestamp, timestamp]);
			expect(bashHistory.map((message) => message.id)).toEqual([expect.any(String), expect.any(String)]);
			expect(new Set(bashHistory.map((message) => message.id)).size).toBe(2);
			expect(pendingBash.map((component) => mode.pendingBashMessages.get(component)?.id)).toEqual(
				bashHistory.map((message) => message.id),
			);

			const firstMessage = bashHistory[0];
			if (!firstMessage) throw new Error("Expected first bash history message");
			const { id: _persistedId, ...legacyTwin } = firstMessage;

			// A legacy message can have identical timestamp and content, but cannot claim a pending wrapper.
			mode.clearChatContainer();
			mode.renderSessionItems([legacyTwin]);
			expect(mode.pendingBashComponents).toEqual(pendingBash);
			expect(mode.pendingMessagesContainer.children).toEqual(expect.arrayContaining(pendingWrappers));
			for (const wrapper of pendingWrappers) expect(mode.chatContainer.children).not.toContain(wrapper);

			// Partial history claims only the wrapper whose exact id is present, regardless of timestamp collision.
			mode.clearChatContainer();
			mode.renderSessionItems([legacyTwin, bashHistory[1]!]);
			expect(mode.chatContainer.children).not.toContain(pendingWrappers[0]);
			expect(mode.chatContainer.children).toContain(pendingWrappers[1]);
			expect(mode.pendingMessagesContainer.children).toContain(pendingWrappers[0]);
			expect(mode.pendingMessagesContainer.children).not.toContain(pendingWrappers[1]);

			// Later full history restores exact persisted order and remains idempotent on another rebuild and flush.
			for (let rebuild = 0; rebuild < 2; rebuild++) {
				mode.clearChatContainer();
				mode.renderSessionItems([legacyTwin, ...bashHistory]);
				expect(mode.chatContainer.children.filter((child) => pendingWrappers.includes(child))).toEqual(
					pendingWrappers,
				);
			}
			mode.flushPendingBashComponents();
			mode.flushPendingBashComponents();
			expect(mode.pendingBashComponents).toEqual([]);
			expect(mode.chatContainer.children.filter((child) => pendingWrappers.includes(child))).toEqual(
				pendingWrappers,
			);
			density = "full";
			invalidatePolicy();
			const rendered = normalized(mode.chatContainer);
			expect(rendered.match(/IDENTICAL_BASH_OUTPUT/g)).toHaveLength(2);
			// The distinct token appears once in the command header and once in its output.
			expect(rendered.match(/DISTINCT_PENDING_OUTPUT/g)).toHaveLength(2);
		} finally {
			now.mockRestore();
		}
	});

	it("drops prior-session pending bash identity at the runtime session boundary before rebuilding", async () => {
		let beforeSessionInvalidate = () => {};
		const harness = await createHarnessWithExtensions({
			responses: [{ text: "OLD_SESSION_STREAM_FINISHED", delayMs: 50 }],
			extensionFactories: [
				{
					path: "<old-session-bash>",
					factory: (pi) => {
						pi.on("user_bash", async () => ({
							result: {
								output: "OLD_SESSION_PENDING_BASH_OUTPUT",
								exitCode: 0,
								cancelled: false,
								truncated: false,
							},
						}));
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const replacementHarness = await createHarnessWithExtensions({ responses: ["unused"] });
		harnesses.push(replacementHarness);
		await replacementHarness.session.bindExtensions({});
		let currentSession = harness.session;
		const mode = createInteractive(harness, {
			captureBeforeSessionInvalidate: (callback) => {
				beforeSessionInvalidate = callback;
			},
			getSession: () => currentSession,
		});
		mode.subscribeToAgent();

		const prompt = harness.session.prompt("create old session pending UI");
		await waitUntil(() => harness.session.isStreaming);
		await mode.handleBashCommand("old session command");
		const oldComponent = mode.pendingBashComponents[0];
		if (!oldComponent) throw new Error("Expected an old-session pending bash component");
		const oldWrapper = mode.presentedComponents.get(oldComponent);
		if (!oldWrapper) throw new Error("Expected an old-session pending bash wrapper");
		await prompt;

		// This is the production runtime replacement sequence: boundary teardown, swap, then bind-time render.
		beforeSessionInvalidate();
		currentSession = replacementHarness.session;
		mode.renderCurrentSessionState();
		expect(mode.pendingBashComponents).toEqual([]);
		expect(mode.pendingBashMessages.has(oldComponent)).toBe(false);
		expect(mode.presentedComponents.has(oldComponent)).toBe(false);
		expect(mode.pendingMessagesContainer.children).not.toContain(oldWrapper);
		expect(mode.chatContainer.children).not.toContain(oldWrapper);

		// A delayed submit/flush after navigation cannot move old-session UI into the rebuilt chat.
		mode.flushPendingBashComponents();
		expect(mode.chatContainer.children).not.toContain(oldWrapper);
		expect(normalized(mode.chatContainer)).not.toContain("OLD_SESSION_PENDING_BASH_OUTPUT");
	});

	it("does not report a delayed old-session bash rejection in replacement UI", async () => {
		let beforeSessionInvalidate = () => {};
		let rejectBash: (error: Error) => void = () => {};
		let markBashStarted = () => {};
		const bashStarted = new Promise<void>((resolve) => {
			markBashStarted = resolve;
		});
		const harness = await createHarnessWithExtensions({ responses: ["unused"] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockImplementation(async () => {
			markBashStarted();
			return await new Promise((_resolve, reject) => {
				rejectBash = reject;
			});
		});
		const replacementHarness = await createHarnessWithExtensions({ responses: ["replacement"] });
		harnesses.push(replacementHarness);
		await replacementHarness.session.bindExtensions({});
		let currentSession = harness.session;
		const mode = createInteractive(harness, {
			captureBeforeSessionInvalidate: (callback) => {
				beforeSessionInvalidate = callback;
			},
			getSession: () => currentSession,
		});
		const showError = vi.spyOn(mode, "showError");

		const command = mode.handleBashCommand("delayed old-session failure");
		await bashStarted;
		beforeSessionInvalidate();
		currentSession = replacementHarness.session;
		mode.renderCurrentSessionState();
		rejectBash(new Error("OLD_SESSION_REJECTION"));
		await command;

		expect(executeBash).toHaveBeenCalledOnce();
		expect(showError).not.toHaveBeenCalled();
		expect(normalized(mode.chatContainer)).not.toContain("OLD_SESSION_REJECTION");
	});

	it("uses mounted related tool state when deciding orphaned thinking placeholder visibility", async () => {
		const resolvedToolStates: Array<TranscriptBlockDescriptor["state"]> = [];
		const harness = await createHarnessWithExtensions({
			settings: { hideThinkingBlock: true },
			responses: [
				{
					thinking: "private reasoning",
					toolCalls: [{ id: "stateful-tool", name: "echo", args: {} }],
				},
				"done",
			],
			baseToolsOverride: {
				echo: {
					name: "echo",
					label: "Echo",
					description: "Echo",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "STATEFUL_RESULT" }], details: {} }),
				},
			},
			extensionFactories: [
				{
					path: "<stateful-presentation-policy>",
					factory: (pi) => {
						pi.registerTranscriptPresentationPolicy((block) => {
							if (block.kind !== "tool") return undefined;
							resolvedToolStates.push(block.state);
							return { density: block.state === "success" ? "hidden" : "summary" };
						});
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();
		await harness.session.prompt("echo");

		const rendered = normalized(mode.chatContainer);
		expect(rendered).not.toContain("STATEFUL_RESULT");
		expect(rendered).not.toContain("Thinking...");
		expect(resolvedToolStates).toContain("success");
	});

	it("binds presentation invalidation through real startup and reload lifecycle before replacement session_start", async () => {
		let density: TranscriptDensity = "full";
		let duringReloadSessionStart = false;
		let oldResolutionCountAtReplacementStart = -1;
		let getOldResolutionCount = () => 0;
		const ordering: string[] = [];
		const harness = await createHarnessWithExtensions({
			settings: { quietStartup: true },
			extensionFactories: [
				{
					path: "<lifecycle-presentation-policy>",
					factory: (pi) => {
						const registration = pi.registerTranscriptPresentationPolicy((block) =>
							block.kind === "bash" ? { density } : undefined,
						);
						pi.on("session_start", (event) => {
							if (event.reason !== "reload") return;
							oldResolutionCountAtReplacementStart = getOldResolutionCount();
							ordering.push("replacement-session-start");
							density = "hidden";
							duringReloadSessionStart = true;
							registration.invalidate();
							duringReloadSessionStart = false;
						});
					},
				},
			],
		});
		harnesses.push(harness);
		harness.session.recordBashResult("printf lifecycle", {
			output: "LIFECYCLE_BASH_OUTPUT",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		const oldRunner = harness.session.extensionRunner;
		const originalSubscribe = oldRunner.onTranscriptPresentationInvalidated.bind(oldRunner);
		vi.spyOn(oldRunner, "onTranscriptPresentationInvalidated").mockImplementation((listener) => {
			const unsubscribe = originalSubscribe(listener);
			return () => {
				ordering.push("old-runner-detached");
				unsubscribe();
			};
		});
		const oldResolve = vi.spyOn(oldRunner, "resolveTranscriptPresentation");
		getOldResolutionCount = () => oldResolve.mock.calls.length;
		const mode = new InteractiveMode(
			{
				session: harness.session,
				setBeforeSessionInvalidate: () => {},
				setRebindSession: () => {},
			} as unknown as AgentSessionRuntime,
			{ terminal: new VirtualTerminal(100, 30) },
		) as unknown as InteractiveInternals;
		const originalInvalidate = mode.chatContainer.invalidate.bind(mode.chatContainer);
		vi.spyOn(mode.chatContainer, "invalidate").mockImplementation(() => {
			if (duringReloadSessionStart) ordering.push("replacement-invalidation");
			originalInvalidate();
		});

		try {
			await (mode as unknown as { init(): Promise<void> }).init();
			expect(oldRunner.onTranscriptPresentationInvalidated).toHaveBeenCalledOnce();
			expect(normalized(mode.chatContainer)).toContain("LIFECYCLE_BASH_OUTPUT");

			await mode.handleReloadCommand();

			expect(harness.session.extensionRunner).not.toBe(oldRunner);
			expect(ordering).toEqual(
				expect.arrayContaining(["old-runner-detached", "replacement-session-start", "replacement-invalidation"]),
			);
			expect(ordering.indexOf("old-runner-detached")).toBeLessThan(ordering.indexOf("replacement-session-start"));
			expect(ordering.indexOf("replacement-session-start")).toBeLessThan(
				ordering.indexOf("replacement-invalidation"),
			);
			expect(normalized(mode.chatContainer)).not.toContain("LIFECYCLE_BASH_OUTPUT");
			expect(oldResolutionCountAtReplacementStart).toBeGreaterThanOrEqual(0);
			expect(oldResolve).toHaveBeenCalledTimes(oldResolutionCountAtReplacementStart);
		} finally {
			(mode as unknown as { stop(fullscreenExitOutput?: "transcript" | "resume-hint" | "none"): void }).stop("none");
		}
	});

	it("forces hidden and summarized tools to full while expanded and reapplies policy when collapsed", async () => {
		let density: TranscriptDensity = "hidden";
		const harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ id: "expand-tool", name: "echo", args: {} }] }, "done"],
			baseToolsOverride: {
				echo: {
					name: "echo",
					label: "Echo",
					description: "Echo",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "EXPANDED_RESULT" }], details: {} }),
				},
			},
			extensionFactories: [
				{
					path: "<expansion-policy>",
					factory: (pi) => {
						pi.registerTranscriptPresentationPolicy((block) => (block.kind === "tool" ? { density } : undefined));
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const mode = createInteractive(harness);
		mode.subscribeToAgent();
		await harness.session.prompt("echo");

		expect(normalized(mode.chatContainer)).not.toContain("EXPANDED_RESULT");
		mode.setToolsExpanded(true);
		expect(normalized(mode.chatContainer)).toContain("EXPANDED_RESULT");
		mode.setToolsExpanded(false);
		expect(normalized(mode.chatContainer)).not.toContain("EXPANDED_RESULT");

		density = "summary";
		expect(normalized(mode.chatContainer)).toContain("[ok]");
		mode.setToolsExpanded(true);
		expect(normalized(mode.chatContainer)).toContain("EXPANDED_RESULT");
		mode.setToolsExpanded(false);
		expect(normalized(mode.chatContainer)).toContain("[ok]");
	});
});

describe("assistant thinking presentation relationships", () => {
	beforeAll(() => initTheme("dark"));

	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "toolCall", id: "related-tool", name: "read", arguments: { path: "a.ts" } },
		],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};

	it.each<TranscriptDensity>(["full", "summary"])(
		"keeps the orphaned placeholder when related tools are %s",
		(density) => {
			const descriptors: TranscriptBlockDescriptor[] = [];
			const resolve = (block: Readonly<TranscriptBlockDescriptor>): TranscriptPresentation => {
				descriptors.push({ ...block, capabilities: { ...block.capabilities } });
				return { density: block.kind === "tool" ? density : "full" };
			};
			const component = new AssistantMessageComponent(
				message,
				true,
				undefined,
				"Thinking...",
				1,
				[],
				resolve,
				(toolCall) => ({
					id: toolCall.id,
					kind: "tool",
					toolName: toolCall.name,
					state: "pending",
					capabilities: { summary: true, expandable: true },
				}),
			);

			expect(component.render(100).join("\n")).toContain("Thinking...");
			expect(descriptors).toContainEqual({
				kind: "thinking",
				subtype: "orphaned-thinking-placeholder",
				capabilities: { summary: false, expandable: false },
			});
		},
	);

	it("omits the orphaned placeholder only when every related tool is hidden and leaves ordinary thinking unsubtyped", () => {
		const descriptors: TranscriptBlockDescriptor[] = [];
		const resolve = (block: Readonly<TranscriptBlockDescriptor>): TranscriptPresentation => {
			descriptors.push({ ...block, capabilities: { ...block.capabilities } });
			return { density: block.kind === "tool" ? "hidden" : "full" };
		};
		const getRelatedToolDescriptor = (toolCall: Readonly<{ id: string; name: string }>) => ({
			id: toolCall.id,
			kind: "tool" as const,
			toolName: toolCall.name,
			state: "pending" as const,
			capabilities: { summary: true, expandable: true },
		});
		const hidden = new AssistantMessageComponent(
			message,
			true,
			undefined,
			"Thinking...",
			1,
			[],
			resolve,
			getRelatedToolDescriptor,
		);
		expect(hidden.render(100)).toEqual([]);

		const ordinary = new AssistantMessageComponent(
			message,
			false,
			undefined,
			"Thinking...",
			1,
			[],
			resolve,
			getRelatedToolDescriptor,
		);
		expect(ordinary.render(100).join("\n")).toContain("private reasoning");
		expect(descriptors.some((block) => block.kind === "thinking" && block.subtype === undefined)).toBe(true);
	});
});
