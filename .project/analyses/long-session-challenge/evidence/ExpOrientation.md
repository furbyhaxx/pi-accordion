## Summary

The experiment's recorded verdict is **drop it**: keep orientation raw (arm A); typed folding, agent-tracked orientation and pins all failed, and only `thin: "open"` (keel rungs outside finished task spans) was recommended as an opt-in budget guard. All 15 commits' endorsed content is already on `feat/pi-native` (fixes in superseded implementations, round-3 keel thinning as Taskfold's `floor`), and every doc commit's payload is there too — the feat analysis README already contains Round 3 and its verdict. Nothing on the branch needs merging.

Method note (important): this agent has no shell, so `git log feat/pi-native..`, `git cherry` and `git diff | wc -l` could not be run. The 15 commits and subjects come from `.git/worktrees/orientation-modes/logs/HEAD` (branch ref moved only forward from the base commit `6e3dcf4`). "Already on feat" is evidenced by symbol/file presence in the working tree (`.git/HEAD` = `ref: refs/heads/feat/pi-native`), not by patch-id. Patch identity is **UNVERIFIED**.

## Commit table

| # | commit | subject | kind | on `feat/pi-native`? (evidence) | verdict |
|---|---|---|---|---|---|
| 1 | `2348962` | feat(taskfold): orientation options, `tasks` brief, agent guidance | product | **No** — feat `TaskfoldOptions` has no `orientation` (`conductors/in-process/taskfold/taskfold.ts:40-63`); no `brief`/`agentTask`/`"typed"` anywhere in `extension/`; `tasks` params at `extension/accordion.ts:4604-4616` carry no `brief` | reject as default (options stay on branch) |
| 2 | `b5f4d90` | feat(taskfold): fold orientation into brief + source index + live rule files | product | **No** — no `orientation` identifier in feat's taskfold dir; no `thinning.ts` (dir listing: `taskfold.ts, records.ts, routing.ts, taskReports.ts, verdicts.ts, …`) | reject (C: −20…28 retention) |
| 3 | `db94ec2` | test(tasks): orientation guidelines per arm | test/experiment | **No** — exp `extension/taskCoach.ts:126-128 orientationGuidelines`, `taskCoach.test.ts:57-63`; feat's `taskCoach` import list has no such export (`extension/accordion.ts:68`) | reject with #2 |
| 4 | `ca15c77` | fix(taskfold): fold orientation up to the protected tail, copy rule files | product fix (inside rejected feature) | **No** — same evidence as #2 | reject (no orientation fold to fix) |
| 5 | `7b4830b` | docs: tier-1 replay harness + first results | docs/experiment | **Yes** — `.project/analyses/orientation-modes/harness/{probe,replay,tier1}.ts` | n/a (docs) |
| 6 | `dde8c5b` | docs: record tier-1 results | docs | **Yes** — `.project/analyses/orientation-modes/evidence/tier1/` | n/a |
| 7 | `0ef8105` | feat(tasks): pins (verbatim excerpts + file ranges) | product (experiment arm) | **Yes, redesigned** — `extension/taskPins.ts`, `taskPins.test.ts`, `taskAnchors.ts`, `taskSymbols.ts`; wiring `extension/accordion.ts:69-70, 4612` (exp used `extension/pins.ts`, kinds `rule/convention/…`, which feat does not have) | reject as default (rarely used, never better, dearer) |
| 8 | `f04f39d` | fix(tasks): count work reporting before its batched start call | product fix | **Yes** — `extension/taskCoach.ts:157-160` (`started()` seeds missing work entries) + regression test `taskCoach.test.ts:66` | ship (already shipped) |
| 9 | `2131372` | docs: tier-2 fixtures + headless live runner | docs/experiment | **Yes** — `harness/make_fixtures.py`, `harness/tier2.py`, `harness/fixtures/`, `evidence/tier2/` | n/a |
| 10 | `0de49e3` | fix(pins): accept a line range in a text pin's source | product fix | **Yes, redesigned** — `extension/taskPins.ts:24-25` (`path:start-end`), `:84-91 parseLines`, `:153-165` quote check inside the range, `:187-244` `lines` anchor | ship (already shipped) |
| 11 | `8ae458c` | docs: second-phase requirement + tighter budget in tier-2 fixtures | docs | **Yes** — `harness/fixtures/{ratelimit,invoices}/prompt2.txt` | n/a |
| 12 | `b10374c` | docs: tier-2 runs + verdict | docs | **Yes** — README `## Verdict` (feat `README.md:164-171`) + `evidence/tier2/` | n/a |
| 13 | `c643e28` | feat(taskfold): keel rungs, keel-note note, doorman birth skeletons | product | **Partial** — open-scope keel rung floor present: `taskfold.ts:948-977` (`new KeelLiteConductor({high,low,maxRung:5,…})` + `planPressure`, `scope: "open" \| "untracked"`), docs/rule reads and user tail held `:953-962`; option `floor` `:57-58`, `extension/settings.ts:80`. **No** `note`/`birthSkeleton`/orientation scope (no `KeelNoteConductor`/`DoormanConductor` in `taskfold.ts`; feat taskfold has no `birthSkeleton`) | ship `thin:"open"` (done); do **not** ship orientation/birthSkeleton; note optional |
| 14 | `da5c608` | docs: keel arms, tier-1 results, partial tier-2 | docs/experiment | **Yes** — `harness/replay.ts:46-52` `KEEL_ARMS` (K/K+/K+D), `harness/tier2.py:37-41` (incl. `K+N`), `evidence/tier2-keel-pilot/` | n/a |
| 15 | `4827a3b` | docs: round-3 keel results + verdict | docs | **Yes** — feat `README.md:173-232` (Round 3 incl. its verdict) | n/a |

## Quoted verdict (exp `.project/analyses/orientation-modes/README.md`, identical text on feat)

Q1 verdict, `README.md:167-174`:

> "Keep A (orientation raw) as the default. Neither typed folding, agent-tracked orientation nor pins met the promotion bar: retention fell 20–28 points in replay (tier 1), and live runs showed no quality gain, more re-reading and no cost saving. The options stay in this branch, default off.
> The bigger lever the experiment exposed is folding inside a long open task (old tool results of the span) rather than the orientation phase; that is where contexts actually escaped the budget."

Round-3 verdict, `README.md:219-235`:

> "- **Quality is unaffected.** 50/50 pass, every phase-2 requirement found, zero violations.
> - **K (orientation only) changes almost nothing live:** peak context 86k vs 89k. …
> - **K+/K+D/K+N cut peak context by 40–50%** (89k → 45–53k) …
> - **They cost 17–44% more per run.** Every epoch breaks the cache (hit rate 96.4% → 90–93%) and agents re-read thinned results (rereads 1.7 → 4–6) instead of `recall` (≤0.4 per run).
> - **Doorman adds nothing over K+** … **Keel-note** gives the lowest peak (45k) at mid cost, but its cache hit is the lowest (89.9%).
>
> **Recommendation:** keep A as the default. Offer `thin: "open"` (with or without `note`) as an opt-in **budget guard** for when a hard context limit matters more than cost (small-window models, long sessions that would otherwise hit the window). Do not ship `thin: "orientation"` or `birthSkeleton`."

Structural findings the verdict treats as fixes: "**Fixed during the runs:** the coach flagged batched `start` + work as an empty span (`f04f39d`); a text pin whose source carried a line range was rejected (`0de49e3`)." (`README.md:164-165`).

## Q4 — analysis file difference

The exp analysis file is **not newer in substance**. Both files are `revision: 2`, `updated_at: 2026-11-05T17:05:00+01:00`, and both contain Round 3 and both verdicts. The only difference is exp's extra 3-line `changelog` entry for revision 1 (exp `README.md:14-16`; feat `README.md:13-16` has only the revision-2 entry); feat's body is line-for-line identical at a +3 offset down to the last line (232 text lines vs 235). A unified `git diff` of the README would be one hunk, `+3/−0` (≈8–11 lines); the directory-level `git diff … | wc -l` was **not run** (no shell), and byte parity of `harness/` and `evidence/` I did not verify. [INFERENCE] The trimmed changelog matches feat's `.project/AGENTS.md` rule "replace the single changelog entry", i.e. feat's copy was normalized, not weakened.

## Recommendation

**Do not merge the branch; close it as a completed experiment.** Reasons, per the verdict and the evidence above:

- Ship-worthy content is already on `feat/pi-native`: #8 and #10 (in superseded implementations that already have their fix and tests), and #13's endorsed `thin: "open"` as Taskfold's `floor` with `high`/`low` (`taskfold.ts:948-977`).
- Rejected by the verdict and correctly absent from feat: #1, #2, #3, #4 (orientation typing/agent-task/brief), #7 (pins as a default win), and #13's `note`/`birthSkeleton`/orientation scope.
- All 8 docs/experiment commits are already on feat (harness, fixtures, `evidence/tier1`, `evidence/tier2`, `evidence/tier2-keel*`, README verdicts). The only exp-only bytes are 3 changelog lines that feat's artifact convention forbids — nothing to port.
- Follow-up work the verdict names (fewer, larger thinning epochs; agents recalling instead of re-reading; folding inside a long open task) belongs in a backlog item, not in this branch; feat already has the open-task `steps` relief (`taskfold.ts:61-62`).

One finding to act on separately: on `feat/pi-native` the analysis harness is **orphaned** — `.project/analyses/orientation-modes/harness/replay.ts:12` and `tier1.ts:12` import `ORIENTATION_DEFAULTS`, `orientationSpan` and `OrientationOptions` from `conductors/in-process/taskfold/taskfold.ts`, which exports none of them (grep for those identifiers over `.project; extension; conductors; core` hits only the harness). It cannot type-check or re-run against feat's product (no check script covers it: root `package.json` has only `build:client`/`prepare`). Delete the harness when closing the experiment (the `evidence/` and the README verdict stand on their own), or keep it only if the options are deliberately restored.

Then, per the repo's worktree convention: `git worktree remove .pi/worktrees/orientation-modes` and `git branch -D exp/orientation-modes` (abandoned, not merged).

BLOCKERS: none (no shell was available to this agent, so the exact `git log`/`git cherry`/`git diff | wc -l` outputs were replaced by reflog plus file-symbol evidence; patch-level identity of the individual commits is unverified)