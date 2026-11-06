---
document:
  type: "plan"
  id: "PLAN-0002"
  title: "Taskfold tree implementation"
  description: "Slices, progress and acceptance for implementing SPEC-0002 on branch feat/taskfold-tree."
  status: "published"
  revision: 5
  created_at: "2026-11-06T14:44:51+01:00"
  updated_at: "2026-11-06T20:05:27+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 5
      reason: "record floor and attachment measurements"
      changes: ["mark the comparison complete and retain the floor as opt-in"]
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
| 3 | Structured details on blocks, interval planning, composed records, untracked records | §5, §6, §7.1–7.2, §9.3 | done |
| 4 | Cross-group handles in core, recall/unfold of child codes | §7.3 | done; integrated with selective unfold in slice 3 |
| 5 | Aging by task age, cache rule, keep-recent by finish order and waiver, `taskfold.*` settings | §8, §9.1, §12 | done |
| 6 | Task widget title, fold column, breakdown, split hidden rows, legend | §10 | done; folded groups checked live at four widths |
| 7 | Tool texts: review gate, stop rule, resume note | §3.4 | done |
| 8 | Skill `accordion-task-lists` and its eval | §11 | skill done; isolated comparison awaits user decision |
| 9 | Floor (same transaction), measurement, default decision | §9.2, §13 | done; measured floor remains opt-in, inline attachments remain default |

## Slice 1: list file v2 and store actions

Delivered: list files use nested v2 trees with a goal; the store indexes tasks by dotted id and
validates files on read. `TaskCoach` tracks work for empty-span refusal.

Components:
1. `extension/taskSchema.ts`: v2 validation, v1 migration, `parseListFile` and `toListFile`. The
   store keeps a flat in-memory `Task[]` index; reads validate and writes serialize the tree.
2. `extension/skills/accordion-task-lists/references/tasks.schema.json` plus schema/validator tests.
3. `goal` required on `create`. `update` action. `start`/`add`/`move` are refused without a goal.
4. `add {before|after}`, `move`. Only `todo` subtrees move; renumbering with reference rewrite;
   `details.renumbered`.
5. Empty-span refusal: `TaskCoach` exposes `spanWork(key)` counting tool results and assistant
   text blocks over 40 chars. The `tasks` handler refuses `complete`/`fail` when the count is 0 and
   known. Cherry-pick `f04f39d`.
6. Tool description and parameters: `goal`, `acceptanceCriteria`, `before`, `after`, `update`,
   `move`.
7. Views that read `Task[]` keep working: widget, tree, lists browser, transcript dump.

Pins, attachments and taskfold changes are covered by later slices.

Tests (`extension/tasks.test.ts`, `extension/taskSchema.test.ts`):
- v1 file → v2 round trip
- invalid file errors (bad id, missing goal, depth 5, criteria too long)
- move/insert renumbering and reference rewrite
- refusal of moving or inserting before a started task
- empty-span refusal and its exemption for tasks started before the process

The gates passed, SPEC-0001 §4.10/§4.15 record the new actions, and a v1 list loads and is
rewritten as v2 on its next write.

## Slice 2: pins, attachments, working set

Store validated pins and attachments in the list file. Add `pin`/`unpin`/`attach`/`detach` and
`tasks.*` settings. Build and refresh the working set outside the context hook; the hook reads the
session-local cache.

Tests:
- quote check against a user message and a file
- caps
- hash change marks `changed since attached`
- working set contents for nested doing tasks
- not persisted (smoke: `node extension/smoke-context.mjs`)

## Remaining verification

- The corrected floor and attachment comparisons used frozen revisions and an isolated fixture runner.
  Results and limitations are in `evidence/floor-comparison/README.md`; every attachment run started
  the seeded task. The earlier wrong-config attempt is excluded.
- The initial skill baseline accessed repository files outside its synthetic fixture and sent tool
  results to the provider. It also found the skill, contaminating the comparison. Do not use those
  results; an isolated rerun requires the user's decision.
- Rerun the final project and install checks after recording the decisions. Product whitespace
  checks pass; copied branch artifacts retain their original whitespace.

When everything is merged: delete this plan with trailers (`Artifact-Deleted: PLAN-0002`).
