---
document:
  type: "draft"
  id: "DRAFT-fold-timing"
  title: "Taskfold fold timing, cache anchoring, report limits and debug mode"
  description: "Proposal from the PLAN-0029 session audit: selectable fold timing (eager, lazy, pressure), a cache anchor for eager folds, provider cache profiles, high hard report limits without cutting, fixes for row accounting and message routing, and a debug mode"
  status: "draft"
  revision: 1
  created_at: "2026-11-10T09:45:42+01:00"
  updated_at: "2026-11-10T09:45:42+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "audit of a 1,480-request Taskfold session showed that no task folded on completion"
      changes: ["initial proposal with verified cache semantics and a validated timing simulation"]
---

# Taskfold fold timing, cache anchoring, report limits and debug mode

Amends `.project/specs/0002-taskfold-tree.md` §3.4 (report limits), §6.2 (record cap), §8 (fold
lifecycle) and §12 (settings) once decided. It corrects §8 of
`.project/analyses/fold-representations/README.md`.

## 1. What the audit found

Session `01a1c22c` (nukular-ai, PLAN-0029, `claude/claude-sonnet-5-5`, budget 272k, 68 tasks):

| Observation | Value |
|---|---|
| Requests | 1,480; mean input 163k; total input 242M |
| Context shrinks | 25, every one from about 217k (0.8 × 272k) |
| Cache read at each shrink | 22,911 tokens (system and tools only) |
| Rewritten at each shrink | 58k–143k; 2.44M cache-write tokens in total |
| Folds on task completion | none |
| Finished leaves longer than 18 blocks | 52 of 60 (median 67 blocks) |
| Rejected `tasks` calls | 30, of which 23 were length limits |

Taskfold behaved as a pressure compactor. SPEC-0002 §8 says a finished task folds at the next
request. It did not, for the reason in §2.3.

## 2. Verified facts

### 2.1 Provider caches

| Family | Entries are written | A read finds | Prices (× base input) | Source |
|---|---|---|---|---|
| Anthropic | only at a `cache_control` breakpoint, max 4 per request | a prior write within 20 positions behind each breakpoint; a run of `tool_use` or of `tool_result` blocks is one position | write 1.25 (5 min) or 2 (1 h); read 0.1, 0.05 on Sonnet 5.5 and Opus 5.5, 0.025 on Fable and Mythos 5.1+ | platform.claude.com `build-with-claude/prompt-caching`, fetched 2026-11-10 |
| OpenAI GPT-5.6 and later | at breakpoints; implicit mode puts one at the latest eligible message; max 4 writes | the implicit breakpoint, up to 20 earlier eligible message endings, explicit breakpoints | write 1.25 (30 min) or 2.5 (12 h); read 0.1, 0.05 on GPT-6.1 Sol and Terra | `host:/mnt/shared/knowledge-base/ai-context-management/evidence/raw/harness/codex/api-prompt-caching.md` |
| OpenAI before GPT-5.6 | at fixed token intervals | longest matching prefix | no write charge | same |
| DeepSeek | at request ends, detected common prefixes, fixed intervals | a full prefix-unit match | provider specific | KB `cache/deepseek-kv-cache.html` |

Not verified: the `openai-codex` subscription backend, `synthetic`, `xai`, OpenRouter-routed and
Gemini models.

Consequence for both breakpoint families: a fold is cheap only when an entry exists at an
**unchanged position directly before the fold**. The lookback finds earlier writes; it does not
find stable content.

### 2.2 Breakpoints pig sends

`host:/mnt/Projects/furbyhaxx/pig` at `3dbc68a70`, `ai/anthropic.go`: every system block (line
1483; two blocks with an OAuth token, line 1480), the last tool (867), and the last block of the
final user message (470–487). That is 3 breakpoints with an API key and all 4 with OAuth (the
`claude` provider). Extensions can rewrite the provider payload: `pig-auth-plus` already edits
`cache_control` there (`internal/hooks/hooks.go:46-119`).

### 2.3 Why eager folding does not run

- `conductors/in-process/taskfold/taskfold.ts:743-745` defers a finished span when it starts more
  than `CACHE_LOOKBACK = 20` blocks before the end, the cache is warm and there is no pressure.
  The distance is measured before the fold, so it is the length of the task itself.
- The simulation behind that rule (`fold-representations` §8) folded a task at the first request
  after its closing result, where the record is the last message. The planner forbids that
  (`taskfold.ts:942`) and folds one step later.
- One step later, the previous sibling's fold has already landed inside the current task. So no
  request ever ended at the boundary before the current task with the content it has now, and no
  entry exists there. The rule therefore protects nothing: a deferred fold and an immediate fold
  both miss, and the deferred one misses on a context that is two to three times larger.
- The rule has no provider or model input.

### 2.4 Other defects found

