---
document:
  type: "plan"
  id: "PLAN-0005"
  title: "Taskfold fold timing, cache anchoring, report limits and debug mode"
  description: "Six slices that make finished tasks fold on completion, raise the report limits, fix row accounting and message routing, and add a debug log; amends SPEC-0002 slice by slice"
  status: "published"
  revision: 3
  created_at: "2026-11-11T17:51:45+01:00"
  updated_at: "2026-11-11T18:04:09+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 3
      reason: "the user chose the extraction model"
      changes: ["S2 item 4: openai/gpt-6-luna, else openai-codex/gpt-6-luna, as an ordered default"]
---

# Taskfold fold timing, cache anchoring, report limits and debug mode

Amends `.project/specs/0002-taskfold-tree.md` (SPEC). Each slice changes the SPEC sections it names
in the same commit as the code, with a new SPEC revision. Until a slice lands, the SPEC describes
the shipped behaviour.

## Progress

```
next  S1  Debug mode and decline reasons
later S2  Row accounting and routing fixes
later S3  Report limits, tool description, record cap unit
later S4  Timing modes, eager default, cache profile, 20-block rule removed
later S5  Bracket tail; re-run the simulation on real debug logs
later S6  Frontier breakpoint (Anthropic), only if S5's logs still show misses
```

S1 comes first because S4–S6 are judged from its log. S2 and S3 are independent of each other and
of S1. S5 needs S4. S6 needs S5's measurement.

## Why

Audit of session `01a1c22c` (nukular-ai docs baseline, `claude/claude-sonnet-5-5`, budget 272k,
68 tasks, 1,480 requests):

| Observation | Value |
|---|---|
| Mean input / total input | 163k / 242M |
| Context shrinks | 25, every one from about 217k (0.8 × 272k) |
| Cache read at each shrink | 22,911 tokens (system and tools only) |
| Rewritten at each shrink | 58k–143k; 2.44M cache-write tokens in total |
| Folds on task completion | none |
| Finished leaves longer than 18 blocks | 52 of 60 (median 67 blocks) |
| Rejected `tasks` calls | 30, of which 23 were length limits |

Taskfold behaved as a pressure compactor, although SPEC §8 says a finished task folds at the next
request.

## Decisions (user, 2026-11-10)

| # | Decision |
|---|---|
| 1 | Root history shows the whole outcome; the 160-character cut of SPEC §6.3 is removed. |
| 2 | `eager` is the default timing for every provider, verified cache profile or not. |
| 3 | The limit values in S3 are accepted. |
| 4 | The debug log lives in `~/.accordion/debug/`. |

## Facts the design rests on

### Provider caches

| Family | Entries are written | A read finds | Prices (× base input) |
|---|---|---|---|
| Anthropic | only at a `cache_control` breakpoint, max 4 per request | a prior write within 20 positions behind each breakpoint; a run of `tool_use` or of `tool_result` blocks is one position | write 1.25 (5 min) or 2 (1 h); read 0.1, 0.05 on Sonnet 5.5 and Opus 5.5, 0.025 on Fable and Mythos 5.1+ |
| OpenAI GPT-5.6 and later | at breakpoints; implicit mode puts one at the latest eligible message; max 4 writes | the implicit breakpoint, up to 20 earlier eligible message endings, explicit breakpoints | write 1.25 (30 min) or 2.5 (12 h); read 0.1, 0.05 on GPT-6.1 Sol and Terra |
| OpenAI before GPT-5.6 | at fixed token intervals | longest matching prefix | no write charge |
| DeepSeek | at request ends, detected common prefixes, fixed intervals | a full prefix-unit match | provider specific |

Sources: platform.claude.com `build-with-claude/prompt-caching` (fetched 2026-11-10);
`host:/mnt/shared/knowledge-base/ai-context-management/` (`evidence/raw/harness/codex/api-prompt-caching.md`,
`cache/deepseek-kv-cache.html`). Not verified: the `openai-codex` subscription backend, `synthetic`,
`xai`, OpenRouter-routed and Gemini models. Re-check prices and lookback before S4 and S6.

