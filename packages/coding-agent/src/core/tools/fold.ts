import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { SessionManager } from "../session-manager.js";

const foldSchema = Type.Object({
	startId: Type.String({
		description: "Entry ID of the first message in the range to fold (see [id:...] tags on messages)",
	}),
	endId: Type.String({ description: "Entry ID of the last message in the range to fold" }),
	summary: Type.String({
		description: "A concise summary of the folded content that preserves the essential information",
	}),
});

const unfoldSchema = Type.Object({
	foldId: Type.String({ description: "Entry ID of the fold to deactivate (returned by the fold tool)" }),
});

const peekSchema = Type.Object({
	foldId: Type.String({ description: "Entry ID of the fold whose original content you want to inspect" }),
});

/**
 * Create fold/unfold/peek tools that operate on the session manager.
 */
export function createFoldTools(sessionManager: SessionManager): ToolDefinition[] {
	const foldTool: ToolDefinition = {
		name: "fold",
		label: "Fold",
		description:
			"Compress a range of conversation messages into a summary. The original messages are preserved and can be restored with unfold. Use this to reduce context when earlier exploration, verbose tool output, or resolved debugging is no longer needed.",
		promptSnippet: "Fold conversation ranges into summaries (reversible)",
		promptGuidelines: [
			"Each message in the conversation is tagged with an entry ID in the format [id:XXXXXXXX]. These tags are automatically prepended by the system — do NOT include them in your own responses. Use these IDs to specify ranges for the fold, unfold, and peek tools.",
			"Use fold to compress resolved exploration, verbose tool output, or debugging that is no longer actively needed. Provide a summary that captures the key findings or decisions.",
		],
		parameters: foldSchema,
		execute: async (_toolCallId, params) => {
			const { startId, endId, summary } = params as { startId: string; endId: string; summary: string };
			try {
				const foldId = sessionManager.appendFold(startId, endId, summary);

				return {
					content: [{ type: "text", text: `Folded entries [${startId}..${endId}]. Fold ID: ${foldId}` }],
					details: undefined,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: undefined,
				};
			}
		},
	};

	const unfoldTool: ToolDefinition = {
		name: "unfold",
		label: "Unfold",
		description:
			"Restore a previously folded range of messages, deactivating the fold. The original messages reappear in context.",
		parameters: unfoldSchema,
		execute: async (_toolCallId, params) => {
			const { foldId } = params as { foldId: string };
			try {
				const unfoldId = sessionManager.appendUnfold(foldId);

				return {
					content: [{ type: "text", text: `Unfolded fold ${foldId}. Unfold ID: ${unfoldId}` }],
					details: undefined,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: undefined,
				};
			}
		},
	};

	const peekTool: ToolDefinition = {
		name: "peek",
		label: "Peek",
		description:
			"View the original messages inside a fold without unfolding it. Use this to check folded content before deciding whether to unfold. The peek result is automatically folded after the turn to avoid inflating context.",
		parameters: peekSchema,
		execute: async (_toolCallId, params) => {
			const { foldId } = params as { foldId: string };
			try {
				const foldEntry = sessionManager.getEntry(foldId);
				if (!foldEntry || foldEntry.type !== "fold") {
					return {
						content: [{ type: "text", text: `Error: Fold "${foldId}" not found` }],
						details: undefined,
					};
				}

				const path = sessionManager.getBranch();
				const startIndex = path.findIndex((e) => e.id === foldEntry.rangeStartId);
				const endIndex = path.findIndex((e) => e.id === foldEntry.rangeEndId);

				if (startIndex === -1 || endIndex === -1) {
					return {
						content: [{ type: "text", text: "Error: Fold range entries not found on current path" }],
						details: undefined,
					};
				}

				const rangeEntries = path.slice(startIndex, endIndex + 1);
				const lines: string[] = [`Peek at fold ${foldId} (${rangeEntries.length} entries):\n`];

				for (const entry of rangeEntries) {
					if (entry.type === "message") {
						const msg = entry.message;
						const id = entry.id;
						if (msg.role === "user") {
							const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
							lines.push(`[${id}] user: ${text}`);
						} else if (msg.role === "assistant") {
							const text = extractText(msg.content);
							lines.push(`[${id}] assistant: ${text}`);
						} else if (msg.role === "toolResult") {
							const text = extractText(msg.content);
							lines.push(`[${id}] toolResult: ${truncate(text, 200)}`);
						}
					} else if (entry.type === "custom_message") {
						lines.push(`[${entry.id}] custom(${entry.customType}): ${truncate(String(entry.content), 200)}`);
					}
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: undefined,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: undefined,
				};
			}
		},
	};

	return [foldTool, unfoldTool, peekTool];
}

/** Extract text from content blocks */
function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return String(content);
}

/** Truncate text to maxLen characters */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}...`;
}
