import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type {
	TranscriptBlockDescriptor,
	TranscriptPresentation,
} from "../src/core/extensions/transcript-presentation.ts";
import {
	TranscriptPresentationComponent,
	type TranscriptPresentationResolver,
} from "../src/modes/interactive/components/transcript-presentation.ts";

const descriptor: TranscriptBlockDescriptor = {
	kind: "tool",
	capabilities: { summary: true, expandable: true },
};

class FakeComponent implements Component {
	renderCount = 0;
	invalidateCount = 0;
	updateArgsCount = 0;
	lastArgs: unknown;
	private readonly lines: string[];

	constructor(...lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		this.renderCount++;
		return this.lines;
	}

	invalidate(): void {
		this.invalidateCount++;
	}

	updateArgs(args: unknown): void {
		this.updateArgsCount++;
		this.lastArgs = args;
	}
}

function createWrapper(options: {
	component: Component;
	descriptor?: () => TranscriptBlockDescriptor;
	resolve: TranscriptPresentationResolver;
	renderSummary?: (width: number) => string[];
	isExpanded?: () => boolean;
}): TranscriptPresentationComponent {
	return new TranscriptPresentationComponent({
		descriptor: options.descriptor ?? (() => descriptor),
		...options,
	});
}

describe("TranscriptPresentationComponent", () => {
	it("returns the full component render unchanged", () => {
		const full = new FakeComponent("full");
		const lines = full.render(80);
		const component = createWrapper({ component: full, resolve: () => ({ density: "full" }) });

		expect(component.render(80)).toBe(lines);
		expect(full.renderCount).toBe(2);
	});

	it("hides without disposing or suppressing child updates", () => {
		const full = new FakeComponent("full");
		const component = createWrapper({ component: full, resolve: () => ({ density: "hidden" }) });

		expect(component.render(80)).toEqual([]);
		expect(full.renderCount).toBe(0);

		component.invalidate();
		component.updateArgs("updated");

		expect(full.invalidateCount).toBe(1);
		expect(full.updateArgsCount).toBe(1);
		expect(full.lastArgs).toBe("updated");
	});

	it("renders the summary component", () => {
		const full = new FakeComponent("full");
		const summary = new FakeComponent("summary");
		const component = createWrapper({
			component: full,
			resolve: () => ({ density: "summary" }),
			renderSummary: summary.render.bind(summary),
		});

		expect(component.render(80)).toBe(summary.render(80));
		expect(full.renderCount).toBe(0);
		expect(summary.renderCount).toBe(2);
	});

	it("falls back to full when no summary renderer is available", () => {
		const full = new FakeComponent("full");
		const component = createWrapper({ component: full, resolve: () => ({ density: "summary" }) });

		expect(component.render(80)).toBe(full.render(80));
	});

	it("forces full while expanded only for an expandable descriptor", () => {
		const full = new FakeComponent("full");
		const summary = new FakeComponent("summary");
		const component = createWrapper({
			component: full,
			resolve: () => ({ density: "summary" }),
			renderSummary: summary.render.bind(summary),
			isExpanded: () => true,
		});

		expect(component.render(80)).toBe(full.render(80));

		const nonExpandable = createWrapper({
			component: full,
			descriptor: () => ({ ...descriptor, capabilities: { summary: true, expandable: false } }),
			resolve: () => ({ density: "summary" }),
			renderSummary: summary.render.bind(summary),
			isExpanded: () => true,
		});
		expect(nonExpandable.render(80)).toBe(summary.render(80));
	});

	it("reevaluates policy after collapsing", () => {
		const full = new FakeComponent("full");
		const summary = new FakeComponent("summary");
		let expanded = true;
		const resolve = (): TranscriptPresentation => ({ density: expanded ? "hidden" : "summary" });
		const component = createWrapper({
			component: full,
			resolve,
			renderSummary: summary.render.bind(summary),
			isExpanded: () => expanded,
		});

		expect(component.render(80)).toBe(full.render(80));
		expanded = false;
		expect(component.render(80)).toBe(summary.render(80));
	});

	it("reevaluates the descriptor and resolver on every render", () => {
		let currentDescriptor = descriptor;
		const full = new FakeComponent("full");
		const summary = new FakeComponent("summary");
		const seen: TranscriptBlockDescriptor[] = [];
		const component = createWrapper({
			component: full,
			descriptor: () => currentDescriptor,
			resolve: (block) => {
				seen.push(block);
				return { density: block.kind === "tool" ? "summary" : "hidden" };
			},
			renderSummary: summary.render.bind(summary),
		});

		expect(component.render(80)).toBe(summary.render(80));
		currentDescriptor = { ...descriptor, kind: "notice" };
		expect(component.render(80)).toEqual([]);
		expect(seen).toEqual([descriptor, currentDescriptor]);
	});
});
