---
document:
  type: "plan"
  id: "PLAN-0003"
  title: "Taskfold reliability repair"
  description: "Resolve the approved session audit: unlimited nesting, safe persistence, folding fallback, faithful projection and complete task inspection."
  status: "published"
  revision: 13
  created_at: "2026-11-07T08:16:00+01:00"
  updated_at: "2026-11-07T11:39:01+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 13
      reason: "close final source-review defects"
      changes: ["sticky selective human recovery", "reversible whole-task toggles", "lossless YAML terminal controls", "74 focused tests pass"]
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
- done: initial full gates and clean production install/authenticated assets (`evidence/gates.json`).
- done: historical replay and a further shared-serializer defect (`evidence/historical-replay.json`).
- done: real-terminal viewport defects repaired; controls fit 36x24 and 80x10 (`evidence/viewport.json`).
- done: modal task focus routes paging to the inspector on installed Pi-Bolt (`evidence/paging.json`).
- done: main context panel uses the same widget suspension and restores preferences after normal/failed opens (`evidence/context-panel.json`).
- done: full terminal feature matrix and goal/session tests (`evidence/terminal.json`).
- done: trailing-notice working-set repair and genuine native recovery (`evidence/live-result.json`).
- done: final source review; human selective recovery now holds its blocks, full-task toggles remain reversible, and YAML escapes terminal controls losslessly.
- now: final gate refresh and review of delivery evidence.

## Current slice: full verification and live evaluation

The approved implementation slices are complete. Focused tests cover unlimited nesting, safe writes,
planner fallback, aging, exact carriers, metadata, YAML and native recovery. The native context smoke
also verifies zero task-file scans during rendering, update refresh and stale-session refusal.

Completed evidence:
- 229 native Bun tests and 1,054 Vitest tests initially passed, with no skips; clean production
  `prepare` generated assets and authenticated HTTP asset assertions passed. After the replay-found
  serializer repair, 1,055 Vitest tests, app check and focused/context gates passed again.
- Empty custom/protocol messages and system patches now survive unchanged without splitting one
  logical recap. A synthetic regression failed before the serializer repair; replayed wire text
  and order now equal the authoritative carriers.
- At a 100k snapshot budget, baseline live tokens were 123,203 versus 87,683 repaired; the stranded
  child drops from 37,352 to 62 tokens and remains recallable. At 272k, repaired records retain
  more named outcomes and use 143,430 versus 126,821 tokens: not an unconditional size reduction.
- All ten historical exports were generated; YAML/XML parse and YAML leaf sums equal each header.
  The original YAML still fails parsing at line 2525. Originals were not changed.
- The 80-task, six-level backup round-trips every task fact. Its v2 header lacked the goal
  required by strict authoring validation; replay supplies the current authored list goal in memory only. No original was repaired,
  flattened or renumbered. This is distinct from the synthetic deep-v1 migration regressions.
- Replay is a canonical SDK snapshot with saved verdicts, a fixed tail, no provider calibration
  and the host prompt intentionally excluded; it is not a historical request/cost reconstruction.

- Real Pi-Bolt inspection exposed widget/frame viewport collisions and a false visibility reason
  when another list was invalid. Widget suspension now restores safely across sessions; the shared
  frame budget reserves Pi's spacer and footer, and diagnostic rows fit short screens. New
  regressions failed before the fixes. All 232 native tests, app check and extension smokes pass.

- Installed Pi-Bolt is Pi 1.4.0 / Bolt 1.0.9, while local peer dependencies are Pi 1.5.0.
  Fullscreen PageDown was consumed by the transcript before reaching inline task inspection.
  Task screens now use the common modal overlay API, not newer-only component flags or raw
  keyboard interception. Real PageDown moves 1–21/25 → 5–25/25 and PageUp restores 1–21/25.

A completion-style compacted message claimed a main-panel commit that neither git nor the task
store contained. It is not acceptance evidence and does not establish a conductor defect. The
actual repair was implemented after reproducing three failed viewport assertions; it changes
only widget suspension around the existing panel, not a nonexistent panel dependency API.

- The final tracked source was exercised in a private Pi-Bolt terminal at 36/57/80/140 columns
  and 36×10. `evidence/terminal.json` records 47 captures and 15 semantic checks: nested criteria,
  inherited/scoped facts and attachments, named child recovery, sibling recomposition, invalid
  lists, paging, pause labels, new-session isolation and interactive goal creation. No credentials
  or provider calls were available in this fixture.
