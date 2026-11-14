## Summary

PLAN-0006's shipped re-evaluation met **one performance target per family partially** (GPT coach tracking) and **unknown** on four of the eight metrics; the global tracked-result target (≥95%) is missed in both modes, and Kimi has no run at all. The evaluation harness is committed for the four-scenario matrix; the prompt-comparison harness is not. Kimi routes exist only on synthetic (credential + catalog present, budget 13% left), nvidia (key, previously 404), and openrouter (key, $0 credits today); opencode/opencode-go and `kimi-coding` have no credentials.

## Q1 — 8 plan metrics per family × mode

Source: `evidence/prompts/shipped-reevaluation.json` (S7, 2026-11-12T23:21+01), the only post-coaching run. Aggregation: sums over the 4 scenarios for ratios; max over scenarios for rates; `null` = no list/no task calls. `?` = not recorded/unknown. ✓ met, ✗ missed.

**Legend:** M1 tracked results ≥95% · M2 calls before first start ≤6 · M3 p90 leaf tokens/budget ≤15% · M4 rejections/100 task calls ≤3 · M5 out-of-order starts/list ≤1 · M6 plan repairs (report only) · M7 premature stops/prompt ≤0.1 · M8 requests over budget = 0.

**Coach** (total 76/135 = 56.3% ✗, behavior 15/16):

| family | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 |
|---|---|---|---|---|---|---|---|---|
| Claude | 0/10 (0%) ✗ | null (no list) ? | ? | null ? | ? | ? | 0 ✓ | ? (0 trusted/15) |
| GPT | 50/52 (96.2%) ✓ | 1 ✓ | ? | 0 ✓ | ? | ? | 0 ✓ | ? (0/76) |
| DeepSeek | 21/43 (49%) ✗ | 5 ✓ | ? | 16.67 ✗ | ? | ? | 0 ✓ | ? (0/73) |
| GLM | 5/30 (17%) ✗ | 1 ✓ | ? | 0 ✓ | ? | ? | 0 ✓ | ? (0/34) |
| Kimi | blocked, no run | — | — | — | — | — | — | — |

**Gate** (total 59/122 = 48.4% ✗, behavior 12/16):

| family | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 |
|---|---|---|---|---|---|---|---|---|
| Claude | 0/10 (0%) ✗ | null (no list) ? | ? | null ? | ? | ? | 0 ✓ | ? (0/15) |
| GPT | 44/48 (91.7%) ✗ | 2 ✓ | ? | 0 ✓ | ? | ? | 0 ✓ | ? (0/73) |
| DeepSeek | 15/39 (39%) ✗ | 4 ✓ | ? | 31.25 ✗ | ? | ? | 0 ✓ | ? (0/59) |
| GLM | 0/25 (0%) ✗ | null (no list) ? | ? | 96.15 ✗ | ? | ? | 0 ✓ | ? (0/48 of 49; capped) |
| Kimi | blocked, no run | — | — | — | — | — | — | — |

