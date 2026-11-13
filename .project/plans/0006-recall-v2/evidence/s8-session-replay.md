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
