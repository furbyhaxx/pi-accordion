---
document:
  type: "draft"
  id: "DRAFT-taskfold-reliability"
  title: "Taskfold reliability: hold the budget and the task protocol by construction"
  description: "Proposal to make Taskfold keep sessions within budget and keep agents on the tasks protocol for any agent and provider, not only the analysed sessions"
  status: "draft"
  revision: 8
  created_at: "2026-11-05T15:51:30+01:00"
  updated_at: "2026-11-08T13:15:41+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 8
      reason: "align with SPEC-0002 r18: no request injection"
      changes: ["§5.1 HUD replaced by result-borne state and appended notices", "§5.2 bootstrap note is append-only", "header points decided parts to SPEC-0002"]
    - revision: 2
      reason: "the task contract is sequential; misuse is fixed by planning and enforcement, not by loosening the contract"
      changes: ["dropped paused, switch-on-start, complete-from-blocked and interval spans", "added sequential order (§5.4): in-order start, no agent dependency reason, stop-on-block, add … before, scope repair", "planning instructions and required done criterion in the tool text (§6)", "planning metrics; concurrency deferred to subagents"]
    - revision: 3
      reason: "delegated work must be a supported block reason for subagents contributed by other extensions"
      changes: ["block reason delegated, idle-justifying, with optional delegate handle (§5.4, §6.3, §9)"]
    - revision: 4
      reason: "done is ambiguous with the done status"
      changes: ["leaf field renamed from done to goal, described as a checkable end state"]
    - revision: 5
      reason: "a single goal string invites vague intentions"
      changes: ["leaf field goal replaced by acceptanceCriteria, a required list of 1–3 checkable statements on leaves", "record shows the criteria above the outcome", "example and tool text updated"]
    - revision: 6
      reason: "user decisions on the open questions"
      changes: ["decisions table D1–D8", "enforce defaults to coach; gate per model", "orientation allowance 10 calls", "token ratio: lower bound 0.7 only, no upper bound", "stop-on-block, follow-up and large-leaf rules as recommended", "§5.7 configuration: every knob in config.json, per-model where marked"]
    - revision: 7
      reason: "spike results"
      changes: ["§9a spike results", "§3 recount from the pi-auth-plus bus with an anchor rule; its message_end correction does not run under pig", "§4 floor by composition with an R7-off option; unit() counts current member cost", "§9 pi-auth-plus risk replaced by the verified finding"]
---

# Taskfold reliability

Decided parts moved to `.project/specs/0002-taskfold-tree.md`: structured tool results and
delivered-once context (§3–4), nested `tasks` calls (§5.3), eager folding and history (§8), the
floor (§9.2) and legacy adoption (§14). This draft keeps only what is still undecided: token truth
(§3), sequential order and enforcement (§5.3–5.8), prompt engineering (§6) and its evaluation.

Evidence: `.project/analyses/2026-11-05-taskfold-session-failures/analysis.md` (ANA). Token
research: `host:/mnt/Projects/furbyhaxx/pi-auth-plus/.project/analyses/tokens/` and
`host:/mnt/Projects/furbyhaxx/pi-auth-plus/docs/tokens.md`.

## 1. Problem

Today Taskfold depends on three things nobody guarantees:

| Taskfold assumes | What happened |
|---|---|
| The token count is right | Synthetic reports scaled units: 0.42× real tokens for DeepSeek, up to 2.4× for gpt-oss. It also double-counts `cacheWrite`. S2 ran at about 361k real tokens against a 272k budget while Accordion read 152k. |
| The agent uses the tool | In S1 the tool did not exist for the first 13 minutes. Kimi and DeepSeek needed explicit, repeated user instructions. |
| The agent plans a list it can work top to bottom | The plans put dependents before their prerequisites, so the agents jumped between branches. S2 blocked 1.3.4 on Phase C's 4.1 and started 4.1 out of order. Every rejection, the catch-all 4.1.3 and the overlapping 147k span followed from that jump. 18 % of the context belonged to no task. |

When any of these fails, nothing else folds, and the context grows without bound.

The task contract is **sequential**. The agent plans the list so that it can be worked from top to
bottom, in order, one leaf at a time. If the work needs a jump, the plan is wrong, and the agent
fixes the plan, not the order. Our instructions never say this. They say how to end a task, not
how to build a list. Worse, they invite the jump: "`dependency` … means another task comes first:
work on that task now", and "a blocked task frees you to start another".

The fix is therefore planning instructions that produce orderable lists, plus enforcement of the
order. The contract is not loosened to fit misuse. Concurrency, at most 3 siblings in progress
under one parent, belongs to a later subagent design and is out of scope here (§9).

## Decisions (2026-11-05)

