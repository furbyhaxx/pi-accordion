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
| H4 | Taskfold persists verdicts and unfold-state changes from inside the context hook (harness and opening verdicts during ingest, unfold state from the `wire-departing` path); Pi's `appendEntry` is `appendFileSync` | `conductors/in-process/taskfold/taskfold.ts:912`, `verdicts.ts:105-108`, `extension/accordion.ts` (`taskfoldVerdicts.reset`) | fixed aa068f8: entries produced during the hook are written after it returns, in order; the footer refreshes once per tick |
| H5 | `ctx.getContextUsage()` on every request makes Pi rebuild its session projection (10+ walks over all entries), also with folding off | `extension/accordion.ts` (`refreshFromCtx`) | no change: one projection takes 6.2 ms at 7,688 entries (the 1.1M-token session) and grows with the entries. The call is the only source of the routed model's context window (`routedModel?.model ?? model` inside Pi); skipping it would budget the first request after a route change against the wrong window |
| H6 | Reconciliation fingerprints every historical message on every request (all characters, tool arguments re-stringified) | `extension/accordion.ts` (`ingestMessages`), `core/wire.ts` (`contentFingerprint`) | fixed 8980061, e775e8c, d466454: a structural signature per message, a full hash for the last 8 messages and a rotating window of 262,144 characters. Profile of the 1,230-request replay: 11.7 s before, 2.3 s after (signature 0.9 s, window 1.4 s) |
| H7 | Each finished message copies the whole message and fingerprint arrays | `extension/accordion.ts` (`ingestFinishedMessage`) | no change: the four copies take 0.66 ms at 50,000 messages, 0.1 ms at the 7,688 of the 1.1M-token session. The message array can be Pi's own, so an in-place append is not safe |
| H8 | Debug totals (`liveTokens`, `fullTokens`) are computed before the debug-off check | `extension/accordion.ts` (`maybeObserveCalibration`) | fixed ac25b02 |
| H9 | Recall expiry scans all blocks on every request near the budget | `core/recallExpiry.ts:47-74` | fixed ac25b02: without a live recall result the function returns after one cheap pass |
| H10 | WebSocket `send` stringifies per client and never checks `bufferedAmount`; a slow client queues whole snapshots | `extension/accordion.ts` (`send`, `broadcast`) | fixed 0306d4b: one serialisation per broadcast; a client whose queue passes 64 MiB or twice the latest snapshot, whichever is larger, is disconnected |
| H11 | DROP role validation peeks forward per drop run: O(messages x runs) | `core/wire.ts:505-545` | no change: measured at 20,000 messages with 5,000 drop runs, the current code takes 6.8 ms (alternating) and 47 ms (adjacent runs). A rewrite with a per-pass lookahead table gave 24 ms and 11 ms, slower in the common shape, and was dropped |
| H12 | The Anthropic frontier hook rescans task spans and the provider payload per request | `extension/taskCache.ts:55-76` | fixed 26f49e0, bc233cb: `taskSpansOf` (`extension/taskSpans.ts`) scans once per state of the block log; the cache frontier, the stale check, the task widget and the tasks broadcast share the result. One scan takes 2.6 ms at 12,138 blocks |
| H13 | Resume reads the branch three times and scans the entries once per consumer | `extension/accordion.ts` (`session_start`) | no change: once per session start. On the 1.1M-token session `getBranch` takes 0.4 ms and one context projection 6.2 ms; Pi's own `SessionManager.open` takes 254 ms |

## Taskfold

| Id | Finding | Where | Status |
|---|---|---|---|
| T1 | Diagnostic task ages rescan the transcript suffix per finished task on every plan, debug on or off: O(tasks x blocks) | `taskfold.ts:896-904` | fixed b89194c |
| T2 | Absorbed child groups are matched with array searches: O(members x run) | `taskfold.ts:1142-1145` | fixed b89194c |
| T3 | The whole planner runs on every append, turn commit and departing request, changed or not | `taskfold.ts:531-553,765-774` | fixed b89194c |
| T4 | `spanHandle` and `record` filter all blocks per task node | `taskfold.ts:1158-1169,1213-1234` | fixed b89194c |
| T5 | `host.groups()` deep-copies every member and handle array, several times per unit | `core/conductor/liveHost.ts:225-227`, `taskfold.ts:1062-1078` | fixed b89194c |
| T6 | Each pressure-floor scope builds a fresh keel-lite conductor and its quadratic read analysis | `taskfold.ts:948-973` | fixed 34061d4 (linear analysis), b89194c (one span scan) |
| T7 | Bug: delivered context (criteria, pins, attachments in a `tasks start` or `claim` result) can fold while its task is still open | `taskfold.ts:959-962,1021-1022` | fixed bb32da1 |
| T8 | Bug: a classification backlog starts every call at once; the host admits four, the rest become error verdicts and are never retried | `taskfold.ts:639-654`, `extension/accordion.ts:168,1280` | fixed 9a135d1 |
| T9 | Bug: an agent-opened task loses its protection after two newer roots without pressure (SPEC-0002 §7.3 asks for pressure) | `taskfold.ts:803-807` | fixed 41daf32 |
| T10 | Bug: a classifier result that arrives after a session switch writes into the new session's verdict ledger | `taskfold.ts:728-740` | fixed dbb5819 |
| T11 | Bug: the saturation status is never cleared once the session is healthy again | `taskfold.ts:775-778` | fixed af5a584 |

