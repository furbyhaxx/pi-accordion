---
document:
  type: "plan"
  id: "PLAN-0007"
  title: "Long-session hardening and spec conformance"
  description: "Units that fix the findings of the 2026-11-14 challenge pass and close the gaps between SPEC-0001/0002/0003, the docs and the code"
  status: "published"
  revision: 2
  created_at: "2026-11-14T15:28:31+01:00"
  updated_at: "2026-11-14T15:50:00+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 2
      reason: "wave 1 landed"
      changes: ["wave 2 units P13, P14 and the thermocline remainder detailed", "status cells are the integrator's"]
---

# Long-session hardening and spec conformance

Implements B-0005. Findings and their ids (H1, T7, C4, U2, S1, …):
`.project/analyses/long-session-challenge/README.md`. Reviewer detail with the proposed fixes:
`.project/analyses/long-session-challenge/evidence/*.md`. The integrator fills the `Status` cells
of that README at merge; units do not edit it.

A long session is more than 1,000,000 tokens of transcript: 10,000 to 50,000 blocks, 300+ tasks,
1,500+ requests.

## Progress

```
done  W1  P1 truth index · P2 taskfold bugs · P3 keel-lite · P4 thermocline (C4, C9, C7)
          P5 remote+triptych · P6 privacy · P7 compaction · P8 panel · P9 web · P10 recall
          P11 type check
done  W2  P13 taskfold planner cost (T1–T6) · host block view per revision (C1)
          P12a ingest signature (H6) · P15A–F task tooling (U7–U13) · H8, H9 · dropped routing
          operations logged · no change after measurement: H5, H7, H11, H13, U16
          P12b deferred entries and footer (H4) · P12c socket bound (H10)
          P18 sealed turns (U5, U14) · P24a stale tasks and zombieSteps
now   W2  P24b stable task code · P24c stale marker in widget and panel
          P12d one span scan per log state (H12; frontier and stale check done, widget
          after P24c) · B-0001 evaluation · spec text SPEC-0001 · docs drift (S4)
next  W2  P21–P23 thermocline pricing (C5, C6, C2) · signed thinking under a fold
later W3  P16 notices in Truth (U1) · P17 history budget (U2)
          P19 U15, U17, U18, C8, C14
later W4  P20 spec text SPEC-0002 (S2 stale text, D2), artifact cleanup, final gates
```

## Environment (every unit)

- One worktree per unit: `.pi/worktrees/<slug>`, branch as named in the unit, created off local
  `feat/pi-native` by the integrator. `extension/node_modules` and `app/node_modules` are symlinks
  to the main checkout: do not run `npm ci` or `npm install`.
- Never edit or run git in the main checkout. Commit in the worktree: Conventional Commits,
  explicit paths, no AI attribution. Do not push.
- Gate before reporting done, from the worktree root, all four exit 0:
  `bun test extension/settings.test.ts extension/tui/*.test.ts` ·
  `npm --prefix extension run smoke` · `npm --prefix app run check` (0 errors, 0 warnings) ·
  `npm --prefix app test`.
  `core/**/*.test.ts` and `conductors/**/*.test.ts` are Vitest suites and run inside
  `npm --prefix app test`; a single file: `npx --prefix app vitest run --root app ../core/truth.test.ts`.
  Do not run them with `bun test` (seven of them use Vitest fake timers and fail there).
- `conductors/ws/thermocline/remote-sdk.mjs` and `conductors/ws/triptych/triptych-sdk.mjs` are
  generated (`node extension/build-remote-sdk.mjs`). A unit that changes `core/conductor/remote.ts`,
  thermocline or triptych sources regenerates them in its last commit; the integrator regenerates
  again after merging.
- Type check: `npm --prefix extension run check` once P11 has landed; before that, the temporary
  tsconfig recipe (TypeScript 5.9, `files: [extension/accordion.ts]`, `strict`, `noEmit`,
  `allowImportingTsExtensions`, `moduleResolution: bundler`). A unit adds no new error.
- Live terminal check for UI units, isolated from the user's state:

  ```bash
  rm -rf /tmp/acc-home /tmp/acc-proj && mkdir -p /tmp/acc-home/.accordion /tmp/acc-proj && git -C /tmp/acc-proj init -q
  cat > /tmp/acc-home/.accordion/config.json <<'EOF'
  { "autoArm": true, "defaultConductor": "taskfold", "doorPort": 0,
    "privacyConsent": { "taskfold": "2026-11-05T08:00:00.000Z" },
    "taskWidget": { "mode": "auto", "expanded": false, "maxRows": 9, "toggleKey": "alt+t" } }
  EOF
  tmux new-session -d -s acc -x 100 -y 40 \
    "cd /tmp/acc-proj && ACCORDION_HOME=/tmp/acc-home pig --no-session -ne -e <worktree>/extension/accordion.ts --model deepseek/deepseek-flash"
  tmux capture-pane -p -t acc     # tmux resize-window -t acc -x 36 for a narrow width
  ```

  Use a session name and home of your own (`acc-<slug>`, `/tmp/acc-<slug>-home`) and remove both
  afterwards. PiG delivers no mouse clicks to extension components; every action needs a key.
- Fake Pi objects in `extension/smoke*.mjs` must gain any new `pi.*` registration called at load.
- No disk I/O and no await on the `context` hook. Folding stays content substitution. Every write
  goes through `Truth.apply`; the controller lease is untouched.

## What not to do

- Do not change task end states, block reasons or the `tasks` tool contract unless the unit says so.
- Do not weaken, skip or delete a test to get green. A wrong test is reported with the reason.
- Do not fix findings of another unit; report what you see.
- Do not commit anything derived from the private session files under `/mnt/shared/data/sessions`.

---

## P1: Truth indexes (H1, H2, H3, C1) — branch `perf/truth-index`

Files: `core/truth.ts`, `core/conductor/hostAdapter.ts` (only if a call there must change),
`core/truth.test.ts`.

Current: `groupOf(b)` and `inFoldedGroup(id)` loop over `groupList` and call
`g.memberIds.includes(id)` (`core/truth.ts:760-777`); `opGroup` repeats that per member
(`:1772`); `computeFoldOps` calls `groupOf` per folded block (`:1939`). `stats()` (`:665`) runs
`calibratedLiveTokens()` and `calibratedFullTokens()`, each a pass over all blocks, and is called
several times per request. `groupWire()` (`:836`) is cached by `revCounter` and calls
`classifyGroup(g)` (`:974`) for every folded group whenever any rev changes.

Change:

1. Add `private groupsEpoch = 0` and `private memberGroup: Map<string, Group> | null = null`.
   Every statement that changes `groupList`, a group's `memberIds`, `folded`, `digest`, `handles`
   or `role` calls one private method `groupsChanged()` (`this.groupsEpoch++; this.memberGroup = null`).
   Find the sites with `rg -n 'groupList|memberIds|\.folded = |\.digest = ' core/truth.ts`; they
   include `opGroup`, `opUngroup`, `opFoldGroup`, `opUnfoldGroup`, freeze, `resetAll`, pruning in
   `housekeep`, `rebuildFrom`, snapshot adoption (`core/replica.ts` builds a Truth: check how it
   installs groups and route it through the same method).
2. `private memberIndex(): Map<string, Group>` builds the map lazily (first group wins for an id,
   which is what the loop does today). `groupOf(b)` returns `memberIndex().get(b.id)`;
   `inFoldedGroup(id)` returns `memberIndex().get(id)?.folded === true` IF a block can be in at
   most one group. Verify that invariant in `opGroup` (it refuses a block already grouped); if
   two groups may share a block, keep a second map for folded groups only.
3. `opGroup`'s membership test uses the index.
4. Cache `classifyGroup` per group: `private shapeCache = new WeakMap<Group, { epoch: number; attached: boolean; shape: GroupShape }>()`,
   valid while `epoch === this.groupsEpoch` and `attached === this.wireAttached`. A block that
   disappears (rebuild, prune) goes through `groupsChanged()`, so the epoch covers it.
   `groupWire()` keeps its rev key but now reads cached shapes.
5. Cache the aggregates by rev: one private record
   `{ rev, live, full, calLive, calFull, folded }` filled on first use after a rev change, used by
   `liveTokens()`, `fullTokens()`, `foldedCount()`, `calibratedLiveTokens()`,
   `calibratedFullTokens()`. Before relying on it, confirm that every mutation that can change one
   of these numbers bumps `revCounter` (appends, ops, calibration, prior, `setSystemPrompt`,
   rebuild). If one does not, invalidate the record there explicitly.