- M3 and M8 are unknown for **every** cell: `tokens.trustedRequests = 0`, `requestsOverBudget = null`, `leafTokensPerBudgetP90 = null`; the audit states leaf spans are not stored (`evidence/evaluation/README.md:49-50`).
- M5 and M6 are **absent from the shipped JSON schema entirely** (entry keys are only family, scenario, requests, behaviorPassed, testsPassed, timedOut, capped, tracked*, workResults, callsBeforeFirstStart, rejectionsPer100, lists, prematureStops, tokens). The pre-enforcement originals did carry `outOfOrderStarts`/`planRepairs`: all 0 except GLM decision (`outOfOrderStarts: null`, 1 unknown start) (`evaluation/glm-original.json`).
- M7 is 0 in every run; each scenario has one typed user prompt, so 0 ≤ 0.1. (Not a `perPrompt` field in shipped data.)
- Claude coach and gate entries are numerically identical (15 requests, same per-scenario numbers). Plausible: gate only fires after the 10-call orientation allowance and Claude made 3–5 requests per scenario, so it never fired.
- Pre-enforcement baseline (`shipped-reevaluation.json.baselineTotals`; `evaluation/*-original.json`): Claude 0/12 (4/4 behavior), GPT 49/49 (3/4), DeepSeek 0/31 (4/4), GLM 5/28 (2/4); 161 requests all unknown token truth. GPT fell 100%→96.2% tracked after coaching.
- S6 prompt comparison (`evidence/prompts/comparison.json:8-10`): coach control 59/132 vs candidate 57/127, behavior 12/16 both; gate control 54/122 vs candidate 75/139, requests 173 vs 208, behavior 14/16 both. Candidate rejected. Per family control→candidate tracked: Claude 3/18→0/11 coach, 0/12→0/11 gate; GPT 42/44→41/45, 36/39→46/49; DeepSeek 9/33→13/44, 18/42→23/46; GLM 5/37→3/27, 0/29→6/33.

## Q2 — How the evaluation runs

- Runner: `.project/plans/0006-taskfold-reliability/evidence/evaluation/run.mjs`; scenarios `scenarios.mjs`; bwrap sandbox `sandbox.mjs`; tests `scenarios.test.mjs`, `sandbox.test.mjs`; audit `extension/audit-tasks.mjs`.
- Exact commands (`evidence/evaluation/README.md:10-16`):
  - `node --test .project/plans/0006-taskfold-reliability/evidence/evaluation/scenarios.test.mjs`
  - `node .project/plans/0006-taskfold-reliability/evidence/evaluation/run.mjs '<provider/model>' <refactor|bug|docs|decision|history> <outputDir> [coach|gate|off]`
- Internals (`run.mjs:87-106`): rejects an existing output dir, builds a synthetic project + fresh `ACCORDION_HOME` with `autoArm`, `defaultConductor: taskfold`, `debug`, `tasks.enforce` and taskfold consent, then spawns `pi-bolt --offline --no-extensions -e <pi-auth-plus>/src/index.ts -e <repo>/extension/accordion.ts -e sandbox.mjs --tools read,bash,edit,write,tasks,unfold,recall --model <id> --thinking low --mode rpc`; defaults `timeoutMs=360000` (6 min), `maxRequests=30`; SIGTERM then SIGKILL; behavior and tests verified in bwrap; summary.json written 0600.
- Models used: `claude/claude-sonnet-5-5`, `openai/gpt-6.1-sol`, `deepseek/deepseek-flash`, `openrouter/z-ai/glm-latest` (`evaluation/README.md:42-47`). Original runs used the tighter `timeoutMs 240000`, `maxRequests 25` (entry header in `gpt-original.json`). Prompt re-evaluation used the same bounds as baseline: 30 requests / six minutes, thinking low, folding armed (task report `.pig/tasks/backlog-completion.json:5149-5153`); 16 runs per mode (4 families × 4 scenarios), 198 coach + 196 gate requests.
- Cost: **not recorded** anywhere (no cost/usage/price field in any evidence; grep for cost/USD found only prose). Runtime is recorded only as the request/time bounds, not wall-clock totals.
- Committed/runnable: the files are present in `evidence/evaluation/`, and prerequisites exist (`/usr/bin/bwrap`, `~/.local/bin/pi-bolt`, the hardcoded pi-auth-plus `src/index.ts`). I could not verify git tracking or execute a run: this subagent has no shell/exec tool (see BLOCKERS), and a gate was running in the checkout. The prompt-comparison harness itself is **not committed**: it lived under `.pi/eval-prompts/` (`.pi/` is gitignored, dir now absent), so `comparison.json`/`shipped-reevaluation.json` are aggregates without their driver or per-scenario command log.

## Q3 — What is still open for B-0001 deletion

