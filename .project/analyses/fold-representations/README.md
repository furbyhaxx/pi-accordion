---
document:
  type: "analysis"
  id: "ANA-fold-representations"
  title: "Fold representations, fold timing and user-message routing: evaluation"
  description: "Offline cache/token simulation of folded-task representations and fold timing, plus the design of the live comprehension and user-message routing evaluations"
  status: "draft"
  revision: 1
  created_at: "2026-11-08T11:26:48+01:00"
  updated_at: "2026-11-08T11:26:48+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["offline simulation results", "live evaluation design and cost"]
---

# Fold representations, timing and user-message routing

Feeds SPEC-0002 §6–§9 (records, planner, aging, epoch) and the user-message design. Decided by the
user before this analysis: under hard pressure a completed root becomes **one history message per
root** (more cache friendly than one merged history message).

## 1. Candidates

| Id | Folded task on the wire |
|---|---|
| S | one synthetic `assistant` message holding the composed record |
| B | bracket: original `tasks start` call + result, one `assistant` work record (own facts only), children as nested brackets, original `tasks complete` call + result |
| B→S | B for a leaf; once a parent folds, the parent becomes S |
| T | one synthetic tool pair: `assistant` `toolCall tasks {action:"started-and-completed", id}` + `toolResult` record |
| H | history (hard pressure): one `assistant` line per completed root, recall by one code |
| HR | history on completion: children fold as S while their root is open; a root becomes its 1–3 line history (`{history, status, subtasks counts, outcome≤160, fold}`) the moment it completes |
| HP | like HR, but every task **with children** becomes history when it completes; leaves fold as S |
| HRC | HR, and under pressure all history entries are consolidated once into a single message |

Timing: **eager** folds every finished task at the next request; **lazy** folds finished roots only
when live > high·budget (current behaviour, keep-recent waived), down to low·budget.

## 2. Offline simulation

`harness/sim.py <session.jsonl> --budget N` rebuilds the outgoing message list before every
assistant response for each candidate × timing and compares it with the previous request
(longest common message prefix = provider prefix-cache hit; always-warm cache). Tokens are
chars/4. `cost` weights reads 0.1 and writes 1.25 (Anthropic 5-minute cache multipliers) in
input-token units. `rebill` counts previously sent tokens that had to be written again. Spans
crossing their parent (historical late children) stay raw. `harness/synth.py` generates nested
synthetic sessions. No model calls; the private session is only read (sha256 checked).

Full output: `evidence/results.txt`. Excerpt (weighted cost in input-token units, thousands):

| Fixture, budget | RAW | S lazy | S eager | B eager | B→S eager | T eager | rebill S lazy → eager |
|---|---|---|---|---|---|---|---|
| nukular, 120k | 79,288 | 21,927 | 16,016 | 16,127 | 16,043 | 16,023 | 1,374k → 261k |
| nukular, 200k | 79,288 | 23,796 | 16,241 | 16,423 | 16,309 | 16,253 | 1,602k → 289k |
| synth 6×3×3, 120k | 8,063 | 4,341 | 620 | 865 | 630 | 625 | 599k → 12k |
| synth 12×4 leaves, 40k | 1,892 | 1,084 | 213 | 336 | 222 | 217 | 200k → 6k |
| synth 3×3×3 big, 40k | 13,184 | 2,739 | 1,230 | 1,333 | 1,237 | 1,232 | 756k → 8k |

Findings:
1. **Timing dominates.** Eager folding cuts weighted cost by 27–88 % against lazy and rebilled
   tokens 5–95×, on every fixture and budget. It also lowers peak and mean context.
2. **Representation is second order** under eager folding: S, T and B→S are within ~2 % of each
   other. T costs one extra small message per task over S.
3. **Pure B is the most expensive**, 1–58 % above S, and keeps 2–30× more messages (nukular
   final wire: 288 vs 149 messages), because every nested child keeps four scaffolding messages.
   B→S removes that overhead at a ≤2 % premium.
4. Nukular's eager peak (183k) is set by the long-open root and two crossing spans, not by the
   representation; history (H) engaged at 60k–200k budgets on 5–11 roots.

History on completion (same harness, eager):