Test that matters (`core/truth.test.ts`): a seeded random sequence of at least 400 operations
(append blocks, `group`, `ungroup`, `foldGroup`, `unfoldGroup`, `fold`, `unfold`, `replace`,
`resetAll`, freeze, `rebuildFrom` with a shortened block list, `setProtect`, calibration) on a
Truth with 300 blocks; after every operation assert, for every block, that `groupOf` and
`inFoldedGroup` equal the naive loops (keep the two old loops as local helper functions inside
the test), and that `stats()` equals a freshly computed sum. Plus a timing guard: 20,000 blocks,
one folded group over 15,000 of them, `serializeWire`-equivalent `computeFoldOps` + 50 `stats()`
calls finish in under 500 ms (it is seconds today).

Out of scope: `core/wire.ts`, the extension, conductors.

Verification: `npx --prefix app vitest run --root app ../core/truth.test.ts ../core/replica.test.ts ../core/conductor/liveHost.test.ts`, then the gate.

## P2: Taskfold bugs (T7–T11) — branch `fix/taskfold-long-session-bugs`

Files: `conductors/in-process/taskfold/taskfold.ts`, `taskfold.test.ts`, SPEC-0002 only where
named. One commit per finding, each with its regression test (`TestHost`, see the existing tests).

- **T9** (`taskfold.ts:803-807`): the `open` flag of an agent-opened task is cleared after two
  newer finished roots. Add the pressure condition: clear it only when that plan run is under
  pressure (the same `pressure` value the planner uses for timing). SPEC-0002 §7.3 already says so.
- **T11** (`:775-778`): in the branch that returns with no plan and no pressure, clear a previously
  set saturation or raw-warning status (`host.setStatus` with the normal status the conductor
  reports when healthy; look at how a successful epoch sets it at `:1319-1325`). Test: saturate,
  raise the budget, run an evaluation, assert the last status has no warning or error level.
- **T10** (`:728-740`): classification success and failure both check `this.host === host` (the
  host captured when the call started) before touching the verdict ledger or evaluating, exactly
  as routing does (`routeOne`). Test: start a classification, detach, resolve it, assert the ledger
  has no entry.
- **T8** (`:639-654`): replace "start every unclassified message" with a FIFO owned by the
  conductor: at most 2 classifier calls in flight; when one settles, start the next. The host
  refuses a fifth concurrent call (`extension/accordion.ts:168,1280`): find the error it throws
  and treat that error as "no capacity": put the message back at the end of the queue without a
  verdict, at most 3 times per message, then record the error verdict as today. Detach clears the
  queue. Test: 12 unclassified user messages and a scripted `complete` that rejects with the
  capacity error whenever more than 2 are in flight; assert all 12 end with a real verdict and
  never more than 2 were in flight.
- **T7** (`:959-962`, `:1021-1022`): add one predicate `deliveryOwner(block)`: for a `tool_result`
  of the `tasks` tool whose call action is `start`, `resume`, `claim`, `pin` or `attach`, the key
  of the task (or, for `claim`, the list) it belongs to; else null. A block whose owner is an OPEN
  task (or a list with an open task) is excluded from the floor mask, from `steps` runs and from
  `untracked` runs. Check how the scan reads actions and task keys (`scanTaskSpans`, the
  `taskEvents` details in `core/taskEvents.ts`) and reuse that parsing. Test: an open task whose
  `start` result carries 2,000 characters of criteria, then enough steps and pressure for `steps`
  and (with `floor: true`) the floor to act: the `start` result stays unfolded; after `complete`
  the span folds as before.

Out of scope: planner cost (P13), new options.

Verification: `npx --prefix app vitest run --root app ../conductors/in-process/taskfold`, then the gate.

## P3: keel-lite reread analysis (C3, C10) — branch `fix/keel-lite-rereads`

Files: `conductors/in-process/keel-lite/keel-lite.ts` and its test file.

Current (`keel-lite.ts:729-731`): for each read, a search over all reads and writes decides
whether a later full read, ranged read or write supersedes it; a ranged read is superseded by ANY
later ranged read of the same file because only a boolean is kept.

Change: one backward pass over the blocks that keeps, per normalized path, the newest full read
position, the newest write position and the list of ranges of newer ranged reads. A read is stale
when a newer write or a newer full read of the path exists, or (ranged read) when a newer ranged
read covers its whole range. Keep the path normalisation that exists. The decision for every
other case must stay what it is today.

Tests: (1) two ranged reads of one file with disjoint ranges: the older one is NOT stale;
(2) a later ranged read that covers the earlier range: stale; (3) equivalence: for a seeded
random script of 300 reads and writes over 20 paths, the new function returns the same stale set
as the old implementation, except for the disjoint-range cases (keep the old function in the
test file as the oracle and filter those cases); (4) 10,000 reads plan in under 300 ms.

Verification: `npx --prefix app vitest run --root app ../conductors/in-process/keel-lite ../conductors/in-process/keel-note ../conductors/in-process/taskfold`, then the gate.

## P4: thermocline pricing and safety (C2, C4, C5, C6, C7, C9) — branch `fix/thermocline-pricing`

Files: `conductors/ws/thermocline/policy.ts`, `thermocline.ts`, their tests, the regenerated
`remote-sdk.mjs`. One commit per finding. Order: C4, C9, C5, C6, C2, C7.

- **C4** (`policy.ts:928-930`): a block with `ViewBlock.signed === true` is never a per-block fold
  candidate and contributes no projected saving. It may still be a member of a whole-message
  group. Test: a signed thinking block in the compress zone gets no `replace`/`fold` op.
- **C9** (`policy.ts:347-348`): graduation requires the folded state of the members that CAN be
  folded (kinds `text`, `thinking`, `tool_result`), not of the tool call. Test: a cold tool pair
  whose result is folded graduates after the dwell.
- **C5** (`policy.ts:276-278`, `thermocline.ts:1334-1338`): the projected cost of a newly planned
  fold is the token count of the text that will be written (digest or trim, including its
  `{#code FOLDED}` tag), computed with the same counter the plan uses for strata. Test: a plan
  whose trims are longer than the engine digests still projects at or under the cap that
  `serializeWire` then measures.
- **C6** (`policy.ts:860-862`): a DROP stratum's projected cost is what the role floor leaves:
  use the canonical computation (`computeDegradedDropRuns` in `core/wire.ts`, the same one
  `Truth` uses) to find drops that degrade to a recap and charge the recap text. Test: a drop
  that would leave two same-role neighbours is priced above zero and the hard-cap check holds
  against the serialized wire.
- **C2** (`policy.ts:699-706`, `:272-288`): `project()` builds its block index once per plan; the
  ladder keeps a running projected cost and updates it per added move. Test: equivalence of the
  resulting plan with the old implementation on the existing policy fixtures (they must pass
  unchanged) plus a guard: 20,000 blocks and 5,000 moves plan in under 1 s.
- **C7** (`thermocline.ts:844-845`): look up `appliedFolds` first and call `foldBody()` only for
  units without an applied body.

Verification: `npx --prefix app vitest run --root app ../conductors/ws/thermocline`, `node extension/build-remote-sdk.mjs`, `node extension/smoke-conductor.mjs`, then the gate.

## P5: remote listener leak and triptych cache (C11, C12) — branch `fix/remote-triptych-leaks`

Files: `core/conductor/remote.ts`, `core/conductor/remote.test.ts`,
`conductors/ws/triptych/triptych.ts` and its test, both regenerated bundles.

- **C11** (`remote.ts:205`): the abort listener added per `complete()` is removed when that
  completion settles (result, rejection, cancellation, connection drain): keep the remover in the
  pending entry. Test: 200 settled completions on one `AbortSignal` leave zero listeners (count
  them by wrapping `addEventListener`/`removeEventListener` on the signal).
- **C12** (`triptych.ts:283-290`): delete a `skelCache` entry when its block has been swept into
  a summary group and when a resync no longer contains the block. Test: after the top band
  swallows 50 skeletonised blocks the cache holds none of their ids.

