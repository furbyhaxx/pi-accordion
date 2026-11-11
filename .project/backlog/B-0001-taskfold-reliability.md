---
document:
  type: "backlog-item"
  id: "B-0001"
  title: "Taskfold reliability: token truth, sequential order, enforcement, prompts"
  description: "Decided but unimplemented remainder of the Taskfold reliability proposal"
  status: "open"
  revision: 1
  created_at: "2026-11-11T17:49:33+01:00"
  updated_at: "2026-11-11T17:49:33+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  kind: "feature"
  priority: "P2"
  scope: ["extension/**", "conductors/in-process/taskfold/**"]
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
---

# Taskfold reliability remainder

Design and user decisions D1–D8: `.project/drafts/taskfold-reliability.md`. Needs a plan before work starts.

Current behavior (verified 2026-11-11 on `5192d7f`): none of these exist in `extension/`,
`conductors/` or `core/`:

- calibration bounds and priors (`calibration.minRatio`, `dedupeCacheWrite`), draft §3;
- in-order `start`, `delegated` block reason, stop-on-block, draft §5.4;
- bootstrap note, coach/gate with `tasks.orientationCalls` and fail-open, large-leaf reminder,
  stop follow-up, draft §5.2–5.6;
- consent gating only the classifier, tool-change notices, draft §5.8;
- prompt rewrite, `extension/audit-tasks.mjs` and the model eval, draft §6–7.

Why it matters: without token truth a provider that reports scaled units lets a session run over
budget; without order enforcement an agent that jumps between tasks produces overlapping,
unfoldable spans.
