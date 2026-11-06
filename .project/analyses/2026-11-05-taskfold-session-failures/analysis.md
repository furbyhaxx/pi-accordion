---
document:
  type: "analysis"
  id: "ANA-2026-11-05-taskfold-session-failures"
  title: "Why two Taskfold sessions misused the tasks tool and ran over budget"
  description: "Root causes of tasks-tool misuse and Taskfold budget overruns in two real pig sessions, with replay evidence and ranked remedies"
  status: "draft"
  revision: 2
  created_at: "2026-11-05T15:24:12+01:00"
  updated_at: "2026-11-05T15:51:30+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
    - revision: 2
      reason: "pi-auth-plus token research resolves B4"
      changes: ["B4: Synthetic reports scaled input units and duplicates cacheWrite; S2's real DeepSeek context reached about 361k against a 272k budget", "remedy 9 points to the reliability proposal"]
---

# Taskfold session failures (2026-11-05)

## Sessions

| | S1 | S2 |
|---|---|---|
| Name | continue .project/plans/0001-host-gap-resolution/plan.md | continue slice 1 |
| File | `host:~/.pig/agent/sessions/--mnt-Projects-furbyhaxx-pig--/2026-11-05T13-27-06-939Z_01a1abe4-….jsonl` | `host:~/.pig/agent/sessions/--mnt-Projects-furbyhaxx-pig-workbench--/2026-11-05T12-53-01-949Z_01a1abc5-….jsonl` |
| Models | Kimi K3.1 → Claude Opus 5.5 → DeepSeek V4.1 Flash | Kimi K3.1 → DeepSeek V4.1 Flash → Claude Opus 5.5 |
| Budget | 272k (`modelDefaults`) | 272k (`modelDefaults`) |
| Peak real input | 267k (Claude) | 408k (Claude), 150 % of budget |
| Extension commit | `6e3dcf4` (`feat/pi-native`) | same |

Line numbers below are 0-based JSONL line indices of the session files (S1 analysed through line 350, S2 through 679).

## Method

`evidence/replay.ts` replays a session file through a real `Truth` plus `TaskfoldConductor` (`TestHost`), departing the wire before each assistant message, with budget 272k and a 20k protected tail. With a fixed Claude multiplier of 1.7 applied to the whole session (`fixk`, `evidence/s2-replay-fixk1.7.tsv`), the replay tracks S2's real Claude input to within 4 %, for example 221,881 vs 212,892 at line 512 and 409,625 vs 407,523 at line 677. The `cal` mode snaps k to each previous receipt (`evidence/*-replay-calibrated.tsv`). Its token totals are therefore partly forced to match, but it shows each provider's multiplier (B4). The replay runs no classifier, so every user message is kept. In S2 the real classifier kept the correction at line 506 and would fold only the go-ahead at line 510 (loss 0.09, a few tokens), so this does not change the result.

## Part A: why the agents struggled with the `tasks` tool

### A1. S1 had no `tasks` tool when the work started (main cause)

- Taskfold is the `defaultConductor` and declares `privacy`. At session start `selectConductor` (`extension/accordion.ts:772`) opened the one-time consent dialog and returned `false`, so neither the conductor nor its `tasks` tool was attached.
- The first request (13:32:17) had no `tasks` entry in its system prompt tool list (system message, S1 line 49). At 13:33 the agent searched for it: `searchTools("task")` returned `[]`, and `ALL_TOOLS` listed 15 tools, none of them `tasks` (S1 lines 55, 57).
- The user accepted consent at 13:35:17 (`privacyConsent.taskfold` in `~/.accordion/config.json`). `syncConductorTools` then added the tool without telling the agent, which had already settled on a Markdown checklist (`.project/plans/0001-host-gap-resolution/tasks.md`). The tool first appears in a system message at 13:45:59 (line 60).
- The coach (`extension/taskCoach.ts`) stays silent while no list is attached, so roughly 140 tool calls passed without a nudge. The user had to ask twice (lines 186, 191) before the agent created the list. From line 193, the agent's reasoning shows it still believed the tool did not exist.

### A2. Span boundaries do not match the work

- **Late, batched bookkeeping.** S1's 2.2.1 span runs from line 200 to 355 and covers the work of both 2.2.1 and 2.2.2. The agent tried `start 2.2.2` while 2.2.1 was still open (line 349, rejected), closed 2.2.1, and then opened and closed 2.2.2 within six lines (356–362). The 2.2.2 record therefore summarizes nothing.
- **Catch-all leaves.** S2 added 4.1.3, "Register and consume the remaining contribution kinds and trusted secret grants", to escape a branch conflict (line 483). It became one span of about 80 Claude turns, running from line 523 to 679.
- **Starting a parent directly.** S2 ran `start 4.1` (line 406) and did the work inside the parent's span. It later added leaves (`add 4.1.2`, `add 4.1.3`) to describe work that was already done.