| # | Decision | Default | Reason |
|---|---|---|---|
| D1 | A block ends the run; the plan puts user questions into the first leaf | `stopOnBlock: true` | Waiting is an honest cost; continuing means jumping, rework and overlapping records |
| D2 | Enforcement mode | `enforce: "coach"` | User decision; the gate is available per model for models the eval shows ignoring the coach |
| D3 | One follow-up on a premature stop, never after an abort | `resumeOnStop: true` | S2 stopped twice with work in progress; the text offers "continue or block" |
| D4 | Calls before a leaf is required | `orientationCalls: 10` | User decision; enough to find and read the brief and pick the list |
| D5 | Large-leaf reminder | 15 % of budget or 25 results, repeat every 10 | Matches the 5–20 calls per leaf the planning text asks for, with slack |
| D6 | Token-ratio validity | `minRatio: 0.7`, no upper bound | Only a too-low k is unsafe; real high k exists for CJK and emoji |
| D7 | Leaves carry `acceptanceCriteria`, 1–3 items | required | Forces scoping before work and heads the record |
| D8 | Every knob is configurable | §5.7 | User decision |

## 2. Invariants

Every change below serves one of these. Each comes with a check that does not depend on a
particular session.

| # | Invariant | Check |
|---|---|---|
| I1 | **Budget.** After any epoch, the projected live context is at or below `LOW · budget`, unless what remains is unfoldable by rule: protected tail, system and user blocks, held blocks. This holds whatever the agent does with `tasks`. | Replay property test over adversarial scripts (§7.1) |
| I2 | **Accounting.** Folding decisions use a token measure in the model's real tokens. A receipt in unknown or implausible units never lowers the estimate. | Unit tests per provider shape, using the pi-auth-plus captures as fixtures |
| I3 | **Availability.** Whenever Taskfold is the selected conductor, `tasks` is active from the first request, and the agent is told whenever its tool set changes. | Extension test: autoArm with consent pending |
| I4 | **Order.** Exactly one leaf is in progress, and it is the first unfinished leaf in list order. Every non-exempt tool call runs inside it. Under `coach`, a call outside it gets the fix appended to that call's own result; under `gate`, the call is refused with the one call that fixes it. | Store tests, gate tests, protocol metrics (§7.2) |
| I5 | **Orderable plans.** A list is built and kept so that it can be worked top to bottom. A dependency discovered mid-work is fixed by restructuring the list, never by jumping. | Planning eval (§7.2), store tests for `add … before` |
| I6 | **Stop discipline.** A run never ends silently with work in progress or startable. | `agent_end` test |

## 3. Token truth (I2)

