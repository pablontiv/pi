/**
 * Generic transcript presentation policy example.
 *
 * Hides notices and uses a summary for every block that supports one.
 * Blocks without summary support keep their current presentation.
 */

import type { ExtensionAPI, TranscriptPresentationPolicy } from "@earendil-works/pi-coding-agent";

const policy: TranscriptPresentationPolicy = (block) => {
	if (block.kind === "notice") return { density: "hidden" };
	if (block.capabilities.summary) return { density: "summary" };
	return undefined;
};

export default function (pi: ExtensionAPI) {
	pi.registerTranscriptPresentationPolicy(policy);
}