Verification: `npx --prefix app vitest run --root app ../core/conductor/remote.test.ts ../conductors/ws/triptych`, `node extension/build-remote-sdk.mjs`, `node extension/smoke-conductor.mjs`, then the gate.

## P6: privacy declarations (C13) — branch `fix/conductor-privacy`

Files: `core/conductor/registry.ts`, its test, `extension/smoke*.mjs` where a smoke attaches one
of these conductors, `README.md`/`extension/README.md` conductor tables, `conductors/README.md`.

Current: only Taskfold declares `privacy` (`registry.ts:238`). `agedSummaryConductor.ts`
(compaction-naive, handoff, triptych's base), `keel-note.ts` and `thermocline.ts` call
`host.complete` with session text, so `selectConductor` attaches them without the consent gate
(`extension/privacyGate.ts`). Root `AGENTS.md` requires the declaration.

Change: add `privacy: { models: ["chat"], notice }` to the entries of `compaction-naive`,
`handoff`, `keel-note`, `thermocline` and `triptych`. No `deferred` (they have no deterministic
tools), no custom `consentKey` (the default key per conductor id applies; check
`privacyGate.ts` for how the key is derived). Notice text, one per conductor, same style as
Taskfold's: what is sent (compaction-naive, handoff, triptych: the aged part of the transcript;
keel-note: the text of trimmed spans; thermocline: the units it compresses), to which model (the
conductor's chat model, by default the session model), and that the provider receives and may log
it. The gate already skips consent when every routed model is local.

Then fix what the gate breaks: `extension/smoke-conductor.mjs` and `smoke-autoarm.mjs` attach
thermocline; give their isolated home a `privacyConsent` entry for the conductor they attach.
Search tests for `selectConductor` with one of the five ids and do the same.

Test that matters: a registry test asserting that EVERY entry whose conductor source calls
`host.complete` declares `privacy` (list the five ids plus taskfold explicitly), and a host test:
selecting `keel-note` without consent asks and does not attach on refusal.

Verification: `npx --prefix app vitest run --root app ../core/conductor`, the gate (all smokes).

## P7: compaction against SPEC-0001 §7 (S1, compaction rows) — branch `fix/compaction-spec`

Files: `extension/compaction.ts`, its test, the compaction parts of `extension/accordion.ts`
(`:660-720`, `:3186-3196`, `:3870-3910`, `compactPreview` at `:4460-4472`), `core/protocol.ts`
only for the result shape below. Spec: `.project/specs/0001-accordion-ui-polish.md` §7 (read
§7.1–§7.6 first). Rows: `evidence/Spec0001Audit.md`, the lines that name §7.

- **dryRun** (`compaction.ts:112-169`): `req.dryRun === true` computes the projection and returns
  it without calling `Truth.apply`, without an undo record and without a card. The WS `compact`
  command with `dryRun` answers with a `compaction` message that carries `dryRun: true` and the
  projected numbers per strategy (reuse the shape `compactPreview()` returns:
  `{ pass, aggressive, bake, native }`); add the optional fields to `CompactionMessage` in
  `core/protocol.ts` additively (no version bump: optional fields, old clients ignore them).
- **bake projection**: `compactPreview().bake` is the estimated size of the bake summary
  (`buildBakeSummary` length / 4), not the tokens freed.
- **Undo** (§7.4): the undo record also holds the ids of groups the pass created and undo emits
  `ungroup` for them; `folded.groups` reports their count; a session switch (`session_start`,
  `session_shutdown`) clears `lastCompact`.
- **Threshold fallback** (§7.2, `accordion.ts:3874-3897`): a saturated threshold pass applies
  `compact.onSaturated`, including `bake`; today only `overflow` reaches the bake branch.
- **Quiet cancels** (§7.6, `:3884-3908`): a threshold pass that cancels updates the footer status
  only: no notify, no broadcast.
- **Bake summary** (§7.5, `compaction.ts:66-109`): header
  `[accordion-bake v1] <N> messages · <before> → <after> tok`, each folded group once, unfolded
  non-user blocks as their engine digest (`digest()` from `core/digest.ts`), task records as their
  own sections, the cap as the spec states it.

Tests (`extension/compaction.test.ts` or the existing compaction tests): dry run leaves `rev`
unchanged and returns projections; undo after a pass that created a group restores the block and
group state exactly (compare a snapshot before and after); threshold + saturated +
`onSaturated: "bake"` requests the bake; the bake header format.

Out of scope: the panel preview screen and the web dialog (P8, P9 consume what you return).

Verification: the unit's tests, `node extension/smoke-context.mjs`, the gate.

## P8: panel against SPEC-0001 §3, §5, §6.2, §8 (S1, panel rows) — branch `fix/panel-spec`

Files: `extension/tui/**` (not `taskWidget.ts`, `taskTree.ts`, `taskViews.ts`: P15), the footer
call in `extension/accordion.ts:1019-1033` and `displayWebHost` at `:564-583`. Spec sections as
named per row in `evidence/Spec0001Audit.md`. Decisions per row (where this list says "spec text",
the code stays and P20 corrects the spec):

| Row | Decision |
|---|---|
| §3.2 Overview `line()`/`wrapped()` | implement: measure with `visibleWidth` and fit with `fitSegments` |
| §3.5 selected timeline cell inverse | spec text (a grid cell is not a row) |
| §3.8 body cap, §4.4 `?`, §4.12 `b`/`t`, §5.2 tab list, §5.6 cursor glyph, §6.1 key table, §6.2 section list | spec text |
| §5.3 context bar width and legend layout | spec text |
| §5.3 Tasks row | implement: `<title> <done>/<total> · ≡<folded> · <current id and title>`; Enter on that row opens the Tasks tab |
| §5.3 Web UI host | implement: for `0.0.0.0` and `::` show the first non-internal IPv4 from `os.networkInterfaces()`; no OSC 8 (spec text) |
| §5.4 cell glyph by weight | implement with the existing unused `weightGlyph` (`timeline.ts`) |
| §5.4 task label | implement: `▣ task <key> "<title>"`, title cut to fit |
| §5.4 `!` on the system cell | implement |
| §5.4 group colour | spec text (accent stays) |
| §5.4 prompt width | implement the spec's clamp formula |
| §5.4 grid flags | implement: blank instead of `.`, `P` only on the first protected cell |
| §5.4 list columns | implement `kind(10) state(14) tokens(8) label(rest)` |
| §5.5 inspector header and `home`/`end` | implement |
| §5.6 privacy badge | implement: only when the entry has `privacy` and the routed model is not local (the host already knows whether consent is required; expose that boolean on the conductor row instead of `!!entry.privacy`) |
| §6.2 lock labels | implement: `<ENV NAME or --flag> · locked`, and the refusal message names it |
| §7.6 preview | implement: an instructions input line in the `alt+c` preview (typed text is passed as `instructions`), bake row shows `≈ <n> summary`, `alt+c` on the Overview opens the same preview |
| §8 footer | implement in `status.ts`: build segments `accordion <usage%>`, conductor label, timing, status text; measure with `visibleWidth`; when the whole line exceeds `max`, drop the status text first, then the timing, then switch to the compact form `acc <usage%> · <conductor id> <✓ or ▲ or ✗>`; never cut inside a character (no surrogate split). The level glyph is always present when a status level is warning (`▲`) or error (`✗`). |

Tests: extend `extension/tui/*.test.ts` per changed renderer (literal expected lines at 36, 57,
80 and 140 columns for the footer, the timeline labels and the list columns); the printable-key
sweep in `panel.test.ts` still passes with the new instructions input (printable keys type, they
do not act). Live: run the recipe above at 36 and 140 columns, capture Overview, Context (grid
and list), Conductors, Settings and the compact preview with `tmux capture-pane -p`, and paste
the captures into the report.

Verification: `bun test extension/tui/*.test.ts`, the gate, the live captures.

## P9: web surface against SPEC-0001 §9 and §6.3 (S1, web rows) — branch `fix/web-spec`

Files: `app/src/lib/ui/live/SettingsPanel.svelte`, `TasksPanel.svelte`, `CompactDialog.svelte`,
`app/src/lib/ui/map/MapHeader.svelte`, `app/src/lib/live/liveClient.svelte.ts`, their tests, and
two host spots in `extension/accordion.ts`: `updateSettings` (`:3177-3185`) and `broadcastTasks`
(`:1372-1380`, `:3301`). Load the `ui-ux-implementation` skill is not needed; follow the existing
components. Svelte 5 runes; `npm --prefix app run check` must stay at 0 errors and 0 warnings.

- **updateSettings** (§6.3): do not refuse a stale `baseRev` up front. Pass the patch and the
  `baseRev` to `SettingsStore.save`, which already merges different fields and reports a conflict
  for the same field; map its result to `commandResult` (`conflict: true` plus `error` text).
- **tasks broadcast** (§9): the Truth-change listener that calls `taskWidget.sync()` also
  schedules `broadcastTasks()` through one 250 ms trailing debounce (clear the timer on session
  shutdown).
- **SettingsPanel**: keep staged values until the `commandResult` for that command arrives; show
  "Saved to the session host." only on success; on `error`/`conflict` keep the staged values and
  show the error text. `liveClient` must expose the result of a command to its caller (it ignores
  `commandResult.error`/`conflict` at `:492-499` today): return a promise from the send function
  that resolves with the matching `commandResult` (match by the command id the protocol already
  carries; read `core/protocol.ts` `CommandResultMessage`).
- **TasksPanel** (§4.4 as referenced by §9): a tree, not a flat list: indent by depth, glyphs
  `▣ ☒ ⊘ ◐ ▶ ⧗ ☐` coloured through CSS tokens (success, error, muted, warning; never the reserved
  user blue `#044EFF`), click on a parent row toggles its children, a `≡` marker and
  `full → live` tokens on folded rows, finished siblings collapsed into one
  `… N finished` row that expands on click.
- **MapHeader**: a collapsed task summary `Tasks <done>/<total> · ≡<folded>` next to the
  saved/pressure numbers, shown when the host sent a task list.
- **CompactDialog**: on open and on strategy change send `compact` with `dryRun: true` and show
  the projections from the `compaction` reply that has `dryRun: true` (shape: P7); remove the
  read of `settings.lastConductorSaved`. Until P7 is merged the reply never comes: show `…` for
  the numbers in that case and keep the Run button working.

Tests: component/unit tests next to the existing ones in `app/src/lib/**` for the tree builder
(pure function: tasks → rows with depth, collapsed finished run, toggle state), the command
promise in `liveClient`, and a host test or smoke for the two-field merge over the WS (two
`updateSettings` with the same `baseRev` on different keys both persist; same key: the second
gets `conflict`).

Verification: `npm --prefix app run check`, `npm --prefix app test`, `node extension/smoke.mjs`, the gate.

## P10: recall navigation and SPEC-0003 edges (U3, U4, U6, S3) — branch `fix/recall-navigation`

Files: `core/recallView.ts`, `core/recallSearch.ts`, `core/agentView.ts`, their tests, the
`recall`/`unfold` descriptions and the `ask` path in `extension/accordion.ts` (`:4736`,
`:4850-4911`), `.project/specs/0003-recall.md`, both skills under
`extension/skills/accordion-context-*`. Read SPEC-0003 first; root `AGENTS.md` says: change the
contract → update the tool description and both skills.

- **U4** (`recallView.ts:207-238`): a task report honours `page`: sections and subtask rows are
  split into pages of the call limit; each page ends with the exact call for the next page.
- **U3**: the report of a task lists ALL descendants with their codes, indented by depth, not only
  direct children; a descendant whose own carrier is gone (absorbed) is addressed as
  `<ancestor code>.<n>` the way `code.N` entries already work. Check where handles are dropped
  (`taskfold.ts:1194-1196`); if the code is not recoverable from `core/` alone, keep the handle in
  the group's `handles` (do not print it in the standing carrier) and state in the report what you
  changed there. Test: a three-level tree, all folded into the root: `recall` of the root's code
  prints the grandchildren's addresses and each of them recalls its own content.
- **U6** (`recallView.ts:155-166,365-386`, `agentView.ts:180-203`): search builds one index per
  Truth `rev`: code → member block ids, and per member the lower-cased text; a search and its
  pages reuse it while `rev` is unchanged. Resolving metadata for the result list does not join
  full texts. Test: two searches and three pages on an unchanged Truth of 5,000 blocks call the
  text join once (count through an injected spy or a module counter).
- **S3**: unknown regex flags are rejected with an error line that names the allowed flags
  (`recallSearch.ts:40,65`); a query longer than 200 characters is refused with a message, not cut
  (`recallView.ts:26,101`), and SPEC-0003 §2 states the 200-character limit; a codeless search
  that overflows lists what it did not show in a `Not shown:` line like the coded form
  (`recallView.ts:138`); `recall({ask})` charges the account through `serveRecall`
  (`accordion.ts:4850-4879`); SPEC-0003 §7 states the 1,000-character `ask` limit; the `recall`
  description mentions the facts line, clipped results and expiry stubs in one sentence each and
  says the limits are settings; the `unfold` description names both refusal reasons.

Verification: `npx --prefix app vitest run --root app ../core/recallView.test.ts ../core/recallSearch.test.ts ../core/recallAccount.test.ts ../core/recallInvariant.test.ts`, `node extension/smoke-context.mjs`, the gate.

## P11: type check gate (D1) — branch `chore/extension-typecheck`

Files: `conductors/in-process/agedSummaryConductor.ts`, four spots in `extension/accordion.ts`,
new `extension/tsconfig.check.json`, `extension/package.json` (`check` script), root `AGENTS.md`
("Running & verifying").

- `extension/tsconfig.check.json`: `target ES2022`, `module ESNext`, `moduleResolution bundler`,
  `strict`, `noEmit`, `skipLibCheck`, `allowImportingTsExtensions`, `types: ["node"]`,
  `files: ["accordion.ts"]`. Script: `"check": "tsc -p tsconfig.check.json"` with `typescript`
  5.9 as a devDependency of `extension/` — it is not installed there: check
  `ls extension/node_modules/.bin/tsc`. If absent, use `"check": "npx -y -p typescript@5.9 tsc -p tsconfig.check.json"`
  and add no dependency (the integrator owns manifests and lockfiles).
- Fix the seven errors: `agedSummaryConductor.ts` TS2612 ×3 (a subclass property overwrites a base
  property: declare it with `declare` or assign in the constructor instead of a field
  initialiser, whichever keeps runtime behaviour identical); `accordion.ts` TS2345 ×2 (an optional
  URL string passed where a string is required in the WebSocket origin check: narrow it) and
  TS2322 ×2 (`unfold`/`recall` `execute` return type: return the `details` shape the tool type
  asks for).
- Do not add `// @ts-ignore`, `as any` or loosened compiler options.

Verification: `npm --prefix extension run check` exits 0; the gate.

---

## P13: taskfold planner cost (T1–T6) — branch `perf/taskfold-planner`

Files: `conductors/in-process/taskfold/taskfold.ts`, `taskfold.test.ts`. The planner's OUTPUT must
not change: same units, same ops, same `reasons`, same statuses. Only the work to get there.

Current: `onEvent` (`taskfold.ts:535`) calls `evaluate()` on `blocks-appended`, `turn-committed`,
`wire-departing`, `resync` and human `state-changed`. `evaluate()` (`:792`) always calls `plan()`
(`:829`), which materialises `host.blocks()`, scans all task spans, and then: tests ancestry with
`spans.some((o) => contains(o, s))` per span; calls `host.groups()` in `plan`, `groupKeys`,
`condense`, `foldRuns` and several times inside `unit` (`:1121-1208`, some per block:
`heldByHuman` at `:1135`); filters all blocks per task in `spanHandle`/`record` (`:1215`,
`:1273`); counts `tool_result` blocks after each span with `blocks.slice(span.end + 1).filter`
(`:930`); and under pressure `floor`, `untracked` and `steps` each run `scanTaskSpans`,
`taskCoverage` and `deliveryOwners` again.

Steps, one commit each:

0. **Characterisation test first, on the untouched code.** A seeded generator builds a `TestHost`
   session: at least 150 tasks over two lists, nesting to depth 3, end states `done`, `failed`,
   `abandoned` and still open, `blocked` with a reason, untracked runs of 3 to 12 assistant
   messages between tasks, `read` calls of `.md` files, `tasks start` results carrying criteria.
   Drive the conductor event by event (`blocks-appended`, `turn-committed`, `wire-departing`) with
   a budget small enough that at least five pressure epochs happen, with a fixed `foldPolicy`
   (`now`, `lastRequestAt`) so nothing depends on the clock. Record every `host.debug` record of
   type `epoch` (dropping one that is deep-equal to the record just before it, so the skip of
   step 6 does not change the result) and every op list passed to `propose`, and compare with
   `toMatchSnapshot()`. Three
   seeds; one with `floor: true`, one with `timing: "lazy"`. Commit the snapshot. Every later step
   leaves it byte-identical.
1. **T1.** In `plan`, build once `resultsAfter[i]` = number of `tool_result` blocks at index >= i
   (one backward pass); `stepsSince = resultsAfter[span.end + 1] ?? 0`.
2. **Ancestry by key set.** `contains(outer, inner)` is `inner.key.startsWith(outer.key + ".")`,
   so an ancestor's key is a prefix of the key that ends just before a `.`. Add
   `nearestAncestor(key, keys: ReadonlySet<string> | ReadonlyMap<string, unknown>): string | null`
   that walks the `.` positions from the right. Use it for `allRoots`, `roots`, the "top-level
   among descendants" filters in `fold`, and the diagnostics' `ancestor` (nearest ancestor that
   has a reason: walk upward until `reasons.has`).
