/**
 * Context Awareness Extension
 *
 * Injects ephemeral context usage metadata into the conversation so the agent
 * is aware of its own token consumption. A `<system>` block is appended to
 * the most recent user message before each LLM call, and a static addendum
 * is added to the system prompt explaining the tag.
 *
 * When context usage approaches a configurable token limit (default 80 000),
 * the agent is instructed to proactively fold unnecessary earlier messages.
 *
 * Configuration:
 *   pi --context-limit 120000   # override the default 80k token limit
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEFAULT_TOKEN_LIMIT = 80_000;

const SYSTEM_ADDENDUM = `
# Context awareness

Messages from the user may include a trailing <system>…</system> block appended by
the harness. This is NOT user input — it is real-time operational metadata injected
before each request. Use it as ground truth.

Fields:
- context_tokens: estimated tokens currently in your context window
- context_limit: the soft token budget for this session
- context_percent: usage as a percentage of the limit
- status: ok | high | critical — escalates as usage approaches the limit

For reference, things like intermediary steps, verbose tool results, and exploratory
reads tend to be good candidates for folding when context is running high.

Note: peeking at folded content is free — peek results are automatically folded after
each turn, so they do not consume lasting context. It is always safe to peek.`;

function formatTokens(n: number): string {
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

function getStatus(percent: number): "ok" | "high" | "critical" {
	if (percent >= 90) return "critical";
	if (percent >= 70) return "high";
	return "ok";
}

function buildSystemBlock(
	usage: { tokens: number | null; contextWindow: number; percent: number | null },
	limit: number,
): string {
	const tokens = usage.tokens ?? 0;
	const percent = limit > 0 ? Math.round((tokens / limit) * 100) : 0;
	const status = getStatus(percent);

	const lines = [
		"\n\n<system>",
		`context_tokens: ${tokens !== 0 ? formatTokens(tokens) : "unknown"}`,
		`context_limit: ${formatTokens(limit)}`,
		`context_percent: ${percent}%`,
		`status: ${status}`,
	];

	if (status === "high") {
		lines.push("⚠ Context usage is high. Consider folding intermediate steps and verbose tool results.");
	} else if (status === "critical") {
		lines.push("🔴 Context is nearly full. Fold aggressively to stay within budget. Peek is always free.");
	}

	lines.push("</system>");
	return lines.join("\n");
}

function appendToLastUserMessage(messages: AgentMessage[], block: string): AgentMessage[] {
	// Walk backwards to find the last user message
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;

		const content = msg.content;
		if (typeof content === "string") {
			messages[i] = { ...msg, content: content + block };
			return messages;
		}
		if (Array.isArray(content) && content.length > 0) {
			// Find last text block and append
			for (let j = content.length - 1; j >= 0; j--) {
				if (content[j].type === "text") {
					const updated = [...content];
					updated[j] = {
						type: "text" as const,
						text: (content[j] as { type: "text"; text: string }).text + block,
					};
					messages[i] = { ...msg, content: updated };
					return messages;
				}
			}
		}
		break;
	}
	return messages;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-limit", {
		description: "Soft token limit for context awareness (default: 80000)",
		type: "string",
	});

	function getLimit(): number {
		const flag = pi.getFlag("context-limit");
		if (flag && typeof flag === "string") {
			const parsed = parseInt(flag, 10);
			if (!Number.isNaN(parsed) && parsed > 0) return parsed;
		}
		return DEFAULT_TOKEN_LIMIT;
	}

	// Add static explanation to system prompt
	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: event.systemPrompt + SYSTEM_ADDENDUM,
		};
	});

	// Append ephemeral <system> block to last user message before each LLM call
	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;

		const limit = getLimit();
		const block = buildSystemBlock(usage, limit);
		const messages = appendToLastUserMessage(event.messages, block);
		updateStatusBar(ctx, usage, limit);
		return { messages };
	});

	// Update status bar at turn and agent boundaries (including post-fold rebuild)
	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;
		updateStatusBar(ctx, usage, getLimit());
	});

	pi.on("agent_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;
		updateStatusBar(ctx, usage, getLimit());
	});

	function updateStatusBar(
		ctx: ExtensionContext,
		usage: { tokens: number | null; contextWindow: number; percent: number | null },
		limit: number,
	): void {
		const tokens = usage.tokens ?? 0;
		const percent = limit > 0 ? ((tokens / limit) * 100).toFixed(1) : "?";
		ctx.ui.setStatus("context-limit", `${percent}%/${formatTokens(limit)} soft`);
	}
}