## Other conductors

| Id | Finding | Where | Status |
|---|---|---|---|
| C1 | `blocks()` of the view adapter and the remote replica materialise the whole history with the quadratic group lookup of H1; doorman does it per fresh result | `core/conductor/view.ts:179`, `core/conductor/remote.ts:220`, `doorman.ts:129` | fixed 05ef299 (lookup), aad898b (one view per revision) |
| C2 | Thermocline's ladder calls `project()` per move: O(blocks x moves) | `conductors/ws/thermocline/policy.ts:699-706` | fixed 3eb4789: the id-to-block map is built once per view. What remains per call is one pass over the planned folds and strata |
| C3 | keel-lite reread detection compares every read with every read and write | `conductors/in-process/keel-lite/keel-lite.ts:729-731` | fixed 34061d4 |
| C4 | Bug: thermocline replaces signed thinking blocks; the wire keeps the old signature | `policy.ts:928-930` | fixed cd2401c, 4b3c378 |
| C5 | Bug: thermocline prices a new fold with the block's existing `foldedTokens`, not the text it will write | `policy.ts:276-278` | open |
| C6 | Bug: thermocline prices DROP strata at zero although the role floor can keep a recap | `policy.ts:860-862` | open |
| C7 | Thermocline HOLD recomputes `foldBody` for bodies it then discards | `thermocline.ts:844-845` | fixed b0b36c2 |
| C8 | keel-lite never consolidates its own recap groups; a long session saturates on them | `keel-lite.ts:444-446` | open |
| C9 | Bug: a thermocline tool-pair unit never graduates because its tool call cannot be folded | `policy.ts:347-348` | fixed bab78f7 |
| C10 | Bug: keel-lite marks an earlier ranged read stale when a later read covers a different range | `keel-lite.ts:730` | fixed 34061d4 |
| C11 | `remote.ts` never removes abort listeners of settled completions | `core/conductor/remote.ts:205` | fixed 4f79dce |
| C12 | Triptych's skeleton cache grows with every skeleton ever built | `conductors/ws/triptych/triptych.ts:283-290` | fixed f11b380, 784b329 |
| C13 | Bug: keel-note, compaction-naive, handoff, thermocline and triptych send session text to a model but declare no `privacy`, so they attach without consent | `core/conductor/registry.ts:225-249` | fixed 1669879 |
| C14 | keel-lite's protected roots are the benchmark's file names (`AGENT_BRIEFING.md`, `spec_*.md`) | `keel-lite.ts:14-18,92-116` | no change: outside the benchmark the names never match, so the rule does nothing there. Conductor options carry numbers and booleans only (`ConductorOptions` in `core/conductor/registry.ts`); a list of file names needs a new option type in the registry, the settings validation and the settings screen, and nobody uses it yet |

## Long-session use (agent and user)

