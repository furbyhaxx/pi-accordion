---
document:
  type: "draft"
  id: "DRAFT-taskfold"
  title: "Taskfold: a task-boundary folding conductor"
  description: "Proposal for a standalone conductor that folds completed task spans into structured task records, with a shipped tasks tool, user-message classification and the spikes needed to settle open questions."
  status: "draft"
  revision: 1
  created_at: "2026-11-04T12:31:57+01:00"
  updated_at: "2026-11-04T12:31:57+01:00"
  created_by: "claude-agent"
  updated_by: "claude-agent"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation from .project/user-uploaded-assets/task-based-folding.md and the follow-up decisions"]
---

# Taskfold

Input: `.project/user-uploaded-assets/task-based-folding.md`. Undecided proposal; product code unchanged.

## Decisions taken

| # | Decision |
|---|---|
| D1 | Accordion ships the `tasks` tool. |
| D2 | The agent creates task lists. Lists have a slug, persist, and can be loaded in later sessions. |
| D3 | Fold summaries are agent-written (on `complete`), probably combined with deterministic heuristics. Evaluate. |
| D4 | Recall shape for folded parents: settle by spike and eval. |
| D5 | Protocol misuse (overlapping starts, forgotten completes): auto-resolve where safe, otherwise reject with guidance, nudge where needed. Spike. |
| D6 | New standalone conductor. |
| D7 | User messages are classified. Only new instructions or new tasks are kept verbatim; steering, extra info, acks and harness-injected text fold. |

## Model

```
list (slug, persistent)
  task            span = [start call .. complete result]
    subtask       nested span, folded first
```

- **Span**: from the `tasks start <id>` call through the `tasks complete <id>` result. Start/complete calls are inside the span, so the record replaces them too.
- **Fold timing**: budget-triggered batches with a low watermark, preferring to keep the last *n* completed tasks open. Never a rolling "fold the *n+1*-th on every completion": that re-bills *n* tasks per completion. Folding right at completion is the cheapest point for cache, but the span is usually still in the protected tail.
- **Parent fold** composes child records verbatim. It never re-summarizes a summary.

## Task record (the branch summary)

The record is the agent's only memory of the span, so its structure is part of the contract. Fixed field order, so records are stable, diffable and cheap to scan:

```
[task-record] <list>/<path> "<title>"  status: done|failed|abandoned  {#<code>}
outcome:      one or two sentences, agent-written
decisions:    - choice — reason
constraints:  - verbatim durable constraints lifted from folded user messages
changed:      path (+a/-b), ...                       ← deterministic
verified:     `cmd` → exit 0 | failing: `cmd` → exit 1 ← deterministic
open:         - unresolved items, follow-ups
children:     <child records, verbatim, or one line each with {#code}>  ← D4 spike
```

- Agent-written fields: `outcome`, `decisions`, `open`. They come from a required `report` argument on `complete`, with the rubric in the tool description.
- Deterministic fields: `changed` and `verified`, extracted from the span's tool calls and results. They exist so that claims can be checked against tool output.
- `constraints` come from the classifier (below). Keeping them verbatim is the point: compactors keep a small fraction of side constraints, and re-injecting them from a separate store fixes that.
- Failed tasks keep the failing command and its error text, not just a verdict.
- Size cap per record, with a token budget per field. Over-cap reports are rejected at `complete` with guidance, not silently truncated.

## User-message classification (D7)

Pipeline, cheapest first:

1. **Origin, deterministic.** Pi `custom`/`bashExecution`/summary messages are already distinct blocks (`s:` ids, `core/wire.ts` `linearize`). Known harness wrappers inside `role: "user"` (system reminders, retry and steering injections from extensions, subagent result relays) are matched by a configured pattern list. Those fold without a model call.
2. **Classifier, once per user block.** A small fast model labels each remaining user block:

   | Label | Fold treatment |
   |---|---|
   | `new-task` / `new-instruction` | keep verbatim, never inside a group |
   | `constraint` | fold, lift the constraint text verbatim into the record's `constraints` |
   | `steering` / `correction` | fold; durable parts lifted as `constraint` |
   | `info` | fold into the record |
   | `ack` / `approval` | fold; approvals noted in `decisions` |
   | `harness` | fold |

   Steering often hides a durable constraint ("ok, but never touch X"). A binary keep/fold label would lose it, so the classifier returns labels **plus extracted constraint spans**. The model's output is a label, not a summary.
3. **Fail-safe.** Unclassified, errored or low-confidence means `keep`. The verdict is computed off the hot path at ingest, cached by block id, persisted, and never recomputed. A verdict that changes later would change the wire and burn cache.

Requirements found in the code:

- `ConductorHost.complete()` honors only `model: "current"` (`core/conductor/contract.ts`). Routing to an OpenRouter model needs a contract extension: a named secondary model resolved through Pi's model registry and existing auth. The conductor should not hold its own API keys.
- Sending user messages to a third-party provider is a privacy boundary. It must be explicitly opt-in in `~/.accordion/config.json`, with the model configurable, and visible in the UI.

## `tasks` tool (D1, D2)

- Registered for the whole session whether or not Taskfold is attached. Tool schemas sit in the cached prefix, so attaching a tool mid-session would cost a full miss.
- Actions: `create`, `load`, `list`, `add`, `start`, `complete`, `fail`, `abandon`, `status`. `claim` is deferred until subagent sharing is designed.
- Every result carries a structured `details` snapshot, so the session replays task state branch-correctly.
- **Persistence**: the list file is the authority for structure and status. Sessions hold receipts. The location (project-scoped vs. `~/.accordion/tasks/`) is open. Loading an old list must not resurrect old spans: records from other sessions are text, not foldable blocks.

## Truth changes required

| Need | Today (`core/truth.ts`) | Change |
|---|---|---|
| Nested folds | `opGroup` rejects overlap ("overlaps an existing group") | A parent group absorbs child groups atomically in one epoch, and child fold codes keep resolving (or redirect) |
| Group that skips kept user blocks | one contiguous range per group | Either split into per-run groups sharing one record, or allow declared holes. Holes probably don't need a change: `classifyGroup` already emits per-run summaries |
| Record carries a fold tag | strategy summaries are verbatim and may embed `foldTag` (thermocline precedent) | none |
| Fold inside the protected tail | rejected (`protected`) | none; timing policy waits |

## Spikes and evals

| Spike | Question | Measure |
|---|---|---|
| S1 protocol adherence | Do untrained agents call `start`/`complete` reliably? Which nudges work? | % of work inside spans, forgotten completes, overlapping starts |
| S2 report quality | agent report vs. agent + heuristics vs. model summary | unsupported-claim rate against tool output; downstream task success |
| S3 classifier | label accuracy and constraint-extraction recall on real user turns from the analyzed sessions | precision/recall per label, latency, cost per 1k messages |
| S4 recall shape (D4) | parent recall returns the raw span vs. child records with codes | recall count per task, re-recall loops, success |
| S5 misuse resolution (D5) | stack semantics vs. reject for `start B` with A open; auto-close vs. reminder | wrong-boundary folds, agent recovery turns |
| S6 cache economics | watermark and *n* settings | billed input per solved task with cache pricing, not raw tokens |

Bench: SlopCode (as for keel-note) plus replays of in-core-ai sessions. The primary metric is cost per solved task with cache-aware pricing. Token reduction alone is a known misleading proxy.

## Open questions

1. Task list storage location and scope: project, user, or both.
2. Does `claim` (subagents sharing a list) belong in v1?
3. Where the harness-wrapper pattern list lives: shipped defaults plus user config?
4. Should work outside any task get a fallback (keel-lite composition) in a standalone conductor, or is that explicitly out of scope?
