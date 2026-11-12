---
document:
  type: "plan"
  id: "PLAN-0006"
  title: "Taskfold reliability: token truth, ordered work and measured coaching"
  status: "active"
  revision: 4
  created_at: "2026-11-12T02:56:59+01:00"
  updated_at: "2026-11-12T11:35:00+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 4
      reason: "record token truth (S2) as shipped"
      changes: ["S2 receipt validity, per-model prior and v24 protocol recorded", "current behavior refreshed"]
---

# Taskfold reliability

Implements B-0001. Progress is tracked in the project-scope `backlog-completion` task list,
which also carries the other backlog items; do not create a competing claim or duplicate list.

## Goal

Taskfold uses defensible token units, makes task work sequential by construction, keeps its
deterministic tools available, and makes premature stops visible. Coaching and prompt changes
are evaluated against actual model behavior, not merely successful unit tests.

## Progress

- Done: source inventory, executable plan, shared settings foundation, Settings screen, protocol
  audit with paired token measurements, the live pre-enforcement baseline for Claude, GPT,
  DeepSeek and GLM, token truth (S2), and the ordered lifecycle (S3): ordered starts, the four
  public block reasons with internal `dependency`, `stopOnBlock`, required leaf criteria with
  repair-instead-of-refusal for older lists, and a live nine-call run
  (`evidence/lifecycle-live.json`).
- Done: S6. The candidate prompt was compared against the shipped wording on all four families in
  coach and gate (`evidence/prompts/comparison.json`) and reverted: it did not improve tracked-result
  coverage or behavior and cost more requests. Folded-history comprehension is recorded in
  `evidence/prompts/history-comprehension.json`; Claude still disavows its own folded work and no
  tried wording fixed it without side effects, so the shipped carrier shape stands.
- Done since: consent decoupling (S4) and the coaching gate (S5) — bootstrap, the orientation
  allowance, gate mode with a bounded fail-open, and one continuation offer per typed prompt.
- Blocked: the Kimi baseline needs a funded route (task 5).

## Current behavior and evidence

- `extension/accordion.ts:2900` judges every receipt through `extension/calibration.ts`: the
  `input + cacheRead + cacheWrite` pairing, optional dedupe of the Anthropic first-request cache
  write, ratio bounds (floor 0.7, no default ceiling) and a one-per-episode announcement naming the
  provider. A refused receipt leaves `k` alone; the unmeasured content keeps
  `max(prior, last trusted)`.
- `core/truth.ts:184` carries `calibrationPrior` as replicated state distinct from
  `calibration`/`calibrationThroughOrder` (protocol v24). Covered blocks use the receipt ratio, the
  rest use the prior; the raw wire accessors stay raw.
- Recounts are still not consumed: a live bus probe (`evidence/token-truth/recount-probe.json`)
  shows `ContextReport` carries no session, leaf, request or message identity, and its count is a
  second chars estimate. v24 therefore ships no recount dial.
- `extension/tasks.ts` permits parent starts and branch changes after blocking; its public block
  reasons include `dependency`. Criteria are optional. `taskSchema.ts` already supports the
  newer 300-character criterion and expanded report contract.
- `extension/taskCoach.ts` counts work and appends reminders only with an attached list;
  `extension/accordion.ts:3455` records idle verdicts without one-shot continuation.
- `extension/accordion.ts:799` gates attachment on consent; `syncConductorTools` changes tool
  availability without announcing it. Taskfold now also has model-backed chat routing.
- Existing span intervals, folding floor, untracked records, insertion, delivered-once context,
  timing modes, bracket tails and cache-frontier compilation are already implemented.

Evidence: `.project/analyses/2026-11-05-taskfold-session-failures/analysis.md`;
`host:/mnt/Projects/furbyhaxx/pi-auth-plus/docs/tokens.md` and its token analyses;
installed pi-auth-plus `src/tokens/bus.ts`, `src/tokens/engine/index.ts` and `src/bus/tokens.ts`.
The current v1 context payload has `{v, reason, report}`; a report names the model and time but
has no session id or message fingerprint. Recounts therefore need explicit snapshot matching,
not an assumption that the most recently received number belongs to the current folded wire.

The shared knowledge base's `ai-context-management/INDEX.yaml` identifies the relevant failure
modes: untrained agent-directed compaction, recovery/reacquisition costs and moving-prefix cache
invalidation. Product-specific decisions remain in this plan and the specs.

## Decided defaults

