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

A finished task folds at the very next request, whatever the pressure. Folding early is what keeps
the provider cache cheap: the work is rewritten once, right after the model has seen it, instead of
after another 100k tokens have piled on top. Each epoch commits as one transaction, so the cache
breaks once per epoch, at the oldest span folded in it.

| Event | What replaces the span |
|---|---|
| a task finishes inside an open parent | a record (below) |
| a non-root parent finishes | one record that composes its children's records |
| a root finishes | one history line: title, status, subtask counts, a short outcome and the codes of its direct children |
| pressure reaches 80% of the budget inside an open root | its folded records, oldest first, become history lines until the projection is back under 60% |
| pressure remains inside a still-open task | runs of its old finished steps (at least `steps.minSteps`, default 4) become step carriers `{"steps":"<key>","label":…,"count":…}`, oldest first; its start message, user messages, document reads and the tail dial stay live |
| a task with step carriers finishes | its record absorbs them |

A history line is never rewritten, merged or shortened afterwards. Recalling a root's code returns
its full record; recalling a child's code returns that child. A task that ended `failed` or whose
subtree has failed or abandoned work says so in its line.

Finished children fold while their parent is open. A blocked task's separate working intervals do
not include unrelated work done while it was paused. If a parent cannot safely fold, its finished
descendants are tried independently, including lists where child work happened after the parent
ended. `tasks` calls made inside another tool (typically `codemode`) count: each one is recorded as
a task event on the outer result. A task that stays open while others start and finish around it
is reported as stale instead of silently blocking folding. Sessions recorded before task events
are adopted once on resume (`tasks.adopt`, or `/accordion tasks adopt [--dry-run]`).

Set `taskfold.floor` to `true` in `~/.accordion/config.json` to also apply recoverable per-block
folding to older work in open tasks and untracked spans. The floor is off by default. It is a
best-effort guard, not a hard budget guarantee: protected or otherwise ineligible content can keep
the request above budget. `taskfold.keepRecentTasks` (default 0) keeps that many finished tasks
raw; raising it delays folds and multiplies rebilled tokens.

## The record

Every folded task is one `assistant` message: its fold tag, then one line of JSON with a fixed key
order and no empty keys.

```
{#3f9a2c FOLDED} {"task":"auth/2","title":"Extract token store","status":"done","criteria":["callers use TokenStore"],"outcome":"Token storage moved to TokenStore; callers use get/set.","decisions":["in-memory map, not sqlite — single process"],"open":["refresh path untested"],"pins":[{"kind":"constraint","text":"Never touch vendor/","source":"user"}],"user":[{"said":"also keep the old API","ids":["p3"]}],"changed":["src/auth/store.ts"],"verified":["npm test → ok"],"children":[{"task":"auth/2.1","title":"Add interface","status":"done","recall":"{#087c9f FOLDED}","outcome":"TokenStore interface added."}]}
```

`outcome`, `decisions` and `open` come from the agent's `report` in the finishing call. `changed`
and `verified` come from the task's own `edit`/`write` calls and check-like `bash` commands,
excluding child spans. `user` links each routed user message inside the span to the list items it
produced. Each child carries its own tag in `recall`. One code per task is derived from its id, so
it stays stable when the planner recompiles. `recall` returns the task's raw intervals;
`unfold` opens them, and while taskfold stays attached it re-folds eligible siblings around the
requested child. When a record would exceed `taskfold.recordTokens` (default 1,500), its deepest
children become history lines until it fits. Task pins are kept verbatim at every level.

## User messages

A user message is never a fold boundary. Inside a span it folds with the span, once what it said
has been recorded in the task list. For each new message the conductor:

1. classifies it (existing classifier);
2. for a message that can carry durable content, asks a context-aware extractor (a `chat` completion) for list operations: goals, tasks, criteria, pins and attachments to add,
   change or remove, given the list, the task in progress and the agent's last reply;
3. applies them through the same store actions the agent uses. A pin must occur word for word in
   the message or it is dropped; a refused operation is dropped and logged;
4. tells the agent once, with a JSON notice, what changed, so it can revert anything.

A message whose content reached the list is *routed* and folds with its span; its record lists
`user: [{said, ids}]`. A message that was not routed (extraction failed, timed out, or nothing
attached to route it into) falls back to the classifier: it folds only when its expected `loss`
(0–3) is below 0.3, otherwise it stays verbatim and ends the run. Harness text such as
`<system-reminder>` is recognized by pattern. The session's opening message is never sent.

The classifier sees the message, the session's first message, the previous user message and the end
of the assistant's last reply. On 480 hand-labelled messages from real sessions, the gate folded
none of the 341 that had to stay and 54 of the 139 that could fold, at about $0.03 per 1,000
messages and a 312 ms median. The default classifier is
`openrouter/perplexity/pplx-decider-v1.2`; `models.defaults.classifier` or
`models.conductors.taskfold.classifier` in `~/.accordion/config.json` overrides it, and another
model may need a different threshold. The extractor uses the `chat` model: `models.defaults.chat` or `models.conductors.taskfold.chat`, else the session model. If a
model runs off this machine, attaching taskfold first asks for a one-time consent, because its
provider receives your user messages. If the classifier is unreachable, unrouted messages are
kept and the status line counts the unclassified ones.

## Untracked work

If pressure remains after finished tasks are folded and open roots condensed, runs of at least eight
assistant steps outside task spans can fold into recoverable `[untracked-work]` records. User
messages, document reads, existing groups, held blocks and your tail dial stay outside those
runs. Without task boundaries these records have only limited derived facts, not the agent's report.
