import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type {
	TranscriptBlockDescriptor,
	TranscriptDensity,
	TranscriptPresentation,
} from "../src/core/extensions/transcript-presentation.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

function normalized(container: Container, width = 100): string {
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
	pendingTools: Map<string, ToolExecutionComponent>;
	toolComponents: Set<ToolExecutionComponent>;
	subscribeToAgent(): void;
	bindTranscriptPresentationInvalidation(): void;
	rebuildChatFromMessages(): void;
	setToolsExpanded(expanded: boolean): void;
};

function createInteractive(harness: Harness): InteractiveInternals {
	const runtimeHost = {
		session: harness.session,
		setBeforeSessionInvalidate: () => {},
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
			const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, [], resolve);

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
		const hidden = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, [], resolve);
		expect(hidden.render(100)).toEqual([]);

		const ordinary = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], resolve);
		expect(ordinary.render(100).join("\n")).toContain("private reasoning");
		expect(descriptors.some((block) => block.kind === "thinking" && block.subtype === undefined)).toBe(true);
	});
});
