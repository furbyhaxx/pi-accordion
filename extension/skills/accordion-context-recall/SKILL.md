---
name: accordion-context-recall
description: "Read this skill when you need content from a folded context block RIGHT NOW as a tool result — without opening it in your standing context. recall(codes, query?, page?) returns a small fold whole and a large fold as a bounded index you can search or drill into. Accordion may fold older parts of your context to keep token usage within a budget; folded blocks appear as {#<code> FOLDED} markers."
---

Accordion, a Pi extension, may be folding parts of your context to save tokens. A folded block appears as:

```
{#3f9a2c FOLDED} Assistant analyzed the test failures: three imports were missing…
```

The `3f9a2c` is a **fold code**; the text after `FOLDED}` is a digest. The original content is preserved and retrievable.

## recall — bounded, read-only

Each call returns at most ~8k tokens. Your standing context is not changed.

- **Small fold**: `recall({codes: ["3f9a2c"]})` returns it whole.
- **Large fold** (a finished task can hold hundreds of thousands of tokens): the same call returns an **index** — subtask codes, then numbered entries (`.1`, `.2`, …) with kind, tool, size and a preview.
- **Search**: `recall({codes: ["3f9a2c"], query: "ECONNREFUSED"})` returns excerpts around each case-insensitive literal match, each with its entry address. Usually the cheapest way to find a value, path or error.
- **One entry**: `recall({codes: ["3f9a2c.12"]})` reads entry 12; a long entry comes in pages.
- **Subtask**: recall its own code from the index to get its index.
- **Paging**: results name the next call, e.g. `recall({codes: ["3f9a2c"], page: 2})`.

Search or address the entry you need. Do not page through a whole large fold: that refills the context the fold freed.

## When to use unfold instead

`unfold({codes: [...]})` puts a block back into your **standing** context from your next turn until the human re-folds it. Use it only for a small block you will keep referencing over several turns.