A fold is cheap only when a cache entry exists at an **unchanged position directly before the
fold**. The lookback finds earlier writes; it does not find stable content.

### Breakpoints pig sends

`host:/mnt/Projects/furbyhaxx/pig` at `3dbc68a70`, `ai/anthropic.go`: every system block (two with
an OAuth token), the last tool, and the last block of the final user message. That is 3 breakpoints
with an API key and all 4 with OAuth (the `claude` provider). Extensions can rewrite the provider
payload: `pig-auth-plus` edits `cache_control` in `internal/hooks/hooks.go`. Re-read both before S6.

### Why eager folding does not run today

- `conductors/in-process/taskfold/taskfold.ts:747-749` (`deep()`) defers a finished span that starts
  more than `CACHE_LOOKBACK = 20` (line 121) blocks before the end while the cache is warm and
  there is no pressure. The distance is measured before the fold, so it is the task's own length.
- A record may not end the request (`taskfold.ts:988`, `finalMessageFrom`), so a fold lands one
  step after the closing message at the earliest.
- One step later the previous sibling's fold has already landed inside the current task. No request
  ever ended at the boundary before the current task with its present content, so no cache entry
  exists there. A deferred fold and an immediate fold both miss; the deferred one misses on a
  context two to three times larger.
- `.project/analyses/fold-representations/README.md` §8 derived the rule from a simulation that
  folded at the first request after the closing result, which the planner forbids. S4 corrects it.

### Simulation

`evidence/timing_sim.py` replays a session's wire before every request under a fold policy and a
breakpoint cache with TTL, block-counted lookback and the one-step fold delay
(`timing_sim.py <session.jsonl> [--budget N] [--validate]`; read-only, no model calls). Validation
on the audited session (`evidence/validate-plan0029.txt`): recorded mean input 164k, read 242.7M,
write 5.39M, 25 fold events; simulated shipped rule 156k, 231.5M, 4.45M, 30.

Weighted cost in millions of base-input tokens, Anthropic 1 h cache, Sonnet 5.5 weights (read 0.05,
write 2.0). Rows two and three ran on other models and budgets; they are what-ifs at 272k.

| Session | pressure | shipped | lazy | eager | eager + frontier | eager + bracket | both |
|---|---|---|---|---|---|---|---|
| docs baseline (`evidence/modes-plan0029.txt`) | 20.43 | 20.48 | 20.07 | 14.41 | 13.46 | 13.48 | 13.44 |
| auth-plus 11-08 (`evidence/modes-authplus-1108.txt`) | 26.28 | 25.40 | 24.63 | 20.57 | 18.26 | 19.19 | 18.40 |
| nukular 11-06 (`evidence/modes-nukular-1106.txt`) | 16.30 | 16.41 | 15.87 | 13.14 | 11.30 | 12.53 | 11.35 |

- `eager` costs 19–30 % less than the shipped rule although each fold still misses: the context is
  small when it misses.
- A frontier breakpoint saves a further 7–14 %. The bracket tail recovers 33–100 % of that without
  touching the payload. Both together add nothing.
- The ranking is the same under the 5-minute, OpenAI and prefix-cache profiles.
- `shipped`, `lazy` and `pressure` are within 3 % of each other.
- Mean input under `eager` stays at 103k–177k: the rest is the open leaf itself (largest leaf in
  the docs-baseline session: about 154k real tokens). Fold timing cannot fix task size.

Limits: no floor, untracked folding, held blocks or user-message verdicts; spans fold whole; records
are approximated; three sessions.

## Branching and environment

- Base `origin/feat/pi-native`; one worktree and branch per slice under `.pi/worktrees/`:
  S1 `feat/accordion-debug`, S2 `fix/task-rows-routing`, S3 `feat/report-limits`,
  S4 `feat/fold-timing`, S5 `feat/bracket-tail`, S6 `feat/frontier-breakpoint`.
