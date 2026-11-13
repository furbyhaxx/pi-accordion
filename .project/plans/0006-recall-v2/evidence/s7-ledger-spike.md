# S7 fact-ledger spike (2026-11-13)

Gate from the plan: at least 70% of twenty follow-up questions answered from extracted rows alone.

## Result: 18 of 20 (90%). The gate passes.

| | answered |
|---|---|
| verified ledger rows | 18 / 20 |
| the task's own completion report | 13 / 20 |

Five finished tasks of session `01a1c624` (two measurement spikes, one result classification, one
host provisioning, one adapter build with live test), four questions each.

| task | transcript tokens | rows | verified | ledger tokens |
|---|---|---|---|---|
| sparse-code spike | ~11,700 | 52 | 51 | ~1,640 |
| failure-guard spike | ~9,200 | 54 | 54 | ~1,270 |
| correction recurrence | ~5,200 | 48 | 46 | ~1,280 |
| Btrfs provisioning | ~11,900 | 39 | 39 | ~1,200 |
| harness adapter | ~15,300 | 52 | 51 | ~1,310 |

- 241 of 245 rows (98%) passed the verbatim check (value occurs character for character in the
  cited entry).
- Both misses are single numbers inside a large printed result table (one precision value among
  about forty). The 60-row cap makes the model pick; tables lose.
- Question kinds: 9 counts or measurements, 3 commit hashes, 2 paths or file names, 2 identifiers
  (UUID, subvolume id), 2 error causes, 1 port, 1 model name.

## Method

1. Task spans cut from the session log between `tasks start` and `tasks complete`; every text, tool
   call and tool result is one numbered entry.
2. Questions and expected values written from a clipped view of the spans (tool output cut to
   400–900 characters) before any extraction ran.
3. One call per task to `openai-codex/gpt-6-luna` (`pig -p`, no tools, no extensions) with the
   whole numbered transcript; prompt in `ledger_spike.py`. Output rows `{key, value, unit, entry}`.
4. A row is kept when its value occurs verbatim in the cited entry.
5. A question counts as answered when every expected value occurs in a kept row's value (for
   one- to two-digit values the row's key must also name the subject). Short matches were read by
   hand.

## Limits

- Twenty questions by one author, who also built the feature; written from clipped output, so they
  lean toward values that are visible near the start or end of a result.
- All five tasks fit one call (at most ~15k tokens). The tasks that hurt recall are 50–90k tokens;
  chunked extraction is untested.
- One model, one run, no variance measured.
- The literal search of S2 finds all twenty values when the agent knows a distinctive term. What the
  ledger adds is lookup by meaning ("subvolume id" → `324`) at about 1,300 tokens per task instead of
  excerpts. This spike did not measure that against search in a live agent.
- Cost: one extra completion per folded task with the task's whole transcript as input.

Private inputs (span table, questions with their values, extracted rows) are not committed.
