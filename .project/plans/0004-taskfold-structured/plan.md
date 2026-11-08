---
document:
  type: "plan"
  id: "PLAN-0004"
  title: "Structured Taskfold: nested events, adoption, delivered-once results, eager JSON folds"
  description: "Slices, progress and acceptance for implementing SPEC-0002 r18 on branch feat/taskfold-structured, ordered so overflowed legacy sessions can continue first."
  status: "published"
  revision: 3
  created_at: "2026-11-08T13:16:40+01:00"
  updated_at: "2026-11-08T14:58:07+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 3
      reason: "slices 3 to 7 delivered"
      changes: ["progress: JSON results, list v3, eager records and anchors done; notices and routing next"]
---

# Structured Taskfold: plan

Design: `.project/specs/0002-taskfold-tree.md` r18 ("spec"). Evidence:
`.project/analyses/fold-representations/README.md` (§2–5). Branch `feat/taskfold-structured`,
worktree `.pi/worktrees/taskfold-structured`, merged into `feat/pi-native`.

## Rules

- Read the spec section before a slice; if code forces a different design, revise the spec in the
  same commit.
- Gates per slice: `bun test extension/settings.test.ts extension/tui/*.test.ts extension/*.test.ts`,
  `npx vitest run conductors core` (from `app/`: `npm --prefix app test`), `npm --prefix extension run smoke`,
  `npm --prefix app run check`.
- Never read or write private session files except read-only replays; evidence is aggregate and
  redacted.
- Agent-facing strings live in the `tasks` registration or `extension/taskBinding.ts`.

## Progress

| # | Slice | Spec | Status |
|---|---|---|---|
| 1 | Nested task events: queue by outer call, outer `details.taskEvents`, ingest, scan; stale spans | §5.3 | done (3c5d0fb, 5dc3483, ba25f91) |
| 2 | Legacy adoption from `nestedCalls` and prose; `/accordion tasks adopt [--dry-run]`; `tasks.adopt` | §14 | done (00ba073, 38fea61); replay 01a1b680: 1.09M → 138k |
| 3 | Remove the working set and request injection | §4.5 | done (interim: start/claim append the prose context until slice 4) |
| 4 | Structured JSON results for every action; delivery manifests and liveness; claim/resume delivery | §3, §4.3 | done |
| 5 | List file v3: `goals[]`, `{id,text}` criteria, item ids, `ItemEdit`; skill and schema | §2 | done (abd8560) |
| 6 | Eager lifecycle, JSON records on assistant carriers, one code per task, root history | §6, §8, §9 | done |
| 7 | Content anchors (section, symbol, quote) and delivery-time states | §4.2 | done (taskAnchors.ts, taskSymbols.ts, 75e6be0, 603deb1) |
| 8 | Notices and user-message routing (classify, extract, apply, notify) | §4.4, §4.6 | now |
| 9 | Views, dump, settings, docs; replay `01a1b680`, comprehension eval on real rendering, live run | §10, §12, §13 | now: views, docs, replay, comprehension and live session done (README §6–§7); final gates and merge left |

Slices 1–2 let the overflowed session continue under the current record format. Slice 3 removes
the dominant cache cost (107M rebilled tokens in `01a1b680`). Slices 4–8 deliver the new
mechanism; slice 9 closes it.

## Slice 1: nested task events

Current: `scanTaskSpans` (`conductors/in-process/taskfold/taskfold.ts`) reads only `tool_call`
blocks named `tasks`; `linearize` (`core/wire.ts`) copies `details` only for `tasks` results. A
`tasks` call made through `ctx.executeTool()` (codemode) leaves no block, so its span never closes.

Change:
1. `TaskEvent` type (`extension/tasks.ts`): `{action, list, id, started?, finished?, closed?,
   cascaded?, report?, title?}`. The `tasks` tool's `details` gains `taskEvents: [event]` for a
   direct call.
