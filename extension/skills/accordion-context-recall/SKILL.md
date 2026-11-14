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
Reports page like entries. A descendant without its own visible code is shown as an ancestor entry range `3f9a2c.12-18`; recall each entry in that range individually.

A search result may start with "Facts noted when the task was folded": short `key: value  #address` lines written down when the task ended. Their values are copied from the entry named, so you can use them directly; read the entry when you need the surroundings.

## Questions

For a question that needs reading and combining ("why did we drop the retry wrapper?", "what happened with the migration?"), pass `ask`:

```
recall({ask: "Why did we drop the retry wrapper?"})
recall({ask: "Which port did the broker end up on?", codes: ["3f9a2c"], query: "broker port"})
```

Another model reads the matching reports and excerpts and returns a short answer; every statement cites an address like `[3f9a2c.12]`. `codes` narrows it to those folds, `query` sets the search terms. Before relying on an exact value, search the cited entry for it (`recall({codes:["3f9a2c.12"], query:"the value"})`); reading the entry whole costs far more. A result starting with `[no answer:` carries the closest excerpts instead.

## Clipped tool results

A very large tool result arrives clipped: its beginning, a line `[… ~N of ~M tokens clipped. …]` with a fold code, and its end. Nothing is lost. Search the hidden part with `recall({codes: ["<code>"], query: "…"})` or read it in pages with `recall({codes: ["<code>.1"], page: 1})`. Prefer narrowing the original command (a filter, a line range) when you can.

## Queries

- Several words must **all** occur in one entry: `timeout retry`.
- Double quotes keep a phrase together: `"connection refused"`.
- `/…/` is a regular expression: `/p9[05] = \d+ms/`.
- Queries are limited to 200 characters; regex flags are `i` and `s`. Questions are cut to 1,000 characters.
- Matching is case-insensitive. When no entry has every word, you get the hits of the rarest word, marked `PARTIAL`.
- Results name the next call when there are more pages.

## Limits

- The per-call and standing limits are settings (defaults: 8k and 24k tokens). Codes that did not fit are named; recall them separately.
- When the standing limit is reached a call answers `Recall refused: …` and returns nothing. Work with what you have, write down the facts you need, and continue.
- Recall results do not stay: after a few steps an old result may be replaced by `[recall of … released to free context; run it again if you still need it]`. Note the fact you needed when you read it; repeat the call only if you need the text again.
- Do not recall many task codes to rebuild what happened: ask for the report of the one task you need, or search for the one value.

## When to use unfold instead

`unfold({codes: [...]})` puts a block back into your **standing** context from your next turn until the human re-folds it. Use it only for a small block you will keep referencing over several turns. A fold is refused if it exceeds the configured size limit or would exceed the context budget; the reply gives the `recall` calls to use instead.
