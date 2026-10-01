import type { Component } from "@earendil-works/pi-tui";
import type {
	TranscriptBlockDescriptor,
	TranscriptPresentation,
} from "../../../core/extensions/transcript-presentation.ts";

export type TranscriptPresentationResolver = (block: Readonly<TranscriptBlockDescriptor>) => TranscriptPresentation;

export type TranscriptSummaryRenderer = (width: number) => string[];

type TranscriptToolResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
};

type ForwardingComponent = Component & {
	setExpanded?: (expanded: boolean) => void;
	updateArgs?: (args: unknown) => void;
	markExecutionStarted?: () => void;
	setArgsComplete?: () => void;
	updateResult?: (result: TranscriptToolResult, isPartial?: boolean) => void;
};

export class TranscriptPresentationComponent implements Component {
	private readonly component: ForwardingComponent;
	private readonly descriptor: () => TranscriptBlockDescriptor;
	private readonly resolve: TranscriptPresentationResolver;
	private readonly renderSummary?: TranscriptSummaryRenderer;
	private readonly isExpanded?: () => boolean;

	constructor(options: {
		component: Component;
		descriptor: () => TranscriptBlockDescriptor;
		resolve: TranscriptPresentationResolver;
		renderSummary?: TranscriptSummaryRenderer;
		isExpanded?: () => boolean;
	}) {
		this.component = options.component;
		this.descriptor = options.descriptor;
		this.resolve = options.resolve;
		this.renderSummary = options.renderSummary;
		this.isExpanded = options.isExpanded;
	}

	render(width: number): string[] {
		const block = this.descriptor();
		const presentation = this.resolve(block);
		const expanded = block.capabilities.expandable && (this.isExpanded?.() ?? false);

		if (expanded || presentation.density === "full") {
			return this.component.render(width);
		}
		if (presentation.density === "hidden") {
			return [];
		}
		if (!block.capabilities.summary || !this.renderSummary) {
			return this.component.render(width);
		}
		return this.renderSummary(width);
	}

	invalidate(): void {
		this.component.invalidate();
	}

	setExpanded(expanded: boolean): void {
		this.component.setExpanded?.(expanded);
	}

	updateArgs(args: unknown): void {
		this.component.updateArgs?.(args);
	}

	markExecutionStarted(): void {
		this.component.markExecutionStarted?.();
	}

	setArgsComplete(): void {
		this.component.setArgsComplete?.();
	}

	updateResult(result: TranscriptToolResult, isPartial?: boolean): void {
		this.component.updateResult?.(result, isPartial);
	}
}
