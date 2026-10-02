export type TranscriptBlockKind =
	| "user-message"
	| "assistant-message"
	| "thinking"
	| "tool"
	| "custom-message"
	| "custom-entry"
	| "bash"
	| "summary"
	| "notice";

export type TranscriptBlockSubtype = "orphaned-thinking-placeholder";

export interface TranscriptBlockDescriptor {
	readonly id?: string;
	readonly kind: TranscriptBlockKind;
	readonly subtype?: TranscriptBlockSubtype;
	readonly toolName?: string;
	readonly state?: "pending" | "success" | "error";
	readonly capabilities: {
		readonly summary: boolean;
		readonly expandable: boolean;
	};
}

export type TranscriptDensity = "full" | "summary" | "hidden";

export interface TranscriptPresentation {
	readonly density: TranscriptDensity;
}

export type TranscriptPresentationPolicy = (
	block: Readonly<TranscriptBlockDescriptor>,
	current: Readonly<TranscriptPresentation>,
	// biome-ignore lint/suspicious/noConfusingVoidType: the public policy contract uses void for no change.
) => TranscriptPresentation | void;

function copyBlockDescriptor(block: Readonly<TranscriptBlockDescriptor>): TranscriptBlockDescriptor {
	return {
		...block,
		capabilities: { ...block.capabilities },
	};
}

function normalizePresentation(
	block: Readonly<TranscriptBlockDescriptor>,
	presentation: Readonly<TranscriptPresentation>,
): TranscriptPresentation {
	if (presentation.density === "summary" && !block.capabilities.summary) {
		return { density: "full" };
	}
	return { density: presentation.density };
}

export function applyTranscriptPresentationPolicies(
	block: Readonly<TranscriptBlockDescriptor>,
	policies: readonly TranscriptPresentationPolicy[],
): TranscriptPresentation {
	let current: TranscriptPresentation = { density: "full" };

	for (const policy of policies) {
		const next = policy(copyBlockDescriptor(block), { ...current });
		if (next !== undefined) {
			current = normalizePresentation(block, next);
		}
	}

	return normalizePresentation(block, current);
}
