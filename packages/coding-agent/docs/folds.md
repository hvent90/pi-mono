# Fold System Spec

Non-destructive folding/unfolding of conversation history segments within pi's tree-based session model.

## Motivation

Long conversations accumulate context that the LLM doesn't need on every turn (exploration steps, verbose tool output, resolved debugging). Compaction is irreversible. Folds let the agent or user compress sections of the conversation while preserving the ability to restore them.

## Entry Types

Two new entry types added to `SessionEntry` union in `session-manager.ts`:

```typescript
interface FoldEntry extends SessionEntryBase {
    type: "fold";
    rangeStartId: string;  // entry id — first entry in folded range (closest to root)
    rangeEndId: string;     // entry id — last entry in folded range (closest to leaf)
    summary: string;
}

interface UnfoldEntry extends SessionEntryBase {
    type: "unfold";
    foldId: string;  // id of the FoldEntry to deactivate (no range — nothing to overlap)
}
```

Both follow the standard `SessionEntryBase` contract: `id`, `parentId` (set to current leaf), `timestamp`. Appended via `appendFold()` and `appendUnfold()` on `SessionManager`.

## Primitives

### `fold(startId, endId, summary)`

Appends a `FoldEntry` at the current leaf. Validates nesting constraints and range constraints before appending. Returns entry id.

**Range constraints:**
- `rangeStartId` and `rangeEndId` must both exist on the current path (entries on other branches are rejected)
- `rangeStartId` must come before `rangeEndId` on the path
- The range must not include compaction entries (folding a compaction summary would lose compaction context)
- Single-entry folds (`rangeStartId === rangeEndId`) are valid — useful for collapsing a single verbose tool result

### `unfold(foldId)`

Appends an `UnfoldEntry` at the current leaf. Deactivates the referenced fold. Post-fold work is preserved — no branching required. Returns entry id.

**Unfold after compaction:** if compaction has already summarized away the entries in the fold's range, unfolding deactivates the fold but does not restore the original content (compaction is irreversible). The entries are gone from context regardless. This is expected — unfold restores what is available, not what was destroyed by compaction.

### `peek(foldId)`

Read-only. Returns the original messages from the fold's range as a tool result. Does **not** modify the session. The harness auto-folds the peek's tool result entry (not the full assistant message, which may contain other tool calls) after `agent_end` to prevent the peeked content from persisting in context.

## Nesting Constraints

Enforced at fold creation time. A proposed fold `[bStart, bEnd]` is valid iff for every active fold `[aStart, aEnd]` on the current path:

```
disjoint:    bEnd < aStart || bStart > aEnd
b inside a:  bStart >= aStart && bEnd <= aEnd
a inside b:  aStart >= bStart && aEnd <= bEnd
```

If none of these hold (partial overlap), the fold is rejected.

"Active fold" = a fold entry in the current path with no later unfold entry referencing it. Inactive (unfolded) folds are ignored during validation.

Two folds covering the exact same range is permitted (A inside B AND B inside A both hold). Unfolding one leaves the other active. This is an edge case but not harmful — the remaining fold still provides a valid summary.

### Nested fold behavior

Outer fold subsumes inner. When fold-A(1-8) contains fold-B(3-4), only fold-A's summary is used. Fold-B becomes dormant. If fold-A is later unfolded, fold-B reactivates automatically (it's still in the path with no unfold of its own).

## `buildSessionContext` Changes

Single pass with splice. The function remains pure: same entries + same leaf = same context.

### Algorithm

1. Walk the path from root to leaf. For each entry:
   - If it produces a message, push to `messages[]` and push entry id to parallel `entryIds[]`
   - If `type === "unfold"`, record `foldId` in a `deactivated: Set<string>`
   - If `type === "fold"` and `entry.id` is NOT in `deactivated`:
     - Find indices in `entryIds[]` where the entry id falls within `[rangeStartId, rangeEndId]` on the path
     - Splice those messages out of `messages[]` and `entryIds[]`
     - Insert fold summary message at the splice point
   - Settings extraction (thinking level, model) is unaffected — these are read from the path regardless of folds

### Fold summary message

New message role added via declaration merging in `messages.ts`:

```typescript
interface FoldSummaryMessage {
    role: "foldSummary";
    summary: string;
    foldId: string;
    timestamp: number;
}
```

Converted to LLM format as a `user` message:

```
The following is a summary of a folded section of this conversation:

<summary>
{summary}
</summary>
```

## `/tree` Visualization

