---
document:
  type: "analysis"
  id: "ANA-long-session-challenge"
  title: "Challenge pass: logic cost and long-session usability"
  description: "Ranked findings of the 2026-11-14 challenge pass over Taskfold, the other conductors and the context hook, their status, and the replay numbers for sessions above 1M tokens"
  status: "draft"
  revision: 1
  created_at: "2026-11-14T15:28:31+01:00"
  updated_at: "2026-11-14T15:28:31+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["findings from four code reviews, three spec audits, one docs audit and one diverge round"]
---

# Challenge pass: logic cost and long-session usability

A long session here is more than 1,000,000 tokens of transcript: 10,000 to 50,000 blocks, 300+
tasks, 1,500+ model requests, several resumes.

Method: four read-only code reviews at `955b930` (Taskfold cost, hook and Truth, other conductors,
long-session use), audits of SPEC-0001, SPEC-0002, SPEC-0003 and the docs against the code, one
`diverge` round on the fold-unit question, and a replay of real Pi sessions through the real
extension handlers (`extension/replay-session.mjs`). The full reviewer reports are in `evidence/`.
Magnitudes in the tables are estimates from reading unless the replay section states a measurement.

Status values: `open` (carried by `.project/plans/0007-long-session-hardening/plan.md`),
`fixed <commit>`, `backlog <id>` (stays, with the reason in that item), `no change` (with the reason).

## Hot path (hook, Truth, wire)

| Id | Finding | Where | Status |
|---|---|---|---|
| H1 | Block to group lookup scans every group's member array: `groupOf`, `inFoldedGroup`, `opGroup`. Serialising and every `host.blocks()` are quadratic once most blocks are grouped (about 1.25e9 id comparisons at 50k blocks) | `core/truth.ts:760-777,1772,1939`, `core/conductor/hostAdapter.ts:47` | fixed 05ef299 |
| H2 | `stats()` sums all blocks twice per call and is called 4 to 8 times per request (pressure check, receipt estimate, footer on every broadcast, telemetry) | `core/truth.ts:655-680`, `extension/accordion.ts:876,1026` | fixed 05ef299 |
| H3 | Group shapes are cached by the global `rev`, so `markSent`, calibration and appends reclassify every folded group | `core/truth.ts:836-849,974-997` | fixed 05ef299 |
| H4 | Taskfold persists an unfold-state change from the `wire-departing` path; Pi's `appendEntry` is `appendFileSync`: disk I/O on the context hook | `conductors/in-process/taskfold/taskfold.ts:807`, `extension/accordion.ts:3413,3711` | open |
| H5 | `ctx.getContextUsage()` on every request makes Pi rebuild its session projection (10+ walks over all entries), also with folding off | `extension/accordion.ts:1611` | open |
| H6 | Reconciliation fingerprints every historical message on every request (all characters, tool arguments re-stringified) | `extension/accordion.ts:3021-3024`, `core/wire.ts:373-409` | open |
| H7 | Each finished message copies the whole message and fingerprint arrays | `extension/accordion.ts:3146-3147` | open |
| H8 | Debug totals (`liveTokens`, `fullTokens`) are computed before the debug-off check | `extension/accordion.ts:3119-3120` | open |
| H9 | Recall expiry scans all blocks on every request near the budget | `core/recallExpiry.ts:47-74`, `extension/accordion.ts:3702` | open |
| H10 | WebSocket `send` stringifies per client and never checks `bufferedAmount`; a slow client queues whole snapshots | `extension/accordion.ts:861-877` | open |
| H11 | DROP role validation peeks forward per drop run: O(messages x runs) | `core/wire.ts:505-545` | open |
| H12 | The Anthropic frontier hook rescans task spans and the provider payload per request | `extension/taskCache.ts:55-76` | open |
| H13 | Resume reads the branch three times and scans the entries once per consumer | `extension/accordion.ts:3396-3448,2848` | open |

## Taskfold