3. **T5, T2: one snapshot per plan.** Introduce `interface PlanContext` built once at the top of
   `plan`: `blocks`, `groups` (ONE `host.groups()` call), `groupKeys` (from that snapshot),
   `positions: Map<blockId, index>`, `groupOf: Map<blockId, GroupInfo>`, `humanGrouped:
   Set<blockId>` (members of groups whose `by !== "auto"`), `scan` (ONE `scanTaskSpans`),
   `coverage` (ONE `taskCoverage`), `deliveries` (ONE `deliveryOwners`), `userTail`,
   `resultsAfter`. Pass it to `unit`, `condense`, `floor`, `untracked`, `steps`, `foldRuns`; none
   of them calls `host.blocks()`, `host.groups()`, `scanTaskSpans`, `taskCoverage` or
   `deliveryOwners` any more. `plan` does not propose, so the snapshot stays valid for the whole
   call; `commit` and `reconcileTaskUnfold` keep reading fresh state. Every
   `g.memberIds.includes(id)` / `groups.some(...)` per block inside those functions becomes a map
   or set lookup.
4. **T4.** `spanHandle` and `record` walk the span's intervals
   (`for (const r of task.intervals) for (let i = r.start; i <= r.end; i++)`) instead of
   `blocks.filter((_, i) => intervals.some(...))`. Keep the resulting order (ascending index).