- `npm --prefix extension ci` per worktree.
- Gates for every slice: `bun test conductors/in-process/taskfold/*.test.ts extension/*.test.ts
  extension/tui/*.test.ts core/*.test.ts`, `npm --prefix extension run smoke`,
  `npm --prefix app run check`, `npm --prefix app test`.
- Live runs use an isolated home (`ACCORDION_HOME`, `doorPort: 0`); recipe in
  `.project/plans/0001-accordion-ui-polish/plan.md`, "Branching and environment".
- Do not push or change `~/.pig/agent/settings.json` without asking the user.

## What not to do

- No disk I/O on the `context` hook (CLAUDE.md invariant). The debug log is written off that path.
- Never cut text the agent wrote: an over-limit report is rejected, not truncated.
- A mode change never unfolds anything.
- Do not change task end states or block reasons; that contract is not part of this plan.
- Do not add a per-provider timing default: decision 2.
- Step carriers of open tasks (SPEC §9.4) are a pressure measure and keep running in every mode.

## S1: debug mode and decline reasons

Current: no debug setting exists (`extension/settings.ts`). Out-of-band completions can be logged
through the `ACCORDION_COMPLETION_LOG` environment variable (`extension/accordion.ts:902-911`,
`logCompletion`). The planner declines a fold silently on about ten paths
(`taskfold.ts:749`, `unit()` from line 939: `deep`, protected tail, prefill guard, message still classified or
routing, record over the cap, a visible handle not covered, `keepRecentTasks`); only saturation
sets a status. `ZOMBIE_STEPS = 40` (`taskfold.ts:119`) is used for stale spans only.

Change:

- `debug: false` in `~/.accordion/config.json`, sanitized like the other settings and listed on the
  Settings tab. `/accordion debug on|off` sets the session value and records a session entry
  (`accordion.debug`), restored on resume.
- When on, append JSONL to `~/.accordion/debug/<sessionId>.jsonl` (under `ACCORDION_HOME` when
  set), buffered and flushed asynchronously:

  | Record | Fields |
  |---|---|
  | `request` | time, model, estimate, real input, cache read, cache write, calibration `k`, live and full tokens, timing mode |
  | `epoch` | planned units; for every finished task not folded, the declining path |
  | `fold` | task key, carrier tokens, tokens removed, first changed block, blocks behind the end |
  | `complete` | conductor, model, purpose, tokens, `stopReason`, the reply (first 2,000 characters), error |
  | `tasks` | rejected calls with error code and message |
  | `truth` | rebuilds and resyncs |

- The conductor reports through a new optional host method (for example `host.debug(record)`) that
  is a no-op when debug is off; the planner returns a reason for every declined span instead of
  `null`. Extend `core/conductor/contract.ts` additively and keep the remote SDK compiling.
- The file holds session content: local only, mode 0600, 50 MB per session, oldest half dropped at
  the cap.
- `/accordion debug bundle [file]` writes the log, the `dump-transcript` tree
  (`extension/tui/transcriptDump.ts`) and the settings with the token redacted into one archive.
- `ACCORDION_COMPLETION_LOG` and `logCompletion` are removed; the `complete` record replaces them.
  Search README files and `docs/` for the variable and update them.
- A task that stays raw for more than `ZOMBIE_STEPS` steps after finishing sets a warning status
  naming the task and the declining path.

Tests: a planner test per declining path asserting the reason; the log writer's cap; the settings
sanitizer; a smoke assertion that the `context` hook performs no synchronous write with debug on.

Done: with debug on, a live session's log explains every finished task that is still raw; SPEC §12
lists `debug`, a new SPEC subsection describes the log; root `AGENTS.md`, `extension/README.md`
and `conductors/in-process/taskfold/README.md` mention it.

## S2: row accounting and routing fixes

Current:

- A task row can show `→ 0`: `extension/tui/taskWidget.ts` (`foldedTaskTokens`, lines 240–257) sums the
  handle's members, but a group's summary is charged to the group's first block, which message
  snapping can put before the handle (`extension/tui/taskTranscript.ts:123`, `taskFoldRefs`).
