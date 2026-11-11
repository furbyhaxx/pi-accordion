---
document:
  type: "analysis"
  id: "ANA-orientation-modes"
  title: "Orientation modes: folding the work before the first task"
  description: "Experiment comparing how Taskfold handles the orientation phase (raw, typed fold, agent-tracked), measured by replay probes on real sessions and live runs."
  status: "published"
  revision: 2
  created_at: "2026-11-05T15:32:28+01:00"
  updated_at: "2026-11-05T17:05:00+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 2
      reason: "tier-2 live runs and verdict"
      changes: ["pins arm", "two tier-2 rounds (60 + 36 runs)", "verdict: keep A as default"]
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

Harness: `harness/make_fixtures.py` builds two fixture repos, `harness/tier2.py` runs them.

- **Fixtures.** `ratelimit` (~24k tokens of docs) and `invoices` (~17k). Each has a long spec with the
  needed facts buried in filler, a superseded draft with conflicting values (trap), `AGENTS.md` work
  rules, and a hidden grader: tests on the spec's values and constraint checks (no vendor/fixture
  edits, constants only in the config module, docstrings, no float money, stdlib only). Both
  graders fail on the stubs and pass on reference solutions.
- **Runs.** Headless `pig -p` on a fresh repo copy with an isolated `ACCORDION_HOME`, Taskfold
  attached, deepseek-flash, the arm's options in `config.json`. Metrics come from the session file.
- **Arms.** A, C, CD (C + agent-tracked orientation), and each of A, C, CD with pins (AP, CP, CDP).
  Pins (`extension/pins.ts`): `tasks pin` stores verbatim quotes or short file ranges, checked
  against their source and capped, shown in a working-set message for the active branch.

### Round 1: budget 24k, one prompt (60 runs, $3.18)

| arm | pass | violations | peak ctx | tokens sent | cache hit | cost | rereads |
|---|---|---|---|---|---|---|---|
| A | 10/10 | 0 | 43.1k | 1541k | 96% | $0.052 | 3 |
| AP | 10/10 | 0 | 47.3k | 1404k | 95% | $0.055 | 7 |
| C | 10/10 | 0 | 37.1k | 920k | 93% | $0.051 | 5 |
| CP | 10/10 | 0 | 38.2k | 930k | 92% | $0.048 | 5 |
| CD | 10/10 | 0 | 31.5k | 799k | 93% | $0.043 | 12 |
| CDP | 10/10 | 0 | 36.6k | 1049k | 94% | $0.053 | 10 |

Medians per run except counts. Pass = hidden tests and the agent's suite green.

### Round 2: budget 16k, a second prompt in the same session (36 runs, $4.61)

The spec gained one requirement the plan never mentions; after the first task the session continues
with "implement the one spec requirement you have not covered yet" (not named).

| arm | pass | phase 2 found | phase-1 peak | cost | cache hit | rereads | spec re-read in phase 2 |
|---|---|---|---|---|---|---|---|
| A | 6/6 | 6/6 | 42.4k | $0.089 | 96% | 13 | 6/6 |
| AP | 6/6 | 6/6 | 45.3k | $0.140 | 96% | 9 | 6/6 |
| C | 6/6 | 6/6 | 33.5k | $0.105 | 93% | 23 | 6/6 |
| CP | 6/6 | 6/6 | 38.6k | $0.141 | 93% | 6 | 6/6 |
| CD | 6/6 | 6/6 | 33.1k | $0.147 | 94% | 26 | 6/6 |
| CDP | 6/6 | 6/6 | 42.9k | $0.103 | 95% | 24 | 6/6 |

### What the live runs show

1. **Quality did not separate the arms.** 96/96 runs passed with zero constraint violations, and
   every run found the unlisted requirement. With the source files at hand, losing orientation
   from context did not hurt: agents re-read what they needed.
2. **They re-read instead of recalling.** `recall`/`unfold` were used 0–2 times per arm; in round 2
   every run found the requirement by reading `spec.md` again. Folded arms re-read about twice as
   often as A.
3. **Typed folding lowers the peak context by ~20%** (42k → 33k) **but not the cost.** It breaks the
   cache once per fold (hit rate 96% → 93%) and the extra re-reads add uncached input; on
   deepseek's pricing that makes C and CD cost the same or more than A.
4. **Pins are rarely used and cost more.** Only 15 of 48 pin-enabled runs pinned anything, despite
   the guidance; pinned arms were never better and AP/CP were the most expensive.
5. **Agent-tracked orientation (D)** worked mechanically (agents created and ran the orientation
   task) and gave the smallest contexts, with the most re-reads.

### Caveats

One model (deepseek-flash), two small fixtures, 6–10 runs per arm: differences under ~20% in cost
are noise. The fixtures keep every source file available, so they test whether agents *need*
orientation in context, not what happens when the source is gone (a deleted scratch file, a web
page, command output that cannot be repeated). deepseek's cache reads cost 1/50 of input; providers
with dearer cache misses make every fold more expensive.

### Structural findings (independent of the arms)

- **A long open task never folds.** Taskfold folds finished spans only; in round 2, phase-2 work
  inside one long task grew contexts to 75–160k at a 16k budget in every arm.
- **Fixed during the runs:** the coach flagged batched `start` + work as an empty span
  (`f04f39d`); a text pin whose source carried a line range was rejected (`0de49e3`).

## Verdict

