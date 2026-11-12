# Taskfold protocol evaluation harness

`scenarios.mjs` creates four independent, synthetic Node projects. The discount scenario's
money helper is an implicit prerequisite; the decision scenario withholds its answer until
an observed `user-decision` task block. The verifier checks behavior separately from the
model's self-report. For bug, docs and decision scenarios the runner also reverts the relevant
implementation in a disposable copy and checks that the submitted tests fail against it.

From the repository root, with Pi-Bolt and the configured pi-auth-plus installation:

```sh
node --test .project/plans/0006-taskfold-reliability/evidence/evaluation/scenarios.test.mjs
node .project/plans/0006-taskfold-reliability/evidence/evaluation/run.mjs \
  '<provider/model>' bug .pi/eval-bug-run
```

The output directory must not exist. It contains private session and diagnostic data; do not
commit it. `summary.json` contains metrics and counts only, but still review it before copying
it into evidence. The runner uses a fresh project, session directory and Accordion home; it
loads the current source extension and explicitly consents to sending synthetic session content
to Taskfold's configured model routes. Do not point it at a real project. This is **not an OS
sandbox**: Pi's tools run with the invoking user's permissions. The model has a 30-request and
six-minute limit; failed starts, timeouts, unverified decisions and unknown metrics are not passes.

The money helper makes prerequisite discovery possible; whether a model actually repairs its
plan is a measured observation, not inferred from using the helper. Token budget metrics remain
unknown until matched, trustworthy measurements are available. Baselines have not yet been run.