| Decision | Contract |
|---|---|
| D1 | `tasks.stopOnBlock: true`; blocked work stops the run. Put needed user questions in the first leaf. |
| D2 | `tasks.enforce: "coach"`; `"gate"` and `"off"` are available, including per-model overrides. |
| D3 | `tasks.resumeOnStop: true`; at most one follow-up per user prompt, never after an abort. |
| D4 | `tasks.orientationCalls: 10`; count nested non-exempt calls individually. |
| D5 | Large-leaf reminder at 15% of budget or 25 tool results, repeating every 10 results. |
| D6 | `calibration.minRatio: 0.7`; `maxRatio: null`. Low unknown units cannot lower the estimate. |
| D7 | Leaves require 1–3 checkable `acceptanceCriteria` by default. |
| D8 | All controls below are configurable and editable through the shared Settings schema. |

Later accepted contracts take precedence over obsolete draft examples: criterion text defaults
to the shipped 300-character limit, not 120; nesting has no three-level ceiling; no moving
request HUD or task-state suffix is introduced. Existing `taskWidget` controls own the HUD.
The folding floor and untracked safety options remain opt-in.

## Shared settings prerequisite

Finish `.project/plans/0001-accordion-ui-polish/plan.md` S2 and S3 first. That work owns the
SQLite sidecar lock extraction, revisioned settings store, cross-instance sync, validation
schema, registry option plumbing and generic staged screen. This plan adds reliability fields
and runtime effects to that framework; it does not build a second store or temporary editor.
Preserve the existing `~/.accordion/config.json` location and the session-dial precedence.

## S1: audit and baseline

1. Add `extension/audit-tasks.mjs`, reading session JSONL and optional matching diagnostics.
   Recognize native and nested `tasks` calls, bindings, idle entries, block/resume intervals,
   refusals and model changes. Emit metrics, not private message bodies. Missing token truth
   remains unknown; do not count an unknown budget observation as a passing request.
   Paired measurements (`tokenMetrics`) count a request only when one trusted `request` diagnostic
   with a real input and budget exists per session request — equal counts are the only available
   proof of order. Surplus, shortage or a rejected receipt leaves every request unknown, and leaf
   tokens per budget stay unknown because the session file stores no task spans
   (`evidence/token-truth/audit-pairing-live.json`).
2. Add a reproducible synthetic repository and bounded evaluation runner under this plan's
   `evidence/`. Four requests: refactor, bug plus regression test, docs plus code, user decision.
   Hide one prerequisite so scope repair is observable. The decision case must visibly block,
   receive a scripted answer, resume, integrate and finish.
3. Discover enabled Claude, GPT, Kimi, DeepSeek and GLM models from the actual registry. Record
   original-behavior results before enforcement changes. Do not claim a gate baseline before
   the gate exists. Keep model ids, settings, commands, receipts and metrics; bound loops and
   preserve failures. Report unavailable families as blocked, not silently skipped.

## S2: token truth — shipped

1. Extract a small calibration boundary from `maybeObserveCalibration`, retaining exact
   departing-wire pairing, aborted/error exclusions, model invalidation and receipt frontier.
   De-duplicate `cacheWrite == input > 0` on Anthropic-shaped receipts when configured.
   Do not mutate stored usage or billed costs.
2. Add model priors: Anthropic/Claude 1.5; DeepSeek, GLM, Kimi and identified open families 1.2;
   fallback 1.15. Allow explicit provider/model, provider and family-pattern overrides.
   Model changes reset to the new prior. Receipt-covered estimates and the unmeasured tail
   must remain distinct; add explicit replicated prior state if needed, never fake coverage.
3. Reject non-finite, non-positive or out-of-bounds ratios. Default upper bound is absent:
   real CJK/emoji ratios can be high. While untrusted, use `max(prior, last trusted k)`.
   Mark the observation untrusted and warn once per degraded episode, naming the provider.
4. Consume optional pi-auth-plus recounts outside the context hook — RESOLVED AS UNAVAILABLE.
   The live `tokens:query`/`tokens:context` payloads carry no session, leaf, request or message
   identity and no provider-anchored per-request input, so no report can be proven to measure the
   same unfolded messages. The conservative estimate stands and the dial was not shipped.
5. Update ADR 0025, Truth/replica/protocol surfaces and generated remote SDKs together when
   replicated state changes. Preserve system-prompt replacement and append-frontier regressions.

## S3: ordered task lifecycle

- `start` accepts only the first unfinished leaf, depth first; parents auto-start. Direct parent
  starts are refused with the next leaf's call. Claiming an older list reports its next leaf
  and any criteria repair it needs; loading older list files must not destroy them.
- Public `block` reasons become `user-decision`, `user-input`, `third-party`, `delegated`.
  `dependency` remains readable and usable internally for parent propagation, not accepted as an
  agent escape from list order. `delegated` has a required detail and optional opaque delegate
  handle; its result must return to this session, which resumes and integrates it before ending.