### A3. Lifecycle rules forced workarounds

S2 hit four rejections in a row at a single decision point, where the agent wanted to close 1.3.4 because 4.1.2 had delivered its goal:

| Line | Call | Rejection |
|---|---|---|
| 481 | `start 1.3.4` | 4.1 / 4 still in progress (one branch at a time) |
| 485 | `block 4.1 dependency 4.1.3` | a task cannot wait for its own branch |
| 498 | `complete 1.3.4` | blocked; resume with `start` first |
| 517 | `start 1.3` | 4.1 / 4 still in progress |

Each error was correct by the contract (SPEC-0001 §4.15), but none named the one call that would work. The agent finally used `abandon 1.3.4 supersededBy 4.1.2` (line 514). The record now says "abandoned" for work that was done.

### A4. Premature stops were recorded but not acted on

S2 stopped twice with an `accordion.tasks.idle` verdict of `in-progress` (lines 502, 684). The verdict is written to the session, but neither the agent nor the user is told about it.

## Part B: why Taskfold could not hold the budget

Taskfold only reclaims context when a task finishes: it folds finished outermost spans, oldest first, once the context reaches 80 % of the budget, and stops at 60 % (`conductors/in-process/taskfold/taskfold.ts`, `plan`). Anything that is not a finished, foldable span grows without bound.

S2's live context at line 679, from the `fixk` replay (`evidence/s2-fixk-breakdown.txt`), calibrated tokens:

| Mass | Tokens | Share | Why it never folded |
|---|---|---|---|
| Open span 4.1.3 | 180,155 | 44 % | Open spans are never folded |
| Abandoned 1.3.4 | 147,471 | 36 % | Overlapping span; see B2 |
| Outside any span | 75,770 | 18 % | Never folded; see B3 |
| Open span 4, done 4.1.2 | 4,014 | 1 % | — |
| **Live total** | **410,465** | 151 % of 272k | Every epoch from line 514 on reported "Over budget; no finished task span is foldable yet." |

### B1. Open spans are unbounded (44 %)

`plan()` only ever considers spans that have a status. A long leaf like 4.1.3 cannot be touched until it completes. When 4.1.3 completed (line 679), the real input fell from 408k to 266k on the next request (line 680, `cacheWrite` 244,836). That is the expected one-epoch drop, and it arrived about 160k tokens too late. The agent was never told that its open span was what kept the context over budget: `setStatus` only reaches the footer.

### B2. A blocked task's span keeps running over sibling work (36 %)

`scanTaskSpans` keeps a blocked task's span open until the task is finished ("A resumed (blocked) task keeps the span it opened"). In S2, 1.3.4 was blocked at line 404 and abandoned at line 514. Its span, from line 368 to 515, therefore contains all of 4.1's work (406–515), including the finished 4.1.2. Two failures follow:

1. When 4.1.2 finished while 1.3.4 was still blocked, 4.1.2 was a root and folded on its own. Once 1.3.4 finished, that group sat inside 1.3.4's span but was not 1.3.4's child: its key does not start with `1.3.4.`. `unit()` therefore treated it as foreign and returned `null` for good (`evidence/s2-span-1.3.4-unfoldable.txt`).
2. With `keepRecentTasks: 1`, the kept root is the outermost finished span that started last, which is 1.3.4 again. This held 147k open even when nothing else was left to fold. A replay with `KEEP=0` changes nothing, because of failure 1.

Had 1.3.4 folded, its record would also have claimed 4.1's work as its own.

### B3. Untracked work is never reclaimed (18 %)

S2's opening reads ran before the list existed (lines 8–27), adding about 68k of tool results that no span ever covered. S1 is the extreme case: about 140 tool calls ran before any task started, and no task finished before line 355. Taskfold had nothing to fold for the whole session. The S1 replay ends with zero groups (`evidence/s1-replay-calibrated.tsv`).

### B4. Synthetic usage is in scaled units, so Accordion never saw the real size (resolved)

For the same history, the per-request multiplier k (real tokens / Accordion estimate) varied widely between providers:

| Provider | k |
|---|---|
| `synthetic` (Kimi / DeepSeek) | 0.2–0.5 |
| `claude` | 1.6–1.7 |

Live probes in pi-auth-plus settle this (`host:/mnt/Projects/furbyhaxx/pi-auth-plus/.project/analyses/tokens/synthetic-counts/report.md`, `…/tokens/usage-audit/report.md`, `…/docs/tokens.md`):

- Synthetic reports input in a **per-model scaled unit**: 0.4208 × the model's real tokenizer count for the DeepSeek family, 1.36× for GLM-4.7-Flash and about 2.44× for gpt-oss-120b. Output tokens are exact. Kimi K3's factor was not measured, because its count endpoint answers 500.
- Its stream also **repeats the uncached input** as `cache_creation_input_tokens`, so `cacheWrite == input` on every turn. Accordion's `input + cacheRead + cacheWrite` counts that run twice.
- The provider **enforces its context limit on real tokens**: a request of 510,840 real tokens (reported as 215,042) is accepted; one of 599,339 real tokens (reported as 252,294) is rejected.
- pi-auth-plus corrects both in a `message_end` replacement (`src/families/synthetic/usage.ts`). The persisted messages in both sessions still carry the raw values, so the correction did not run there, and Accordion's own `message_end` calibration read the raw message either way.

