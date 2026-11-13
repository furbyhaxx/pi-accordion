---
document:
  type: "specification"
  id: "SPEC-0003"
  title: "Recall: bounded retrieval of folded content"
  description: "What the agent's recall tool returns for each kind of address, how one session account bounds everything recall adds to the context, the query language of archive search, expiry of recall results and the guard that clips oversized tool results the bound on the agent's unfold and questions answered by a side model."
  status: "published"
  revision: 5
  created_at: "2026-11-13T12:48:37+01:00"
  updated_at: "2026-11-13T13:01:59+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 5
      reason: "questions that need reading and combining made the agent recall many entries"
      changes: ["§7: recall({ask})", "§8: recall.ask"]
    - revision: 4
      reason: "the agent's unfold could put a fold of any size back into the standing context"
      changes: ["§6: bounded unfold", "§7: recall.unfoldTokens"]
    - revision: 3
      reason: "one tool result larger than the budget could not be folded and ended a session as saturated"
      changes: ["§5: oversized tool-result guard", "§6: guard.resultTokens"]
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

## 5. Oversized tool results

`core/resultGuard.ts` plans; the host applies it in the `context` hook after ingestion, only while
folding is armed, whichever conductor is attached.

- A `tool_result` of any tool above `guard.resultTokens` that has not been sent yet is replaced
  (`replace`, recoverable) by its first and last 1,500 tokens around one line:
  `[… ~N of ~M tokens clipped. Search the rest: recall({codes:["<code>"], query:"text"}) · read it in pages: recall({codes:["<code>.1"], page:1})]`.
  The model never saw it whole, so the provider cache is not touched, and Truth allows the
  replacement inside a protected tail (birth-fold).
- The first pass after a session's Truth is built also covers results that count as sent: a loaded
  session holds its whole history as sent, and this is what repairs one that already contains an
  oversized result. Truth still refuses a sent block inside a conductor's protected tail.
- An oversized `recall` result (written before recall was bounded) becomes its expiry stub (§4)
  instead of a clipped block.
- Left alone: a result with a human override, a result already folded or inside a folded group.
- The clipped block's code works with `recall` like any fold code: search, or `code.1` in pages.

## 6. Bounded unfold

The agent's `unfold` tool goes through `resolveUnfoldBounded` (`core/agentView.ts`). Human unfolds
in the panel and the web UI are not limited.

- Per code, the cost is the full size of the blocks it would restore minus what they occupy now.
- Refused `size`: the cost is above `recall.unfoldTokens`.
- Refused `budget`: the projection plus the cost would reach `taskfold.high × budget`.
- A refused code changes nothing (no revision). The reply names the cost and the two `recall` calls
  that reach the content: the code alone, and the code with a query.
- Codes of one call are decided in order, each against the projection the earlier ones left.
- A leading `#` on a code is ignored.

## 7. Ask

`recall({ask: "question", codes?, query?})` returns a short answer written by a side model
(`core/recallAsk.ts` plans, `answerRecall` in `extension/accordion.ts` runs it).

- Material, at most `recall.ask.inputTokens`: one third for the reports of the named tasks (all
  folded tasks, newest first, when no codes are given), the rest for search hits. The search uses
  `query` when given, otherwise one alternation of the question's up to eight longest non-stopword
  words. A whole transcript is never sent.
- One completion through the host's completion executor with routing id `recall`
  (`models.conductors.recall.chat`, then `models.defaults.chat`, then the session's model).
- Privacy: the session's own model and loopback models need no consent. Any other model needs
  `privacyConsent.recall`; an interactive session asks once, a non-interactive one does not answer.
- The answer is cut to 800 tokens and to the account's grant. Citations are bracketed addresses.
  A citation whose address the material did not show is removed and the result says how many were;
  an answer left without a citation says so.
- No answer (ask turned off, nothing matches, no model, no consent, failed or empty completion):
  the result starts with `[no answer: <reason>.` and carries the search hits within the grant.
- The account applies as to any call: refused below the minimum grant, the result is reserved, and
  it expires like other recall results (the stub names the question).

## 8. Settings (`~/.accordion/config.json`)

```json
{ "recall": { "callTokens": 8000, "liveTokens": 24000, "keepSteps": 3, "unfoldTokens": 20000,
              "ask": { "enabled": true, "inputTokens": 24000 } },
  "guard": { "resultTokens": 16000 } }
```

`callTokens` 2,000–50,000; `liveTokens` 2,000–200,000 and never below `callTokens`; `keepSteps`
0–100; `unfoldTokens` 1,000–1,000,000; `ask.inputTokens` 2,000–200,000; `resultTokens` 4,000–1,000,000, or 0 to turn the guard off. Read on every call and request.

## 9. Tests

| What | Where |
|---|---|
| parallel calls with many codes stay within the account; refusal text; landed results count across turns; projection stays within budget | `core/recallAccount.test.ts` |
| whole/index/entry/paging/missing | `core/recallView.test.ts` |
| used results become stubs in one transaction; recent, held, small and foreign results stay; a refused call is served after a release | `core/recallExpiry.test.ts` |
| a giant result at the tail of an open task saturates Taskfold without the guard and not with it; both ends kept, rest reachable by search and pages; sent, held and small results untouched; loaded-session repair; recall result → stub | `conductors/in-process/taskfold/resultGuard.test.ts` |
| unfold of a 40k fold refused with no revision; small fold unfolded in the same call; refusal when the room below the ceiling is too small | `core/unfoldBounded.test.ts` |
| ask material bounded and without transcript; caller query; question terms; invented citations removed; uncited answer marked; fallback within the grant | `core/recallAsk.test.ts` |
| ask through the registered tool: fallback without a model, answered with a mocked completion | `extension/smoke.mjs` |
| eleven task codes → eleven reports without transcript; subtasks as codes; `.entries`; archive search, terms, phrase, regex, partial, paging | `conductors/in-process/taskfold/taskReports.test.ts` |
| the registered tool end to end, including codeless search | `extension/smoke.mjs` |