| Defect | Location |
|---|---|
| A task row shows `→ 0`: it sums the handle's members, but the summary is charged to the group's first block, which message snapping puts before the handle | `extension/tui/taskWidget.ts:255-259`, `extension/tui/taskTranscript.ts:123` |
| The routing extractor fails on any reply that is not bare or fully fenced JSON; the host's `complete()` ignores `stopReason`; the reply is not kept; no retry | `extension/taskRouting.ts:122-131`, `extension/accordion.ts:999-1022`, `taskfold.ts:625-650` |
| The extractor runs on the session's main model when `models` is empty | `extension/accordion.ts:927-935` |
| Report limits are not stated in the tool description or schema ("one or two sentences"), and the check reports one violation per call | `extension/accordion.ts:4055-4098`, `extension/tasks.ts:166-173` |
| `recordTokens` is compared in calibrated tokens; the multiplier still absorbs tool-schema overhead, so the cap tightens as the wire shrinks | `core/conductor/liveHost.ts:225`, `taskfold.ts:1014-1015`, `extension/accordion.ts:2829-2831` |
| Ten paths decline a fold silently; only saturation sets a status | `taskfold.ts:745, 915-1018` |
| A cache that expired during an idle gap is not treated as cold | `taskfold.ts:744` |
| `leafForm: "bracket"` is specified but not implemented | SPEC-0002 §6.2 |

## 3. Simulation

`evidence/timing_sim.py` replays a session's wire before every request under a fold policy and a
breakpoint cache with TTL, block-counted lookback and the one-step fold delay. Tokens are chars/4
scaled by `k`; `S` (system and tools) and `k` are fitted per session on the requests before its
first real fold.

Validation on the audited session (`evidence/validate-plan0029.txt`):

| | Mean input | Peak | Read | Write | Fold events |
|---|---|---|---|---|---|
| Recorded | 164k | ~218k | 242.7M | 5.39M | 25 |
| Simulated, shipped rule | 156k | 217.6k | 231.5M | 4.45M | 30 |

Policies:

- `pressure`: fold all finished tasks when the projection reaches `high`.
- `shipped`: `pressure`, plus spans inside the 20-block lookback, plus a never-sent cache.
- `lazy`: `shipped`, plus an expired cache counts as cold.
- `eager`: fold every finished task one step after its closing message.
- `frontier`: an extra breakpoint directly before the innermost open task's start.
- `bracket`: the carrier replaces the span up to its closing call; the closing call and result
  stay verbatim, so the fold can land at the first request after completion.

Weighted cost in millions of base-input tokens, Anthropic 1 h cache, Sonnet 5.5 weights (read
0.05, write 2.0). Rows two and three ran on other models and budgets; they are what-ifs at 272k.

| Session | pressure | shipped | lazy | eager | eager + frontier | eager + bracket | both |
|---|---|---|---|---|---|---|---|
| PLAN-0029 (`modes-plan0029.txt`) | 20.43 | 20.48 | 20.07 | 14.41 | 13.46 | 13.48 | 13.44 |
| auth-plus 11-08 (`modes-authplus-1108.txt`) | 26.28 | 25.40 | 24.63 | 20.57 | 18.26 | 19.19 | 18.40 |
| nukular 11-06 (`modes-nukular-1106.txt`) | 16.30 | 16.41 | 15.87 | 13.14 | 11.30 | 12.53 | 11.35 |

Findings:

1. `eager` costs 19–30 % less than the shipped rule, although each fold still misses. The context
   is small when it misses.
2. A frontier breakpoint saves a further 7–14 %. The bracket tail recovers 33–100 % of that
   without touching the payload. Both together add nothing.
3. The ranking is the same under the 5-minute, OpenAI and prefix-cache profiles (same files).
4. `shipped`, `lazy` and `pressure` are within 3 % of each other.
5. Mean input under `eager` stays at 103k–177k and the peak barely moves. The rest is the open
   leaf task itself (largest leaf in PLAN-0029: about 154k real tokens). Fold timing cannot fix
   task size.

Limits: no floor, untracked folding, held blocks or user-message verdicts; spans fold whole;
records are approximated; three sessions.

## 4. Proposal

### 4.1 Fold timing modes

`taskfold.timing`, default `eager`:

| Mode | A finished task folds |
|---|---|
| `eager` | at the first request that can carry its record, whatever its length |
| `lazy` | when the rewrite is free or forced: the cache is cold or expired, or pressure reaches `high` |
| `pressure` | only when pressure reaches `high` |

- `lazy` and `pressure` keep today's behaviour available as a compaction that folds only where a
  cache miss happens anyway.
- The 20-block rule is removed from every mode: it defers folds without saving a rewrite (§2.3).
- Resolution follows budget and protect in `extension/dials.ts`: session value → `modelDefaults`
  entry (`provider/model`, `provider/*`, `*`) → `taskfold.timing`.
