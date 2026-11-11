---
document:
  type: "backlog-item"
  id: "B-0002"
  title: "CLAUDE.md states protocol v22 and seven conductors"
  description: "Upstream guidance file lags the fork's protocol version and conductor catalog"
  status: "open"
  revision: 1
  created_at: "2026-11-11T17:49:33+01:00"
  updated_at: "2026-11-11T17:49:33+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  kind: "drift"
  priority: "P3"
  scope: ["CLAUDE.md"]
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
---

# CLAUDE.md drift

Current: `CLAUDE.md` lines 38, 46, 74 and 132 say protocol v22; `core/protocol.ts` has
`PROTOCOL_VERSION = 23` (cross-group task handles). Line 164 lists seven shipped conductors and
the codebase map lists five in-process ones; `conductors/in-process/taskfold/` is the eighth.

Target: `CLAUDE.md` matches the code. It is upstream's file and `AGENTS.md` imports it, so every
edit is a merge-conflict surface with `upstream/devmain`; decide between editing it and stating
the fork's differences in `AGENTS.md`.