5. **T6.** `floor` takes spans, coverage and deliveries from the context. The two `KeelLiteConductor`
   instances stay (their read analysis is linear since `34061d4`).
6. **T3: skip an unchanged idle state.** `private idleKey: string | null = null`. In `evaluate`,
   after computing `stats`, `pressure` and the policy's `cold` flag, build
   `key = [stats.rev, stats.budget, stats.protectTokens, stats.liveTokens, pressure, policy.timing, cold].join("|")`.
   If `key === this.idleKey`, return at once. When `plan` returned no unit (both the healthy and
   the saturated branch), set `this.idleKey = key` after setting the status. Set it to `null` in
   `commit`, `attach`, `detach`, and in a private `touch()` called wherever conductor-owned state
   that the plan reads changes: every `this.verdicts.set…` call, every add or delete on
   `this.classifying` and `this.routing`, `reconcileTaskUnfold`, and an options change. Find them
   with `rg -n 'this\.verdicts\.set|this\.classifying\.(add|delete)|this\.routing\.(add|delete)' taskfold.ts`.
7. **Classifier queue leftovers** (from the T8 fix): a capacity error puts the item back and must
   not restart it in the same tick. Drain only when another classifier call settles or on the next
   `blocks-appended` / `turn-committed` event; when no call is in flight, arm one
   `setTimeout(() => this.drainClassifiers(), 250)` (cleared in `detach`). Replace the
   `this.host === host` checks of the classifier bookkeeping by a `private generation` counter
   incremented in `attach` and `detach` and captured per call, so a call from before a detach can
   never decrement the counter of a later attach of the same host object.

Tests besides step 0: (a) `blocks-appended`, `turn-committed`, `wire-departing` in a row with no
state change between them: `host.blocks` is called by one plan only (wrap it and count); after a
classifier verdict arrives the plan runs again. (b) 20,000 blocks, 400 finished and folded tasks,
no pressure: one `evaluate` from a cold `idleKey` takes under 150 ms; print the time before your
change and after in the report. (c) Capacity error with fake timers: the item is retried after
another call settles, never synchronously.

Out of scope: any change to what folds or when; host-closed spans; history budget.

Verification: `npx --prefix app vitest run --root app ../conductors/in-process/taskfold`, then
`.pi/gate/gate.sh <worktree>` (five checks).

## P12a: ingest fingerprint budget (H6) — branch `perf/ingest-fingerprint`

Files: `core/wire.ts` (next to `contentFingerprint`, about `:372`), `core/wire.test.ts`,
`extension/accordion.ts` (`ingestMessages` about `:3030-3062`, `setLastMessages`, `lastFps`,
`sameMessageIdentity`), `extension/smoke-context.mjs`, `docs/adr/0021-truth-in-the-extension.md`
(hot-path note), both regenerated bundles.

Current: every `context` hook calls `contentFingerprint` on every message of the incoming array:
a full FNV pass over all text (Pi hands over a deep copy, so object identity is gone). Measured on
a 1.1M-token session: 10.9 s of a 37 s replay, 5 to 9 ms per MB, and the array reaches 6 MB.

Change:

1. `core/wire.ts`: add `export function contentSignature(m: PiMessage): number`, O(parts): FNV
   over the role tag, the part count, each part's type tag and text length, the tool-call name and
   `isError`, and for each text at most 192 characters (first 64, last 64, 64 taken at an even
   stride). No full pass.
2. `accordion.ts`: keep `lastSigs: number[]` beside `lastFps`. In `ingestMessages`, for each old
   message `i < prev.length`: compute `contentSignature`; differs from `lastSigs[i]` → diverged.
   Full `contentFingerprint` only for (a) the last 8 old messages, (b) a rotating window of older
   messages: start at `verifyCursor`, hash whole messages until 262,144 characters were hashed in
   this hook, store the cursor, wrap at `prev.length - 8`; a mismatch with `lastFps[i]` →
   diverged. Old messages outside (a) and (b) keep their stored fingerprint. New suffix messages
   get both values as today. `rebuildTruth` recomputes both for all messages and resets the cursor.
3. Rewrite the `COST` and `RESIDUAL GAP` paragraphs above `contentFingerprint` and the ADR note:
   a rewrite that changes length, part shape or a sampled character, and any rewrite of the last
   8 messages, is seen in the same hook; a same-length rewrite elsewhere is seen within
   `ceil(total characters / 262,144)` hooks.

Tests: `contentSignature` differs for a length change, a part-count change, an `isError` flip and
a change in the first 64 characters; smoke-context: (1) a same-length rewrite in the middle of
the newest old message rebuilds in the same hook; (2) the same in message 2 of 400 large messages
rebuilds within the bound, and the hook after it serves the new text to `recall`; (3) a length
change in message 2 rebuilds in the same hook.

Out of scope: `messageInfo`, `Truth.append`.

Verification: `npx --prefix app vitest run --root app ../core/wire.test.ts`,
`node extension/smoke-context.mjs`, `node extension/build-remote-sdk.mjs`, the gate, and
`node extension/replay-session.mjs "<session A>" --limit-requests 1230 --out /tmp/p12a.json`
before and after (report `hookMs` and `ingestMs`; delete the file; session path from the
integrator, never commit its content).

## P15: task tooling — six units, files disjoint

Code map with functions, lines, callers, tests and settings per finding:
`evidence/p15-map.md` (groups A to F). Read your group there before anything else. Decisions:

- **P15A coach** (U8, U9; `extension/taskCoach.ts`, its test, SPEC-0002 §3.4/§12 sentences;
  branch `fix/task-coach-recurrence`).
  - U8 coach mode: replace `remindedNoList`/`remindedNoLeaf` by a recurrence. After the first
    reminder, remind again when 25 further untracked work results passed, then 50, 100, 200 and
    every 200 after that. The counter is not reset by `started()`; it resets when a result is
    tracked and on `userPrompt()`. Repeats use one line: `Still untracked: <n> tool results
    without a task. <next step>` where the next step is the existing repair phrase (start the
    named next task, or create a list). With a list but no task to name: stay silent, as today.
  - U8 gate mode: after the gate failed open it closes again after 50 further untracked calls
    and refuses once (one refusal, then open for the next 50). `gateFailOpenAfter` keeps its
    meaning for the first opening. The notice in `accordion.ts:3504-3508` says "for the next 50
    calls" (that line is yours).
  - U9: the large-leaf reminder and the floor-fold note are emitted in `gate` mode too. The
    large-leaf reminder is emitted when the leaf first crosses the threshold and again each time
    its size doubled since the last emission, not every ten results.
- **P15B resume note** (U7; `extension/taskBinding.ts`, its test; branch `fix/task-resume-note`).
  A changed resume and a UI attachment send, instead of `renderList`'s whole tree: counts per
  status, the active branch (root to the task in progress or the next task, id and title per
  level), blocked tasks (id, reason; at most 10, then `+N more`), the next task, the changed ids
  (at most 20, then `+N more`), and the line `Whole list: tasks status`. `renderList` stays for
  its other callers. Test: 300 tasks, changed resume, the note is under 1,500 characters and
  names the active branch and the changed ids.
- **U16: no change.** SPEC-0001 §4.15 defines `complete` only from `doing`; the refusal names
  the repair (`start`, then `complete`). One extra call does not justify a contract change in
  store, tool description, Taskfold and views.
- **P15C widget** (U10, widget text code rows; `extension/tui/taskWidget.ts`, `taskTree.ts`,
  their tests; branch `fix/task-widget-reveal`). Clicking a hidden-siblings row reveals at most
  10 more rows of that run; the rest stays behind the same `… N more` row. At most 30 revealed
  rows per widget; beyond that the row reads `… N more · alt+t Tasks` and a click does nothing.
  Header and row token pair follow SPEC-0002 §10.1/§10.2 as listed in the map ("code" rows only).
  `foldedTaskIds`/`foldedTaskTokens` keep their signatures (a Vitest file imports them).
- **P15D views** (U11; `extension/tui/taskViews.ts`, `taskTranscript.ts`, their tests; branch
  `perf/task-views-cache`). Cache the structural tree and the per-span token charges by
  transcript revision; elapsed-time labels are computed at render from cached timestamps. Per-span
  charges come from one pass over the blocks (prefix sums per span interval), not one filter per
  task. Extend the existing cache-count test: ten renders and ten key presses on an unchanged
  transcript build the tree once.