The consequence in S2: during the DeepSeek phase, reported prompt sizes of 45k (line 136), 95k (line 301) and 152k (line 500) correspond to about **108k, 227k and 361k real tokens**. The real context passed the 272k budget at line 364 and stayed above it for all 58 remaining DeepSeek requests, while Accordion believed it was at 152k at most and folded nothing. This agrees with the replay: the unfolded history at line 500 is about 315k estimated tokens (1.26 M characters), and DeepSeek's tokenizer averages about 3.4 characters per token, about 375k tokens. Calibration snapped to these receipts makes the budget meaningless for any provider whose units are not real tokens.

### B5. S1's 267k → 73k drop is not Accordion's doing (open)

Claude's input fell from 267k to 73k between two consecutive requests: S1 lines 208 and 210, where `cacheRead` fell to 8,283. The replay shows no group at that point, and pi-auth-plus sends no `context_management` edits. The cause is outside Taskfold and remains unexplained.

## Remedies, ranked

| # | Remedy | Addresses | Expected effect (S2, line 679) |
|---|---|---|---|
| 1 | **Split spans at `block`.** A span is a list of intervals: `block` closes the current interval and `start` opens a new one. Fold intervals as parts, as kept user messages already do. Treat a group nested by position but not by key as a boundary, not a veto. | B2, A3 record honesty | About 147k becomes foldable. Records stop absorbing sibling work. |
| 2 | **In-span fallback.** When the context is over HIGH and `plan()` finds no finished span, fold the oldest tool results inside the open span and outside the protected tail, block by block, keeping the `{#code}` tag so `recall` still works. Fold finished subtask intervals within the open parent first. | B1 | Most of the 180k open-span mass. |
| 3 | **Fold untracked runs.** When over budget, group runs that lie outside every span into an `[untracked-work]` record built only from deterministic facts (`recordFacts`: changed files, checks run). | B3 | About 70k in S2; in S1 this is the only mass there is. |
| 4 | **Coach on span size and budget.** When the innermost doing task exceeds a share of the budget (for example 15 %) or a number of tool results, append a reminder: finish it, or split off and complete the finished part. When an epoch finds nothing foldable, tell the agent, not just the footer. | A2, B1 | Spans close before they get large, so remedy 2 is needed less. |
| 5 | **Decouple consent from the tool.** Attach Taskfold and `tasks` at once, and gate only `classify` on consent. The unclassified-means-kept fallback already exists. When conductor tools change mid-session, send a `before_agent_start` notice ("`tasks` is now available"). | A1 | S1 would have had the tool from its first request. |
| 6 | **Coach with no list attached.** Once `tasks` is active and N tool calls have run with no claimed list, remind the agent once to create or claim one. | A1, B3 | Shorter untracked preludes. |
| 7 | **Actionable lifecycle errors and complete-from-blocked.** Every rejection names the exact next valid call. Allow `complete` on a blocked task, which closes the block. | A3 | Removes the four-rejection loop and false "abandoned" records. |
| 8 | **Choose the kept task by finish order, and waive it under pressure.** Keep the most recently *finished* root, and fold it too when the context is still over budget after every other candidate. | B2.2 | Prevents one large recent span from pinning the budget. |
| 9 | **Bound calibration.** Reject an implausible k, de-duplicate `cacheWrite == input`, and prefer a tokenizer recount (pi-auth-plus) over provider units. Superseded by the proposal in `.project/drafts/taskfold-reliability.md`. | B4 | Folding would have started on DeepSeek before line 364. |
| 10 | **Surface idle verdicts.** On an `in-progress` or `pending` stop, show the user a notice and give the agent a short note on its next prompt. | A4 | Makes premature stops visible. |

Remedies 1–3 are conductor changes in `conductors/in-process/taskfold/taskfold.ts`. Remedies 4, 6 and 10 belong in `extension/taskCoach.ts`, 5 in `extension/accordion.ts` (`selectConductor`, `syncConductorTools`), and 7 in `extension/tasks.ts` together with the tool description. These are SPEC-0001 §4.15 contract changes: change the store, the tool text, the span scan and the views together. The S2 replay is a ready-made regression fixture, but it cannot be committed as is because the session content is private. A scrubbed or synthetic equivalent is needed.

## Open

- B4: Kimi K3's scale factor on Synthetic (its count endpoint answers 500), and whether pi-auth-plus's `message_end` replacement reaches Accordion's handler under pig.
- B5: cause of S1's Claude drop from 267k to 73k at line 210.
