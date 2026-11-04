# taskfold

Folds finished task spans into structured task records.

The agent tracks its work with the `tasks` tool, which is active only while taskfold is
attached. A **span** runs from a successful `tasks start <id>` call to the successful `complete`,
`fail` or `abandon` call for the same task. Lists persist per project in `.pig/tasks/<slug>.json`,
so a list outlives the session that created it. Each list has a claim, so two sessions don't work
on the same list at once.

## When it folds

Nothing happens below 80% of the budget. Above that, one epoch folds the oldest finished spans
until the projection is back under 60%. Each epoch commits as one transaction, so the prompt cache
breaks once per epoch, at the oldest folded span. It does not break once per finished task.

Nested tasks fold outermost first. When a parent finishes, its folded children are absorbed into
the parent's group in the same transaction, and each child becomes one line under `children:`.

## The record

```
{#3f9a2c FOLDED} [task-record] auth/2 "Extract token store"  status: done
outcome: Token storage moved to TokenStore; callers use get/set.
decisions:
  - in-memory map, not sqlite — single process
constraints:
  - Don't touch the lexer.
changed: src/auth/store.ts, src/auth/index.ts
verified:
  - `npm test` → ok
open:
  - refresh path untested
children:
  - 2.1 "Add interface" done: TokenStore interface added.
```

`outcome`, `decisions` and `open` come from the agent's `report` in the finishing call. The tool
rejects reports that are missing or over budget, with a message saying how to fix them.
`changed` and `verified` come from the span's own `edit`/`write` calls and its check-like `bash`
commands. `constraints` lifts user steering verbatim. The `{#code FOLDED}` tag means `recall` and
`unfold` always return the raw span.

## User messages

A user message inside a span stays verbatim unless a classifier model labels it as a constraint,
steering, extra information, an acknowledgement or harness text, with at least 0.6 confidence.
Kept messages split the span into several groups, and the record rides on the last one. Harness
text such as `<system-reminder>` is recognized by pattern, without a model call.

With no classifier configured, every user message is kept. The classifier comes from
`models.defaults.classifier` or `models.conductors.taskfold.classifier` in
`~/.accordion/config.json`. If that model runs off this machine, attaching taskfold first asks
for a one-time consent, because the classifier's provider receives your user messages.

## Not a fit

Sessions that don't use the `tasks` tool get no folding from taskfold. Pair it with work where
the agent plans in tasks, or use keel-lite.
