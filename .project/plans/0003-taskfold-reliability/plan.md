---
document:
  type: "plan"
  id: "PLAN-0003"
  title: "Taskfold reliability repair"
  description: "Resolve the approved session audit: unlimited nesting, safe persistence, folding fallback, faithful projection and complete task inspection."
  status: "published"
  revision: 3
  created_at: "2026-11-07T08:16:00+01:00"
  updated_at: "2026-11-07T08:45:29+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 3
      reason: "close conductor and projection repairs"
      changes: ["safe descendant fallback and named aging", "interval-aware transcript", "exact carrier export with metadata, suffix and valid YAML"]
---

# Taskfold reliability repair

Branch `fix/taskfold-reliability`, worktree `.pi/worktrees/taskfold-reliability`, based on `origin/feat/pi-native` at `e6e87a2`. User approved the audit findings and requires no task nesting depth limit.

## Scope and invariants

- No flattening or renumbering started tasks. Preserve legacy identities, reports, pins and attachments.
- Do not edit the original nukular-ai list, session or projection dump. Replay private inputs locally only; commit synthetic fixtures and redacted aggregate evidence, never the private transcript.
- Preserve Truth authority, controller lease/session isolation, no context-hook I/O, reversible folds and exact pins.
- No external publication or changes to live user configuration.

## Progress

- done: remove depth caps; 64-level authored and 32-level mutation/migration regressions pass.
- done: validate writes before replacement; invalid-list browser/widget warnings, cached outside render.
- done: safe descendant fallback and named child recovery through aging.
- done: metadata/interval-aware transcript; exact-once carrier export, lossless YAML and explicit working set.
- now: complete task inspection and composed-handle recovery, with cached I/O outside render.
- later: full gates, read-only historical replay, real Pi-Bolt terminal evaluation and final review.

## Current slice: complete task inspection

The core and shared model now retain precise metadata, intervals and recovery handles; dump formats consume authoritative carriers. Native task details still need goal/criteria/pins/attachments, composed-child steering must resolve core handles, and the list/transcript cache must refresh off render paths. Extend behavioral tests and then evaluate the complete flow in an isolated terminal.

## Remaining slices

1. `conductors/in-process/taskfold/taskfold.ts`: if a parent cannot compile, attempt independently safe finished descendants. Preserve useful child identity/handle associations through aging, exact scoped pins and existing cache rules.
2. `extension/tui/taskTranscript.ts`: retain structured details and handles; attribute blocks to actual task intervals, not their enclosing continuous envelope.
3. `extension/tui/transcriptDump.ts`: construct one ordered representation of actual wire groups/substitutions, emit each carrier once, never print substituted raw tool results, and account additively. YAML must parse and preserve arbitrary indentation/newlines. Expose working-set content and task metadata explicitly.
4. `extension/tui/taskViews.ts` and wiring: show list/task goal, criteria, pins and attachments; recover composed children through core handles and the controller lease; cache list/transcript data on reload/change, not render.

## Verification

- Extend adjacent behavioral tests; observe regressions fail before fixes.
- `bun test extension/*.test.ts extension/tui/*.test.ts conductors/in-process/taskfold/*.test.ts` plus touched core suites.
- `npm --prefix extension run smoke`, `npm --prefix app run check`, `npm --prefix app test`, package dry run as applicable.
- Private historical replay: measure stranded completed work, group/handle recovery, carrier uniqueness and projection totals; keep private text outside committed evidence.
- Real isolated Pi-Bolt terminal: 36/57/80/140 columns and short height, exercising task metadata, nested recovery, diagnostics and dump command. Capture redacted evidence here.
- Review full diff, document unavailable checks precisely, commit explicit intended paths only. No push or PR without authorization.