| Id | Finding | Where | Status |
|---|---|---|---|
| U1 | Task notices are custom messages: Pi sends them to the model, Accordion has no block for them. They escape budget, folding, recall and dumps, and accumulate | `core/wire.ts:217-219`, `extension/accordion.ts:3549-3589` | open |
| U2 | Root history keeps every outcome whole and is never condensed again: about 25k tokens at 300 roots with 200-character outcomes, 160k at the 2,000-character limit | `records.ts:138-150`, `taskfold.ts:909-924` | open |
| U3 | A root's history lists only direct children; grandchild codes disappear, recall prints "(no code)" | `records.ts:141`, `taskfold.ts:1194-1196`, `core/recallView.ts:227-231` | fixed 71b0a13 |
| U4 | A task report is cut at the call limit and `page` repeats the first page | `core/recallView.ts:207-238` | fixed ce116c5 |
| U5 | Untracked work folds only in runs of 8 uninterrupted assistant messages; short exchanges and document reads never fold | `taskfold.ts:1013-1042` | fixed 1969b98: work outside tasks folds once a user message follows it and the fold reclaims at least `taskfold.untracked.minTokens` (2,000; 400 when the cache is cold). The final reply of each turn stays. Under pressure only the newest read of each document stays |
| U6 | Recall search resolves every fold and joins its full text per call and per page | `core/recallView.ts:155-166,365-386`, `core/agentView.ts:180-203` | fixed 48860ee |
| U7 | A changed resume sends the whole task tree (about 4,500 tokens at 300 tasks), each time | `extension/taskBinding.ts:107-126`, `extension/tasks.ts:1039-1046` | fixed c7ebe16: counts, active branch, blocked, next and up to 20 changed ids; under 1,500 characters at 300 tasks |
| U8 | Missing-list and missing-leaf coaching speak once per prompt, then stay silent for thousands of calls; the gate fails open for the rest of the run | `extension/taskCoach.ts:147-153,270-279` | fixed 128e9c6: reminders after 25, 50, 100, 200 and every 200 further untracked results; the gate closes once every 50 calls |
| U9 | Gate mode suppresses large-leaf and floor notes; coach mode repeats the large-leaf text every ten results forever | `extension/taskCoach.ts:205-211,257-266` | fixed 128e9c6; the unused `tasks.largeLeaf.repeatEvery` setting goes with P24 |
| U10 | Revealing hidden widget rows shows all of them, past the row budget | `extension/tui/taskWidget.ts:220-224`, `taskTree.ts:217-247` | fixed 405dd5a: 10 rows per click, 30 at most. The click path has a unit test only: the terminal host delivers no mouse clicks to extension components |
| U11 | The task views rebuild the session tree on every render and key | `extension/tui/taskViews.ts:473-486`, `taskTranscript.ts:243-265` | fixed 1ea14be: ten builds of 300 tasks over 10,000 blocks took 1,152 ms, now 257 ms |
| U12 | Fact extraction has per-task caps but no session budget; parents reread their children | `extension/accordion.ts:4792-4815`, `core/factLedger.ts:27-33` | fixed b28d6c1, 3576531: `recall.ledger.maxCalls` (default 120), own entries only, no rescan while the folded tasks are unchanged |
| U13 | Every transcript dump format carries all task metadata; there is no compact export | `extension/tui/transcriptDump.ts:221-283` | fixed 4d102a3: `--compact` |
| U14 | Agents declare only 56% of their work as tasks (Claude 0%, GLM rejects 96% under the gate); undeclared work folds only under pressure (B-0001) | `.project/plans/0006-taskfold-reliability/plan.md` | fixed 1969b98 for the cost side: undeclared work folds with the turn (U5). Full replay of the 2M-token session: live tokens mean 66,391 to 56,066, final 64,086 to 47,118, characters sent over all requests 2.61 G to 1.87 G (−28%), invalidated characters 37.7 M to 38.5 M, no request over budget before or after. How often each model family declares tasks is measured again for B-0001 |
| U15 | The agent is never told that nothing foldable is left; saturation is a footer status | `taskfold.ts:785` | fixed d488c9b, d41eb0a: the next tool result carries one note per saturation episode, naming the open task that holds the context and how to end it; at most one note per 50 tool results |
| U16 | `complete` on a blocked task is refused; the agent must resume first | `extension/tasks.ts:887-890` | no change: SPEC-0001 §4.15 allows `complete` only from `doing`, and the refusal names the repair (`start`, then `complete`). One extra call does not justify changing the end-state contract in store, tool description, Taskfold and views |
| U17 | `unfold` restores in place and rewrites an early part of the wire (diverge: deliver at the tail) | `core/agentView.ts`, `extension/accordion.ts` unfold tool | no change: measured over 74 sessions of November 2026, agents called `unfold` 0 times and `recall` 51 times (20 sessions). `recall` already delivers at the tail; `unfold` is capped at `recall.unfoldTokens` |
| U18 | Agents re-read or redo folded work instead of recalling it (diverge: echo the fold code when a tool call touches a folded task's files) | none yet | no change: the folded task's record stays in the context and lists the changed and verified paths with its recall code, and reading the current file is the right action after a change. An extra line on each such read would repeat the record |
| U19 | Carried over from the session-failures analysis: does a usage correction another extension makes at `message_end` reach Accordion's token receipt? | Pi `core/extensions/runner.js` (`emitMessageEnd`), `extension/accordion.ts` (`message_end`, `maybeObserveCalibration`) | no change: Pi chains `message_end` handlers in load order, so Accordion sees the correction only from an extension loaded before it. A receipt built from uncorrected numbers is judged by the ratio bounds in `extension/calibration.ts` and refused when it is out of range |

## Spec, docs and debt

| Id | Finding | Where | Status |
|---|---|---|---|
| S1 | SPEC-0001 and the code differ in about 30 places: compaction (`dryRun` folds for real, undo ignores groups, no bake fallback on threshold, bake summary format), web parity (settings result, task tree, compact preview), panel rendering, footer | `evidence/Spec0001Audit.md` | open: code rows fixed (compaction 2a7f65c, panel 9ca4f33, web f4e7102); the "spec text" rows wait for P20 |
| S2 | SPEC-0002 and the code differ in about 25 places, mostly stale spec text; code gaps: `stale` reporting, `zombieSteps` setting, one stable fold code per task, dropped routing operations not logged, anchor-ref pin sources | `evidence/Spec0002Audit.md` | open: dropped routing operations logged 3514638; `tasks.zombieSteps` and `stale` in tool results 50e883f; `stale` in the widget and the panel list d5c4fa3; one task code for partly held spans dae3f5f; spec text is being rewritten |
| S3 | SPEC-0003 edge differences: unknown regex flags accepted, silent 200-character query cut, codeless overflow shape, tool descriptions narrower than the contract; `recall({ask})` bypasses `serveRecall` | `evidence/Spec0003DocsDrift.md` | fixed 8a37999 |
| S4 | Docs drift: conductor count and list, "folding off by default" versus `autoArm: true`, six tabs documented as five, removed `ACCORDION_COMPLETION_LOG`, missing shims, stale `docs/` pages | `evidence/Spec0003DocsDrift.md` | fixed de83b38. Two pages under `docs/` are identical to the upstream project (`docs/conductor-rework-roadmap.md`, `docs/explorations/relevance-signals/README.md`) and stay as the upstream's history |
| D1 | Seven TypeScript errors in the extension's strict check and no committed type-check command | `conductors/in-process/agedSummaryConductor.ts`, `extension/accordion.ts` | fixed bf817ce |
| D2 | The orientation-modes harness imports symbols Taskfold no longer exports | `.project/analyses/orientation-modes/harness/` | open |
| D3 | Bug, found by the new type check: recall release and the unfold ceiling read `settings.taskfold.high`, a setting that no longer exists, so both compared against `NaN` and never acted | `extension/accordion.ts` (`taskfoldHigh`) | fixed ad8ed21 |
| D4 | Carried over from the history-conductor analyses: a proposed held-out trial of keel-note as memory for a coordinator session in other projects | none | dropped: it is a trial plan for other projects' sessions and nothing in this repository waits for it. Its code findings are tracked here as C4 and C13 (fixed), C14 and U1 |

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

Harness: `node extension/replay-session.mjs <session.jsonl> [--conductor taskfold|none] [--limit-requests n] [--out file.json]`.
It feeds a recorded Pi session through the real extension hooks (ingest, context hook, turn commit)
with Taskfold attached, budget 272,000, tail 20,000, no model calls. Session content stays on the
machine; only the metrics below are recorded.

Session A (nukular-ai, 45 MB file), first 1,230 requests: 2,459 messages, 4,423 blocks,
1,114,495 transcript tokens.

| Measure | Before (955b930) | After wave 1 (bd616b4) |
|---|---|---|
| Context hook, mean ms | 25.0 | 15.7 |
| Context hook, p95 ms | 63.8 | 32.5 |
| Context hook, max ms | 95.8 | 68.6 |
| Turn commit, mean ms | 72.8 | 7.0 |
| Turn commit, p95 ms | 203.6 | 14.4 |
| Message ingest, mean ms | 20.2 | 7.6 |
| Replay wall time, s | 156.7 | 48.8 (with the CPU profiler on) |
| Live tokens on the wire, mean / p95 / max | 74,804 / 185,317 / 216,140 | same |
| Wire characters sent, sum | 1,758,560,930 | same |
| Prefix characters invalidated by folds, sum (events) | 19,518,960 (85) | same |
| Folded groups / folded blocks at the end | 25 / 3,617 | same |
| Requests over budget | 0 | 0 |

Without a conductor the same 1,230 requests had 864 requests over budget (before).
Session B (pig), first 1,247 requests, 1,249,662 tokens, before: hook quarter means 2.92 to
41.87 ms, 5 folded groups.

Where the time goes after wave 1 (CPU profile of session A, 37 s inside the replay; 8 s of it is
the harness copying messages the way Pi does):

| Share | Where | Finding |
|---|---|---|
| 14.1 s | Taskfold `plan()` on every event (`scanTaskSpans` 2.5 s, diagnostics, ancestry tests) | T1–T6 |
| 10.9 s | `ingestMessages` on every request: `contentFingerprint` hashes every message's content again (`fnvStr` 6.6 s, `thinkingIsSigned` 2.0 s) | H6 |
| 4.1 s | `noteFacts` on every request rebuilds the folded-task list (`foldedTasks`, `recallIndex`, `canRecallHandle`) | U12 |
| 3.7 s | `LiveConductorHost.blocks()` builds every `ViewBlock` per call | C1 |
| 2.5 s | `serializeWire`, of which 1.3 s is `computeDegradedDropRuns` with no DROP group present | H11 |

The final numbers (after all waves, full sessions) are added below when the runs exist.
