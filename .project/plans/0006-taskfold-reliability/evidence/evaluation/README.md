# Taskfold protocol evaluation harness

`scenarios.mjs` creates four independent, synthetic Node projects. The discount scenario's
money helper is an implicit prerequisite. After the decision scenario's first stop, the runner
records whether a user-decision block remains open and whether the fix was already implemented,
then supplies the scripted answer even if the block was missing. The verifier checks behavior
separately from the model's self-report. For bug, docs and decision scenarios the runner also reverts the relevant
implementation in a disposable copy and checks that the submitted tests fail against it.

From the repository root, with Pi-Bolt, bubblewrap and the configured pi-auth-plus installation:

```sh
node --test .project/plans/0006-taskfold-reliability/evidence/evaluation/scenarios.test.mjs
node .project/plans/0006-taskfold-reliability/evidence/evaluation/run.mjs \
  '<provider/model>' bug .pi/eval-bug-run
```

The output directory must not exist. It contains private session and diagnostic data; do not
commit it. `summary.json` contains metrics and counts only, but still review it before copying
it into evidence. The runner uses a fresh project, session directory and Accordion home; it
loads the current source extension and explicitly consents to sending synthetic session content
to Taskfold's configured model routes. Do not point it at a real project. Shell commands, tests
and behavioral checks run in network-isolated bubblewrap; native file operations have a
project-path preflight guard and task-list symlinks must resolve inside the project. Tool batches
containing a shell call are refused: this prevents model-started shell activity from racing a
native path check, but changes batching behavior relative to an unrestricted session. The native
guard does not defend against an independent hostile host process, so it is not a hostile-code
security boundary. The model has a 30-request and six-minute limit; failed starts, timeouts,
unverified decisions and unknown metrics are not passes.

`isolation-live.json` records a real synthetic canary probe and task-tool cycle.
The money helper makes prerequisite discovery possible; whether a model actually repairs its
plan is a measured observation, not inferred from using the helper.

## Recorded pre-enforcement baseline

Committed summaries: `claude-original.json`, `gpt-original.json`, `deepseek-original.json`,
`glm-original.json`; `kimi-unavailable.json` records why that family could not be measured.
Each row ran all four scenarios on the shipped (uncoached) Taskfold with folding armed and
`--thinking low`.

| Family | Route | Behavior passed | Tracked results | Calls before first start | Decision block |
|---|---|---|---|---|---|
| Claude | `claude/claude-sonnet-5-5` | 4/5 runs (the first decision run predates the reply fix) | 0/2, 0/3, 0/2, 0/3 | never created a list | no |
| GPT | `openai/gpt-6.1-sol` | 3/4 (refactor, docs, decision) | 12/12, 12/12, 16/16, 9/9 | 0 | yes, not early |
| DeepSeek | `deepseek/deepseek-flash` | 4/4 | 0/9, 0/4, 0/6, 0/12 | never created a list | no |
| GLM | `openrouter/z-ai/glm-latest` | 2/4 (refactor, decision) | 0/8, 0/4, 0/9, 5/7 | 0, 0, 0, 2 | yes, not early |

Counts are refactor, bug, docs, decision in that order. All 161 observed requests have unknown
token truth: the runtime records no trustworthy, request-paired measurement yet. `bug` failures
are the withheld rounding prerequisite in `src/money.mjs`; `docs` failures are a missing
documented case-sensitive mode. Neither is a harness defect — the verifier checks behavior, not
the model's self-report.