- `parseExtraction` (`extension/taskRouting.ts:119-131`) accepts only bare or fully fenced JSON.
- The host's `complete()` (`extension/accordion.ts`, about 940–1030) returns text, model and token
  counts but no `stopReason`, so a truncated reply looks like a parse failure. `routeOne`
  (`taskfold.ts:634-657`) does not retry.
- With no `models` configured, extraction runs on the session's main model
  (`resolveChatModel`, `extension/accordion.ts:923-932`); the registry declares only a classifier
  default for Taskfold (`core/conductor/registry.ts:191`).

Change:

1. A task that owns a group's summary is charged the whole group (`groupFullTokens` /
   `groupLiveTokens`). Regression test: a `start` call that follows a thinking block in the same
   message. The per-node sums of `transcriptDump.ts` must still add up to the wire.
2. `parseExtraction` takes the first balanced JSON object in the reply.
3. `CompletionResult` gains `stopReason`; the conductor reports truncation and provider errors as
   such; one retry on a parse failure.
4. Taskfold declares a default chat model for extraction in the registry (`defaultModels.chat`):
   `openai/gpt-6-luna`, else `openai-codex/gpt-6-luna` (user decision, 2026-11-11). The entry is
   an ordered list: the first spec the host's model registry can resolve is used; when none
   resolves, extraction falls back to today's behaviour (the session model) and sets a warning
   status once. `defaultModels` holds one string per type today (`core/conductor/registry.ts`,
   `resolveModelSpec` in `extension/settings.ts`), so the type and its resolution change. A
   `models` entry in `~/.accordion/config.json` still wins. Extraction sends session content to
   that model, so the `privacy` declaration and the consent notice must name chat models too.

Tests: `extension/taskRouting.test.ts` (prose around JSON, truncated reply, retry),
`extension/tui/*.test.ts` (row tokens), `conductors/in-process/taskfold/taskfold.test.ts`.

Done: no `→ 0` row on a folded task in a live session; SPEC §4.6 and §10.2 updated.

## S3: report limits, tool description, record cap unit

Current: `extension/tasks.ts:118-122` (`TITLE_MAX 200`, `OUTCOME_MAX 600`, `ITEM_MAX 240`,
`ITEMS_MAX 8`), `extension/taskSchema.ts:25-26` (`CRITERIA_MAX 8`, `CRITERION_MAX 120`).
`cleanReport` (`tasks.ts:161-179`) throws on the first violation. The tool description says "one
or two sentences" and names no number (`extension/accordion.ts:4041`); the schema has no
`maxLength`. `HISTORY_OUTCOME_CHARS = 160` (`conductors/in-process/taskfold/records.ts:46`).
`recordTokens` is compared through `host.countTokens` (`taskfold.ts:1060-1061`), which is
calibrated (`core/conductor/liveHost.ts:225`); the multiplier absorbs tool-schema overhead, so the
cap tightens as the wire shrinks, and a task whose own report exceeds it stays raw.

Change:

| Field | Today | New |
|---|---|---|
| `report.outcome` | 600 | 2,000 |
| `report.decisions[]`, `report.open[]` item | 240 | 1,000 |
| items per list | 8 | 12 |
| `acceptanceCriteria[]` item | 120 | 300 |
| task title | 200 | 200 |

- The tool description and the JSON schema state each limit as a number (`maxLength`, `maxItems`).
- A rejected call lists every violation with its length and the limit.
- Root history entries carry the whole outcome (decision 1).
- `recordTokens` applies to a record's children only: over the cap, the deepest children become
  history entries. A task's own report never keeps it raw. The cap is measured on the raw estimate
  (`core/tokens.ts`), not in calibrated tokens.
- The limits are part of the authoring format: update
  `extension/skills/accordion-task-lists/references/tasks.schema.json`, `references/schema.md`,
  `references/context.md` and `scripts/validate.mjs` expectations (root `AGENTS.md`).

