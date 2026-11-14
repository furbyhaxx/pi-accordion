# Taskfold protocol evaluation harness

`scenarios.mjs` creates four independent, synthetic Node projects. The discount scenario's
money helper is an implicit prerequisite. After the decision scenario's first stop, the runner
records whether a user-decision block remains open and whether the fix was already implemented,
then supplies the scripted answer even if the block was missing. The verifier checks behavior
separately from the model's self-report. For bug, docs and decision scenarios the runner also reverts the relevant
implementation in a disposable copy and checks that the submitted tests fail against it.

From the repository root, with Pi-Bolt, bubblewrap and the configured pi-auth-plus installation:

```sh
node --test extension/eval/tasks/scenarios.test.mjs extension/eval/tasks/sandbox.test.mjs
node extension/eval/tasks/run.mjs '<provider/model>' bug .pi/eval-bug-run
# model ids with a colon: ACCORDION_EVAL_PROVIDER=synthetic node extension/eval/tasks/run.mjs 'hf:<org>/<model>' bug .pi/eval-bug-run
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

The money helper makes prerequisite discovery possible; whether a model actually repairs its
plan is a measured observation, not inferred from using the helper.

The verifier checks behavior, not the model's self-report: a `bug` failure is the withheld
rounding prerequisite in `src/money.mjs`, a `docs` failure a missing documented case-sensitive
mode. Neither is a harness defect.