- With `stopOnBlock: true`, a block prevents later starts and gives the wait/ask/stop instruction.
  With `false`, later leaves may run in order while blocked intervals stay closed; a resumed
  leaf opens a new interval. Never overlap records or run two doing leaves.
- Repair a bad order by completing only achieved scope, or abandoning unwanted/replaced scope,
  then inserting remaining work where it belongs. Never fabricate a completion to make order fit.
- Enforce configured leaf criteria at create/add and give actionable repair for older leaves.
  Default policy is required, min 1, max 3, maxChars 300, bounded by the public format caps.
- Lifecycle refusals name the actual next valid repair call. Update store, tool text, task
  schema/validator, both specs, skills, widget, tree views and browser consumers together.
  Retain existing item ids, symlink writes, finished-span reports and claim isolation.

## S4: deterministic availability and privacy

Attach Taskfold and activate `tasks` before the first request even without classifier consent.
Without required consent, no remote classification or chat routing runs; user messages stay
verbatim and status says `classifier: awaiting consent`. Consent later drains the pending backlog.
Fully local routes retain their existing no-consent behavior.
Tool additions/removals produce a next-prompt append-only notice. Stale consent dialogs or
callbacks must never affect a replacement session.

The older settings revoke rule needs a Taskfold exception: revoke cancels/gates its protected
model-backed operations while keeping deterministic tools available. Other consent-required
conductors still detach.

**Shipped.** `privacy.deferred` on the registry entry, `attachPolicy`/`revocationEffect` in
`extension/privacyGate.ts`, the Taskfold model gate (`allowModel` ctor argument; skipped user
messages stay unverdicted in `consentQueue`), a `resync` that classifies the whole block list so
an opened gate reaches what it held, and a consent grant that dispatches that resync to the SAME
instance — reattaching would have created a fresh conductor and silently dropped the queue.
A conductor's tools appear and vanish with one append-only notice on the next prompt
(`extension/toolSetNotice.ts`), cleared on a session swap; a consent answer that arrives after a
session switch attaches nothing. Spec §6.4 and AGENTS.md updated. Verified by 700 unit
tests, the smoke suites and a live Pi-Bolt run (`evidence/deferred-consent-live.json`: phase A ran
the `tasks` tool with no consent and made zero model calls; phase B granted consent mid-session
and the classifier request followed), plus `evidence/deferred-consent-drain-live.json` for the
draining itself (a steering message queued while gated is classified after consent, with no new
prompt). This extends classifier-only consent decoupling to the newer chat
surface; it never authorizes an external model call without consent. Change the registry,
selection gate, revocation effect, browser picker and spec wording together.

## S5: coaching, gate and stop discipline

- Bootstrap once per session through the existing append-only notice path when `tasks` is
  active without an attached list: multi-step work should list, then claim/create before tools.
- Count non-exempt calls since the last user prompt. `tasks`, `unfold`, `recall` are exempt.
  Nested codemode calls count individually, but only the outer call carries a reminder/refusal.
- After the orientation allowance, no attached list or no doing leaf gets a result-borne coach
  reminder once; gate mode refuses with the specific repair call. No request suffix is used.
- Three consecutive refusals open the gate for the rest of that run and notify once. A new
  user prompt resets the run allowance; automatic follow-ups must not defeat the one-shot guard.
- On `in-progress` or `pending` idle verdict: notify and optionally enqueue one follow-up offering
  continue, end honestly or block. Never follow up after abort, legitimate wait or finished work.
  Verify actual installed lifecycle signals rather than guessing an abort from an empty message.
- Large-leaf reminders use the configured budget share/result threshold and repeat interval.
  A floor epoch touching the current leaf also triggers the reminder. Do not auto-split spans.
  Keep agent-facing text centralized in `extension/taskBinding.ts`.

Shipped so far: the bootstrap notice, the orientation allowance counted across nested calls, the
gate with `block` + exact repair and a bounded fail-open, the one-shot stop follow-up, and the
large-leaf tap (`TaskCoach.largeLeafNote`) measured over the span's own content in estimated
tokens and its tool results. A pressure floor that folds inside an open span reports it
(`floor_spans`) and the coach turns that into the same note (`TaskCoach.floorTap`), so a leaf that
was silently shrunk learns it outgrew its span. Per-model `tasks.enforce`, `tasks.orientationCalls` and
`tasks.largeLeaf` resolve through `modelDefaults` (`extension/dials.ts → modelTaskDials`).

## Configuration

Add to the shared validated schema and Settings sections:

