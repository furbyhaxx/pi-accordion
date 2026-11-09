---
name: accordion-context-folding
description: "Read this skill if you see {#<code> FOLDED} markers in your context (e.g. {#3f9a2c FOLDED}), or if earlier parts of your context look summarized. Accordion is a Pi extension that may compact older context blocks to keep you under a token budget. The unfold tool restores a folded block (open from your next turn); the recall tool reads its full content right now as a tool result without changing your standing context."
---

Accordion, a Pi extension, may be folding parts of your context to keep token usage within a budget. This is opt-in and controlled by the human — you cannot disable it, but you can always pull specific blocks back.

## What folding looks like

A folded block appears as:

```
{#3f9a2c FOLDED} Assistant analyzed the test failures: three imports were missing…
```

The `3f9a2c` is a short **fold code** — an opaque handle for that block. The part after `FOLDED}` is a short summary. The original content is preserved and retrievable — nothing is lost.

## Restoring folded content

Call the `unfold` tool with one or more codes copied from the markers:

```
unfold({codes: ["3f9a2c"]})
unfold({codes: ["3f9a2c", "00a2cd"]})
```

(Pass the codes exactly as shown, as strings — a code may have leading zeros.)

The tool returns a confirmation. The restored content appears in your context **on your next turn** — not immediately. If you need the content now, call `unfold` and then take another step (e.g. re-read, continue the task) so the next turn picks it up.

## Reading folded content right now (recall)

If you need folded content **for the current step** but do not want to change your standing context, call `recall` instead of `unfold`:

```
recall({codes: ["3f9a2c"]})
recall({codes: ["3f9a2c"], query: "parseConfig"})
recall({codes: ["3f9a2c.12"]})
```

`recall` answers **as this tool's result, immediately**, and is bounded to ~8k tokens per call. A small fold comes back whole; a large one comes back as an index of subtask codes and numbered entries. Search it with `query` or read one entry with `code.N`. Your standing context is unchanged.

Choose between them:

- **recall** — read it once, now, bounded. Content (or an index of a large fold) comes back as the tool result this turn; your context is untouched.
- **unfold** — keep it open. The block returns to your context on your **next** turn and stays open until the human re-folds it.

Prefer `recall` when you just need to glance at a value or quote; use `unfold` only for a small block you will keep referring to over several turns. Never unfold a large finished task to read one detail: search it with `recall`.

## What to unfold

Only unfold what you genuinely need. Agent unfolds are sticky — the human can see and re-fold them in the Accordion panel, but they will not be auto-refolded while you work. Unfolding costs tokens; if the budget is tight, Accordion may fold other blocks to compensate.

If a block looks irrelevant to your current task, leave it folded. If you need the exact content (code, a specific value, a previous decision), unfold it. If a code matches more than one block (rare), all matching blocks are restored.
