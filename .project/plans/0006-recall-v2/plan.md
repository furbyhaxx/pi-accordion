---
document:
  type: "plan"
  id: "PLAN-0006"
  title: "Recall v2: retrieval that cannot outgrow the context"
  description: "Eight slices that replace the transcript-returning recall with report-first, searchable, account-bounded retrieval, expire retrieved text, clip oversized tool results, bound unfold, and add side-model answers and a fold-time fact ledger"
  status: "published"
  revision: 1
  created_at: "2026-11-13T12:35:13+01:00"
  updated_at: "2026-11-13T12:35:13+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "a session was lost to recall output and could not be resumed"
      changes: ["initial plan"]
---

# Recall v2

Branch `feat/recall-redesign`, worktree `.pi/worktrees/recall-redesign`. Slice S1 creates the recall
specification (number 3, reserved in `.project/ids.toml` by this plan); every slice amends it and
the recall sentences of `.project/specs/0002-taskfold-tree.md` §7.3 and §12 in the same commit as
the code. Until a slice lands, SPEC-0002 describes the shipped behaviour.

## Progress

```
done  S1  Recall account and report-first task codes
done  S2  Archive-wide search
done  S3  Expiry of recall results
done  S4  Oversized tool-result guard
done  S5  Bounded unfold
done  S6  recall({ask}) through a side model
done  S7  Fact ledger (spike passed 18/20, evidence/s7-ledger-spike.md; off by default)
done  S8  Replay, randomized admission test, gates, live run (evidence/s8-session-replay.md)
```

## Why

Session `01a1c624` (spikemem, devsrv01, budget 272k):

- The agent recalled 3–11 task codes per call, twice in parallel, to "get the outcomes" of finished
  tasks. Results: 507k, 162k, 131k characters, then 477k + 692k in one turn. The next request had
  671,677 input tokens and the provider refused it.
- Every recall in that session asked for outcomes, numbers or "what did that task cover". None
  needed a transcript.
- On resume with the bounded recall (`84346c2`) and step carriers (`8bf5c52`) the two results sit in
  the protected tail of open task `agent-brain/11`. `foldRuns` skips the tail
  (`conductors/in-process/taskfold/taskfold.ts:902`), so the epoch ends at
  `Taskfold saturated: open task agent-brain/11 (~320291 tokens)`.

What the shipped recall still allows:

| Gap | Where |
|---|---|
| The 32k-character cap is per call. Parallel calls and repeated paging multiply it | `core/recallView.ts:14` |
| A recall result is an ordinary tool result. It stays until its task folds | `extension/accordion.ts` recall tool |
| A task code returns transcript (whole or as an entry index), not the task's report | `core/recallView.ts` `render` |
| Search needs a code and matches one literal substring | `core/recallView.ts` `querySection` |
| One tool result larger than the tail cannot be folded by anything | `taskfold.ts:902`, `core/truth.ts` `opReplace` |
| `unfold` restores a fold of any size; a second agent unfold keeps it open | `core/agentView.ts:92`, SPEC-0002 §7.3 |

## Invariant

After any sequence of `recall` and `unfold` calls, in any number and order, parallel or not:

1. the projection the next request sends is at most `budget`, and
2. every token those calls added can be removed again by the host without a model call.

Recalled text is always re-derivable from the archive. That is what makes (2) cheap: a recall result
never needs a summary to be dropped.

## Design

### Tool contract

```
recall({ codes?: string[], query?: string, ask?: string, page?: number })
```

| Input | Result |
|---|---|
| task code | the task's report: title, status, outcome, decisions, open, changed, verified, direct children (id, title, status, code, size), entry count. Never transcript |
| `code.N` | entry N verbatim, clipped to the call cap, paged |
| other fold code (block, group, steps, untracked) | whole when it fits the call cap, else its entry index |
| `query` (with or without codes) | ranked matches with entry addresses; no codes = the whole archive (S2) |
| `ask` (with or without codes) | a short answer with `code.N` citations from a side model (S6) |

- One call returns at most `recall.callTokens` (default 8,000) across all its codes. Addresses that do
  not fit are named, not rendered.
- Eleven task codes return eleven reports.

### Account (S1)

`core/recallAccount.ts`, pure over `Truth` plus the in-flight reservations of this turn.

- `outstanding` = tokens of live `recall` tool results (unfolded, not expired) + reservations of calls
  that returned but whose result block has not been appended yet.
- A call may add `grant = min(callTokens, liveTokens − outstanding, budget − projection − margin)`
  tokens. `recall.liveTokens` defaults to 24,000; `margin` is 4,000.
- Reservation is synchronous inside `execute`, so parallel calls of one assistant message share it.
- `grant` below 1,000: the host first expires used recall results (S3, one transaction) and
  recomputes. Still below: the call returns a refusal of one line that names the outstanding tokens
  and says to finish with what is already in context. A refusal never carries archive text.

### Report-first (S1)

- A code that resolves to a task handle (`t:<list>/<id>`) renders its report. The report comes from
  the span itself: the finishing `tasks` call's `report`, the title and criteria from the start
  result, `changed` and `verified` from `recordFacts`. It does not depend on the carrier's current
  form, so a root condensed to history still returns its full report.