- All five native dump formats were generated. Both YAML exports parse and their live leaf sums
  equal their headers: mixed projection 48,046; paused projection 91,881 (also the full count).
  A working set had not been built before the first agent start; metadata was exported and the
  authenticated request remains the check for the applied suffix.
- Reproduce the terminal fixture/checks with `bun evidence/terminal-fixture.mjs <new-runtime-dir>`
  and `bun evidence/terminal-check.mjs <runtime-dir>` from this plan directory. Launch isolated
  Pi-Bolt with the repaired extension and dummy fixture provider; save captures after task lists,
  context, record/original, child unfold, deep filter, pause/tree/export, `/new` and goal creation.

- The credential-free native RPC preflight exposed a real omission after resume: a trailing
  opaque task notice made the wire skip its working set and the dump label it cached-only.
  Wire and dump now share an input-target rule that skips opaque notices without crossing an
  assistant reply. User/tool-result input is copied; the notice remains unchanged. The regression
  failed before the repair and passes afterward. Native before/after evidence is in
  `evidence/notice-suffix.json`: the actual suffix appears on message 36/38, has 292 tokens, and
  the additive live header rises from 4,155 to 4,447. No provider or credential was involved.

- `evidence/live-eval.mjs` was dry-run on actual Pi-Bolt. The local proxy captures provider-ready
  payloads and triggers the real dump command while the request is in flight. The snapshot has
  the exact suffix and records, and sums to 4,447 tokens. `evidence/live-dry-run.json` records
  no upstream call, credentials, stderr or non-JSON protocol output.
- Live transport bounds are two requests, 512 output tokens each, 90 seconds and a conservative
  $0.05 catalog-cost preflight. Rates/model identity were checked with models.dev and the official
  DeepSeek API docs on 07.11.2026. Existing credentials are resolved read-only in parent memory;
  only a random loopback-proxy token enters the isolated child environment. Error responses are
  sanitized before forwarding. No credential value is written into evidence or child config.
- For the live fixture, pass `300` as the third fixture-generator argument, then run
  `bun evidence/live-eval.mjs <runtime-dir> --dry-run` or replace `--dry-run` with an existing
  auth-file path. Set isolated HOME, PI_CODING_AGENT_DIR and ACCORDION_HOME before either script.

- Authenticated evaluation passed on the actual native runtime: two HTTP 200 responses, one
  real child `recall`, exact recovered sentinel and no sibling raw content. Both in-flight
  dumps match actual working-set text/records and have exact live sums (4,447 and 8,334).
  The transient suffix has 292 tokens and targets user input, then the recall tool result.
  `evidence/live-result.json` contains provider usage: 12,474 total tokens and SDK-estimated
  USD 0.001817886 (not provider-reported billing). The original auth file stayed byte-identical.
- The 7k dial is a best-effort estimate, not a hard ceiling: after selective recall the snapshot
  estimated 8,334 tokens; that request's real provider receipt was 6,935 including output.
  Classifier service and task-coaching closure were deliberately outside this isolated live run.

Final source review reproduced two further failures before fixing them: selective human recovery
had no sticky Truth overrides, and YAML literal scalars rejected carriage returns/ANSI output.
Selected child blocks now use human `unfold` overrides while whole-task group toggles avoid
selective recomposition. A two-newer-root pressure regression confirms the human-held child stays
open; the existing agent-refold policy still passes. YAML uses escaped JSON-compatible scalars for
terminal controls and Unicode line separators. All 74 focused tests pass, including exact byte
round trips and whole-task open/close behavior.

Remaining work:
1. Refresh final gates/builds after all source repairs and record limits.

The repository-wide artifact checker reports legacy frontmatter/changelog/dangling-reference
errors outside this branch's changed artifacts. An extra Bun run of Vitest-only core timer tests
fails because Bun lacks `vi.advanceTimersByTimeAsync`; those suites pass in their configured runner.

## Verification

- Extend adjacent behavioral tests; observe regressions fail before fixes.
- `bun test extension/*.test.ts extension/tui/*.test.ts conductors/in-process/taskfold/*.test.ts` plus touched core suites.
- `npm --prefix extension run smoke`, `npm --prefix app run check`, `npm --prefix app test`, package dry run as applicable.
- Private historical replay: measure stranded completed work, group/handle recovery, carrier uniqueness and projection totals; keep private text outside committed evidence.
- Real isolated Pi-Bolt terminal: 36/57/80/140 columns and short height, exercising task metadata, nested recovery, diagnostics and dump command. Capture redacted evidence here.
- Review full diff, document unavailable checks precisely, commit explicit intended paths only. No push or PR without authorization.