2. `extension/accordion.ts`: the `tasks` handler receives `toolCallId`; a nested id
   (`<outer>/<n>`, also `parentToolCallId` in `tool_result`) queues the event under the outer id.
   The `tool_result` hook of the outer call returns `details: {...details, taskEvents}` (merged
   after any existing ones) and clears the queue entry.
3. `core/wire.ts`: keep `details` on any tool result whose `details.taskEvents` is an array.
4. `scanTaskSpans`: build events per tool result. For a `tasks` result: from `taskEvents` if
   present, else the existing call-args + prose path. For any other result: its `taskEvents`, with
   `start` anchored at the outer `tool_call` and finishes at the outer result. Events of one result
   apply in order. Adopted events (slice 2) feed the same path.
5. Stale span: `TaskSpan.stale` when open with no event of its own or a descendant for
   `taskfold.zombieSteps` (default 40) tool results while other spans started/finished. Reported in
   the conductor status; no fold.

Tests (`taskfold.test.ts`): codemode-style outer call with `complete A`,`start B` events folds A
and keeps B open; nested start opens at the outer call; direct results without `taskEvents` keep
working; stale detection. Extension test: nested `tasks` call puts its event on the outer result
(hook unit test with a fake `tool_result` sequence).

Done: tests pass; replay of `01a1b680` with the slice-2 adopter or synthetic events closes span
`3.11.1.3.3.2`.

## Slice 2: adoption

Derive events for legacy sessions from each outer result's `nestedCalls` (pi ≥1.5) plus the list
file, write one `accordion.taskfold.adopted` entry `{version, branchFingerprint, events:
{[blockId]: TaskEvent[]}, projected: {before, after}}`, and feed it into the scan. Detection on
`session_start`, `tasks.adopt` = `auto|ask|off`, `/accordion tasks adopt [--dry-run]`. Tests: a
synthetic legacy session with codemode batches yields the same spans as the native one;
idempotent; dry run writes nothing; incomplete record falls back to list status. Done: the replay
of `01a1b680` adopts and folds below its 272k budget.

## Slice 6: eager JSON records and root history

Current (`conductors/in-process/taskfold/taskfold.ts`): `record()` renders a `[task-record]` text
block; `ageRecord`/`condenseChildren`/`ladder` shrink old records in three levels; `evaluate()` returns
unless live tokens ≥ `high·budget`; `plan()` stops folding at `low·budget` and keeps
`keepRecentTasks` (default 1) raw; `taskKeyOfSummary` and `taskTranscript.recordLevel` parse the text.
A carrier's wire role is the role of its run's first message.

Change, in order (each its own commit with tests on a real `Truth`):
1. **JSON carrier.** `record()` returns an object; the carrier text is `{#<foldCode("t:<key>")> FOLDED} <one-line JSON>`
   with the key order of §6.2. Children are nested objects with `recall` in place of the tag. A prior child
   summary is reused verbatim (parsed, re-keyed), so an unchanged child never changes bytes. When the root
   handle is not covered the group's own tag is used. `taskKeyOfSummary` parses `task`/`history`/`part`/`untracked`;
   `taskTranscript.recordLevel` and the dump follow. `applyPlan` gives a Taskfold group carrier the role
   `assistant` (new optional `Group.role`, conductor groups only; rides the existing group spread, no protocol bump).
2. **Eager epoch.** `evaluate()` always plans records; `plan()` folds every finished unit regardless of
   `low·budget`; `keepRecentTasks` default 0. A unit whose end still lies in the protected tail is
   deferred, not folded partially, unless pressure ≥ `high` (then partial runs as today). Steps 2–6 of §9
   stay behind the pressure check.
3. **History.** A finished root compiles to `{"history":…}` (§6.3) with direct child codes and a truthful
   `subtasks` count; under pressure ≥ `high` finished subtrees of an open root become history oldest
   first. Delete `ageRecord`, `condenseChildren`, `ladder`, `taskfold.aging` (settings, defaults, docs).
4. **Tests/gates.** Exact carrier JSON; assistant role even when the run starts at a tool result; eager
   timing; a second request starts with every earlier byte; recall/unfold of root and child codes;
   history `status` shows a failed descendant; settings sanitize without `aging`.