| Id | Finding | Where | Status |
|---|---|---|---|
| T1 | Diagnostic task ages rescan the transcript suffix per finished task on every plan, debug on or off: O(tasks x blocks) | `taskfold.ts:896-904` | open |
| T2 | Absorbed child groups are matched with array searches: O(members x run) | `taskfold.ts:1142-1145` | open |
| T3 | The whole planner runs on every append, turn commit and departing request, changed or not | `taskfold.ts:531-553,765-774` | open |
| T4 | `spanHandle` and `record` filter all blocks per task node | `taskfold.ts:1158-1169,1213-1234` | open |
| T5 | `host.groups()` deep-copies every member and handle array, several times per unit | `core/conductor/liveHost.ts:225-227`, `taskfold.ts:1062-1078` | open |
| T6 | Each pressure-floor scope builds a fresh keel-lite conductor and its quadratic read analysis | `taskfold.ts:948-973` | open |
| T7 | Bug: delivered context (criteria, pins, attachments in a `tasks start` or `claim` result) can fold while its task is still open | `taskfold.ts:959-962,1021-1022` | fixed bb32da1 |
| T8 | Bug: a classification backlog starts every call at once; the host admits four, the rest become error verdicts and are never retried | `taskfold.ts:639-654`, `extension/accordion.ts:168,1280` | fixed 9a135d1 |
| T9 | Bug: an agent-opened task loses its protection after two newer roots without pressure (SPEC-0002 §7.3 asks for pressure) | `taskfold.ts:803-807` | fixed 41daf32 |
| T10 | Bug: a classifier result that arrives after a session switch writes into the new session's verdict ledger | `taskfold.ts:728-740` | fixed dbb5819 |
| T11 | Bug: the saturation status is never cleared once the session is healthy again | `taskfold.ts:775-778` | fixed af5a584 |

## Other conductors

| Id | Finding | Where | Status |
|---|---|---|---|
| C1 | `blocks()` of the view adapter and the remote replica materialise the whole history with the quadratic group lookup of H1; doorman does it per fresh result | `core/conductor/view.ts:179`, `core/conductor/remote.ts:220`, `doorman.ts:129` | open: lookup fixed 05ef299; doorman still builds the whole view per fresh result (P12) |
| C2 | Thermocline's ladder calls `project()` per move: O(blocks x moves) | `conductors/ws/thermocline/policy.ts:699-706` | open |
| C3 | keel-lite reread detection compares every read with every read and write | `conductors/in-process/keel-lite/keel-lite.ts:729-731` | fixed 34061d4 |
| C4 | Bug: thermocline replaces signed thinking blocks; the wire keeps the old signature | `policy.ts:928-930` | fixed cd2401c, 4b3c378 |
| C5 | Bug: thermocline prices a new fold with the block's existing `foldedTokens`, not the text it will write | `policy.ts:276-278` | open |
| C6 | Bug: thermocline prices DROP strata at zero although the role floor can keep a recap | `policy.ts:860-862` | open |
| C7 | Thermocline HOLD recomputes `foldBody` for bodies it then discards | `thermocline.ts:844-845` | open |
| C8 | keel-lite never consolidates its own recap groups; a long session saturates on them | `keel-lite.ts:444-446` | open |
| C9 | Bug: a thermocline tool-pair unit never graduates because its tool call cannot be folded | `policy.ts:347-348` | fixed bab78f7 |
| C10 | Bug: keel-lite marks an earlier ranged read stale when a later read covers a different range | `keel-lite.ts:730` | fixed 34061d4 |
| C11 | `remote.ts` never removes abort listeners of settled completions | `core/conductor/remote.ts:205` | fixed 4f79dce |
| C12 | Triptych's skeleton cache grows with every skeleton ever built | `conductors/ws/triptych/triptych.ts:283-290` | fixed f11b380, 784b329 |
| C13 | Bug: keel-note, compaction-naive, handoff, thermocline and triptych send session text to a model but declare no `privacy`, so they attach without consent | `core/conductor/registry.ts:225-249` | fixed 1669879 |
| C14 | keel-lite's protected roots are the benchmark's file names (`AGENT_BRIEFING.md`, `spec_*.md`) | `keel-lite.ts:14-18,92-116` | open |

## Long-session use (agent and user)

