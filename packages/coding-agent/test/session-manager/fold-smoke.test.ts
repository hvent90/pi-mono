/**
 * Smoke tests for fold tools, entry ID prepending, and peek.
 * Exercises the full pipeline without needing an LLM call.
 */
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createFoldTools } from "../../src/core/tools/fold.js";

describe("Fold smoke tests", () => {
	describe("fold tool", () => {
		it("folds a range and returns fold ID", async () => {
			const sm = SessionManager.inMemory();
			const e0 = sm.appendMessage({ role: "user", content: "First", timestamp: Date.now() });
			const e1 = sm.appendMessage({ role: "user", content: "Second", timestamp: Date.now() });
			const _e2 = sm.appendMessage({ role: "user", content: "Third", timestamp: Date.now() });

			const [foldTool] = createFoldTools(sm);
			const result = await foldTool.execute(
				"tc1",
				{ startId: e0, endId: e1, summary: "Two messages" },
				undefined,
				undefined,
				{} as any,
			);

			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as any).text).toContain("Fold ID:");

			// Context should now have fold summary + third message
			const context = sm.buildSessionContext();
			expect(context.messages.length).toBe(2);
			expect(context.messages[0].role).toBe("foldSummary");
			expect(context.messages[1].role).toBe("user");
		});

		it("returns error for invalid range", async () => {
			const sm = SessionManager.inMemory();
			sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			const [foldTool] = createFoldTools(sm);
			const result = await foldTool.execute(
				"tc1",
				{ startId: "bad", endId: "bad", summary: "x" },
				undefined,
				undefined,
				{} as any,
			);

			expect((result.content[0] as any).text).toContain("Error:");
		});
	});

	describe("unfold tool", () => {
		it("unfolds and restores messages", async () => {
			const sm = SessionManager.inMemory();
			const e0 = sm.appendMessage({ role: "user", content: "First", timestamp: Date.now() });
			const e1 = sm.appendMessage({ role: "user", content: "Second", timestamp: Date.now() });
			const _e2 = sm.appendMessage({ role: "user", content: "Third", timestamp: Date.now() });

			const [foldTool, unfoldTool] = createFoldTools(sm);

			// Fold
			const foldResult = await foldTool.execute(
				"tc1",
				{ startId: e0, endId: e1, summary: "Two messages" },
				undefined,
				undefined,
				{} as any,
			);
			const foldIdMatch = (foldResult.content[0] as any).text.match(/Fold ID: (\w+)/);
			const foldId = foldIdMatch[1];

			// Unfold
			const unfoldResult = await unfoldTool.execute("tc2", { foldId }, undefined, undefined, {} as any);
			expect((unfoldResult.content[0] as any).text).toContain("Unfolded");

			// Context should have all 3 messages again
			const context = sm.buildSessionContext();
			expect(context.messages.length).toBe(3);
		});
	});

	describe("peek tool", () => {
		it("shows original messages without modifying session", async () => {
			const sm = SessionManager.inMemory();
			const e0 = sm.appendMessage({ role: "user", content: "Hello world", timestamp: Date.now() });
			const e1 = sm.appendMessage({ role: "user", content: "How are you", timestamp: Date.now() });
			const _e2 = sm.appendMessage({ role: "user", content: "Third", timestamp: Date.now() });

			const [foldTool, , peekTool] = createFoldTools(sm);

			// Fold e0..e1
			const foldResult = await foldTool.execute(
				"tc1",
				{ startId: e0, endId: e1, summary: "Greeting" },
				undefined,
				undefined,
				{} as any,
			);
			const foldId = (foldResult.content[0] as any).text.match(/Fold ID: (\w+)/)[1];

			// Context should be folded (2 messages: fold summary + third)
			expect(sm.buildSessionContext().messages.length).toBe(2);

			// Peek — should return original content
			const peekResult = await peekTool.execute("tc2", { foldId }, undefined, undefined, {} as any);
			const peekText = (peekResult.content[0] as any).text;
			expect(peekText).toContain("Hello world");
			expect(peekText).toContain("How are you");
			expect(peekText).toContain("2 entries");

			// Context should still be folded (peek is read-only)
			expect(sm.buildSessionContext().messages.length).toBe(2);
		});
	});

	describe("entry ID prepending end-to-end", () => {
		it("messages sent to LLM have [id:...] tags", () => {
			const sm = SessionManager.inMemory();
			const e0 = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
			const e1 = sm.appendMessage({ role: "user", content: "World", timestamp: Date.now() });

			const context = sm.buildSessionContext();
			const llm = convertToLlm(context.messages);

			expect(llm.length).toBe(2);
			expect(llm[0].content).toBe(`[id:${e0}] Hello`);
			expect(llm[1].content).toBe(`[id:${e1}] World`);
		});

		it("fold summaries also get entry IDs", () => {
			const sm = SessionManager.inMemory();
			const e0 = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
			const e1 = sm.appendMessage({ role: "user", content: "World", timestamp: Date.now() });
			const _e2 = sm.appendMessage({ role: "user", content: "!", timestamp: Date.now() });

			sm.appendFold(e0, e1, "A greeting");

			const context = sm.buildSessionContext();
			const llm = convertToLlm(context.messages);

			// First message should be the fold summary with the fold's entry ID
			expect(llm.length).toBe(2);
			const foldMsg = llm[0];
			expect(foldMsg.role).toBe("user");
			const foldText = (foldMsg.content as any[])[0].text;
			expect(foldText).toMatch(/^\[id:\w+\]/);
			expect(foldText).toContain("A greeting");
		});
	});
});