Tests: `extension/tasks.test.ts` (all violations in one error, new limits),
`extension/taskSchema.test.ts`, `taskfold.test.ts` (a 2,000-character outcome folds; history
carries it whole).

Done: SPEC §2.1, §3.4, §6.2, §6.3 updated.

## S4: timing modes, cache profile, 20-block rule removed

Change:

- `taskfold.timing`: `"eager" | "lazy" | "pressure"`, default `eager`.

  | Mode | A finished task folds |
  |---|---|
  | `eager` | at the first request that can carry its record, whatever its length |
  | `lazy` | when the rewrite is free or forced: the cache is cold or expired, or pressure reaches `high` |
  | `pressure` | only when pressure reaches `high` |

- `CACHE_LOOKBACK` and `deep()` are removed from every mode.
- Resolution follows budget and protect in `extension/dials.ts`: session value → `modelDefaults`
  entry (`provider/model`, `provider/*`, `*`) → `taskfold.timing`. `DialKind` is numeric today;
  extend the record format without breaking stored `accordion.dials` entries.
- `/accordion fold <eager|lazy|pressure>` sets the session value and records an `accordion.dials`
  entry. The footer (`extension/tui/status.ts`) shows the mode after the conductor name. The
  Settings tab edits the global value.
- A mode change applies from the next epoch and never unfolds anything.
- Provider cache profile: one table in `core/`, keyed like `modelDefaults`: family (`anthropic`,
  `openai-breakpoint`, `prefix`), TTL, read and write weight. Used for the expiry test in `lazy`
  (the last request is older than the TTL) and the cost figures in the debug log. The TTL comes
  from pig's cache-retention setting where the host exposes it, else from the table. An unknown
  provider is `prefix` with a 5-minute TTL.
- `.project/analyses/fold-representations/README.md` §8: replace the lookback conclusion with the
  finding above ("Why eager folding does not run today"), new revision.

Tests: one `taskfold.test.ts` case per mode with a finished 60-block task (eager folds at the next
step, lazy after the TTL or at `high`, pressure only at `high`); `extension/dials.test.ts` for the
resolution order; `extension/smoke-context.mjs` still shows byte-identical prefixes before a fold.

Done: SPEC §8 (the lookback bullet replaced by the modes) and §12 updated; README files name the
setting and the command; a live session's debug log shows a `fold` record within two requests of
each task completion.

## S5: bracket tail

SPEC §6.2 specifies `taskfold.leafForm = "bracket"`; no code implements it.

Change: the carrier replaces the span up to, not including, its closing `tasks` call. The closing
call and its result stay verbatim.

- The wire then ends on a tool result, so the fold lands at the first request after completion and
  the entry written by the request before the task started is still valid.
- The report stays on the wire word for word in the closing call. The record omits `outcome`,
  `decisions` and `open` while the closing call is visible, so nothing is sent twice.
- A closing call batched with the next task's start already stays in that message.
- When the parent folds, the children's closing calls go into the parent's span and the child
  records carry their reports again.

Decide at the start of the slice whether bracket becomes the default form or stays behind
`leafForm`; the simulation favours it, the SPEC default is `record`.

Then run two live sessions with debug on (one per form) and re-run `evidence/timing_sim.py` against
them. Store the outputs in `evidence/`.

Done: SPEC §6.2 and §8 describe the implemented form; the measurement is in `evidence/` and its
result decides S6.

## S6: frontier breakpoint (Anthropic only)

Only if S5's logs still show cache misses at folds. Through `before_provider_request`, add a
breakpoint on the last block before the innermost open task's start. With an OAuth token it
replaces the breakpoint on the identity system block, which the system prompt's breakpoint already
covers. Verify live first that moving a marker alone does not change the prefix hash. If S5 makes
it unnecessary, record that here and close the plan.

## Done

All slices merged (or S6 closed as unnecessary), SPEC-0002 matches the code, and a live eager
session's debug log shows no finished task raw for more than `ZOMBIE_STEPS` steps without a stated
reason. Then delete this plan and its evidence with trailers.