| Id | Finding | Where | Status |
|---|---|---|---|
| U1 | Task notices are custom messages: Pi sends them to the model, Accordion has no block for them. They escape budget, folding, recall and dumps, and accumulate | `core/wire.ts:217-219`, `extension/accordion.ts:3549-3589` | open |
| U2 | Root history keeps every outcome whole and is never condensed again: about 25k tokens at 300 roots with 200-character outcomes, 160k at the 2,000-character limit | `records.ts:138-150`, `taskfold.ts:909-924` | open |
| U3 | A root's history lists only direct children; grandchild codes disappear, recall prints "(no code)" | `records.ts:141`, `taskfold.ts:1194-1196`, `core/recallView.ts:227-231` | fixed 71b0a13 |
| U4 | A task report is cut at the call limit and `page` repeats the first page | `core/recallView.ts:207-238` | fixed ce116c5 |
| U5 | Untracked work folds only in runs of 8 uninterrupted assistant messages; short exchanges and document reads never fold | `taskfold.ts:1013-1042` | open |
| U6 | Recall search resolves every fold and joins its full text per call and per page | `core/recallView.ts:155-166,365-386`, `core/agentView.ts:180-203` | fixed 48860ee |
| U7 | A changed resume sends the whole task tree (about 4,500 tokens at 300 tasks), each time | `extension/taskBinding.ts:107-126`, `extension/tasks.ts:1039-1046` | open |
| U8 | Missing-list and missing-leaf coaching speak once per prompt, then stay silent for thousands of calls; the gate fails open for the rest of the run | `extension/taskCoach.ts:147-153,270-279` | open |
| U9 | Gate mode suppresses large-leaf and floor notes; coach mode repeats the large-leaf text every ten results forever | `extension/taskCoach.ts:205-211,257-266` | open |
| U10 | Revealing hidden widget rows shows all of them, past the row budget | `extension/tui/taskWidget.ts:220-224`, `taskTree.ts:217-247` | open |
| U11 | The task views rebuild the session tree on every render and key | `extension/tui/taskViews.ts:473-486`, `taskTranscript.ts:243-265` | open |
| U12 | Fact extraction has per-task caps but no session budget; parents reread their children | `extension/accordion.ts:4792-4815`, `core/factLedger.ts:27-33` | open |
| U13 | Every transcript dump format carries all task metadata; there is no compact export | `extension/tui/transcriptDump.ts:221-283` | open |
| U14 | Agents declare only 56% of their work as tasks (Claude 0%, GLM rejects 96% under the gate); undeclared work folds only under pressure (B-0001) | `.project/plans/0006-taskfold-reliability/plan.md` | open |
| U15 | The agent is never told that nothing foldable is left; saturation is a footer status | `taskfold.ts:785` | open |
| U16 | `complete` on a blocked task is refused; the agent must resume first | `extension/tasks.ts:887-890` | open |
| U17 | `unfold` restores in place and rewrites an early part of the wire (diverge: deliver at the tail) | `core/agentView.ts`, `extension/accordion.ts` unfold tool | open |
| U18 | Agents re-read or redo folded work instead of recalling it (diverge: echo the fold code when a tool call touches a folded task's files) | none yet | open |

## Spec, docs and debt

| Id | Finding | Where | Status |
|---|---|---|---|
| S1 | SPEC-0001 and the code differ in about 30 places: compaction (`dryRun` folds for real, undo ignores groups, no bake fallback on threshold, bake summary format), web parity (settings result, task tree, compact preview), panel rendering, footer | `evidence/Spec0001Audit.md` | open |
| S2 | SPEC-0002 and the code differ in about 25 places, mostly stale spec text; code gaps: `stale` reporting, `zombieSteps` setting, one stable fold code per task, dropped routing operations not logged, anchor-ref pin sources | `evidence/Spec0002Audit.md` | open |
| S3 | SPEC-0003 edge differences: unknown regex flags accepted, silent 200-character query cut, codeless overflow shape, tool descriptions narrower than the contract; `recall({ask})` bypasses `serveRecall` | `evidence/Spec0003DocsDrift.md` | fixed 8a37999 |
| S4 | Docs drift: conductor count and list, "folding off by default" versus `autoArm: true`, six tabs documented as five, removed `ACCORDION_COMPLETION_LOG`, missing shims, stale `docs/` pages | `evidence/Spec0003DocsDrift.md` | open |
| D1 | Seven TypeScript errors in the extension's strict check and no committed type-check command | `conductors/in-process/agedSummaryConductor.ts`, `extension/accordion.ts` | fixed bf817ce |
| D2 | The orientation-modes harness imports symbols Taskfold no longer exports | `.project/analyses/orientation-modes/harness/` | open |
| D3 | Bug, found by the new type check: recall release and the unfold ceiling read `settings.taskfold.high`, a setting that no longer exists, so both compared against `NaN` and never acted | `extension/accordion.ts` (`taskfoldHigh`) | fixed ad8ed21 |

## Diverge round

Question: how to decide what to fold, when and into what over 1M+ tokens without depending on the
agent declaring its work. Six frames, 36 ideas. Position taken:

- **Host-closed spans** (U5, U14): the host seals undeclared work itself on signals it can see (a new
  user message after a finished reply, a size cap) and folds it at the tail, where the cache miss is
  small. Taskfold already folds untracked runs and open-task steps, but only under pressure and only
  in long uninterrupted runs. This is the lever for B-0001: coverage stops depending on discipline.
- **Tail delivery for unfold** (U17) and **anchor echo** (U18) attack the disown and re-read
  behaviour without touching the cached prefix.
- Rejected as traps: waiting for pressure and then folding early history, per-turn verbosity decay of
  old records (rewrites deep prefix positions repeatedly), a ledger message at the first fold
  position, side-model need scores.
- One-look tool results (skeleton a large result on the request after it arrived) is doorman's
  mechanism; it stays a separate conductor.

## Replay of sessions above 1M tokens

Pending: numbers before and after are added here when the runs exist.