Done when the replay of `01a1b680` and the synthetic fixtures fold at the next eligible request and the
gates in "Rules" pass.

## Slice 8: notices and user-message routing

Current: `TaskfoldConductor.classifyNew` runs one classifier call per user block (`USER_QUESTIONS`) and
stores a `Verdict` (`loss`) through `VerdictLedger` (session entry `accordion.taskfold.verdict`); a
message folds only when `loss < maxLoss`, so a high-loss message ends a run (`foreign()`/`makeRuns()`
in `taskfold.ts`). `TaskSession` queues prose notices delivered by `before_agent_start`
(`accordion.ts`, `NOTICE_MESSAGE`). `core/wire.ts` `linearize` drops `custom` messages, so notices are
no Truth blocks.

Design decisions (spec §4.4, §4.6 amended in the same commits):
- **Port, not import.** The conductor cannot reach the store. The extension sets a process-wide
  `taskfoldRouting` port (like `taskfoldVerdicts`): `snapshot()` returns the attached list and `doing`
  branch with item ids, `apply(ops, said)` validates and writes through the store with
  `source: "user"` and returns the applied item ids. Null while no list is attached.
- **Extractor model = the conductor's chat model** (`host.complete`, `models.conductors.taskfold.chat`),
  not a new model type. Privacy consent already covers Taskfold.
- **Routed = a recorded extraction.** `Verdict.routed = {ids, at}` rides the existing verdict entry.
  `folds(b)` = `routed` or classifier `loss < maxLoss`. Extraction failure or timeout leaves today's rule.
  Skipped for harness and opening messages and when no list is attached.
- **Extractor output uses item ids** (`{op,kind,target,id?,value?,pinKind?}`), so `-`/`~` never match by text.

Order, each its own commit with tests on a real store/`Truth`:
1. **Ops** `extension/taskRouting.ts` (pure): parse and validate extractor JSON; drop an operation that
   fails the store's rules (started tasks stay frozen, caps, unknown id); a pin must occur verbatim in the
   message; apply through the store; return `{applied, dropped}`.
2. **Extractor** in the conductor after classification: context-aware prompt (list, `doing` branch, agent's
   last turn, message), strict JSON, one retry-free call with a deadline; record `routed`; never blocks the
   request path.
3. **Folding and links**: routed messages join runs; records get `"user":[{"said","ids"}]`.
4. **Notices**: one queue in the extension; kinds `changed`, `restored`, `waiting` as JSON; delivered with the
   next prompt (`before_agent_start`) or `pi.sendMessage(..., {deliverAs: "steer"})` while a turn runs; each
   persisted once, never moved. Routing posts `changed` with `by: "user-message"`. If `linearize` can carry
   notices as grouped blocks safely, they count as delivery; otherwise they stay blockless and `restored`
   is dropped from this slice.
5. **Gates and live check**: exact-JSON tests, extraction-failure raw path, replay of the eval corpus
   through the real port (`harness/routing.py` against the implementation), `deepseek/deepseek-flash` live run.

Done when a user correction inside a span lands in the list, the message folds with its span, the agent sees
one notice, and a failed extraction keeps the message raw.

## Later slices

- 3: delete `workingSet`/`placeWorkingSet`/`workingSetTarget`, the `context_with_system` suffix and
  the dump's working-set path; smoke: consecutive requests are byte prefixes.
- 4: `runTasksTracked` returns a typed result object; the tool returns `JSON.stringify(result)`;
  `details.delivered` manifests; liveness from unfolded Truth blocks via a callback the extension
  provides. Exact-JSON test per action.
- 5: `taskSchema.ts` v3 + migration of v1/v2 with backup, store `ItemEdit`, skill examples, schema.
- 7: anchor resolution module `extension/taskAnchors.ts` (Markdown sections, tree-sitter symbols,
  W3C quote).
- 9: views/dump/README/SPEC-0001; evaluations listed in spec §13.