1. **Normalize usage at Accordion's boundary**, before calibration (`maybeObserveCalibration`):
   - De-duplicate `cacheWrite` when `cacheWrite === input > 0` on an Anthropic-shaped receipt. This is
     the same rule as pi-auth-plus `correctSyntheticUsage`.
   - Prefer a recount when one is offered, from the pi-auth-plus token bus
     (`pi-auth-plus:v1:tokens:context`), not from its `message_end` correction. Spike 1 (§9a)
     showed that the correction never runs under pig, while the bus does publish tokenizer counts.
     The bus counts Pi's unfolded session, so the recount k is `report.tokens / Accordion's
     unfolded estimate of the same messages`. Use it only when the report has no anchor, or its
     anchor's source is not `provider`. Under pig the anchor is the raw, scaled usage, and a sum is
     labelled with its weakest part, so `report.tokens.source` alone cannot reveal a bad anchor.
2. **Model-family priors and a lower bound.** Accordion estimates 4 characters per token.
   pi-auth-plus measured real ratios of 2.1–2.9 characters per token on Claude and JSON-heavy tails,
   about 3.4 on DeepSeek, and 3.3–4.7 elsewhere. That puts a true k between about 0.85 and 1.9.
   - Keep a small prior table: `anthropic`/`claude` ≈ 1.5; DeepSeek, GLM, Kimi and other open
     models ≈ 1.2; everything else ≈ 1.15.
   - Reject a receipt that yields k below `calibration.minRatio` (default 0.7; no tokenizer is
     coarser than about 4.7 characters per token, k ≈ 0.85). The receipt is marked `untrusted`,
     k stays at its last trusted value or the prior, and the footer shows a one-time warning
     naming the provider.
   - **No upper bound by default** (`calibration.maxRatio: null`). A k that is too high only folds
     early, which is safe. Real high values exist: CJK and emoji text reaches k ≈ 7. An upper
     bound would replace those with a low prior and underestimate, which is the unsafe direction.
   - Synthetic's raw k of 0.2–0.5 for DeepSeek is rejected automatically, with no provider list to
     maintain. Its about 2.4× overcount for gpt-oss is accepted and folds early until the
     pi-auth-plus recount corrects it.
3. **On a model change, reset k to the new model's prior,** not to 1. The first Claude request
   after a DeepSeek phase is then budgeted at the right scale.
4. **Err high when unsure.** While k is untrusted, decisions use `max(prior, last trusted k)`.
   Folding a little early costs a cache break. Folding late costs the budget.

Contract note: this amends ADR 0025's "no clamp" policy. The lower bound is a validity check on
the input, not smoothing of k.

## 4. Folding floor (I1, I5)

Taskfold stays the primary policy. Task records are the best fold. It gains a floor, so a session
cannot outgrow the budget because of how the agent used `tasks`.

1. **Keep-recent by finish order, and waivable.** Keep the most recently finished root open only
   while the plan reaches the target without it.

The floor is a safety net for the budget, not a licence for bad plans. A well-scoped leaf can
still be large, for example one big read. Every floor epoch is also reported as a plan signal
(§5.5), so a list whose leaves are too coarse shows up instead of being absorbed silently.

With sequential order enforced (§5.4), spans cannot overlap. The overlap that made 1.3.4
unfoldable came from blocking a task and working elsewhere, which §5.4 removes. The span scan
therefore stays as it is.

2. **Floor ladder.** If the task-record plan plus record aging leaves the projection above the
   target, run keel-lite's per-block rungs R1–R5 in the same epoch and transaction. They cover
   everything outside Taskfold's groups and the protected tail: open spans first by age, then
   untracked runs. Those rungs are thinking fold, stale reads, bash trim, read skeletons, and the
   deep fold of everything still above 200 tokens. All of them are recoverable, and `recall` and
   `unfold` keep working.
   - Reuse keel-lite by composition, as keel-note does: Taskfold owns an unmodified
     `KeelLiteConductor` attached to a proxy host, and forwards host events to it only after its
     own epoch has settled, with the same HIGH/LOW band. keel-lite then acts only when the
     task-record epoch left the context above HIGH. Spike 4 (§9a) found the ladder reads instance
     state (decisions, pruning, R0 re-assertion), so extracting it would be a refactor of
     keel-lite. keel-lite already skips every grouped block, so records are never touched. The
     floor sets `rootSpecPaths: 0`, because keel-lite's roots are SlopCode-specific.
   - The floor proposes no R7 groups. Whole-step groups would cut across future spans. Grouping
     belongs to records. This needs one new keel-lite option that turns R7 off
     (`groupChunkSteps` is validated ≥ 1 today).
   - When a span later finishes, its record group absorbs the floor-folded members. Spike 5 (§9a)
     confirmed Truth applies a group over auto-folded and replaced blocks, and that ungrouping
     restores them. `unit()` must count each member at its current cost
     (`folded ? foldedTokens : tokens`); today it does that only for members of its own groups,
     and would overstate the savings. The group
     takes their folded size, so the saving is still counted.
3. **Untracked records.** Runs of at least 8 assistant steps that lie outside every span and
   outside the tail become `[untracked-work]` groups when the floor still falls short. The record
   holds only deterministic facts from `recordFacts` (changed files, checks run) plus the first
   line of the assistant text.
4. **Saturation is visible.** If an epoch still ends above budget, the status level becomes
   `error`, and the next `tasks` result names what is holding the space (§5.1).

Order within an epoch:

```
records (oldest finished first) → record aging → floor R1–R5 (open spans, then untracked)
  → untracked groups → saturated
