---
document:
  type: "plan"
  id: "PLAN-0002"
  title: "Taskfold tree implementation"
  description: "Slices, progress and acceptance for implementing SPEC-0002 on branch feat/taskfold-tree."
  status: "published"
  revision: 2
  created_at: "2026-11-06T14:44:51+01:00"
  updated_at: "2026-11-06T17:42:36+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 2
      reason: "record current implementation progress"
      changes: ["update slice status after cross-group handles and interval composition"]
---

# Taskfold tree: plan

Design: `.project/specs/0002-taskfold-tree.md` (the "spec" below). Branch `feat/taskfold-tree`,
worktree `.pi/worktrees/taskfold-tree`, PR into `feat/pi-native`.

## Rules for every slice

- Read the spec section first. If the code forces a different design, update the spec in the same
  commit (new revision).
- One Conventional Commit series per slice. SPEC-0001 sections the slice changes are updated in
  the same commits.
- Gates before a slice is done:
  - `bun test extension/settings.test.ts extension/tui/*.test.ts`
  - `bun test` for the touched modules
  - `npm --prefix extension run smoke`
  - `npm --prefix app run check`
  - `npm --prefix app test`
- Agent-facing strings live in `extension/taskBinding.ts` or the `tasks` tool registration, never
  scattered.

## Progress

| # | Slice | Spec | Status |
|---|---|---|---|
| 1 | List file v2, validator, migration, `goal`, `update`/`add before\|after`/`move`, empty-span refusal, `f04f39d` | §2, §3.1–3.3 | done |
| 2 | Pins, attachments, working set, `tasks.*` settings | §4, §12 | done |
| 3 | Structured details on blocks, tree scan with intervals, compile/diff planner, composed records, untracked records | §5, §6, §7.1–7.2, §9.3 | in progress: interval folding and nested records implemented; planner and untracked work remain |
| 4 | Cross-group handles in core, recall/unfold of child codes | §7.3 | done; integrated with selective unfold in slice 3 |
| 5 | Aging by task age, cache rule, keep-recent by finish order and waiver, `taskfold.*` settings | §8, §9.1, §12 | next |
| 6 | Task widget title, fold column, breakdown, split hidden rows, legend | §10 | done; live folded group still needs checking |
| 7 | Tool texts: review gate, stop rule, resume note | §3.4 | done |
| 8 | Skill `accordion-task-lists` and its eval | §11 | implemented; isolated eval remains |
| 9 | Floor (same transaction), measurement, default decision | §9.2, §13 | later |

## Slice 1: list file v2 and store actions

Current: `extension/tasks.ts` stores `TaskList {slug,title,createdAt,updatedAt,claim,tasks: Task[]}`.
`tasks` is flat with dotted ids (`flatten`, `parentOf`). There is no goal and no validation on
read. `TaskCoach` (`extension/taskCoach.ts`) only notes empty spans after the fact.

Change:
1. `extension/taskSchema.ts`: v2 types (`TaskListV2`, `TaskNodeV2`), `validateList(raw) →
   {list} | {errors: string[]}`, `migrateV1`, `flattenTree`/`buildTree`. The store keeps its
   flat in-memory `Task[]` index, so most of `tasks.ts` is untouched. Reads go through the
   validator; writes serialize the tree.
2. `extension/tasks.schema.json` plus a test asserting that schema and validator agree on fixtures.
3. `goal` required on `create`. `update` action. `start`/`add`/`move` are refused without a goal.
4. `add {before|after}`, `move`. Only `todo` subtrees move; renumbering with reference rewrite;
   `details.renumbered`.
5. Empty-span refusal: `TaskCoach` exposes `spanWork(key)` counting tool results and assistant
   text blocks over 40 chars. The `tasks` handler refuses `complete`/`fail` when the count is 0 and
   known. Cherry-pick `f04f39d`.
6. Tool description and parameters: `goal`, `acceptanceCriteria`, `before`, `after`, `update`,
   `move`.
7. Views that read `Task[]` keep working: widget, tree, lists browser, transcript dump.

Not in this slice: pins, attachments, span scan changes, any taskfold change.

Tests (`extension/tasks.test.ts`, `extension/taskSchema.test.ts`):
- v1 file → v2 round trip
- invalid file errors (bad id, missing goal, depth 5, criteria too long)
- move/insert renumbering and reference rewrite
- refusal of moving or inserting before a started task
- empty-span refusal and its exemption for tasks started before the process

Done when the tests and gates pass, SPEC-0001 §4.10/§4.15 mention the new actions, and a v1 list
from `.pig/tasks/` of this repo loads and is rewritten as v2 on its next write.

## Slice 2: pins, attachments, working set

Port `extension/pins.ts` from `exp/orientation-modes` (validation, caps, file re-read), storing
into the list file. Add `pin`/`unpin`/`attach`/`detach`. Build the working set in the
`context_with_system` hook as the last text part of the last message. Add the `tasks.*` settings.

Tests:
- quote check against a user message and a file
- caps
- hash change marks `changed since attached`
- working set contents for nested doing tasks
- not persisted (smoke: `node extension/smoke-context.mjs`)

## Slices 3–9

Sparse until slice 2 lands. Key facts:
- **3:** verify first whether Pi persists tool-result `details` on reload. Keep the prose fallback.
  Delete the `ownGroups` cache.
- **4:** bump the protocol and snapshot versions; update `app/` replica types.
- **6:** real terminal checks at 36/57/80/140 columns.
- **9:** the measurement needs the tier-2 harness from `exp/orientation-modes`
  (`harness/make_fixtures.py`, `harness/tier2.py`), copied into this plan's `evidence/`; budget
  $4–6. Record results in this plan, then set the `taskfold.floor` default.

When everything is merged: delete this plan with trailers (`Artifact-Deleted: PLAN-0002`).
