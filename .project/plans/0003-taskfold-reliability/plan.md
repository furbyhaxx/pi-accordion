---
document:
  type: "plan"
  id: "PLAN-0003"
  title: "Taskfold reliability repair"
  description: "Resolve the approved session audit: unlimited nesting, safe persistence, folding fallback, faithful projection and complete task inspection."
  status: "published"
  revision: 4
  created_at: "2026-11-07T08:16:00+01:00"
  updated_at: "2026-11-07T09:08:44+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 4
      reason: "close task inspection and native wiring repairs"
      changes: ["goals and scoped metadata", "human and agent composed recovery", "off-render snapshots and session isolation smoke"]
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
- done: complete task inspection and composed-handle recovery, with cached I/O outside render.
- now: full gates, read-only historical replay, real Pi-Bolt terminal evaluation and final review.

## Current slice: full verification and live evaluation

The approved implementation slices are complete. Focused tests cover unlimited nesting, safe writes,
planner fallback, aging, exact carriers, metadata, YAML and native recovery. The native context smoke
also verifies zero task-file scans during rendering, update refresh and stale-session refusal.

Remaining work:
1. Run all project gates and a clean production/package asset verification; address in-scope failures.
2. Replay the private historical inputs without modifying them. Measure actual coverage, recovery,
   carrier uniqueness, additive totals and runtime cost; retain only redacted aggregate evidence.
3. Exercise the isolated Pi-Bolt UI at 36/57/80/140 columns and short height, including metadata,
   composed-child recovery, diagnostics, pause state, session switching and export.
4. Review and commit the complete change with precise remaining limitations, if any.

## Verification

- Extend adjacent behavioral tests; observe regressions fail before fixes.
- `bun test extension/*.test.ts extension/tui/*.test.ts conductors/in-process/taskfold/*.test.ts` plus touched core suites.
- `npm --prefix extension run smoke`, `npm --prefix app run check`, `npm --prefix app test`, package dry run as applicable.
- Private historical replay: measure stranded completed work, group/handle recovery, carrier uniqueness and projection totals; keep private text outside committed evidence.
- Real isolated Pi-Bolt terminal: 36/57/80/140 columns and short height, exercising task metadata, nested recovery, diagnostics and dump command. Capture redacted evidence here.
- Review full diff, document unavailable checks precisely, commit explicit intended paths only. No push or PR without authorization.
