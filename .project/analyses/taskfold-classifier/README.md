---
document:
  type: "analysis"
  id: "ANA-taskfold-classifier"
  title: "Taskfold user-message classifier: model, questions and threshold"
  description: "Benchmark of OpenRouter classifiers on real user-role messages and the gate Taskfold ships."
  status: "published"
  revision: 1
  created_at: "2026-11-04T23:22:00+01:00"
  updated_at: "2026-11-04T23:22:00+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
---

# Taskfold user-message classifier

## Outcome

Taskfold ships `openrouter/perplexity/pplx-decider-v1.2`. Each user message is sent with goal-aware context, and four questions go in one call. The message folds when the expected `loss` level (0–3) is below **0.3**. On 480 hand-labelled messages, this gate wrongly folded **none of the 341** messages that had to stay visible, and folded **54 of the 139** messages that could go. Cost was $0.030 per 1,000 messages, with a 312 ms median and 877 ms p95 latency. Code: `conductors/in-process/taskfold/taskfold.ts` (`USER_QUESTIONS`, `TASKFOLD_CLASSIFIER`, `maxLoss`).

| Split | Messages | Wrongly folded (keep/lift) | Folded (of fold-worthy) |
|---|---|---|---|
| dev (mixed projects) | 170 | 0 / 125 | 19 / 45 |
| test (mixed projects) | 100 | 0 / 79 | 6 / 21 |
| nukular-ai (labelled before any model run) | 210 | 0 / 137 | 29 / 73 |

## Data

- Source: user-role messages after the opening message, from local Pi sessions in the last 30 days. They include human messages, coordinator-agent messages and harness notices.
- Each message comes with the session's first message (≤1,500 chars), the previous user message (≤600) and the end of the preceding assistant text (≤600). The message itself is cut at 2,000 chars. Taskfold builds the same shape at run time.
- Gold labels: **keep** (opens or redirects work, or asks a new question), **lift** (states a lasting rule, decision or correction) and **fold** (everything else). One rater (the assistant). 11 dev/test labels were revised after seeing model disagreements; the nukular-ai split was labelled blind.
- The raw messages are private and not committed. `evidence/shipped-gate.jsonl` holds per-message hashed ids, gold labels and the shipped gate's scores. `evidence/scores.json` holds per-model, per-question AUC and threshold results.

## What was tried

About 12,500 classifier calls across 13 OpenRouter classifiers, for about $1.55 in total. Two calls were refused, both by `openai/gpt-6-luna-decisions`.

1. **Seven-category labelling with confidence gating** (the first Taskfold design). Its best safe setting folded only 20% of fold-worthy messages, and category accuracy topped out at 71%. Rejected: the categories mix what a message *is* with what losing it *costs*.
2. **Binary keep question, message only.** Ranking quality (AUC) reached .925 for pplx-decider on the first 200 messages, but the safe thresholds did not transfer across splits.
3. **Goal-aware context with several question shapes.** Adding the session goal, the previous user message and the assistant reply helped once the questions referred to them (AUC on nukular-ai .923 vs .856 for the message-only binary question). The `loss` scale ranked best. Asked alone, it made 2 wrong folds on nukular-ai; asked together with the other questions, it made none.
4. **Compact bundles for production.** Sending all 15 questions costs $0.073 per 1,000 messages. The shipped four-question bundle (`keep_goal`, `durable_rule`, `overrule`, `loss`) matched or beat it at fixed thresholds:

| Bundle (pplx-decider-v1.2) | loss < 0.2 | < 0.3 | < 0.4 | $/1k |
|---|---|---|---|---|
| all 15 questions | 1 wrong / 39 folded | 1 / 54 | 1 / 61 | 0.073 |
| `loss` alone | 0 / 31 | 3 / 43 | 3 / 52 | 0.017 |
| `act`, `fate`, `loss` | 0 / 26 | 0 / 41 | 1 / 50 | 0.028 |
| **`keep_goal`, `durable_rule`, `overrule`, `loss`** | 0 / 40 | **0 / 54** | 1 / 61 | 0.030 |

Counts cover all 480 messages: 341 must stay, 139 may fold.

Other models on the 15-question bundle, best feature per model, threshold tuned on dev:

| Model | AUC nukular-ai | Wrongly folded test / nuk | Folded test / nuk | $/1k | p50 |
|---|---|---|---|---|---|
| perplexity/pplx-decider-v1.2 | .923 | 0 / 0 | 3 / 23 | 0.073 | 436 ms |
| nace-ai/drex-max | .924 | 0 / 0 | 0 / 0 | 0.265 | 1,420 ms |
| liquid/d1-ultra | .909 | 1 / 1 | 6 / 26 | 0.155 | 334 ms |
| cloudflare/clef | .911 | 0 / 0 | 3 / 11 | 1.048 | 880 ms |
| microsoft/microsoft-decision-1 | .841 | 0 / 0 | 7 / 15 | 0.148 | 476 ms |

## Design consequences

- **No user-message lifting.** Under the shipped gate, only one folded message scored `durable_rule` ≥ 0.3, and it was a go-ahead. Lasting rules stay verbatim instead of being copied into the record, so the `constraints` field was removed.
- **Fail closed.** If the classifier fails, gives no score, or the message is the opening message, the message is kept.
- **Wording is part of the calibration.** `USER_QUESTIONS` is byte-identical to the benchmarked questions, checked against `evidence/eval5.ts`. Edit the wording only together with a re-run.

## Limits

- The 0.3 threshold was chosen after seeing all three splits. It is the most conservative point where every split had zero wrong folds; 0.4 already made one. Expect it to drift on new workloads.
- Single rater, two project families, and many coordinator-agent messages. Human-only sessions are under-represented.
- A message folded by mistake is still recallable through its `{#code FOLDED}` group, so an error costs a recall, not data. Classifiers can be steered by injected text ("answer true"); the gate only ever folds, never deletes.
- Costs are the provider-reported usage per call, not reconciled against invoices.

## Reproduce

`evidence/eval5.ts` is a Pi extension: `CLF_MODELS=perplexity/pplx-decider-v1.2 CLF_VARIANTS=c_keep CLF_ITEMS=<items.json> CLF_OUT=<out.json> pig -p --no-session --no-tools -e evidence/eval5.ts "Reply with ok."`. `evidence/score5.py` (which uses `score4.py`) computes AUC and threshold tables from the result files. The items file needs the fields `id`, `split`, `gold`, `text`, `goal`, `prev_user` and `prev_asst`.
