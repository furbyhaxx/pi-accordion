# taskfold

Folds finished task spans into structured task records.

When `tasks` is active, its default system-prompt guidance asks agents to break broad features into
independently verifiable child tasks. Each child can finish and become eligible for folding while
its parent remains open. Task size remains a judgment: avoid both large multi-feature leaves and
bookkeeping-only microtasks. A custom replacement system prompt may omit this default guidance.

The agent tracks its work with the `tasks` tool, which is active only while taskfold is
attached. A **span** runs from a successful `tasks start <id>` call to the successful `complete`,
`fail` or `abandon` call for the same task. Lists persist per project in `.pig/tasks/<slug>.json`,
so a list outlives the session that created it. Each list has a claim, so two sessions don't work
on the same list at once. Use `release {list}` to hand a list to another session; releasing an
unclaimed list or another session's claim is rejected. Normal session shutdown (including reload
or session replacement) automatically releases this session's claims without changing task status
or reports. A crash or forced kill still relies on the stale-claim timeout or an explicit takeover.

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
commands. The `{#code FOLDED}` tag means `recall` and
`unfold` always return the raw span.

## User messages

A user message inside a span stays verbatim unless a classifier model scores that losing it would
cost the later work nothing: approvals, "commit and push", status checks, instructions about the
current step, facts the step already used, and retry notices. Anything that starts work, asks a
new question, or states a rule, decision or correction stays verbatim, so the record never has to
reconstruct it. Kept messages split the span into several groups, and the record rides on the
last one. Harness text such as `<system-reminder>` is recognized by pattern, without a model call.
The session's opening message is never sent.

The classifier sees the message, the session's first message, the previous user message and the
end of the assistant's last reply. It answers four questions in one call and the message folds
when the expected `loss` level (0–3) is below 0.3. On 480 hand-labelled messages from real
sessions, that gate folded none of the 341 that had to stay and 54 of the 139 that could fold, at
about $0.03 per 1,000 messages and a 312 ms median.

The default classifier is `openrouter/perplexity/pplx-decider-v1.2`, the model the questions and
threshold are calibrated for. `models.defaults.classifier` or `models.conductors.taskfold.classifier`
in `~/.accordion/config.json` overrides it; another model may need a different threshold. If the
classifier runs off this machine, attaching taskfold first asks for a one-time consent, because
its provider receives your user messages. If the classifier is unreachable, every user message is
kept and the status line counts the unclassified ones.

## Not a fit

Sessions that don't use the `tasks` tool get no folding from taskfold. Pair it with work where
the agent plans in tasks, or use keel-lite.
