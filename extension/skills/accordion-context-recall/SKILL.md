---
name: accordion-context-recall
description: "Read this skill when you need something from a folded context block RIGHT NOW as a tool result, without opening it in your standing context. recall(codes?, query?, page?) returns a task's report, searches all folded content, or reads one entry. Accordion may fold older parts of your context to keep token usage within a budget; folded blocks appear as {#<code> FOLDED} markers."
---

Accordion, a Pi extension, may be folding parts of your context to save tokens. A folded block appears as:

```
{#3f9a2c FOLDED} Assistant analyzed the test failures: three imports were missing…
```

The `3f9a2c` is a **fold code**; the text after `FOLDED}` is a digest. The original content is preserved and retrievable.

## recall: look something up

`recall` is a lookup, not a way to re-read past work. Your standing context is not changed.

| You need | Call | You get |
|---|---|---|
| what a finished task achieved or decided | `recall({codes: ["3f9a2c"]})` | its report: outcome, decisions, open items, files changed, checks run, and the codes of its subtasks |
| a value, path, number or error, wherever it was | `recall({query: "ECONNREFUSED"})` | excerpts from all folded content, newest first, each with an address like `3f9a2c.12` |
| the same, inside known folds | `recall({codes: ["3f9a2c"], query: "timeout retry"})` | matches inside those folds |
| one whole entry | `recall({codes: ["3f9a2c.12"]})` | that entry; a long one comes in pages |
| the list of a fold's entries | `recall({codes: ["3f9a2c.entries"]})` | subtask codes and numbered entries with previews |

A fold that is not a task (a single block, a run of steps) comes back whole when it is small and as its entry list otherwise.

## Queries

- Several words must **all** occur in one entry: `timeout retry`.
- Double quotes keep a phrase together: `"connection refused"`.
- `/…/` is a regular expression: `/p9[05] = \d+ms/`.
- Matching is case-insensitive. When no entry has every word, you get the hits of the rarest word, marked `PARTIAL`.
- Results name the next call when there are more pages.

## Limits

- One call returns at most about 8k tokens across all its codes. Codes that did not fit are named; recall them separately.
- At most about 24k tokens of recalled text stay in your context. Beyond that a call answers `Recall refused: …` and returns nothing. Work with what you have, write down the facts you need, and continue.
- Do not recall many task codes to rebuild what happened: ask for the report of the one task you need, or search for the one value.

## When to use unfold instead

`unfold({codes: [...]})` puts a block back into your **standing** context from your next turn until the human re-folds it. Use it only for a small block you will keep referencing over several turns.