Per plan text:
1. **Tracked non-exempt results ≥95%** — missed: coach 76/135 (56%), gate 59/122 (48%); "B-0001 stays open on that target" (`plan.md:44-47`). The table allows "a justified per-model gate override when missed" (`plan.md:262`), but gate scored lower, so no override applies.
2. **Kimi baseline** — "Blocked: the Kimi baseline needs a funded route (task 5)" (`plan.md:48`); task 6 acceptance criterion: all four scenarios run on a funded Kimi route with sanitized metrics committed alongside the other family baselines (`.pig/tasks/backlog-completion.json` task 6).
3. **Claude folded-work disavowal** — recorded as unresolved in the task report's `open` list, not a plan "Blocked" line (`evidence/prompts/history-comprehension.json:6`).
4. **Deletion gate** — "Delete B-0001 and its pointer only after its behavior and required checks are reached" (`plan.md:291`), i.e. the whole "Verification and done when" list (`plan.md:262-291`): unit/regression suites, smoke, app check/test, remote-SDK rebuild + production package paths, real Pi-Bolt narrow/wide terminal checks, bounded model evaluation with evidence, docs/skills/specs updates. The plan does not record completion of the narrow/wide terminal pass or production package-path exercise — UNVERIFIED status. Pointer exists at `BACKLOG.md:1`; item body only points at the plan (`.project/backlog/B-0001-taskfold-reliability.md`).

## Q4 — Kimi/moonshot routes on this host

Not verifiable by execution: no shell tool, and `pi-bolt` is a 315 MB binary (`read` refuses it as text), so `pig --help`/`pi-bolt --help` and `--list-models` were **not run**. Findings come from catalog/auth config.

Every configured id containing kimi/moonshot:
- `synthetic`: `hf:moonshotai/Kimi-K3.1-Pro`, `hf:moonshotai/Kimi-K3` (`models-store.json:6146,6166`); enabled in `~/.pi` settings (`Kimi-K3`) and `~/.pig` settings (`Kimi-K3.1-Pro`, also a `272k` budget entry in `~/.accordion/config.json`).
- `nvidia`: catalog `moonshotai/kimi-k2.6` (`models-store.json:6522`); `models.json:93` declares an override for `moonshotai/kimi-k3`.
- `openrouter`: `~moonshotai/kimi-latest`, `moonshotai/kimi-k2`, `-k2-0905`, `-k2-thinking`, `-k2.5`, `-k2.6`, `-k2.7-code`, `-k3`, `-k3:batch`, `-k3.1-pro` (`models-store.json:7984,13384-13672`). Note the evidence attempted `openrouter/moonshotai/kimi-latest`, but the catalog id is `~moonshotai/kimi-latest` (leading `~`).
- `opencode`: `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`; `opencode-go`: `kimi-k2.7-code`, `kimi-k3` (models-store).
- `kimi-coding`: `models.json:37-43` declares model `k3` with a 272k window, but no catalog entries, no registration (not in pi-auth-plus providers) and no credential — dead config.

Credentials (keys/fields only, values not read):
- `~/.pi/agent/auth.json`: `synthetic`, `nvidia`, `openrouter`, `deepseek`, `claude`, `google`, `openai`, `xai`, `antigravity`. **No** `kimi-coding`, `opencode`, `opencode-go`.
- `~/.pig/agent/auth.json`: `openai-codex`, `deepseek`, `openrouter`, `anthropic`, `synthetic`, `claude`, `xai`, `antigravity`. No opencode/opencode-go/kimi-coding.
- Quota cache (`~/.pi/agent/cache/auth-plus/quotas.json`): entries for `antigravity, claude, codex, deepseek, openai, openrouter, synthetic, xai`. Funding now: openrouter **$0.00 left** (`credits.remaining: 0`); synthetic 7d plan **13.24% left** (`usedFraction 0.8676`, reset due within ~42 min of the snapshot).

