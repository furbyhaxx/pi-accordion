# S8 replay of the lost session (2026-11-13)

`node extension/replay-session.mjs <session.jsonl> --budget 272000` loads a saved session as a
resume under Taskfold, sends six requests and reports the standing context. No model is called.

Session `01a1c624` (2,347 messages, 2,283,324 tokens unfolded), budget 272,000:

| code | standing tokens | fits |
|---|---|---|
| `feat/pi-native` at `bfbbf5b` | 365,368 | no |
| `feat/recall-redesign` at `9c284b9` | 192,475 | yes |

Same script for both rows; the first imported `extension/accordion.ts` of the main checkout.
Neither run printed "saturated" within six requests; the base run stays 93k over the budget with no
further fold available, which is the state the user's session reported as saturated.

Not covered: classification and extraction calls (unavailable offline, so user messages stay
verbatim in both runs), and the provider's real token count.

# S8 live run in pig (2026-11-13)

`pig -p -ne -e extension/accordion.ts --model openai-codex/gpt-6-luna` in a scratch directory with
its own `ACCORDION_HOME`: Taskfold armed, budget 30k, `recall.ledger.enabled`. Three 35 KB log
files, each with one line of facts in the middle; one task per file, then a fourth task that had to
answer four questions through `recall` without reading a file again.

| | result |
|---|---|
| answers | 4 of 4 correct (id, port, count from searches; constraint from `ask` with a valid citation) |
| largest request | 22,602 tokens (budget 30,000; the three reads alone are ~27,000) |
| search results | 589 to 2,399 characters each |
| ledger | 4, 15 and 6 verified rows; every asked value present; one task also got 9 noise rows (worker names) |

Three runs. The first two found defects fixed in `99e0c66`: long entries were shown to the
extraction model by their ends only, so the facts were missed; rows did not match a query that
named the task; searches returned earlier recall results. The third run is the table above.

Still seen in the third run: the agent read the whole cited entry (7,800 tokens, one page) to check
the `ask` answer. The hint under an answer now names a search of the entry instead; not re-run.