| Fixture, budget | S eager | HR | HP | HRC | rebill S → HR |
|---|---|---|---|---|---|
| nukular, 120k | 16,044 | 15,712 | 15,778 | 16,214 | 261k → 24k |
| nukular, 200k | 16,241 | 15,712 | 15,848 | 15,876 | 289k → 24k |
| synth 6×3×3, 40k | 620 | 534 | 520 | 534 | 12k → 8k |
| synth 12×4 leaves, 40k | 213 | 171 | 171 | 171 | 6k → 3k |
| synth 3×3×3 big, 40k | 1,230 | 1,189 | 1,174 | 1,189 | 8k → 5k |

5. **History on completion is the cheapest overall.** HR rebills ~10× less than S on nukular,
   because a completed root is written once in its final form and never touched again; aging and
   pressure-time history no longer rewrite old positions (HR needed zero pressure-time history on
   nukular at any budget). HP is within ~1 % of HR, slightly better on deep synthetic trees,
   slightly worse on nukular, where nested parents finishing late cause extra rewrites.
6. **Consolidating history under pressure does not pay.** Per-root history is already tiny; merging
   rewrites everything from the first history entry onward and costs up to 3 % more (nukular 120k
   rebill 24k → 491k). Keep per-root messages, as decided.

Limits: chars/4 estimates; a perfectly warm cache (no TTL expiry, which would favour folding even
more); folding decisions simplified (no protected tail, no held blocks, no keel-lite floor).

## 3. Live evaluation (designed, not run)

The offline numbers cannot say whether the model **understands** a representation: recalls the
right code, does not redo finished work, places new work in the right task. That needs model
calls.

### 3.1 Comprehension (S, B, T, B→S, HR, HP)

Fixtures: the nukular replay at 120k cut at 10 points, and the three synthetic shapes cut at 5
points each, 25 contexts per representation. Per context, 6 probes, one per request:

| Probe | Correct when |
|---|---|
| "Which task are you on and what is its parent?" | names the doing id and parent |
| "Was 3.2 completed? What was its outcome?" | answers from the record without a tool call |
| "Show the test command you ran for 2.1." | calls `recall` with 2.1's code (not the parent's, not re-run) |
| "Continue." (next step) | no tool call that repeats a finished task's work |
| "Add a check for X under the task it belongs to." | `tasks add` with the right parent |
| "Summarize what is left." | lists only unfinished tasks |

Metrics: accuracy per probe, wrong-code recalls, redo rate, tokens. 4 representations × 25
contexts × 6 probes = 600 requests, mean context ≈ 60k tokens → **≈ 36M input tokens, ≈ 0.3M
output**. With prefix caching across the 6 probes of a context, ≈ 6M written + 30M read.

### 3.2 User-message routing (options A, B, C)

Corpus: the 10 user messages of the nukular session plus 40 synthetic ones (directives,
corrections, scope changes, chat, answers), each with the list state at that moment. Gold labels
for the expected list operations written by hand.

| Option | Measured |
|---|---|
| Extraction alone (shared by B and C) | precision/recall of ops vs gold; verbatim-pin validity; latency, tokens |
| A agent applies proposals | ops actually applied by the agent within its next 3 calls; turns spent |
| B sidecar applies | ops applied; wrong ops applied; agent's next action consistent with the change |
| C hybrid | as B for safe ops, as A for risky ops |

Extraction: 50 messages × ~8k context ≈ 0.4M tokens per model. A/C agent runs: 50 × ~3 requests ×
~40k ≈ 6M tokens. Total ≈ **7M input tokens** per model tried.

### 3.3 Cost

≈ 43M input tokens (≈ 70 % cache reads) and < 1M output for one model. Dollar cost depends on the
model chosen and is quoted from current prices before running. Nothing has been run.

## 3.3 Live comprehension results (deepseek-flash)

Model `deepseek/deepseek-flash` (DeepSeek V4.1 Flash 1017, api.deepseek.com). 6 cut points on the
nukular session (77k–190k tokens) plus 12 on three synthetic trees, 6 representations, 5 probes
each: 540 probes. Run 2 lets the model take up to 4 steps; `tasks status` and `recall` are answered
from the true list and the task's full record, everything else returns "unavailable". Run 1
(single reply, lookups scored as failures) is kept in `evidence/live-comprehension.txt`.