- `/accordion fold <eager|lazy|pressure>` sets the session value and records an `accordion.dials`
  entry. The footer shows the mode after the conductor name.
- A mode change applies from the next epoch and never unfolds anything.

### 4.2 Cache anchor for eager folds

Step 1, all providers: **bracket tail**. The carrier replaces the span up to, not including, its
closing `tasks` call. The closing call and its result stay verbatim.

- The wire then ends on a tool result, so the fold lands at the first request after completion,
  and the entry written by the request before the task started is still valid.
- The report stays on the wire word for word in the closing call. The record omits `outcome`,
  `decisions` and `open` while the closing call is visible, so nothing is sent twice.
- A closing call batched with the next task's start already stays in that message.
- When the parent folds, the children's closing calls go into the parent's span and the child
  records carry their reports again.

Step 2, Anthropic only, after debug data confirms step 1: **frontier breakpoint** through
`before_provider_request`, on the last block before the innermost open task's start. With an
OAuth token it replaces the breakpoint on the identity system block, which the system prompt's
breakpoint already covers. To verify live first: that moving a marker alone does not change the
prefix hash.

### 4.3 Provider cache profile

One table in `core/`, keyed like `modelDefaults`: family (`anthropic`, `openai-breakpoint`,
`prefix`), TTL, read and write weight. Used for:

- the expiry test in `lazy` (the last request is older than the TTL);
- cost figures in the debug log.

The TTL comes from pig's cache-retention setting where the host exposes it, else from the table.
An unknown provider is `prefix` with a 5-minute TTL.

### 4.4 Report limits

Hard caps stay, set high, and the store never cuts what the agent wrote.

| Field | Today | Proposed |
|---|---|---|
| `report.outcome` | 600 | 2,000 |
| `report.decisions[]`, `report.open[]` item | 240 | 1,000 |
| items per list | 8 | 12 |
| `acceptanceCriteria[]` item | 120 | 300 |
| task title | 200 | 200 |

- The tool description and the JSON schema state each limit as a number (`maxLength`,
  `maxItems`).
- A rejected call lists every violation with its length and the limit, not only the first.
- `recordTokens` applies to a record's children only: over the cap, the deepest children become
  history entries. A task's own report never keeps it raw. The cap is measured on the raw
  estimate, not in calibrated tokens.

### 4.5 Fixes

1. Row tokens: a task that owns a group's summary is charged the whole group
   (`groupFullTokens` / `groupLiveTokens`). Regression test: a start call that follows a thinking
   block in the same message.
2. Routing: take the first balanced JSON object from the reply; `complete()` returns `stopReason`
   and the conductor reports truncation and provider errors as such; one retry on a parse
   failure; Taskfold declares a default small chat model for extraction.
3. Every declined fold reports its reason to the debug log (§4.6); a task that stays raw for
   more than `ZOMBIE_STEPS` steps after finishing sets a warning status.

### 4.6 Debug mode

`debug: false` in `~/.accordion/config.json`, `/accordion debug on|off` for the session (recorded
as a session entry). When on, the extension appends JSONL to
`~/.accordion/debug/<sessionId>.jsonl`, off the `context` hook:

| Record | Fields |
|---|---|
| `request` | time, model, estimate, real input, cache read, cache write, calibration `k`, live and full tokens, timing mode |
| `epoch` | planned units; for every finished task not folded, the declining path |
| `fold` | task key, carrier tokens, tokens removed, first changed block, blocks behind the end |
| `complete` | conductor, model, purpose, tokens, `stopReason`, the reply (first 2,000 characters), error |
| `tasks` | rejected calls with error code and message |
| `truth` | rebuilds and resyncs |

- The file holds session content: local only, 50 MB per session, oldest half dropped at the cap.
- `/accordion debug bundle [file]` writes the log, the `dump-transcript` tree and the settings
  (token redacted) into one archive.
- `ACCORDION_COMPLETION_LOG` is removed; the `complete` record replaces it.

## 5. Slices

1. Debug mode and decline reasons (§4.6, §4.5 item 3).
2. Row accounting and routing fixes (§4.5 items 1–2).
3. Report limits, tool description, record cap unit (§4.4).
4. Timing modes with `eager` default, expiry test, provider profile, 20-block rule removed
   (§4.1, §4.3).
5. Bracket tail (§4.2 step 1); re-run `timing_sim.py` against debug logs of real eager sessions.
6. Frontier breakpoint for Anthropic, only if slice 5's logs still show misses at folds.

## 6. Open questions

1. Root history cuts the outcome to 160 characters (SPEC-0002 §6.3). The full report stays
   recallable. Keep the cut, or show the whole outcome in history too?
2. Default mode: `eager` for every provider, or `lazy` for providers without a verified cache
   profile?
3. Proposed limit values in §4.4: high enough?
4. Debug log location: `~/.accordion/debug/` (next to the existing config) or an XDG state
   directory?
