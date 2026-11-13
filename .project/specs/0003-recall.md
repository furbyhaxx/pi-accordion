---
document:
  type: "specification"
  id: "SPEC-0003"
  title: "Recall: bounded retrieval of folded content"
  description: "What the agent's recall tool returns for each kind of address, how one session account bounds everything recall adds to the context, and the query language of archive search."
  status: "published"
  revision: 2
  created_at: "2026-11-13T12:48:37+01:00"
  updated_at: "2026-11-13T12:52:40+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 2
      reason: "a refusal was final until recall results left the context by other means"
      changes: ["§3: a call that cannot be served releases used results first", "§4: expiry of recall results", "§5: recall.keepSteps"]
    - revision: 1
      reason: "recall returned task transcripts and was bounded per call only, so several calls filled the context"
      changes: ["initial: tool contract, session account, report-first task codes, archive search, settings"]
---

# Recall

`recall` is a read: it never changes fold state and is never lockable (ADR 0011). What it adds to the
context is bounded as one session-wide quantity.

## 1. Invariant

Whatever codes, queries and pages the agent passes, in any number of calls, sequential or parallel:

- one call returns at most `recall.callTokens`;
- recalled text standing in the context plus the calls of the current turn never exceed
  `recall.liveTokens`;
- a call never takes the projection above `budget − margin`.

## 2. Tool contract

`recall({codes?, query?, page?})`. Codes are given without `#`.

| Address | Result |
|---|---|
| task code (`t:<list>/<id>` handle) | the task's **report**; never its transcript |
| `code.entries` | the index of a fold: subtask codes, then numbered entries with kind, tool, size and a preview |
| `code.N` | entry N of that fold; a long entry in pages |
| any other fold code | whole when it fits one call, else its index |
| `query` with codes | matches inside those folds, in entry order |
| `query` without codes | matches in all folded content, newest first |

- All sections of one call share `recall.callTokens`. An address that exists but does not fit is
  named in a `[budget reached] Not shown: …` line; an address that resolves to nothing is named as
  missing. 600 characters of every call are reserved for these lines.
- Pages are cut against `recall.callTokens`, never against what the account has left, so `page: N`
  means the same in every call.
- Tool `details` carry codes, modes and counts, never the text.

### 2.1 Task report

Built from the session log by `conductors/in-process/taskfold/taskReports.ts` (span scan plus the
facts Taskfold derives from the task's own tool calls) and injected into `core/recallView.ts` as
`reportOf`, so `core/` does not import a conductor.

```
[report of task auth/2 (#k3m9qa) · done · 214 entries · ~182,400 tok of transcript, not shown]
title: …
outcome: …
decisions:
- …
open:
- …
criteria:
- …
changed: path, path, …
verified:
- `npm test` → ok
subtasks (recall a code for its report):
  #p7w2ne  2.1 · done · Title — outcome…
Exact values: recall({codes:["k3m9qa"], query:"text"}) · entry list: recall({codes:["k3m9qa.entries"]}) · one entry: recall({codes:["k3m9qa.N"]})
```

- A resumed task has several spans; the last one supplies the report.
- When the reports of one call do not fit together, all of them are rendered compact (items cut to
  160 characters, no criteria, 8 changed paths, 3 checks, no child outcomes) before any is left out.
- A task code without a report (no span in the log) reads like any other fold code.

### 2.2 Search

`core/recallSearch.ts`.

- `/re/` or `/re/i` as the whole query is one regular expression (flags `i`, `s`; always
  multi-line). The pattern is at most 120 characters, and a repeated group that contains a
  repetition is rejected with a message.
- Otherwise the query is up to 8 whitespace-separated terms that must all occur in one entry,
  case-insensitive. `"a phrase"` keeps its spaces.
- Each hit: `#code.N`, the task (archive search), kind, tool, and excerpts of 160 characters around
  the matches (one per term; five for a single term), overlapping excerpts joined.
- No entry has every term: the hits of the rarest term that occurs, with `PARTIAL` in the header.
- Archive search visits every agent-reachable folded entry once and addresses it through the
  smallest fold that holds it, so the address names the task and opens the entry directly.

## 3. Account

`core/recallAccount.ts`; one `RecallAccount` per extension instance.

- `outstanding` = tokens of `recall` tool results that are live in the projection (not inside a
  folded group; a replaced result counts at its replacement's size) + reservations.
- A reservation is made synchronously when a call returns and dropped when its result block is in
  the log, so parallel calls of one assistant message share the account. Reservations are cleared
  when a prompt starts and when the session's Truth is first built.
- `grant = min(callTokens, liveTokens − outstanding, budget − projection − reservations − margin)`.
  `margin` is 4,000 tokens and `minGrant` 1,000, each at most 2% of the budget.
- `grant < minGrant`, or nothing the call asked for fits the grant: used results are released
  once (§4, including those of earlier prompts) and the grant is recomputed. Still not enough: the
  call returns one line,
  `Recall refused: ~N tokens of recalled text are already in your context (limit M) or the context is near its budget. …`.
  A refusal never contains archive text.

## 4. Expiry

`core/recallExpiry.ts` plans, the host applies (`releaseRecall` in `extension/accordion.ts`), only
while folding is armed.

- A recall result is **used** once `recall.keepSteps` later assistant messages exist.
- Released means replaced (`replace`, not recoverable) by one line that repeats the call and
  carries no fold code:
  `[recall of #abc123 query "p95 latency" released to free context; run it again if you still need it]`.
- When:
  - a call cannot be served (§3): every used result; when none is used, every result that a later
    user message follows;
  - the `context` hook sees the projection at or above `taskfold.high · budget`: every used result;
  - the enclosing task folds: the result goes into the task's group like any other block.
- All results of one release go in one transaction, so the provider cache breaks once.
- Never released: a result with a human override (it keeps counting as outstanding), a result
  under 200 tokens, a result Truth protects (a sent block inside a conductor's protected tail; with
  Taskfold attached there is none).
- Fold state is not persisted, so a resumed session holds its old recall results whole again until
  the first of the two triggers fires.

## 5. Settings (`~/.accordion/config.json`)

```json
{ "recall": { "callTokens": 8000, "liveTokens": 24000, "keepSteps": 3 } }
```

`callTokens` 2,000–50,000; `liveTokens` 2,000–200,000 and never below `callTokens`; `keepSteps`
0–100. Read on every call.

## 6. Tests

| What | Where |
|---|---|
| parallel calls with many codes stay within the account; refusal text; landed results count across turns; projection stays within budget | `core/recallAccount.test.ts` |
| whole/index/entry/paging/missing | `core/recallView.test.ts` |
| used results become stubs in one transaction; recent, held, small and foreign results stay; a refused call is served after a release | `core/recallExpiry.test.ts` |
| eleven task codes → eleven reports without transcript; subtasks as codes; `.entries`; archive search, terms, phrase, regex, partial, paging | `conductors/in-process/taskfold/taskReports.test.ts` |
| the registered tool end to end, including codeless search | `extension/smoke.mjs` |