- **P15E facts** (U12; `extension/accordion.ts` only `noteFacts`, its state at `:460-465` and the
  trigger at `:3779-3780`; `core/factLedger.ts`, its test; `extension/settings.ts`,
  `settingsValidation.ts`, `tui/screens/settingsRows.ts`, SPEC-0003 §8; branch
  `fix/fact-ledger-budget`).
  - Idle check: `noteFacts` runs after every tool result and rebuilds `foldedTasks(t)` each time
    (4.1 s of a 37 s replay). Replace `ledgerIdleRev` by `ledgerIdleKey`: the joined ids of the
    `t:` handles of folded groups (`truth.groups`, O(groups)); while the key is unchanged and the
    last scan found nothing to do, return before `foldedTasks`.
  - Own entries only: a task's prompt entries exclude blocks inside a descendant task that
    already has a ledger (hierarchy from the task key: `list/1.2` is inside `list/1`).
  - Session budget: new setting `recall.ledger.maxCalls` (integer 1 to 10,000, default 120):
    side-model calls for fact extraction per session process. A task whose chunks do not fit the
    remaining budget is not started, not added to `ledgerTried`, and the idle key is not set by
    that stop. When the budget is spent: one `ctx.ui.notify` ("fact extraction stopped after N
    calls; recall still searches the full text") and one debug record.
  - Tests: factLedger unit test for "own entries"; smoke-context: budget 2 with three folded
    tasks leaves the third without a ledger and without a prompt; unchanged groups cause no
    second `foldedTasks` scan (count via a spy the smoke can reach, or by timing-free call count).
- **P15F dump** (U13; `extension/tui/transcriptDump.ts`, its test, the three usage lines in
  `accordion.ts`, README and SPEC-0002 §10.3 text; branch `feat/transcript-dump-compact`). New
  flag `--compact` for every format: the outgoing projection only. A folded span prints its
  record, code, title and full/live tokens, without member blocks, task-list metadata or reports.
  Per-node token sums still add up to the wire. Default output is unchanged.
- **Not in these units** (they write `taskfold.ts`, after P13): `stale` in status, widget and
  results; `tasks.zombieSteps`; one stable `t:` code; dropped routing operations logged.

Verification per unit: its test file (`bun test <file>` under `extension/`, Vitest under
`core/`), `node extension/smoke-context.mjs` where it touches `accordion.ts`, then the gate. UI
units (C, D, F output) also run live in a Pi-Bolt terminal per "Environment".

## P12b: no session write on the request path, footer once per tick (H4) — branch `fix/hook-deferred-entries`

Files: `extension/accordion.ts` (only: the two callbacks passed to `taskfoldVerdicts.reset(...)` in
`session_start`, the `context` hook's `try`/`finally`, `session_shutdown`, the line
`nativeListeners.add(refreshConductorPresentation)`), `extension/smoke-context.mjs`.

Current: Pi's `appendEntry` is `appendFileSync`. Two paths reach it inside the `context` hook:
`VerdictLedger.set` for harness and opening verdicts (Taskfold `classifyBlocks`, run from
`blocks-appended` during `ingestMessages`), and `VerdictLedger.setUnfold` from `plan()` under
pressure (run from `wire-departing`). The footer listener `refreshConductorPresentation` runs on
every broadcast, three to four times per request, each time forcing a fresh `stats()` walk; the
last one runs after `recordHook`, so its time is not in the hook telemetry.

Change:

1. Deferred entries. Next to `debug()`:

   ```ts
   // Session entries produced while the context hook runs are written after it returns.
   let hookDepth = 0;
   const deferredEntries: { session: string; type: string; data: unknown }[] = [];
   function persistEntry(type: string, data: unknown): void {
       if (hookDepth === 0 && deferredEntries.length === 0) { pi.appendEntry(type, data); return; }
       deferredEntries.push({ session: sessionId, type, data });
   }
   function flushDeferredEntries(): void {
       for (const e of deferredEntries.splice(0)) {
           if (e.session !== sessionId) continue;
           try { pi.appendEntry(e.type, e.data); }
           catch (err) { console.error("[accordion] deferred session entry failed:", err); }
       }
   }
   ```

   A non-empty queue also takes entries produced outside the hook, so their order in the session
   file is the order they were produced in. The two `taskfoldVerdicts.reset` callbacks call
   `persistEntry(VERDICT_ENTRY, …)` and `persistEntry(UNFOLD_ENTRY, …)`; they keep their
   `sessionId === sessionAtStart` check. Other `appendEntry` calls stay direct (none of them runs
   inside the hook).
2. `context` hook: `hookDepth++` as the first statement of the `try`; in the `finally`, before
   `markSent`: `hookDepth--; if (deferredEntries.length) setImmediate(flushDeferredEntries);`.
3. `session_shutdown`: call `flushDeferredEntries()` first, before any state is cleared.
4. Footer: replace `nativeListeners.add(refreshConductorPresentation)` by a listener that sets a
   flag and schedules one `setImmediate`; the callback clears the flag and calls
   `refreshConductorPresentation()` only if `sessionId` is still the one captured when it was
   scheduled. Direct calls of `refreshConductorPresentation()` elsewhere stay synchronous.

Test (smoke-context, next to "debug records receipts and rejected tasks without synchronous
writes on the context hook"): attach the Taskfold conductor, arm folding, wrap the fake Pi's
`appendEntry` to record whether it was called while the `context` handler's promise was pending;
run a request whose new messages contain a harness message (`<system-reminder>` text as a user
message, matched by `TASKFOLD_DEFAULTS.harnessPatterns`) so a verdict is produced during
ingest. Assert: no `appendEntry` call before the handler resolved; after
`await new Promise(setImmediate)` the verdict entry is there; a verdict produced after the hook
but before the flush lands after the queued one. Existing smoke checks that read the footer
right after an action await one `setImmediate` first; list every check changed that way in the
report.

Out of scope: the other listeners in `nativeListeners` (tool activation must stay synchronous),
`broadcast` itself.

Verification: `node extension/smoke-context.mjs`, `npm --prefix extension run smoke`,
`bun test extension/tui/status.test.ts`, the gate.

## P12c: one serialisation per broadcast, bounded socket buffer (H10) — branch `fix/ws-outbound-bound`

Files: `extension/accordion.ts` (only `send`, `broadcast`, `sendSnapshot`, the constants beside
`MAX_WS_PAYLOAD_BYTES`, `RuntimeDependencies`), `extension/smoke.mjs`, SPEC-0001 or README text
only if one of them states the socket behaviour (search for `bufferedAmount`, "slow client").

Current: `send(ws, m)` runs `JSON.stringify(m)` per client; nothing reads `ws.bufferedAmount`
(`ws` package, the property exists), so a client that stops reading queues every snapshot.

Change: `send(ws, m)` becomes `sendText(ws, text)` plus a thin `send` that stringifies for the
single-client call sites; `broadcast` stringifies once and calls `sendText` per open client.
`sendText` first checks `ws.bufferedAmount > Math.max(wsBufferLimit, 2 * lastSnapshotBytes)` and
then calls `ws.terminate()` and returns (the existing close handler removes the client; the app
shows "disconnected" and gets a fresh snapshot when it dials again). `lastSnapshotBytes` is the
text length of the latest snapshot `sendSnapshot` serialised: a client can always take one whole
snapshot plus what follows it in the same tick, and is cut off only when it lags by more than
that. `wsBufferLimit = dependencies.wsBufferLimit ?? MAX_WS_BUFFERED_BYTES`,
`MAX_WS_BUFFERED_BYTES = 64 * 1024 * 1024`; add `wsBufferLimit?: number` to
`RuntimeDependencies` with a doc line naming it a test seam.

Test (smoke.mjs, in the WebSocket hardening part): start the extension with
`wsBufferLimit: 256 * 1024`; connect two clients; pause the first one's underlying socket
(`client._socket.pause()`) after its snapshot; drive broadcasts by appending messages through
the fake Pi's `message_end` until the server closes the first client. Assert: the first client
is closed within the loop's bound (fail after 2,000 broadcasts), the second client keeps
receiving events with matching `rev`, and a new connection gets `hello` and a `snapshot`.

Verification: `npm --prefix extension run smoke`, the gate.

## P18: sealed turns fold like finished tasks (U5, U14) — branch `feat/taskfold-sealed-turns`

Files: `conductors/in-process/taskfold/taskfold.ts` (`TaskfoldOptions.untracked`,
`TASKFOLD_DEFAULTS`, the constructor check, `plan`, `untracked`, `foldRuns`), `taskfold.test.ts`,
`replay.test.ts` and `core/conductor/liveHost.test.ts` (option literals only),
`extension/settings.ts`, `settingsValidation.ts`, `tui/screens/settingsRows.ts`,
`settings.test.ts`, SPEC-0002 §8 table row 5, §9.3 and §12, `extension/README.md` and
`conductors/in-process/taskfold/README.md` rows that name `untracked.minSteps`.

Current: work outside every task span ("untracked") folds only under pressure, only in runs of
at least `untracked.minSteps` (8) assistant messages, and never across a document read. An agent
that declares no tasks (measured: 44% of work, one model 100%) therefore keeps every turn whole
until the budget is nearly full, and short exchanges and old document reads never fold.

Decisions:

- A run of untracked work is **sealed** when a user message follows it. That is the one signal
  the host has that the work ended. Ruled out: sealing inside a running turn by a token cap; the
  host cannot know the work ended, and pressure folding already covers a long turn.
- Sealed runs fold under the same timing rule as finished tasks (`timingAllows`), without
  pressure. Runs of the current turn fold under pressure only, as today.
- The threshold is reclaimed tokens, replacing the message count: option
  `untracked: { enabled: boolean; minTokens: number }`, default `minTokens: 2000`, range 100 to
  1,000,000. `minSteps` is removed from the option, the settings (`taskfold.untracked.minSteps`:
  type, defaults, sanitize, validation, settings row, tests), spec and READMEs. A stored
  `minSteps` is ignored by sanitize like any unknown key. Under pressure or with a cold cache
  (`cold` in `plan`) the threshold is the constant `UNTRACKED_PRESSURE_MIN_TOKENS = 400`: an
  eager fold rewrites the cached prefix behind it, a cold or forced one does not pay for that.
  `steps.minSteps` stays as it is.
- Without pressure the turn's final reply stays live: the last message of a sealed run when it
  holds no `tool_call` block and the next block is a `user` block. Under pressure it folds as
  today.
- Document reads (`documentCalls` in `foldRuns`): without pressure all stay live, as today. Under
  pressure only the newest read of each path stays live; older reads of the same path fold with
  their run. This also applies to `steps()`, which shares `foldRuns`.

Change:

1. `foldRuns`: replace the parameter `minSteps: number` by
   `limits: { minSteps: number; minReclaimed: number; pressure: boolean }`. Keep the step check
   (`steps.size < limits.minSteps`), replace `if (reclaimed <= 0) continue` by
   `if (reclaimed < limits.minReclaimed) continue`. Build `documentCalls` as a map path → call
   ids in order; excluded are all of them when `!limits.pressure`, else only the last id per path.
   `steps()` passes `{ minSteps: this.k.steps.minSteps, minReclaimed: 1, pressure: true }`.
2. `untracked(host, ctx, need, planned, mode: "sealed" | "pressure", cold: boolean)`:
   `lastUser` = index of the last `user` block (`-1` if none). `ownerOf(i)` returns `null` as
   today, and in mode `"sealed"` also for `i > lastUser` and for blocks of a final reply (see
   decisions; precompute the set of their message keys once per call). Limits: sealed →
   `{ minSteps: 1, minReclaimed: cold ? UNTRACKED_PRESSURE_MIN_TOKENS : this.k.untracked.minTokens, pressure: false }`;
   pressure → `{ minSteps: 1, minReclaimed: UNTRACKED_PRESSURE_MIN_TOKENS, pressure: true }`.
3. `plan`: after the `for (const span of candidates)` loop:
   `if (!recompose && timingAllows && this.k.untracked.enabled)` → `this.untracked(host, ctx, Infinity, planned, "sealed", cold)`,
   push the units, add their member ids to `planned`, subtract `saved` from `projected` (same
   three lines the pressure call uses). The existing pressure call passes `"pressure"`.
4. Settings, spec and READMEs as listed. SPEC-0002 §9.3 states the rule in the words of the
   decisions above; §8's table row "5 untracked" names both cases.

Tests (taskfold.test.ts; the Session helper has `user`, `work(n, label)`, `call`, `start`,
`finish`): (a) no pressure, eager timing: `user`, `work(6)`, a text-only reply, `user`,
`work(2)` → one untracked carrier holding the six steps, the reply and both user messages live,
nothing of the second turn folded; (b) same with `timing: "pressure"` and no pressure → no
group; (c) a sealed run that reclaims less than `minTokens` stays live with a warm cache and
folds when `cold`; (d) under pressure two reads of `docs/spec.md` in sealed runs: the older one
is in a group, the newer one is live; without pressure both are live; (e) the carrier's code
resolves with `resolveRecall`. Rewrite the three existing tests that pin `minSteps` ("folds long
untracked runs…", "does not fold short untracked runs…", "preserves document reads…") for the
new contract and say so in the report.

Replay (report only numbers, read nothing from the file): `node extension/replay-session.mjs
"<session B>" --out /tmp/p18-<before|after>.json` on the untouched worktree and at the end:
`folds`, `liveTokens`, `wireChars.sum`, `invalidatedChars`, `overBudgetRequests`, `hookMs`.

Verification: `npx --prefix app vitest run --root app ../conductors/in-process/taskfold/`,
`bun test extension/settings.test.ts extension/tui/*.test.ts`, `node extension/build-remote-sdk.mjs`
(commit the bundles if they changed), the gate.

## P24a: stale tasks and `tasks.zombieSteps` (S2) — branch `feat/task-stale-report`

Files: `extension/settings.ts`, `settingsValidation.ts`, `tui/screens/settingsRows.ts`,
`settings.test.ts`, `conductors/in-process/taskfold/taskfold.ts` (only `TaskfoldOptions`,
`TASKFOLD_DEFAULTS`, the two `ZOMBIE_STEPS` uses), `extension/accordion.ts` (only where the
Taskfold conductor's options are built, and where a successful `tasks` tool result is
assembled), `extension/tasks.ts` (only the `TaskResult` type), `extension/taskCoach.ts`,
SPEC-0002 §3.4, §5.3 and §12, `extension/README.md` settings block.

Current: SPEC-0002 §5.3 says an open span with no task event for `tasks.zombieSteps` (default
40) steps, while other tasks start and finish, is reported as stale and offered to the agent in
the next `tasks` result as `{"stale": ["<id>"]}`. The code has the constant `ZOMBIE_STEPS = 40`,
no setting, and uses `staleSpans` only for the saturation status text. Separately,
`tasks.largeLeaf.repeatEvery` is read by nothing since the large-leaf reminder repeats on
doubling.

Change:

1. Setting `tasks.zombieSteps`: integer 1 to 10,000, default 40 (type, `DEFAULT_SETTINGS`,
   `sanitizeTaskSettings`, `validateSetting`, a Settings row "Stale after steps" in the Tasks
   section, spec §12).
2. Taskfold option `zombieSteps?: number` (default `ZOMBIE_STEPS`, validated as a positive safe
   integer in the constructor), used at both places that read the constant today. Where
   `accordion.ts` builds the Taskfold options from settings, pass
   `zombieSteps: settings.tasks.zombieSteps`.
3. `accordion.ts`: `function staleTaskIds(slug: string): string[]`, which returns `[]` without a
   Truth and otherwise
   `staleSpans(scanTaskSpans(truth.blocks, (b) => b.text), truth.blocks, settings.tasks.zombieSteps).filter((s) => s.list === slug).map((s) => s.id)`.
   Every successful `tasks` tool result for a list gains `stale: [...]` when the array is not
   empty (also `status`, which the spec names). `TaskResult` gains `stale?: string[]` with a doc
   line.
4. Remove `tasks.largeLeaf.repeatEvery`: settings type, defaults, sanitize, validation, row,
   `CoachPolicy.largeLeaf`, tests, spec §12 and the sentence in §12 that says it is retained,
   README.

Tests: settings test for the new key and the removed one; smoke-context: a list with task 1
left open, 41 tool results after its last event while task 2 starts and finishes → the next
`tasks status` result carries `"stale":["1"]`; with `tasks.zombieSteps: 100` it does not.

Out of scope: the widget and panel marker (P24c, after this merges), `statusOf` in `tasks.ts`.

Verification: `bun test extension/settings.test.ts extension/taskCoach.test.ts`,
`node extension/smoke-context.mjs`,
`npx --prefix app vitest run --root app ../conductors/in-process/taskfold/taskfold.test.ts`, the gate.

## P24b: one stable task code (S2) — branch `fix/taskfold-stable-task-code`

Files: `conductors/in-process/taskfold/taskfold.ts` (only `unit()` and `record()`, plus the
import of `hasOwnFoldTag` from `core/digest`), `taskfold.test.ts`, SPEC-0002 §6.1 and §7.3, the
conductor README where it describes codes.

Current: SPEC-0002 §6.1 says every task has one fold code, `foldCode("t:<list>/<id>")`. In
`unit()` the carrier gets the `t:` tag and handle only when `covered(rootHandle)` holds: every
block of the span is in the carrier's own runs, or is a live user message. Otherwise the tag is
the group's own `g:` code and there is no `t:` handle. The common miss: `complete A` and
`start B` in one assistant message. A folds first and takes that message, so B never gets its
`t:` code and the recall task index does not list it. Children the carrier holds only in part
get a record without a recall code.

Truth's rule for a handle (`Truth.canRecallHandle`, `core/truth.ts`): members in transcript
order; each one is in the carrier group, or in another folded automatic group whose summary
shows that group's own `g:` tag (`hasOwnFoldTag(summary, group.id)`: a root carrier tagged `t:`
does not qualify), or is a visible, unfolded user message; none is held or the system block; at
least one is in a group; the carrier summary contains the handle's tag.

Change:

1. In `unit()`, after `included` is built:

   ```ts
   // Blocks a handle may name besides the carrier's own: members of automatic groups that show their own code.
   const tagged = new Set<string>();
   for (const g of groups) {
       if (g.by !== "auto" || !g.folded || typeof g.summary !== "string" || !hasOwnFoldTag(g.summary, g.id) || ours.includes(g)) continue;
       for (const id of g.memberIds) if (!planned.has(id)) tagged.add(id);
   }
   const reachable = (id: string) => {
       const b = blocks[positions.get(id)!];
       if (b.held || b.kind === "system") return false;
       return included.has(id) || tagged.has(id) || (b.kind === "user" && !this.folds(b) && members.includes(b));
   };
   ```

2. `spanHandle(task)` returns `{ id, memberIds: memberIds.filter(reachable) }`. `covered` is
   removed. A span handle is used when at least one of its members is in `included`. Handles
   inherited from `ours` (group ids and their handles) are kept when every member is reachable.
3. The root: `const rootHandle = spanHandle(span); const rootHeld = rootHandle.memberIds.some((id) => included.has(id));`
   The tag is `foldTag("t:" + span.key)` when `rootHeld`, else the `g:` tag as today; the handle
   list takes `rootHandle` when `rootHeld`.
4. `reach` (`"full" | "partial" | "none"`) becomes `present: Set<string>`: the keys of children
   with at least one member in `included`. `record()` takes `present?: ReadonlySet<string>`
   instead of `reach`, omits children not in it (as "none" today) and gives every listed child
   with intervals its `recall` tag; the `recallable` branches go.
5. Spec §6.1 and §7.3: one sentence each for "the handle names what the carrier and other
   coded groups hold of the task; a block that stays live or held is not part of it".

Tests (taskfold.test.ts): (a) `finish("1")` and `start("2")` in one assistant message, task 1
folds first, then task 2 finishes and folds: the group of 2 starts with
`foldTag("t:work/2")`, its `t:work/2` handle has none of the shared message's blocks, and
`resolveRecall(host.truth, [foldCode("t:work/2")]).missing` is empty; (b) a span with one
human-held block in its middle: `t:` tag, handle without that block, recall resolves; (c) a
parent composing a child it holds only in part: the child's record carries `recall` and that
code resolves; (d) the existing tests that pin a record without a recall code are rewritten.
In none of them may a group op come back clamped (`invalid-group`): assert the propose results
or that every planned group exists.

Verification: `npx --prefix app vitest run --root app ../conductors/in-process/taskfold/`,
`node extension/smoke-context.mjs`, `node extension/build-remote-sdk.mjs`, the gate.

## Later units (sparse; detailed when they start)

- **P24c**: `stale` marker in the widget and the panel list (after P24a). **P12d** (H12): one
  task-span scan per block-log revision, shared by the cache frontier, the tasks broadcast, the
  widget and the stale check.
- **P21 fold pricing** (C5), **P22 DROP pricing** (C6), **P23 incremental projection** (C2), in
  this order, same files (`conductors/ws/thermocline/policy.ts`, `thermocline.ts`). C5 needs an
  exact price for "this text as the body of block X" from the host: `max(countTokens(padded
  text), raw estimate + overhead)` under-charges a block the last receipt did not cover when the
  calibration prior is above the current factor (`core/truth.ts:531-532`). C6: one
  `host.groups()` snapshot per epoch, foreign groups and planned ops into
  `computeDegradedDropRuns`. C2: running cost, equal to a full recount after top-up.
- **P16 notices in Truth** (U1), **P17 history budget** (U2), **P19** U15, U17, U18, C8, C14.
- **B-0001 evaluation** after P18: rerun the tracking scenarios and the Kimi baseline, record
  the changed metric in PLAN-0006.
- **P20**: docs and spec text (S1–S4 rows marked "spec text", docs drift), delete consumed
  analyses and uploaded assets, final gates, `npm pack --dry-run`.

## Done

Every finding in the analysis README is `fixed`, `backlog <id>` or `no change` with a reason; the
replay numbers before and after are in that README; the four gates and
`cd extension && npm pack --dry-run` pass; then delete this plan and B-0005 with trailers.
