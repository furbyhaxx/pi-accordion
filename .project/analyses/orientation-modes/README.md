---
document:
  type: "analysis"
  id: "ANA-orientation-modes"
  title: "Orientation modes: folding the work before the first task"
  description: "Experiment comparing how Taskfold handles the orientation phase (raw, typed fold, agent-tracked), measured by replay probes on real sessions and live runs."
  status: "draft"
  revision: 1
  created_at: "2026-11-05T15:32:28+01:00"
  updated_at: "2026-11-05T15:32:28+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["tier-1 replay results on six real sessions"]
---

# Orientation modes

Branch `exp/orientation-modes`. The orientation phase is everything before the first `tasks start`:
the user's request plus all reading and exploration. In real sessions it is 45–143k tokens, often
most of the context, and Taskfold never folded it.

## Arms

Settings under `conductorOptions.taskfold.orientation` in `~/.accordion/config.json`:

| Arm | `fold` | `agentTask` | `rules` | Meaning |
|---|---|---|---|---|
| A | `off` | `false` | – | status quo: orientation stays raw |
| C | `typed` | `false` | `live` | fold to brief + source index; rule files (SKILL.md, AGENTS.md, …) copied verbatim into the record |
| C-rules-fold | `typed` | `false` | `fold` | as C, rule files become index lines |
| C+brief | as C | | | C with the agent's `brief` present (simulated in replay) |
| D | any | `true` | | the agent tracks orientation as its own first task; live runs only |

Promotion criterion (agreed): at least 20% fewer context tokens than A, no more constraint violations
or failed tasks, retention within 5 points of A.

## Tier 1: replay probes

`harness/tier1.ts`. For each session: 12 fact probes (goal, constraints, paths, values, decisions)
extracted once from the raw orientation; the session is cut after its 1st and 4th finished task;
each arm's outgoing context is rebuilt with the real Taskfold (`serializeWire`) at budget = 50% of
the full size; deepseek-flash answers the probes from that context only ("unknown" when absent),
and a second call grades the answers. In C+brief, a brief generated from the orientation (same
model, without the probes) is injected into the session's `tasks create` call. Total cost $0.89.

Averages over 9 cut points on 6 sessions (one early cut folds nothing in any arm and scores 100 everywhere):

| Arm | retention % | sent / full | wrong answers | goal | constraint | path | value | decision |
|---|---|---|---|---|---|---|---|---|
| A | **98** | 89% | 1 | 100 | 100 | 91 | 100 | 100 |
| C | 70 | **52%** | 2 | 92 | 63 | 82 | 45 | 72 |
| C-rules-fold | 65 | 49% | 2 | 92 | 54 | 78 | 45 | 61 |
| C+brief | 78 | 52% | 2 | 97 | 73 | 82 | 63 | 78 |

Per-row results: `evidence/tier1/results-2026-11-05-14-31.md`; probes, briefs, every request and
grade: `evidence/tier1/<session>/`.

### Findings

1. **Typed folding saves about 40% of the context but loses about 20–30 points of recall-free
   retention.** No C arm meets the promotion criterion in replay.
2. **What gets lost is evidence, not instructions.** User messages stay in place. The losses are
   values, constraints and plan facts that lived in tool output: config defaults, constants,
   handoff operating rules, task order. The source index names the file but not the fact.
3. **The brief recovers a third of the loss** (70 → 78), mostly values and constraints. It cannot
   carry everything a 50–140k orientation held in 350 words.
4. **Keeping rule files verbatim is worth about 5 points** (65 → 70) for 3% more context.
5. **The cache breaks at the head** (first changed block 1) in every C arm. A breaks later or never.
   Orientation folds once per session, so this is one cache miss, not a recurring cost.

### Limitations

- **Replay is the worst case for C**: the model cannot `recall` the folded record, which a live agent
  can. Tier 2 measures whether agents recall what they need and whether task success suffers.
- The brief is simulated by the same model that answers; a working agent may write a better or worse one.
- One session (`a944…`) drove `tasks` from inside `codemode`. Taskfold sees only direct `tasks` calls,
  so there the brief cannot be attached and spans are found only through direct calls. Nested calls
  (`parentToolCallId`) are not yet supported.
- 6 sessions, 12 probes each, one grader model: differences under about 10 points are noise.

### Fixes made along the way

- Orientation partly inside the protected tail never folded; it now folds up to the tail
  (`taskfold.ts`, orientation branch of `plan`).
- Rule results kept in place pinned their whole parallel tool batch, so nothing folded. Rule files
  are now copied verbatim into the record instead.

## Tier 2: live runs

Pending: fixture repos with planted constraints, headless PiG, deepseek-flash, N=5 per arm and fixture.