| Rep | current | status | recall | continue | place | mean | steps/probe |
|---|---|---|---|---|---|---|---|
| S | 1.00 | 1.00 | 0.94 | 1.00 | 0.94 | 0.978 | 1.30 |
| B | 1.00 | 1.00 | 1.00 | 1.00 | 0.89 | 0.978 | 1.37 |
| T | 1.00 | 0.94 | 1.00 | 1.00 | 0.69 | 0.928 | 1.16 |
| B→S | 0.94 | 1.00 | 1.00 | 1.00 | 0.89 | 0.967 | 1.27 |
| HR | 0.92 | 0.97 | 0.94 | 1.00 | 0.94 | 0.956 | 1.76 |
| HP | 1.00 | 0.81 | 0.89 | 1.00 | 0.92 | 0.922 | 1.84 |

7. **All in-root forms are understood.** S, B and B→S score 0.97–0.98; differences are within
   one or two probes. T is lowest on `place` (0.69): the synthetic `started-and-completed` call
   seems to make the model treat folded tasks as tool events rather than list positions.
8. **History works, but costs a lookup.** With no detail in context, HR/HP answer through
   `tasks status` + `recall` (1.8 steps per probe vs 1.3). Without those tools answering (run 1)
   history collapsed to 0.3–0.4 on status/recall — the mechanism depends on recall being cheap and
   the history line naming the right code.
9. **Recall targets the root, not the child.** Under HR/HP, 11–12 of 18 recall probes used the
   root's code (correct content, but the whole subtree comes back). History lines should list
   child codes, or recall of a root should return a compact child index first.
10. **HP is worse than HR** (status 0.81): parents-as-history inside an open root hide sibling
    outcomes the agent still needs.

Spend: ~55M prompt tokens (52.5M cache hits) + 0.27M completion across both runs, about
$1.40 at the local pig price ($0.30 in / $0.006 cached / $1.20 out per M).

## 3.4 User-message routing results (deepseek-flash)

50 messages (41 synthetic against a fixed list, 9 real messages from the nukular session with the
list reconstructed at that point), 2 repetitions, hand-labelled gold ops. Corpus and labels:
`harness/routing_corpus.py`; harness: `harness/routing.py`; numbers: `evidence/routing.txt`.

| Arm | recall | precision | exact items | no-op messages left alone | pins verbatim |
|---|---|---|---|---|---|
| A0 agent alone (today) | 0.68 | 0.82 | 0.70 | 30/30 | 2/14 |
| A sidecar proposes, agent applies | 0.81 | 0.88 | 0.84 | 29/30 | 15/24 |
| B sidecar applies everything | 0.93 | 0.82 | 0.90 | 29/30 | 25/30 |
| C sidecar applies safe ops, proposes the rest | 0.89 | 0.86 | 0.89 | 29/30 | 26/29 |

11. **Today's behaviour loses a third of durable instructions** (A0 recall 0.68), and none of the
    real nukular corrections reached the list (real recall 0.00). The agent paraphrases pins (2/14
    verbatim).
12. **The sidecar extractor is the reliable part**: recall 0.93, 1.00 on the real messages; classifying
    no-op messages (approvals, questions, "go on") is near perfect in every arm.
13. **The agent is the unreliable part.** In A it applies 71 % of proposed ops; in C only 37 % —
    once told some changes are "already recorded", it skips most of the rest (task additions
    12/67). C's score comes almost entirely from what the sidecar applied itself.
14. **B's errors are over-recording**: pins of one-off instructions ("you broke the build"), an
    extra pin next to a task removal, two attachments for one reference. Precision on real
    messages (0.67) is understated: restructuring requests legitimately produce many task ops the
    gold only partly lists.

Spend: 0.57M prompt (0.46M cached) + 0.09M completion tokens, about $0.15.

## 4. Recommendation

- Fold eagerly: `keepRecentTasks` default 0, fold at the request after `complete`.
- HR: completed roots become 1–3 line history immediately (cheapest, 0.956 comprehension, one
  extra lookup when detail is needed). Add child codes to the history line or a child index to
  the root's recall.
- Inside an open root: S or B→S (0.97–0.98). B scores the same but costs 1–58 % more; T is
  cheaper but places new tasks worse. HP rejected.
- No pressure-time consolidation; one history message per root.
- User messages: the extension applies extracted ops itself (B), with the existing verbatim check
  on pins and a "changed" notice to the agent; the agent can still undo. Proposing ops to the
  agent (A, C) loses 30–60 % of them. Tighten the extractor against one-off instructions.