```

Each step is skipped once the projection reaches `LOW · budget`, and all ops commit as one
transaction. Cache economics are unchanged: one break per epoch, at the oldest edit.

## 5. Protocol enforcement (I3, I4, I6)

The prompting layer (§6) asks. These mechanisms make the protocol hold for models that do not
listen.

### 5.1 Task state on the wire

Decided in SPEC-0002 §3–4: nothing is appended to the outgoing request. A per-request suffix moves
the last cached message every step; the injected working set rebilled 107M tokens in session
`01a1b680` (ANA-fold-representations §5). Task state reaches the agent only through `tasks` results
(`start` delivers context once, `status` returns state) and appended notices (SPEC-0002 §4.4).
What remains open here is the coaching content for a call outside the current leaf: it rides on
that tool's own result (append-only), never on the request.

### 5.2 Bootstrap note

On `before_agent_start`, when `tasks` is active and no list is attached, append one custom
message per session, using the existing `NOTICE_MESSAGE` path (append-only, SPEC-0002 §4.4):

> This session tracks work with the `tasks` tool. If this request needs more than one step, call
> `tasks list` now, then `claim` an existing list or `create` one before any other tool.

The note is deterministic and costs about 40 tokens once. It fixes the "nobody told me" case
without a classifier guessing whether the request is multi-step.

### 5.3 Gate

`pi.on("tool_call")` returns `{ block: true, reason }` (Pi `ToolCallEventResult`) for a
non-exempt tool when:

- no list is attached and the agent has made more than `tasks.orientationCalls` (default 10)
  non-`tasks` tool calls since the last user message, counting calls inside `codemode`
  individually; or
- a list is attached and no leaf is `doing`, after that many such calls.

Under `coach`, the same conditions append the reminder to the offending tool's result (§5.1), once
instead of refusing the call.

The allowance covers the first exploration of a request. After that, exploration is a leaf
like any other.

`reason` is the exact fix:

```
Blocked by Accordion: no task is in progress in "slice-1". Call tasks start {list:"slice-1", id:"4.2.1"} (next to do), or tasks add {...} for new work, then retry.
```

- **Exempt:** `tasks`, `unfold`, `recall`. Calls nested inside `codemode` count toward the
  allowance but are not gated individually.
- **Fail-open:** after `tasks.gateFailOpenAfter` (default 3) consecutive refusals, the gate lets
  calls through for the rest of the run and notifies the user once. A broken model must not
  deadlock a session.
- **Setting:** `tasks.enforce` = `"coach"` (default: bootstrap note and result-borne reminders), `"gate"`
  (coach plus refusals) or `"off"`. It can be overridden per model in `modelDefaults`, so the gate
  can be turned on for models that ignore the coach. The eval (§7.2) shows which ones need it.

The orientation allowance keeps single questions free. "What does this function do?" never hits
the gate.

### 5.4 Sequential order

The store enforces the order the plan defines, and every refusal says how to fix the plan.

| Rule | Behaviour |
|---|---|
| **`start` takes the next leaf only.** Next = the first unfinished leaf in list order, depth first. Its parents start with it, as today. | `start` on any other task is refused: `Work the list in order: the next task is 2.3 "…". If 4.1 must come first, restructure the list: tasks add {parent:"2", before:"2.3", tasks:[…]} for the prerequisite, or end 2.3 and add its remaining scope after 4.1.` |
| **`start <parent>` is refused.** Work happens in leaves. | `Start the parent's first unfinished leaf: tasks start {id:"4.1.1"}.` |
| **`dependency` is no longer an agent block reason.** A dependency on an earlier task is already satisfied by the order. A dependency on a later task is a plan error. | `block … dependency` is refused with the restructure instructions above. The store keeps using `dependency` internally for a parent whose subtask is blocked. |
| **`block` means stop and wait** (`tasks.stopOnBlock`, default `true`). The agent reasons are `user-decision`, `user-input`, `third-party` and `delegated`. All four justify going idle. The agent does not start later tasks meanwhile. With `false`, the agent may continue with the next leaf in order, and the span scan ends the blocked leaf's span at `block` and resumes it at `start`, so records never overlap. | The block result names what to do: `Ask the user for …, then stop.` For `delegated`: `Stop until the delegate reports back.` Either way: `Resume with tasks start {id:"…"} once it is resolved.` |
| **New reason `delegated`.** The leaf's work was handed to another agent: a subagent, or an agent another extension provides. Its result returns to this session. | `detail` names the delegate and how its result arrives, for example `subagent "review-1" reviewing 2.3; result arrives as a follow-up message`. Optional `delegate` holds a machine-readable handle that the delegating extension can match. When the result arrives, the agent resumes the leaf with `start`, integrates the result, and ends the leaf. A delegated result never ends a leaf by itself. |
| **New: `add {…, before: "<id>"}`.** Inserts tasks before a `todo` task, so new or prerequisite work lands where the order needs it. | Only `todo` tasks after the insertion point are renumbered. They have never started, so no span or record refers to them. `blockedBy` and `supersedes` links are rewritten in the same write. The result lists the new ids. |
| **Scope adjustment mid-work.** When a leaf turns out to need later work first: | `complete` the part that is done (its report's `open` names what moved), or `abandon` it when nothing is done. Then `add … before` (or under the later parent) the remaining scope, with `supersedes` where it replaces a planned task. |
| Every rejection | Ends with one copyable call: `Do this: tasks … {…}`. |

In S2 this would have gone as follows. `block 1.3.4 dependency 4.1` is refused, and the
agent instead completes 1.3.4 with "decoder reconciled and committed; open: resolver wiring needs
Phase C". It then adds "Wire the live resolver" under 4 after 4.1, and continues with 1.4.

Contract change: SPEC-0001 §4.15 loses `dependency` as an agent reason, gains `delegated` (an idle reason, with an optional `delegate` handle) and gains in-order
`start`, stop-on-block and `add … before`. Store, tool text, span scan (unchanged in behaviour),
widget and tree view change together.

### 5.5 Span size

When the innermost doing leaf passes `tasks.largeLeaf.budgetShare` (default 15 %) of the budget or
`tasks.largeLeaf.toolResults` (default 25) tool results, the next tool result gets, once:

```
4.1.3 is larger than one step. If its acceptance criteria are met, complete it. Otherwise complete it with the part that is done and add the rest with tasks add {before:"<next id>", …}.
```

It repeats every `tasks.largeLeaf.repeatEvery` (default 10) further tool results. The same line
follows every floor epoch that folded inside the current leaf. Spans are never
split automatically. Only the agent knows where a goal ends.

### 5.6 Stop discipline

On `agent_end` with an `in-progress` or `pending` idle verdict:

- Notify the user: `Agent stopped with 4.1 in progress (pending: 4.2.1)`.
- Send at most one follow-up per user prompt, with `sendUserMessage(…, { deliverAs: "followUp" })`:

  > You stopped while 4.1.3 is in progress. Continue it, or end or block it with a reason.

The follow-up can be turned off with `tasks.resumeOnStop: false`. It never fires after the user
aborted the run, or when the verdict is `waiting` (everything left waits on the user, a third
party or a delegate) or `finished`. Its text always offers both correct exits, continuing or
blocking with a reason, so a stop that needed the user becomes a visible block.

### 5.7 Configuration

Every knob in this proposal lives in `~/.accordion/config.json` (`extension/settings.ts`) and is
editable in the Settings screen (SPEC-0001 §1 C). Keys marked *per model* can also be set in
`modelDefaults` entries (`provider/model`, `provider/*`, `*`), resolved like budget and tail in
`extension/dials.ts`.

```jsonc
{
  "tasks": {
    "enforce": "coach",            // "gate" | "coach" | "off"; per model
    "orientationCalls": 10,        // non-tasks calls per user message before a leaf is required; per model
    "gateFailOpenAfter": 3,        // consecutive refusals before the gate opens for the run
    "stopOnBlock": true,           // a block ends the run (§5.4)
    "resumeOnStop": true,          // one follow-up on a premature stop (§5.6)
    "bootstrapNote": true,         // first-prompt note when no list is attached (§5.2)
    "hud": true,                   // per-request [tasks] line (§5.1)
    "largeLeaf": { "budgetShare": 0.15, "toolResults": 25, "repeatEvery": 10 },  // per model
    "acceptanceCriteria": { "required": true, "min": 1, "max": 3, "maxChars": 120 }
  },
  "calibration": {
    "minRatio": 0.7,               // reject receipts below this k
    "maxRatio": null,              // no upper bound unless set
    "dedupeCacheWrite": true,      // drop cacheWrite when it equals input
    "preferRecount": true,         // use a tokenizer recount (pi-auth-plus) when offered
    "priors": { "anthropic": 1.5, "claude": 1.5, "*": 1.15 }   // keys: provider, provider/model or model-family pattern
  },
  "taskfold": {
    "high": 0.8, "low": 0.6,       // epoch band (existing TaskfoldOptions)
    "keepRecentTasks": 1,
    "floor": true,                 // keel-lite fallback rungs (§4)
    "untrackedRecords": { "enabled": true, "minSteps": 8 }
  }
}
```

Validation follows the existing settings rules: an invalid value is reported and ignored, and the
default applies. Fractions must lie in (0, 1], `low < high`, counts must be positive integers, and
`minRatio < maxRatio` when both are set.

### 5.8 Availability

- **Consent gates the classifier, not the conductor.** `selectConductor` attaches Taskfold at
  once. Until consent exists, `classify` is not called, and every user message stays verbatim
  (the documented fallback). The status shows `classifier: awaiting consent`. Accepting consent
  later starts classifying the backlog.
- **Tool-set changes are announced.** When `syncConductorTools` adds or removes tools in an active
  session, the next `before_agent_start` carries:

  > `tasks` is now available: …

  or

  > `tasks` was removed; continue without it.

## 6. Prompt engineering

### 6.1 What is weak today

- **Permissive framing.** "Use the `tasks` tool for work with more than one step; a single
  question … needs no list" gives an exit to any model inclined to skip, and gives no reason to
  comply.
- **No size or shape guidance.** Nothing says what a leaf is, so the agents produced catch-alls,
  parents with no leaves, and bulk updates after the fact.
- **No orientation rule.** The analysed agents read for 20–140 calls before creating a list.
  Nothing says the list comes first, or that reading counts as work.
- **No planning instructions.** Nothing says the list must be workable top to bottom. Nothing
  says to order prerequisites before dependents, to give each task checkable acceptance criteria, or to put
  integration, docs and housekeeping into the plan as their own tasks. Nothing says to restructure
  the list when a dependency appears mid-work. Both sessions' plans followed the document they
  came from (plan phases, backlog ids), not the order the work could be done in.
- **Text that invites jumping.** "`dependency` … means another task comes first: work on that
  task now", and "a blocked task frees you to start another", tell the agent to leave its place in
  the list.
- **Density.** About 2,300 characters of description plus five long guidelines. The protocol is
  buried under the lifecycle definitions. No example shows a complete cycle.
- **One channel.** All guidance sits in the system prompt, which some models weigh least on long
  runs. Nothing in the recent context shows the task state.

### 6.2 Principles

1. State the protocol as numbered imperatives, with the reason in one line: "finished tasks are
   folded into records; untracked work is not".
2. Show one complete example cycle, at most 8 lines.
3. Teach planning before tracking. The list is ordered by dependency, so it can be worked top to
   bottom. Every leaf is one verifiable step of about 5–20 tool calls, with stated acceptance criteria. The
   first leaf is exploration, and the last leaves of a group are its integration, documentation
   and housekeeping.
4. Give the repair procedure in the same place as the rule: when the order turns out wrong,
   restructure the list, then continue in order.
5. Put the live state where the model looks (tool results) and the fix where the error is (gate and
   lifecycle errors). The system prompt holds the rules; the tail holds the state.
6. Keep strictness in enforcement (§5), not in longer prose. Longer text does not make a
   non-compliant model compliant, and it costs every request.
7. Measure every text change with §7.2. Wording that does not move the metrics is reverted.

### 6.3 Drafted texts

**Tool description** (replaces the current one; lifecycle details move into result texts and
errors):

```
Your task list, worked top to bottom. Accordion keeps your context within budget by replacing
each finished task with a short record built from your report; work outside a started task
cannot be recorded that way.

Plan (create, or add to a claimed list):
- Order tasks so the list can be worked top to bottom: every prerequisite comes before the tasks
  that need it. Up to 3 levels.
- Each leaf is one verifiable step of about 5–20 tool calls with 1–3 acceptanceCriteria: checkable
  statements that are true when it is finished ("no direct map access left", not "improve the
  store"). First leaf: explore what you need and ask the user every question the plan depends
  on. Last leaves of each group: integrate, verify, document and housekeeping.
- If you cannot order it, the scopes are wrong: split or merge tasks until you can.

Work:
1. Multi-step request: before any other tool, `list`, then `claim` the matching list or `create`
   one with the whole plan.
2. `start` the next leaf, the first unfinished one in order, before its first tool call. One leaf
   at a time, in order; parents start with their first leaf.
3. Right after the leaf's last tool call, end it, in the same message as the next `start`:
   complete (all acceptance criteria met) · fail (tried, criteria not met; quote the error) · abandon (no longer
   wanted or replaced; supersededBy).
4. The order is wrong (this leaf needs a later task first, or new work appears): restructure,
   do not jump. Complete the part that is done (name what moved in `open`), or abandon it when
   nothing is done, then `add` the rest where it belongs (`before: "<id>"` to insert ahead of a
   task), and continue with the next leaf.
5. Only the user, a third party or a delegate can unblock you: `block` with reason
   user-decision | user-input | third-party | delegated and a detail, ask the user if it is
   theirs, and stop.
6. After a group's last leaf, complete the parent with a report summing up the group. Do not
   stop while a leaf is in progress or a leaf is left to do.

Report: outcome = 1–2 sentences of what was achieved (or tried, for fail); decisions = "choice —
reason"; open = what is unresolved. Changed files and checks are added automatically.

Example: create {list:"auth", title:"Token store", tasks:[{title:"Survey token callers",
acceptanceCriteria:["every caller of the token map is listed"]},{title:"Extract TokenStore",
subtasks:[{title:"Add the interface", acceptanceCriteria:["TokenStore get/set/delete exist",
"unit tests for TokenStore pass"]},{title:"Migrate callers", acceptanceCriteria:["no direct map
access left", "npm test passes"]},{title:"Update docs and changelog",
acceptanceCriteria:["docs describe TokenStore", "changelog entry added"]}]}]} → start 1 → … →
complete 1 + start 2.1 → … → complete 2.1 + start 2.2 → … → complete 2.3 → complete 2
```

**Schema change:** `acceptanceCriteria` (list of 1–3 strings, each ≤120 characters) is required on
leaves at `create` and `add`, and optional on parents, whose criteria are mostly "all subtasks
met". Its description asks for checkable statements that are true when the leaf is finished,
not intentions. A list makes the model break the end state into separate checks; a single
string lets it write one fuzzy intention. The name is one models already associate with
checkable, testable statements. Rejected names: `done` (already a status value), `outcome`
(the report's field for what was achieved), `goal`/`goals` (invite intentions), `doneWhen` and
`doneConditions` (clash with the `done` status again).

Writing the criteria makes the agent scope each step before working. They head the task's record,
above the outcome, so later turns see the planned end state beside the achieved one:

```
acceptance criteria:
  - no direct map access left
  - npm test passes
outcome: callers migrated; one test helper still reads the map
```

Leaves without criteria are refused, and the error names them. Possible later step, not part of
this proposal: `complete` asks the report to state which criteria were met, with unmet ones going
to `open`. Measure the basic version first (§7.2).

**Prompt snippet:**

```
tasks — required, ordered task list for multi-step work: plan it to be worked top to bottom, start the next leaf before working, end it right after.
```

**Guidelines:** two lines instead of five; the description carries the rest.

```
- Multi-step work runs inside started `tasks` leaves, in list order. Create or claim the list before exploring. When the order turns out wrong, restructure the list, do not jump.
- When a result or the [tasks] line names a next call, make that call before anything else.
```

**Agent-facing texts:**

| Text | Location | Draft |
|---|---|---|
| Result-borne state | §5.1 | as shown there |
| Bootstrap note | §5.2 | as shown there |
| Gate refusal | §5.3 | as shown there |
| Lifecycle errors | §5.4 | each ends with `Do this: tasks …` |

They live in `extension/taskBinding.ts`, beside the existing agent texts, so one file holds every
string a model reads.

### 6.4 Per-model overlays: not by default

A per-model prompt fork doubles the surface and goes stale. Enforcement (§5.3) is the per-model
lever: `modelDefaults` can set `tasks.enforce`. An overlay is added only when §7.2 shows a model
below threshold *with* the gate on.

## 7. Verification

### 7.1 Budget property test (I1)

- Commit `replay.ts` from the ANA as a test helper, with **synthetic** session fixtures generated
  by a script, not copies of private sessions.
- Adversarial scripts, each run at k = 0.42, 1.0 and 1.7:

  | Script | Exercises |
  |---|---|
  | No tasks at all | S1 |
  | One giant leaf | S2's 4.1.3 |
  | Blocked task with sibling work | S2's 1.3.4 |
  | Prelude before the list | untracked runs |
  | Model switch mid-session | calibration reset |
  | Synthetic-shaped receipts (`cacheWrite == input`, 0.42 units) | §3 |

- Assert after every epoch: live ≤ `LOW · budget`, or the remainder consists only of unfoldable
  blocks.
- Assert `recall` round-trips every group and fold.

### 7.2 Protocol metrics and model eval (I4, I6)

Metrics, computed from session files (`tasks` calls, `accordion.tasks.idle` entries,
`accordion.tasks.binding` entries):

| Metric | Definition | Target (with `coach`; a model that misses it gets `gate` in `modelDefaults`) |
|---|---|---|
| Tracked share | Non-exempt tool results inside a doing leaf | ≥ 95 % |
| Orientation | Tool calls before the first `start` | ≤ 6 |
| Leaf size | p90 span tokens as a share of the budget | ≤ 15 % |
| Rejections | Per 100 `tasks` calls | ≤ 3 |
| Out-of-order attempts | Refused `start` of a task that is not the next leaf, per list | ≤ 1 |
| Plan repairs | `add … before` or scope adjustments per list; reported, not targeted | — |
| Premature stops | `in-progress` or `pending` verdicts per user prompt | ≤ 0.1 |
| Over-budget requests | Real input above the budget (real input from the trusted k) | 0 |

- Run as `node extension/audit-tasks.mjs <session.jsonl…>`. The same script audits real sessions,
  so regressions show up in normal use.
- **Eval suite:** a small scripted repository with 4 multi-step tasks (refactor, bug fix with
  test, docs plus code, a task needing one user decision). One task hides a prerequisite that only
  shows mid-work, to measure the repair procedure. Run it in print mode on each enabled
  model family: Claude, GPT, Kimi, DeepSeek and GLM. Report the metrics per model, for
  `coach` and `gate`.
- Prompt changes (§6) land only with before-and-after numbers from this suite.

## 8. Slices

| Slice | Content | Touches | Closes |
|---|---|---|---|
| 1 | Token truth: normalization, lower bound, priors, model-change reset, `calibration` settings; read pi-auth-plus corrected usage | `extension/accordion.ts` calibration path, ADR 0025 addendum | I2; S2's DeepSeek phase |
| 2 | Sequential order: in-order `start`, no agent `dependency`, stop-on-block, `add … before`, required `acceptanceCriteria`; waivable keep-recent | `tasks.ts`, `taskfold.ts`, tool text, views, SPEC-0001 §4.15 | I4, I5; the cause of S2's 147k |
| 3 | Floor ladder (extracted keel-lite planner) and untracked records; saturation status | `taskfold.ts`, `keel-lite.ts` (extraction), Taskfold README | I1; S2's 180k and 76k |
| 4 | Availability: consent gates the classifier only; tool-change notices | `selectConductor`, `syncConductorTools` | I3; S1 |
| 5 | Enforcement: result-borne reminders, bootstrap, coach and gate with fail-open, stop follow-up, lifecycle errors, `tasks` and `taskfold` settings with Settings-screen editing | `taskCoach.ts`, `taskBinding.ts`, `accordion.ts`, `settings.ts` | I4, I6 |
| 6 | Prompt rewrite, audit script, eval suite and baselines | tool registration, `extension/audit-tasks.mjs` | measurement of §6 |

Slices 1–3 make the budget hold whatever the agent does, so they come first. Slices 4–6 make the
agent behave so that the floor is rarely needed. Slice 6's eval establishes a baseline before
slice 5 lands, so the gate's effect is measured, not assumed.

## 9a. Spike results (2026-11-05)

All probes ran under pig with pi-auth-plus 0.5.5 (`55baab6`) on
`synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`. Scripts and logs are in
`.project/analyses/2026-11-05-taskfold-session-failures/evidence/spikes/`.

| # | Assumption | Result | Consequence for the design |
|---|---|---|---|
| 1 | Accordion sees pi-auth-plus's corrected usage | **No.** A later extension's `message_end` and the persisted message both carry `cacheWrite == input`. Across the 7 most recent sessions, 1,552 of 1,774 Synthetic replies carry the duplicate; the other 222 were not examined further. The bus works: one reply reported 7,397 tokens, source `tokenizer`, where Pi counted 8,413. | §3: Accordion de-duplicates itself and takes recounts from the bus, under the anchor rule. |
| 2 | PiG delivers `tool_call` blocks and `sendUserMessage` follow-ups to Node extensions | **Yes.** A blocked call became an error tool result whose text is exactly `reason`, and the model retried as instructed. A follow-up from `agent_end` started a new run and is persisted as a user message. | §5.3: the refusal text carries the whole fix. §5.6: the follow-up reads as an Accordion notice, because it appears as a user message. |
| 3 | The HUD can ride the wire without being persisted | **Yes.** A text part appended in the `context` hook reached the model, which quoted it verbatim, and is absent from the stored message. | §5.1: Accordion appends the HUD inside its own `context` handler, after Truth ingestion and wire serialization, so Truth never sees it. Measured since: a moving suffix rebilled 107M tokens in `01a1b680`, so request injection is rejected (SPEC-0002 §4.5). |
| 4 | keel-lite's planner can be extracted | **Not cleanly**; composition works. | §4: compose like keel-note, plus one keel-lite option to disable R7. |
| 5 | A record group can cover floor-folded blocks | **Yes.** In a real-Truth test, live tokens went 5,745 → 4,112 after the floor → 1,934 after the group, and ungrouping restored the floor's fold and replace. | §4: `unit()` savings must count current member cost. |

## 9. Risks and open questions

- **Gate friction.** A model that keeps calling blocked tools burns turns. Fail-open after three
  refusals bounds this; the eval measures it.
- **Floor versus record quality.** Per-block folds inside an open span make the agent recall more
  often while it works. The span-size HUD should keep this rare; the eval reports recall counts.
- **Sequential order is a contract change.** Store, tool text, widget, tree view and web app
  change together (AGENTS.md). Lists created before it may be out of order. On claim, the store
  reports the first unfinished leaf and lets the agent restructure before starting.
- **Stop-on-block costs throughput** when later tasks do not depend on the blocked one. That is
  accepted: the user is asked anyway, and the agent resumes in order once they answer.
- **Concurrency is deferred.** With subagents, up to 3 siblings under one parent may be in progress
  at once, each in its own subagent. That needs per-subagent spans and its own design. Until then
  exactly one leaf is in progress, and a `delegated` leaf stops the run until its delegate
  reports back. The concurrency design builds on `delegated`: a leaf held by a delegate is what
  frees the agent to start its next sibling.
- **pi-auth-plus under pig.** Its Synthetic usage correction never runs there, because
  `physicalHooksAvailable()` is true but no physical hook applies. This is a pi-auth-plus bug.
  Accordion does not depend on the fix, because it de-duplicates and bounds k itself and reads
  only the bus.
- **Kimi on Synthetic.** Its scale factor is unmeasured, because its count endpoint answers 500.
  The lower bound covers it until it is measured.
- **S1's Claude drop from 267k to 73k** (ANA B5) is still unexplained and is outside this
  proposal.
