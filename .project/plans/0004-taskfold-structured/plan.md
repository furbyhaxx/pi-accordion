---
document:
  type: "plan"
  id: "PLAN-0004"
  title: "Structured Taskfold: nested events, adoption, delivered-once results, eager JSON folds"
  description: "Slices, progress and acceptance for implementing SPEC-0002 r18 on branch feat/taskfold-structured, ordered so overflowed legacy sessions can continue first."
  status: "published"
  revision: 2
  created_at: "2026-11-08T13:16:40+01:00"
  updated_at: "2026-11-08T13:38:07+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 2
      reason: "slices 1 and 2 delivered"
      changes: ["progress: nested events and adoption done, slice 3 now"]
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
| 5 | List file v3: `goals[]`, `{id,text}` criteria, item ids, `ItemEdit`; skill and schema | §2 | later |
| 6 | Eager lifecycle, JSON records on assistant carriers, one code per task, root history | §6, §8, §9 | later |
| 7 | Content anchors (section, symbol, quote) and delivery-time states | §4.2 | later |
| 8 | Notices and user-message routing (classify, extract, apply, notify) | §4.4, §4.6 | later |
| 9 | Views, dump, settings, docs; replay `01a1b680`, comprehension eval on real rendering, live run | §10, §12, §13 | later |

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

## Later slices

- 3: delete `workingSet`/`placeWorkingSet`/`workingSetTarget`, the `context_with_system` suffix and
  the dump's working-set path; smoke: consecutive requests are byte prefixes.
- 4: `runTasksTracked` returns a typed result object; the tool returns `JSON.stringify(result)`;
  `details.delivered` manifests; liveness from unfolded Truth blocks via a callback the extension
  provides. Exact-JSON test per action.
- 5: `taskSchema.ts` v3 + migration of v1/v2 with backup, store `ItemEdit`, skill examples, schema.
- 6: records as `{#code FOLDED} {json}`, carriers forced to `assistant` in `applyPlan` for Taskfold
  groups, handle id `t:<list>/<id>`, root history, `taskKeyOfSummary` JSON parse, aging removed.
- 7: anchor resolution module `extension/taskAnchors.ts` (Markdown sections, tree-sitter symbols,
  W3C quote).
- 8: notices through `pi.sendMessage`/`before_agent_start`; extractor through `models` with
  privacy consent.
- 9: views/dump/README/SPEC-0001; evaluations listed in spec §13.