- Children are listed with their codes. `code.N` and `query` remain the only way to transcript text.
- The provider is injected into `recallView` (`reportOf(handleId)`), so `core/` does not import a
  conductor.

### Search (S2)

- `query` without codes searches every agent-reachable folded block.
- Terms are whitespace-separated and all must occur in one entry (case-insensitive); `"a phrase"` is
  literal; `/re/` is a regular expression (bounded pattern length, per-entry time bound).
- Ranking: entries matching all terms, by rarer term first, then recency. Each hit: address, task,
  kind, tool, one excerpt per term.
- No match with all terms: hits for the rarest term, marked as partial.

### Expiry (S3)

- A recall result is *used* once `recall.keepSteps` (default 3) later assistant messages exist.
- Used results are replaced by a one-line stub (`replace`, `recoverable: false`) that repeats the
  call: `[recall of #a1b2c3 query "x" released; run it again if needed]`.
- When: (a) the account needs room, (b) the projection is at or above `high·budget`, (c) the
  enclosing task folds (already the case). (a) and (b) expire every used result in one transaction,
  so the cache breaks once.
- Under (a) with nothing used, results of earlier turns expire regardless of `keepSteps`.
- A human override on a result wins; such a result counts as outstanding and is never expired.

### Oversized tool-result guard (S4)

- Any `tool_result` above `guard.resultTokens` (default 16,000) is clipped when it enters `Truth`,
  before it is first sent: `replace`, recoverable, content = first and last 1,500 tokens around
  `[clipped N tokens; read it with recall({codes:["<code>.1"], page}) or search it]`. Unsent blocks
  may be replaced inside the protected tail (birth-fold), so this costs no cache.
- On session load the same pass runs over the tail, which repairs sessions that already hold such
  a result.
- A human override wins. The guard is host behaviour, independent of the attached conductor, and
  active only while folding is armed.

### Bounded unfold (S5)

- `unfold` computes the tokens it would add before applying. It applies only when the delta is at
  most `recall.unfoldTokens` (default 20,000) and keeps the projection below `high·budget`.
- Otherwise it changes nothing and answers with the fold's size and the recall calls to use instead.

### Ask (S6)

- Material: the reports of the named tasks (or of all folded tasks, newest first) plus search hits
  for the question's terms, at most `recall.ask.inputTokens` (default 24,000). Never a whole
  transcript.
- One out-of-band completion (`models` type `recall`, privacy consent like a conductor that sends
  session content). Answer at most 800 tokens, each claim with a `code.N` or task-code citation.
  Citations that do not resolve are removed and the answer says so.
- No model, no consent or a failed call: the same material's top hits are returned instead, marked
  as unanswered.

### Fact ledger (S7, gated)

- Spike first (falsification): five folded tasks from real sessions, twenty follow-up questions
  written before looking at any extraction. Go only if at least 70% are answered from rows alone.
- Shape if it goes: at fold time a side model emits rows `(task, key, value, unit, entry address)`;
  a row is kept only when its value occurs verbatim in the cited entry; `recall({codes, query})`
  shows matching rows before transcript hits. No ledger text is added to the standing context.

## Settings

```jsonc
"recall": { "callTokens": 8000, "liveTokens": 24000, "keepSteps": 3, "unfoldTokens": 20000,
            "ask": { "enabled": true, "inputTokens": 24000 }, "ledger": { "enabled": false } },
"guard":  { "resultTokens": 16000 }
```

Sanitized in `extension/settings.ts` like the existing keys.

## Do not

- Do not rewrite a recall result on every turn or keep recalled text in one re-rendered block: both
  break the provider cache on every request.
- Do not send a whole task transcript to the side model.
- Do not make `recall` lockable or let it change fold state (ADR 0011).
- Do not do disk or model I/O on the `context` hook.
- Do not use the private session as a committed fixture; build synthetic logs with its shape.

## Tests

| Slice | Test |
|---|---|
| S1 | `core/recallView.test.ts`, `core/recallAccount.test.ts`: eleven large task codes return eleven reports within the cap; parallel calls never exceed the account; exhausted account refuses without archive text |
| S2 | all-terms, phrase, regex, partial fallback, ranking order, no-code search over several folds |
| S3 | used results become stubs in one transaction; unused ones stay; human-held stays and counts |
| S4 | a 300k-token result at the tail is clipped before the first send; a loaded session with one is repaired; Taskfold no longer reports saturation for it |
| S5 | oversize unfold refused and state unchanged; small unfold applies |
| S6 | material bound, citation check, fallback without model |
| S8 | property test over random recall/unfold/parallel/paging sequences asserting the invariant; synthetic replay of the failing session's last turn; `npm --prefix app test`, `npm --prefix app run check`, `npm --prefix extension run smoke`, `bun test extension/settings.test.ts extension/tui/*.test.ts`; live run in pig |

## Done when

Every slice's tests pass, the gates are green, a live session shows report-first recall and an
expired result, and resuming a session shaped like `01a1c624` ends below budget. Then this plan is
deleted with trailers.