Implication: the only previously untried/funded-ish Kimi path is `synthetic/hf:moonshotai/Kimi-K3(.1-Pro)` (key + catalog + 13% budget). `kimi-unavailable.json` records five failed attempts: nvidia `moonshotai/kimi-k2.6` → 404, openrouter `moonshotai/kimi-latest` → 402, opencode/kimi-k2.5 and opencode-go/kimi-k3 → credentials_not_configured, synthetic `hf:moonshotai/Kimi-K3` → model not found in the then-running catalog. Whether synthetic accepts Kimi now needs a live probe — UNVERIFIED.

## Q5 — Per-model gate override

- Resolution: `extension/dials.ts:149-155` `modelTaskDials(model, defaults)` walks `provider/model` → `provider/*` → `*` (`patternsFor`, `dials.ts:89-92`) and returns the **first** pattern's `.tasks` object wholesale (no field merge).
- Schema/sanitizing: `dials.ts:14-19` `ModelTaskDials { enforce?: "coach"|"gate"|"off"; orientationCalls?; largeLeaf? }`; `dials.ts:128-146` validates values; `dials.ts:95-114` attaches it under `modelDefaults[key].tasks`.
- Application: `extension/accordion.ts:3597-3610` `coachPolicy()` computes `modelSpec()` as `` `${latestModelObj.provider}/${latestModelObj.id}` `` (`accordion.ts:2899-2902`) and applies `enforce: exact.enforce ?? settings.tasks.enforce`, `orientationCalls` likewise, and `largeLeaf: {...settings.tasks.largeLeaf, ...exact.largeLeaf}`. `gateFailOpenAfter` and `stopOnBlock` are **not** per-model.
- Shipped defaults: global `tasks.enforce: "coach"` (`extension/settings.ts:148-160`), sanitizer falls back to `"coach"` (`settings.ts:311`), and `modelDefaults: {}` (`settings.ts:166`). Grep of `extension/`, `conductors/`, `core/` finds no shipped per-family `enforce: "gate"` default (only tests/smoke fixtures). Therefore a family-level gate is **user config only**; this host's `~/.accordion/config.json` has `modelDefaults` entries with `budget`/`protect` only — no `tasks`.
- Settings validation exposes `tasks.enforce` as coach|gate|off (`extension/settingsValidation.ts:50`); `modelDefaults` reaches Settings through `dials.ts` but only via the generic budget/tail/timing patterns path.

## Key files

- `.project/plans/0006-taskfold-reliability/plan.md:44-48,260-291` — progress, metric table, done-when.
- `.project/plans/0006-taskfold-reliability/evidence/prompts/shipped-reevaluation.json` — S7 per-family/scenario metrics (no M5/M6 fields).
- `.../evidence/prompts/comparison.json:8-10` + `.control/.candidate.{coach,gate}` — S6 control/candidate.
- `.../evidence/evaluation/{README.md,run.mjs,scenarios.mjs,sandbox.mjs,*-original.json,kimi-unavailable.json,isolation-live.json}`.
- `.../evidence/lifecycle-live.json`, `evidence/token-truth/audit-pairing-live.json` — ordered lifecycle and token-truth proofs.
- `extension/dials.ts:14-19,89-114,128-155`; `extension/accordion.ts:2899-2902,3597-3610`; `extension/settings.ts:52-74,137-166,311`.
- `~/.pi/agent/{auth.json,settings.json,models.json,models-store.json}`, `~/.pig/agent/{auth.json,settings.json}`, `~/.accordion/config.json`, `.pig/tasks/backlog-completion.json`.

BLOCKERS: No shell/exec tool in this subagent's tool set, so `pig --help`/`pi-bolt --help`, `--list-models`, `git ls-files`, and any runner execution were impossible (pi-bolt is also a 315 MB binary unreadable as text); every command/observation above is from committed files or config reads, and runner reproducibility on a live funded route remains unverified.