Keep A (orientation raw) as the default. Neither typed folding, agent-tracked orientation nor pins
met the promotion bar: retention fell 20–28 points in replay (tier 1), and live runs showed no
quality gain, more re-reading and no cost saving. The options stay in this branch, default off.

The bigger lever the experiment exposed is folding inside a long open task (old tool results of the
span) rather than the orientation phase; that is where contexts actually escaped the budget.

## Round 3: Taskfold + Keel rungs (2026-11-05)

Arms: **K** (keel-lite R1–R4 on orientation only), **K+** (R1–R4 everywhere outside finished task
spans), **K+D** (K+ plus doorman birth skeletons), **K+N** (K+ plus keel-note's note), against **A**.
Document and rule-file reads (`.md`, `.txt`, …) and finished spans are never touched
(`conductors/in-process/taskfold/thinning.ts`, options `orientation.thin|note|birthSkeleton`).

### Tier 1 (replay, 6 sessions × 2 cuts, $0.42)

| arm | retention | sent / full |
|---|---|---|
| A | 96% | 88% |
| K | 87% | 68% |
| K+ / K+D | 88% | 63% |
| C (round 1) | 70% | 53% |

Losses: values inside function bodies of skeletonized code reads (e.g. a default port), and text
that only appeared inside long bash dumps. Some "constraint" probes were system-prompt text quoted in
a 12k bash output, which penalizes any trimming.

### Tier 2 (live, budget 16k, tail 3k, two prompts, 50 runs, $7.58)

| fixture | arm | n | pass | phase 2 | violations | peak ctx | cost/run | cache hit | rereads | recall+unfold | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ratelimit | A | 5 | 5/5 | 5/5 | 0 | 81k | $0.112 (sd 0.031) | 96.5% | 1.2 | 0.0 | 329s |
| ratelimit | K | 5 | 5/5 | 5/5 | 0 | 77k | $0.130 (sd 0.025) | 94.9% | 3.2 | 0.2 | 389s |
| ratelimit | K+ | 5 | 5/5 | 5/5 | 0 | 50k | $0.181 (sd 0.080) | 92.3% | 6.8 | 0.2 | 535s |
| ratelimit | K+D | 5 | 5/5 | 5/5 | 0 | 53k | $0.193 (sd 0.079) | 93.8% | 4.8 | 0.4 | 606s |
| ratelimit | K+N | 5 | 5/5 | 5/5 | 0 | 44k | $0.163 (sd 0.038) | 89.9% | 3.8 | 0.2 | 480s |
| invoices | A | 5 | 5/5 | 5/5 | 0 | 96k | $0.129 (sd 0.059) | 96.2% | 2.2 | 0.0 | 354s |
| invoices | K | 5 | 5/5 | 5/5 | 0 | 95k | $0.155 (sd 0.047) | 94.8% | 1.8 | 0.2 | 544s |
| invoices | K+ | 5 | 5/5 | 5/5 | 0 | 51k | $0.150 (sd 0.032) | 92.0% | 2.4 | 0.4 | 414s |
| invoices | K+D | 5 | 5/5 | 5/5 | 0 | 54k | $0.156 (sd 0.074) | 91.8% | 7.0 | 0.4 | 431s |
| invoices | K+N | 5 | 5/5 | 5/5 | 0 | 46k | $0.148 (sd 0.033) | 89.9% | 4.4 | 0.2 | 345s |
| all | A | 10 | 10/10 | 10/10 | 0 | 89k | $0.121 (sd 0.048) | 96.4% | 1.7 | 0.0 | 341s |
| all | K | 10 | 10/10 | 10/10 | 0 | 86k | $0.142 (sd 0.040) | 94.9% | 2.5 | 0.2 | 467s |
| all | K+ | 10 | 10/10 | 10/10 | 0 | 51k | $0.166 (sd 0.062) | 92.1% | 4.6 | 0.3 | 475s |
| all | K+D | 10 | 10/10 | 10/10 | 0 | 53k | $0.174 (sd 0.079) | 92.8% | 5.9 | 0.4 | 519s |
| all | K+N | 10 | 10/10 | 10/10 | 0 | 45k | $0.156 (sd 0.037) | 89.9% | 4.1 | 0.2 | 412s |

Evidence: `evidence/tier2-keel/` (a first wave stopped by a DeepSeek 402 is logged in
`run-wave1-402.log`; all 50 runs were rerun).

### Verdict

- **Quality is unaffected.** 50/50 pass, every phase-2 requirement found, zero violations.
- **K (orientation only) changes almost nothing live:** peak context 86k vs 89k. Orientation is not
  where these sessions grow; open-task work is.
- **K+/K+D/K+N cut peak context by 40–50%** (89k → 45–53k) and are the first arms that come near the
  budget at all.
- **They cost 17–44% more per run.** Every epoch breaks the cache (hit rate 96.4% → 90–93%) and
  agents re-read thinned results (rereads 1.7 → 4–6) instead of `recall` (≤0.4 per run).
- **Doorman adds nothing over K+** (slightly more rereads and cost). **Keel-note** gives the lowest
  peak (45k) at mid cost, but its cache hit is the lowest (89.9%).

**Recommendation:** keep A as the default. Offer `thin: "open"` (with or without `note`) as an
opt-in **budget guard** for when a hard context limit matters more than cost (small-window models,
long sessions that would otherwise hit the window). Do not ship `thin: "orientation"` or
`birthSkeleton`. The cost penalty comes from cache breaks; the next lever is fewer, larger thinning
epochs (raise `high`, lower `low`) and teaching agents to `recall` instead of re-reading.

