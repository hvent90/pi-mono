import { describe, expect, it } from "vitest";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.js";

function _msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

describe("SessionManager fold/unfold", () => {
	describe("appendFold", () => {
		it("creates a fold entry with correct range", () => {
			const sm = SessionManager.inMemory();
			const userId = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
			const assistantId = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Hi there!" }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			const foldId = sm.appendFold(userId, assistantId, "A greeting exchange");

			expect(foldId).toBeDefined();
			expect(foldId.length).toBe(8); // 8-char hex ID

			const foldEntry = sm.getEntry(foldId);
			expect(foldEntry?.type).toBe("fold");
			if (foldEntry?.type === "fold") {
				expect(foldEntry.rangeStartId).toBe(userId);
				expect(foldEntry.rangeEndId).toBe(assistantId);
				expect(foldEntry.summary).toBe("A greeting exchange");
			}
		});

		it("throws if rangeStartId is not on current path", () => {
			const sm = SessionManager.inMemory();
			const _userId = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			// Create a branch
			sm.branch(sm.getEntries()[0].id);
			const assistantId = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Hi!" }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			// Go back to main branch
			sm.branch(sm.getEntries()[0].id);
			const userId2 = sm.appendMessage({ role: "user", content: "Another message", timestamp: Date.now() });

			// Try to fold across branches - should throw
			expect(() => sm.appendFold(userId2, assistantId, "Cross-branch fold")).toThrow();
		});

		it("throws if range includes compaction entry", () => {
			const sm = SessionManager.inMemory();
			const userId = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			// Add compaction
			sm.appendCompaction("Summary", userId, 1000);

			const assistantId = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Hi!" }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			// Try to fold range that includes compaction - should throw
			expect(() => sm.appendFold(userId, assistantId, "Fold with compaction")).toThrow(
				"Cannot fold a range that includes a compaction entry",
			);
		});

		it("allows single-entry folds", () => {
			const sm = SessionManager.inMemory();
			const userId = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			// Single-entry fold is valid
			const foldId = sm.appendFold(userId, userId, "Single entry fold");
			expect(foldId).toBeDefined();
		});

		it("validates nesting constraints - rejects partial overlap", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 8; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			// Create outer fold [1, 6]
			sm.appendFold(entries[1], entries[6], "Outer fold");

			// Partial overlap [5, 7] should throw
			expect(() => sm.appendFold(entries[5], entries[7], "Partial overlap")).toThrow(/partially overlaps/);
		});

		it("allows nested folds (b inside a)", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 8; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			// Create outer fold [1, 6]
			const _outerFoldId = sm.appendFold(entries[1], entries[6], "Outer fold");

			// Inner fold [2, 4] should be allowed
			const innerFoldId = sm.appendFold(entries[2], entries[4], "Inner fold");
			expect(innerFoldId).toBeDefined();
		});

		it("allows containing folds (a inside b)", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 8; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			// Create inner fold [2, 4]
			const _innerFoldId = sm.appendFold(entries[2], entries[4], "Inner fold");

			// Outer fold [1, 6] should be allowed
			const outerFoldId = sm.appendFold(entries[1], entries[6], "Outer fold");
			expect(outerFoldId).toBeDefined();
		});
	});

	describe("appendUnfold", () => {
		it("creates an unfold entry that deactivates a fold", () => {
			const sm = SessionManager.inMemory();
			const userId = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
			const assistantId = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Hi there!" }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			const foldId = sm.appendFold(userId, assistantId, "A greeting exchange");
			const unfoldId = sm.appendUnfold(foldId);

			expect(unfoldId).toBeDefined();
			const unfoldEntry = sm.getEntry(unfoldId);
			expect(unfoldEntry?.type).toBe("unfold");
			if (unfoldEntry?.type === "unfold") {
				expect(unfoldEntry.foldId).toBe(foldId);
			}
		});

		it("throws if fold entry not found", () => {
			const sm = SessionManager.inMemory();
			expect(() => sm.appendUnfold("nonexistent")).toThrow(/not found/);
		});

		it("throws if referenced entry is not a fold", () => {
			const sm = SessionManager.inMemory();
			const userId = sm.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

			expect(() => sm.appendUnfold(userId)).toThrow(/not found/);
		});
	});

	describe("getActiveFolds", () => {
		it("returns active folds on current path", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 5; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			sm.appendFold(entries[1], entries[3], "Active fold");

			const activeFolds = sm.getActiveFolds();
			expect(activeFolds.length).toBe(1);
			expect(activeFolds[0].summary).toBe("Active fold");
		});

		it("excludes deactivated folds", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 5; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			const foldId = sm.appendFold(entries[1], entries[3], "Deactivated fold");
			sm.appendUnfold(foldId);

			const activeFolds = sm.getActiveFolds();
			expect(activeFolds.length).toBe(0);
		});
	});

	describe("buildSessionContext with folds", () => {
		it("replaces folded range with fold summary", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 5; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			sm.appendFold(entries[1], entries[3], "Folded messages 1-3");

			const context = sm.buildSessionContext();

			// Should have: message 0, fold summary, message 4
			expect(context.messages.length).toBe(3);
			expect(context.messages[0].role).toBe("user");
			expect((context.messages[0] as { content: string }).content).toBe("Message 0");
			expect(context.messages[1].role).toBe("foldSummary");
			expect((context.messages[1] as { summary: string }).summary).toBe("Folded messages 1-3");
			expect(context.messages[2].role).toBe("user");
			expect((context.messages[2] as { content: string }).content).toBe("Message 4");
		});

		it("handles multiple non-overlapping folds", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 8; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			sm.appendFold(entries[1], entries[2], "First fold");
			sm.appendFold(entries[5], entries[6], "Second fold");

			const context = sm.buildSessionContext();

			// Should have: message 0, fold 1, message 3, message 4, fold 2, message 7
			expect(context.messages.length).toBe(6);
			expect(context.messages[0].role).toBe("user");
			expect((context.messages[0] as { content: string }).content).toBe("Message 0");
			expect(context.messages[1].role).toBe("foldSummary");
			expect((context.messages[1] as { summary: string }).summary).toBe("First fold");
			expect(context.messages[2].role).toBe("user");
			expect((context.messages[2] as { content: string }).content).toBe("Message 3");
			expect(context.messages[3].role).toBe("user");
			expect((context.messages[3] as { content: string }).content).toBe("Message 4");
			expect(context.messages[4].role).toBe("foldSummary");
			expect((context.messages[4] as { summary: string }).summary).toBe("Second fold");
			expect(context.messages[5].role).toBe("user");
			expect((context.messages[5] as { content: string }).content).toBe("Message 7");
		});

		it("handles nested folds (outer subsumes inner)", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 8; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			// Create inner fold first, then outer
			sm.appendFold(entries[2], entries[4], "Inner fold");
			sm.appendFold(entries[1], entries[6], "Outer fold");

			const context = sm.buildSessionContext();

			// Outer fold should subsume inner fold
			// Should have: message 0, outer fold summary, message 7
			expect(context.messages.length).toBe(3);
			expect(context.messages[0].role).toBe("user");
			expect(context.messages[1].role).toBe("foldSummary");
			expect((context.messages[1] as { summary: string }).summary).toBe("Outer fold");
			expect(context.messages[2].role).toBe("user");
		});

		it("unfolding reactivates nested folds", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 8; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			// Create inner fold first, then outer
			const _innerFoldId = sm.appendFold(entries[2], entries[4], "Inner fold");
			const outerFoldId = sm.appendFold(entries[1], entries[6], "Outer fold");

			// Unfold outer - inner should become active again
			sm.appendUnfold(outerFoldId);

			const context = sm.buildSessionContext();

			// Should have: message 0, message 1, inner fold (covers 2-4), message 5, message 6, message 7
			expect(context.messages.length).toBe(6);
			expect(context.messages[0].role).toBe("user");
			expect((context.messages[0] as { content: string }).content).toBe("Message 0");
			expect(context.messages[1].role).toBe("user");
			expect((context.messages[1] as { content: string }).content).toBe("Message 1");
			expect(context.messages[2].role).toBe("foldSummary");
			expect((context.messages[2] as { summary: string }).summary).toBe("Inner fold");
			expect(context.messages[3].role).toBe("user");
			expect((context.messages[3] as { content: string }).content).toBe("Message 5");
			expect(context.messages[4].role).toBe("user");
			expect((context.messages[4] as { content: string }).content).toBe("Message 6");
			expect(context.messages[5].role).toBe("user");
			expect((context.messages[5] as { content: string }).content).toBe("Message 7");
		});

		it("inactive folds are ignored", () => {
			const sm = SessionManager.inMemory();
			const entries: string[] = [];
			for (let i = 0; i < 5; i++) {
				entries.push(sm.appendMessage({ role: "user", content: `Message ${i}`, timestamp: Date.now() }));
			}

			const foldId = sm.appendFold(entries[1], entries[3], "Deactivated fold");
			sm.appendUnfold(foldId);

			const context = sm.buildSessionContext();

			// Should have all 5 messages (fold is inactive)
			expect(context.messages.length).toBe(5);
			for (let i = 0; i < 5; i++) {
				expect(context.messages[i].role).toBe("user");
			}
		});
	});
});