- `tasks.enforce` (`coach`), `orientationCalls` (10), `gateFailOpenAfter` (3),
  `stopOnBlock` (true), `resumeOnStop` (true), `bootstrapNote` (true).
- `tasks.largeLeaf`: `budgetShare` (0.15), `toolResults` (25), `repeatEvery` (10).
- `tasks.acceptanceCriteria`: `required` (true), `min` (1), `max` (3), `maxChars` (300).
- `calibration`: `minRatio` (0.7), `maxRatio` (null), `dedupeCacheWrite` (true), `priors` (the
  family defaults above). No recount switch: no source can prove the match (S2.4).
- Per-model overrides in `modelDefaults`: `tasks.enforce`, `tasks.orientationCalls`,
  `tasks.largeLeaf`, resolved like budget/tail (`provider/model` → `provider/*` → `*`).

Fractions lie in (0,1], counts are positive integers, criteria min ≤ max within public caps,
priors are finite positive values, and configured minRatio < maxRatio. Bad loaded values are
reported and ignored according to existing policy; interactive saves are strictly rejected
with field-specific errors. No new required provider dependency or environment-variable surface.

## S6: prompts and isolated live comparison

Use numbered planning/work rules and one short complete cycle. Explain why tracking matters:
finished tasks fold into records; untracked work does not. Teach dependency order, exploration
as the first leaf, one verifiable outcome per leaf, checkable criteria, honest reports and
scope repair rather than jumping. Treat 5–20 calls as scoping guidance, not mandatory filler.
Integration, docs and housekeeping need tracked outcomes when substantial, not ceremonial tasks.
Keep descriptions short; do not create per-model prompt forks without measured need.

At a fixed runtime, compare old and candidate prompts in both coach and gate on all four
scenarios for each enabled family. Record actual before/after metrics; revert wording that
adds cost without improving behavior. Done 2026-11-12: the candidate was reverted
(`evidence/prompts/comparison.json`). Audit folded-history comprehension too: a completed
record is evidence of recorded work, not proof that hidden execution never occurred. Exercise
`recall` and batched tool boundaries before disavowing it. The record/bracket live observations
are in `.project/plans/0005-fold-timing/evidence/form-live/bracket-checks.json`.

## Verification and done when

| Metric | Target with coach; use a justified per-model gate override when missed |
|---|---|
| Tracked non-exempt results | ≥95% |
| Calls before first start | ≤6 |
| p90 leaf tokens / budget | ≤15% |
| Task rejections / 100 task calls | ≤3 |
| Out-of-order starts / list | ≤1 |
| Plan repairs | report, no target |
| Premature stops / user prompt | ≤0.1 |
| Requests demonstrably over budget | 0; missing trusted measurements remain unknown |

- Unit/regression tests cover scaled and duplicated receipts, high Unicode ratios, late recounts,
  model changes, no-list coaching, nested counts, fail-open, abort suppression, follow-up bounds,
  consent pending/revoked, delegated wait/resume, order repair and criteria validation.
- Adapt the ANA's `evidence/replay.ts` into a synthetic test helper; never commit private session fixtures.
- Synthetic replays live in `conductors/in-process/taskfold/replay.test.ts`: no tasks, giant leaf,
  blocked sibling work, pre-list exploration, model switch, repeated scaled receipts; k = 0.42,
  1.0, 1.7. Every replay asserts that blocks survive, no epoch grows the context, a finished task
  folds at eager timing, a repeated epoch over unchanged content is a no-op, every fold recalls,
  and — once nothing foldable is left — a session still at or above `high·budget` reports
  saturation rather than staying quiet, with or without the opt-in safety options. It never
  asserts `live ≤ low·budget`: Taskfold is not a hard budget guarantee (§9.2), and a replay that
  demands one would encode a promise the spec refuses.
- Run `bun test extension/settings.test.ts extension/tui/*.test.ts`, targeted native/core and
  conductor suites, `npm --prefix extension run smoke`, `npm --prefix app run check`,
  `npm --prefix app test`; rebuild affected remote SDKs and exercise production package paths.
- Run real Pi-Bolt terminal checks at narrow and wide widths and the bounded model evaluation.
  Preserve sanitized commands, metrics and failures under this plan's `evidence/`.
- Update current public docs, skills, specs and steering for changed contracts in the fixing
  commits. Delete B-0001 and its pointer only after its behavior and required checks are reached.

## Do not

Do not append per-request task state, silently enable folding safety options, mutate billed
usage, trust unpaired recounts, bypass consent, add concurrent task execution or subagent spans,
invent successful tool results, weaken tests, publish/push, or declare unavailable live checks
passed. S1's unrelated unexplained Claude usage drop remains outside this change.