- **Active folds**: shown with `▶` marker, entry count, and summary preview
- **Inactive folds** (those with a corresponding unfold): hidden in default filter mode
- **Unfold entries**: hidden in default filter mode
- Both visible in "all" filter mode

## Harness Integration

### Auto-fold of peek results

After `agent_end` in `agent-session.ts`, alongside `_checkCompaction`:

```
agent_end
  → _handleRetryableError
  → _checkCompaction
  → _autoFoldPeekResults
```

`_autoFoldPeekResults` scans entries appended during the agent loop for peek tool calls and their results, then appends a fold covering those tool result entries with a minimal summary (e.g., `"peeked at fold [id]"`).

**Scoping:** The auto-fold targets the `toolResult` entry for the peek, not the assistant message entry that contains the peek tool call (which may also contain other tool calls). Track the agent loop boundary via a `_agentStartLeafId` field set on `agent_start`.

**Ordering:** Runs after `_checkCompaction`. If compaction fires in the same `agent_end`, it runs first, then peek auto-fold runs on the post-compaction state. After auto-folding, rebuild agent state messages from session context.

## Compaction Interaction (hard dependency)

Compaction must be fold-aware before folds ship:

1. **Token estimation**: when computing token counts for compaction decisions, use fold summary token counts for folded ranges, not the original entries' token counts
2. **Precedence**: if compaction's `firstKeptEntryId` falls inside a fold range, the fold takes precedence for that range (the fold already provides a summary; compaction should not double-summarize)
3. **Subsumed folds**: if compaction summarizes a region that fully contains a fold's range, the fold becomes a no-op (its range is already gone). This is safe — `buildSessionContext` would not find the fold's range entries in the message array, so the splice is a no-op
4. **Fold spanning compaction boundary**: if a fold's range has some entries before `firstKeptEntryId` and some after, only the post-boundary entries are in the message array. The splice removes only those — a partial fold. This is correct behavior: compaction already summarized the pre-boundary entries, and the fold handles the remainder

## Summary Generation

The `summary` field is a string — the caller provides it. How it's produced depends on the caller:

### User-initiated (UX)

- **A**: LLM generates a summary from the folded entries automatically
- **B**: User provides a prompt; LLM generates a summary guided by that prompt
- **C**: User provides the summary directly

### Agent-initiated

Depends on the harness:

- **Tool**: the fold tool accepts a `summary` parameter that the agent fulfills
- **REPL**: the agent calls the `fold()` function primitive directly, passing the summary

## UX

Simplest viable approach. Details TBD — the primitives are the priority.

## Entry ID Addressing

Fold primitives reference entries by their 8-character hex IDs. These IDs are internal to the session manager and not currently exposed in the LLM context. For agents to use fold/unfold/peek, they need a way to discover entry IDs.

Options (harness-dependent):
- **Listing tool**: a `list_entries` tool that returns recent entry IDs with role/preview, allowing the agent to select a range
- **Relative addressing**: accept "last N turns" or "from turn X to turn Y" and resolve to entry IDs internally
- **Context injection**: include entry IDs as metadata in messages sent to the LLM

The primitives accept entry IDs. The addressing layer that resolves human/agent-friendly references to IDs is a separate concern.

## Wiring to Agent

Depends on the harness:

- **Tool-based harness**: `fold`, `unfold`, `peek` registered as agent tools with parameter schemas
- **REPL-based harness**: function primitives (`fold()`, `unfold()`, `peek()`) exposed directly

## Implementation Notes

### Exhaustiveness

Every `switch(entry.type)` and `if/else` chain on entry types must handle `"fold"` and `"unfold"`. Known sites:
- `buildSessionContext` in `session-manager.ts`
- `getMessageFromEntry` in `compaction.ts` and `branch-summarization.ts` (return `undefined` — fold/unfold don't produce messages directly)
- `findValidCutPoints` in `compaction.ts` (fold/unfold are not valid cut points)
- `getEntryDisplayText` and `getSearchableText` in `tree-selector.ts`
- `estimateTokens` in `compaction.ts` (add `foldSummary` case for the new message role)
- HTML export template switches (no-crash fallthrough)

### Session versioning

No version bump needed. Fold/unfold entries are additive — old clients encountering unknown entry types will ignore them gracefully (existing switch statements fall through without throwing).

### ReadonlySessionManager

`appendFold` and `appendUnfold` are write operations — they must NOT be added to `ReadonlySessionManager`. Query methods (e.g., `getActiveFolds`) may be added if needed.

## Not in scope (deferred)

- **Fold-aware HTML export**: export currently uses `buildSessionContext`; folds will work automatically, but rendering fold entries in the export is deferred
