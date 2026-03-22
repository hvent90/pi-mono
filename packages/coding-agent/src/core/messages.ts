/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const FOLD_SUMMARY_PREFIX = `The following is a summary of a folded section of this conversation:

<summary>
`;

export const FOLD_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export interface FoldSummaryMessage {
	role: "foldSummary";
	summary: string;
	foldId: string;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		foldSummary: FoldSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createFoldSummaryMessage(summary: string, foldId: string, timestamp: string): FoldSummaryMessage {
	return {
		role: "foldSummary",
		summary,
		foldId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Prepend an entry ID tag to a converted LLM message.
 * Entry IDs are set on AgentMessages by buildSessionContext() as `_entryId`.
 */
function prependEntryId(msg: Message, entryId: string): Message {
	const tag = `[id:${entryId}] `;

	if (msg.role === "user") {
		const content = msg.content;
		if (typeof content === "string") {
			return { ...msg, content: tag + content };
		}
		if (Array.isArray(content) && content.length > 0 && content[0].type === "text") {
			return { ...msg, content: [{ ...content[0], text: tag + content[0].text }, ...content.slice(1)] };
		}
		return msg;
	}

	if (msg.role === "assistant") {
		const content = msg.content;
		if (content.length > 0 && content[0].type === "text") {
			return { ...msg, content: [{ ...content[0], text: tag + content[0].text }, ...content.slice(1)] };
		}
		return msg;
	}

	if (msg.role === "toolResult") {
		const content = msg.content;
		if (content.length > 0 && content[0].type === "text") {
			return { ...msg, content: [{ ...content[0], text: tag + content[0].text }, ...content.slice(1)] };
		}
		return msg;
	}

	return msg;
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			const entryId = (m as any)._entryId as string | undefined;
			let converted: Message | undefined;

			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					converted = {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
					break;
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					converted = {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
					break;
				}
				case "branchSummary":
					converted = {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
					break;
				case "compactionSummary":
					converted = {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
					break;
				case "foldSummary":
					converted = {
						role: "user",
						content: [{ type: "text" as const, text: FOLD_SUMMARY_PREFIX + m.summary + FOLD_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
					break;
				case "user":
				case "assistant":
				case "toolResult":
					converted = m;
					break;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}

			if (converted && entryId) {
				return prependEntryId(converted, entryId);
			}
			return converted;
		})
		.filter((m) => m !== undefined);
}
