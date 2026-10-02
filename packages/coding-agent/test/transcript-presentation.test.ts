import { describe, expect, it } from "vitest";
import {
	applyTranscriptPresentationPolicies,
	type TranscriptBlockDescriptor,
	type TranscriptPresentationPolicy,
} from "../src/core/extensions/transcript-presentation.ts";

const block: TranscriptBlockDescriptor = {
	id: "block-1",
	kind: "tool",
	toolName: "read",
	state: "success",
	capabilities: {
		summary: true,
		expandable: true,
	},
};

describe("transcript presentation policies", () => {
	it("starts with full density", () => {
		expect(applyTranscriptPresentationPolicies(block, [])).toEqual({ density: "full" });
	});

	it("composes policies in load order", () => {
		const policies: TranscriptPresentationPolicy[] = [
			(_block, _current) => ({ density: "summary" }),
			(_block, current) => ({ density: current.density === "summary" ? "hidden" : "full" }),
		];

		expect(applyTranscriptPresentationPolicies(block, policies)).toEqual({ density: "hidden" });
	});

	it("preserves the current value when a policy returns undefined", () => {
		const policies: TranscriptPresentationPolicy[] = [
			(_block, _current) => ({ density: "summary" }),
			(_block, _current) => undefined,
		];

		expect(applyTranscriptPresentationPolicies(block, policies)).toEqual({ density: "summary" });
	});

	it("allows a later policy to override an earlier policy", () => {
		const policies: TranscriptPresentationPolicy[] = [
			(_block, _current) => ({ density: "hidden" }),
			(_block, _current) => ({ density: "full" }),
		];

		expect(applyTranscriptPresentationPolicies(block, policies)).toEqual({ density: "full" });
	});

	it("falls back to full when summary is unavailable", () => {
		const noSummaryBlock: TranscriptBlockDescriptor = {
			...block,
			capabilities: { summary: false, expandable: true },
		};
		const policies: TranscriptPresentationPolicy[] = [(_block, _current) => ({ density: "summary" })];

		expect(applyTranscriptPresentationPolicies(noSummaryBlock, policies)).toEqual({ density: "full" });
	});

	it("keeps policy inputs isolated and leaves the descriptor unchanged", () => {
		let secondPolicyInput: { blockKind: string; summary: boolean; density: string } | undefined;
		const policies: TranscriptPresentationPolicy[] = [
			(receivedBlock, current) => {
				const mutableBlock = receivedBlock as unknown as {
					kind: string;
					capabilities: { summary: boolean };
				};
				mutableBlock.kind = "assistant-message";
				mutableBlock.capabilities.summary = false;
				const mutableCurrent = current as unknown as { density: string };
				mutableCurrent.density = "hidden";
				return undefined;
			},
			(receivedBlock, current) => {
				secondPolicyInput = {
					blockKind: receivedBlock.kind,
					summary: receivedBlock.capabilities.summary,
					density: current.density,
				};
				return undefined;
			},
		];

		expect(applyTranscriptPresentationPolicies(block, policies)).toEqual({ density: "full" });
		expect(secondPolicyInput).toEqual({ blockKind: "tool", summary: true, density: "full" });
		expect(block).toEqual({
			id: "block-1",
			kind: "tool",
			toolName: "read",
			state: "success",
			capabilities: { summary: true, expandable: true },
		});
	});

	it("propagates policy errors for registration-level isolation", () => {
		const failingPolicy: TranscriptPresentationPolicy = () => {
			throw new Error("policy failed");
		};

		expect(() => applyTranscriptPresentationPolicies(block, [failingPolicy])).toThrow("policy failed");
	});

	it("preserves the stable orphaned-thinking-placeholder subtype", () => {
		const orphanedThinkingBlock: TranscriptBlockDescriptor = {
			kind: "thinking",
			subtype: "orphaned-thinking-placeholder",
			capabilities: { summary: false, expandable: false },
		};
		let receivedSubtype: string | undefined;
		const policies: TranscriptPresentationPolicy[] = [
			(receivedBlock, _current) => {
				receivedSubtype = receivedBlock.subtype;
				return undefined;
			},
		];

		expect(applyTranscriptPresentationPolicies(orphanedThinkingBlock, policies)).toEqual({ density: "full" });
		expect(receivedSubtype).toBe("orphaned-thinking-placeholder");
	});
});
