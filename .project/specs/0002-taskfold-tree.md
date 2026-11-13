---
document:
  type: "specification"
  id: "SPEC-0002"
  title: "Taskfold: nested task lists, structured tool results, context delivery, composed records, history and floor"
  description: "Decided design for task list v3 (nested tree, multiple goals, acceptance criteria, pins, anchored attachments, move/insert), structured tasks tool results and delivered-once context, the tree planner that folds task spans eagerly into JSON records and root history, user-message routing, legacy session adoption, the folding floor, the task widget legibility changes, the tasks protocol fixes and the task-list authoring skill."
  status: "published"
  revision: 38
  created_at: "2026-11-06T14:44:51+01:00"
  updated_at: "2026-11-13T14:35:00+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 38
      reason: "integrate recall v2 with fold timing and conductor options"
      changes: ["retain timing and option contracts alongside SPEC-0003 recall"]
---

# Taskfold

The Taskfold tree is implemented; active changes are tracked in project task lists and `BACKLOG.md`.

This spec amends SPEC-0001 §4.3, §4.4, §4.10, §4.11 and §4.15. Each slice that changes one of those
behaviours updates SPEC-0001 in the same commit.

Evidence it builds on:
- `.project/analyses/orientation-modes/README.md` (experiments from branch `exp/orientation-modes`)
- `.project/analyses/2026-11-05-taskfold-session-failures/analysis.md` and
  `.project/plans/0006-taskfold-reliability/plan.md` (reliability decisions from branch `fix/failing-sessions`)

The evidence originated in those branches; their code is ported, not merged, except
commit `f04f39d`.

## 1. Scope

| In | Out (separate changes) |
|---|---|
| Task list file v3 (nested, `goals`, `acceptanceCriteria`, item ids, pins, attachments) and v1/v2 migration | Synthetic usage units and calibration bounds (PLAN-0006) |
| Store actions `update`, `move`, `add before/after`, `pin`/`unpin`, `attach`/`detach` | Sequential order, `delegated`, coaching/gate, consent decoupling and measured prompt rewrite (PLAN-0006) |
| Span intervals, structured span facts, cascade nodes | Making `acceptanceCriteria` required |
| Tree planner, flat compiler, composed records, `Group.handles` | Orientation typed fold, agent orientation task, doorman, keel-note note |
| Aging by task age, keep-recent by finish order | |
| Folding floor and untracked records | |
| Structured JSON tool results; context delivered once by `start`, derived liveness | |
| Content anchors for attachments (section, symbol, quote) | |
| Task widget title and legibility | |
| Protocol fixes: empty-span refusal, review gate, resume note | |
| Out-of-band list changes as appended notices | |
| Skill `accordion-task-lists` | |

## 2. Task list file v3

### 2.1 Format

File: `<project>/.pig/tasks/<slug>.json`, or a symlink there to a list kept elsewhere (next to its
plan); writes replace the link's target atomically and keep the link. JSON Schema shipped as
`extension/skills/accordion-task-lists/references/tasks.schema.json` (the package ships `skills/`),
referenced by `$schema`.

```json
{
  "$schema": "https://raw.githubusercontent.com/furbyhaxx/pi-accordion/feat/pi-native/extension/skills/accordion-task-lists/references/tasks.schema.json",
  "version": 3,
  "slug": "auth",
  "title": "Token store",
  "goals": [
    { "id": "g1", "text": "All token access goes through TokenStore; no direct map access left." },
    { "id": "g2", "text": "npm test passes." }
  ],
  "createdAt": "…", "updatedAt": "…",
  "claim": null,
  "pins": [ { "id": "p1", "kind": "constraint", "text": "Never modify vendor/", "source": "user", "at": "…" } ],
  "attachments": [ { "id": "a1", "path": "docs/plans/auth.md", "anchor": { "section": "Rollout > Phase 3" }, "note": "plan §3", "hash": "…", "at": "…" } ],
  "tasks": [
    { "id": "1", "title": "Survey token callers", "acceptanceCriteria": [{ "id": "c1", "text": "every caller of the token map is listed" }], "status": "todo" },
    { "id": "2", "title": "Extract TokenStore", "status": "todo", "subtasks": [
      { "id": "2.1", "title": "Add the interface", "status": "todo",
        "attachments": [ { "id": "a2", "path": "src/auth/store.ts", "anchor": { "symbol": "TokenStore" } } ] }
    ] }
  ]
}
```

| Field | Rule |
|---|---|
| `version` | `3`. `2` (single `goal` string, string criteria) and absent (v1) are migrated on load |
| `goals` | On the list: required for authoring and for `create`, 1–5 items of 1–600 chars, together the end state the whole list delivers. On a task: optional, ≤3 items of ≤300 chars, what this subtree must achieve beyond its criteria. The store loads a list without goals (migrated, or created from the UI) and gates new work on it (§2.2) |
| item ids | Goals `g<n>`, criteria `c<n>`, pins `p<n>`, attachments `a<n>`: unique within the list, assigned by the store, never reused after removal. Authors may omit them; an explicit id that collides is a validation error |
| `tasks[].subtasks` | Nested tree with no fixed maximum depth |
| `tasks[].id` | Optional when authoring. Derived from position on load (`1`, `1.2`, …). An explicit id that disagrees with its position is a validation error |
| `acceptanceCriteria` | Optional, ≤8 items (1–3 recommended) `{id, text}` of ≤300 chars, checkable end-state statements. Authoring accepts plain strings and assigns ids |
| `status` | Optional when authoring (`todo`). Other `Task` fields (`report`, timestamps, `blocks`, `supersededBy`, `autoClosed`) keep their v1 meaning |
| `pins`, `attachments` | On the list and on any task (§4). `attachment.anchor` is one of `{section}`, `{symbol}`, `{quote: {exact, prefix, suffix, start}}` or absent (whole file). v2 files with `lines` are converted to a quote anchor on load. Authors omit ids, a pin's `at` and an attachment's `hash`/`at`; a hand-written quote may give only `exact`, and its first delivery resolves it without a `moved` state and stores the completed anchor |

`id` stays a dotted path. Everything that keys on `<list>/<id>` (span keys, records, widget,
verdicts, bindings) is unchanged.

### 2.2 Load, validate, migrate

- **Every read validates.** A file that fails validation makes the `tasks` call fail with a
  `TaskError` naming each problem and its fix, for example `tasks[1].subtasks[0]: id "2.3" does not
  match its position 2.1; remove the id or move the task`. The file is not rewritten.
- **v1 files** (flat `tasks[]`, no `version`) are converted in memory: the tree is rebuilt from the
  dotted ids. **v2 files** convert `goal` to `goals: [{id: "g1", text}]` and string criteria to
  `{id, text}` in document order. The next write stores v3. Every serialized candidate is validated before atomic replacement; a rejected conversion leaves the original file unchanged. Native task views name invalid lists instead of treating them as absent.
- **No goals** (a migrated legacy list): `start`, `add` and `move` are refused until
  `tasks update {list, goals: {add: [...]}}` sets one. The native lists browser asks for title and goals when creating a list. `list`, `status`, `claim` and the finishing actions still
  work, so a running task can always be ended.
- **Hand edits** made while a list is claimed are accepted if they validate. Changing the id or
  position of a started task is a validation error: started ids are frozen (§3.5).
- `tasks list` names files that fail to load (`<slug> — invalid file; "status" shows what to fix`)
  instead of skipping them silently.
- Validator: `extension/taskSchema.ts`, pure and import-free, used by the store
  (`requireGoal: false`) and by the skill's `scripts/validate.mjs` (goal required). The store does
  not call the JSON-Schema file at runtime. The schema is the authoring contract, and
  `extension/taskSchema.test.ts` keeps the two in sync.

## 3. `tasks` tool

While `tasks` is active, its system-prompt guidance asks the agent to split broad features into
independently verifiable child tasks before work, or add children if a leaf grows unexpectedly.
Finished children can then fold while their parent remains open. Do not impose a fixed task count
or split trivial steps merely for bookkeeping. Verify that the installed Pi prompt builder includes
this guidance for the active tool; a replacement system prompt may omit it.

### 3.1 Principles

The tool result is the only channel through which task context reaches the model. Nothing is
injected into the request afterwards (§4.5).

1. **Deliver once, where it is needed.** `start` returns the task's context (goal, criteria, pins,
   attachment contents) exactly once. It rides in the start result, which is the first block of the
   task's span, so it folds together with the span.
2. **Never echo what the agent already has.** The agent wrote its titles, criteria, reports, pins
   and attachment references; results refer to them by id. Content that a still-unfolded result
   already delivered is not sent again (§4.3).
3. **Return what the tool decided.** Assigned ids, renumbering, cascades, auto-started or blocked
   ancestors, a parent that became ready, the next task. Nothing else.
4. **Append, never rewrite.** No result, notice or hook edits an earlier message. Every request
   extends the previous one, so provider prompt caches stay warm.
5. **Guidance lives in the tool description**, not in results. Results carry no instructions.

### 3.2 Result envelope

Results are compact single-line JSON (`JSON.stringify` without indentation). Absent and empty
fields are omitted; the examples below are pretty-printed for reading only.

```ts
type Ok = { ok: true } & ActionResult;
type Err = { ok: false; error: ErrorCode; message: string; fix?: string };
```

| `error` | When | `fix` |
|---|---|---|
| `invalid_args` | missing/unknown field, wrong type, `dependency`/`blockedBy`, `delegate` without `delegated` | the call that works |
| `not_found` | list, task, pin, attachment or anchor does not exist | closest match |
| `invalid_file` | list file fails validation (§2.2) | each problem and its fix |
| `no_goal` | `start`/`add`/`move` on a list without goals | `update {list, goals: {add: [...]}}` |
| `claimed_by_other` | list claimed by another session | `claim {force: true}` after asking the user |
| `frozen` | edit of a started id, finished title/criteria | the call that works, e.g. `add … after` |
| `invalid_transition` | e.g. complete a todo task, start a finished one, start out of order (§3.4) | the next valid `start` or `move` call |
| `open_subtasks` | complete a parent with unstarted/blocked subtasks | ids to fail or abandon |
| `empty_span` | §3.5 | block or abandon call |
| `cap_exceeded` | pin/attachment caps (§4.1, §4.2) | |
| `quote_mismatch` | pin text not found in its source | |

`details` (renderer/scan data, never sent to the model) stays a separate structured object (§5.1).

### 3.3 Shared shapes

```ts
type Pin = { id: string; kind: PinKind; text: string; source: string };
type Attachment = {
  id: string; ref: string;           // canonical anchor, e.g. "docs/auth.md#Token store > Interface"
  note?: string;
  content: string;                   // resolved text; omitted when settings render = "reference"
  state?: "moved" | "fuzzy" | "changed" | "lost" | "too_large";   // §4.2; omitted when exact
  candidates?: string[];             // with "lost": what exists nearby
};
type Item = { id: string; text: string };           // goal or criterion
type TaskContext = {                 // a task entering doing
  id: string; title: string;
  goals?: Item[]; criteria?: Item[]; pins?: Pin[]; attachments?: Attachment[];
};
type ListContext = { goals: Item[]; pins?: Pin[]; attachments?: Attachment[] };
type ItemEdit = { add?: string[]; remove?: string[]; edit?: Item[] };  // update goals/criteria
type Ref = { id: string; title: string };
```

`TaskContext.title` is included because the agent may have written it long ago (folded) and the
start result becomes the task's anchor in the transcript. Titles are the only echo.

### 3.4 Actions and results

Titles are at most 200 chars. Finishing reports require an `outcome` of at most 2,000 chars;
`decisions` and `open` each hold at most 12 strings of at most 1,000 chars. The tool description,
tool JSON schema, authoring schema and validator state the same limits. Rejections enumerate
every field violation with its measured length and limit. Reports are never silently truncated.

Parameters are listed in full; `null` means optional and absent.

#### create

```js
tasks({ action: "create", list: "auth", title: "Token store", goals: ["All token access goes through TokenStore.", "npm test passes."],
  tasks: [{ title: "Design", acceptanceCriteria: ["Interface reviewed"], pins: null, attachments: null, supersedes: null,
            subtasks: [{ title: "Draft interface" }, { title: "Review interface" }] },
          { title: "Implement" }] })
```
```json
{"ok": true, "list": "auth", "ids": ["1", "1.1", "1.2", "2"], "goals": ["g1", "g2"], "criteria": {"1": ["c1"]}}
```
`ids` in authored order; `goals` and `criteria` give the assigned item ids (criteria keyed by task). The list is claimed by this session. Pins and attachments given here are
validated and stored, not echoed; they are delivered by `start` (§4.3).

#### list

```js
tasks({ action: "list" })
```
```json
{"ok": true, "lists": [
  {"list": "auth", "title": "Token store", "done": 7, "total": 15, "claim": "this"},
  {"list": "docs", "title": "Docs pass", "done": 0, "total": 4, "claim": "other"},
  {"list": "old", "invalid": true}]}
```
`claim`: `this` | `other` | omitted (unclaimed). Invalid files are listed, not skipped.

#### status

```js
tasks({ action: "status", list: "auth" })
```
```json
{"ok": true, "done": 7, "total": 15,
 "doing": ["3", "3.1", "3.1.1", "3.1.1.2"],
 "blocked": [{"id": "1.2", "reason": "user-decision", "detail": "User must approve the interface."}],
 "next": {"id": "3.1.1.3", "title": "delete()"}}
```
State only: no tree, no finished tasks, no pins or content. `next` is the first `todo` leaf in
document order that is not blocked and whose dependencies are finished. `done`/`total` count
finished tasks (done, failed, abandoned) over all tasks. `criteriaMissing` appears when the
criteria policy is on and an unfinished leaf outside a branch still needs some.

#### claim

```js
tasks({ action: "claim", list: "auth", force: null })
```
```json
{"ok": true, "done": 7, "total": 15,
 "list": {"goals": [{"id": "g1", "text": "All token access goes through TokenStore."}], "pins": [ … ]},
 "active": [{"id": "3", "title": "Implement"}, {"id": "3.1.1.2", "title": "set()", "criteria": [ … ], "attachments": [ … ]}],
 "blocked": [ … ], "next": { … }}
```
`claim` is how a session (re)acquires a list it may have no context for. It returns the status
fields plus the missing context of the list and of every `doing` task (`active`, `TaskContext[]`),
minus what is already live in this context (§4.3). Claiming a list the session already holds with
all context live returns the status fields only.

#### release

```js
tasks({ action: "release", list: "auth" })
```
```json
{"ok": true}
```

#### add

```js
tasks({ action: "add", list: "auth", parent: "2", before: null, after: null,
  tasks: [{ title: "get/set", goals: null, acceptanceCriteria: ["get/set round-trip"], pins: null, attachments: null, subtasks: null, supersedes: null }] })
```
```json
{"ok": true, "ids": ["2.1"], "criteria": {"2.1": ["c7"]}}
{"ok": true, "ids": ["3"], "renumbered": {"3": "4"}}
{"ok": true, "ids": ["2.3"], "abandoned": ["2.1"]}
{"ok": true, "ids": ["3"], "existing": ["3"]}
```
`renumbered` maps old → new for shifted `todo` tasks. `abandoned` lists tasks closed by
`supersedes`. `existing` lists requested tasks that were not created because an unstarted sibling
already had the same title (compared ignoring case and spacing); `ids` holds that sibling's id in
the request's position. This makes an `add` safe against the §4.6 extractor adding the same work
concurrently. A request with subtasks or `supersedes` is never treated as a repeat. If the new task is a child of a `doing` task, nothing about it is delivered yet; its
context arrives with its own `start`.

#### move

```js
tasks({ action: "move", list: "auth", id: "4", parent: null, before: "3", after: null })
```
```json
{"ok": true, "renumbered": {"4": "3", "3": "4"}}
```

#### update

```js
tasks({ action: "update", list: "auth", id: null, title: null, goals: { add: ["No plaintext tokens on disk."], remove: ["g2"], edit: null }, acceptanceCriteria: null })
tasks({ action: "update", list: "auth", id: "1.1", title: "Draft TokenStore interface", goals: null, acceptanceCriteria: { add: null, remove: null, edit: [{ id: "c1", text: "get/set/delete signatures exist" }] } })
```
```json
{"ok": true, "goals": ["g3"]}
{"ok": true}
```
`goals` and `acceptanceCriteria` take an `ItemEdit`: `add` texts (ids returned), `remove` ids,
`edit` id + new text. `goals` without `id` edits the list, with `id` the task. Removing the last list
goal is refused. Criteria and goals of finished tasks are frozen.

#### pin / unpin

```js
tasks({ action: "pin", list: "auth", id: null, items: [{ kind: "constraint", text: "Never touch vendor/.", source: "user" }] })
tasks({ action: "unpin", list: "auth", id: null, pins: ["p1"] })
```
```json
{"ok": true, "pins": ["p1"]}
{"ok": true}
```
`pins`: assigned ids in item order. The agent wrote the text; it is not echoed. The pin is recorded
as delivered by this result (§4.3).

#### attach / detach

```js
tasks({ action: "attach", list: "auth", id: "3.1.1", items: [{ path: "docs/auth.md", section: "Token store > Interface", symbol: null, quote: null, lines: null, note: "interface contract" }] })
tasks({ action: "detach", list: "auth", id: "3.1.1", attachments: ["a2"] })
```
```json
{"ok": true, "attachments": [{"id": "a2", "ref": "docs/auth.md#Token store > Interface"}]}
{"ok": true}
```
`ref` is returned because the tool canonicalized the anchor (§4.2), which the agent did not write in
that form. Content is not returned: attaching to a task that is already `doing` means the agent is
looking at the material. The attachment is recorded as delivered by reference only; its content is
not considered live (§4.3), so a later `claim` or resume delivers it if needed.

#### start

```js
tasks({ action: "start", list: "auth", id: "3.1.1.1" })
```
First start in the list, ancestors auto-started:
```json
{"ok": true,
 "list": {"goals": [{"id": "g1", "text": "All token access goes through TokenStore."}],
          "pins": [{"id": "p1", "kind": "constraint", "text": "Never touch vendor/.", "source": "user"}]},
 "started": [
   {"id": "3", "title": "Implement"},
   {"id": "3.1", "title": "Store core", "pins": [{"id": "p4", "kind": "fact", "text": "Use the platform keychain.", "source": "docs/auth.md:12"}]},
   {"id": "3.1.1", "title": "Read path", "criteria": [{"id": "c4", "text": "get() never touches disk directly"}]},
   {"id": "3.1.1.1", "title": "get()", "criteria": [{"id": "c5", "text": "get/set round-trip passes"}],
    "attachments": [{"id": "a2", "ref": "docs/auth.md#Token store > Interface", "note": "interface contract",
                     "content": "## Interface\n\n```ts\ninterface TokenStore { … }\n```"}]}]}
```
Next sibling, ancestors' context live:
```json
{"ok": true, "started": [{"id": "3.1.1.2", "title": "set()", "criteria": [{"id": "c6", "text": "set overwrites atomically"}]}]}
```
Resume of a blocked task whose earlier delivery is still live:
```json
{"ok": true, "resumed": ["1.2"]}
```
Resume after its delivery folded, with a changed attachment:
```json
{"ok": true, "resumed": [{"id": "1.2", "title": "Review interface", "attachments": [{"id": "a3", "ref": "docs/auth.md#Interface", "state": "changed", "content": "…"}]}]}
```
`started` / `resumed` hold `TaskContext` (or the bare id when nothing is missing), outermost first,
for every task that enters `doing` with this call.

**Order is part of the contract.** `start` accepts only the task the list's `next` names — the first
unfinished leaf in depth-first list order — or any blocked leaf, which `start` resumes. A parent is
refused with its next leaf's call (`Task 3 is a parent; parents start with their next leaf. Call
start { list: "auth", id: "3.1.1.1" }.`) and starts with that leaf. Any other id is refused with the
valid call and how to make room (`Finish 3.1.1.1 "get()" first, or block it when it waits on
something, or "move" this task ahead of it.`). A blocked task whose next sibling is still `todo`
stays the parent's open wait: starting the sibling does not resume the parent. Refusals change
nothing — no claim, no status. `parents` holds the `TaskContext` of ancestors
already `doing` whose goals, criteria, pins or attachments are no longer live (a fold hid the
result that carried them), outermost first; absent when nothing is missing. `list` appears when list context is missing.
Each item is included only if it is not live (§4.3). An attachment whose content changed since it
was attached carries `state` (§4.2).

#### block

```js
tasks({ action: "block", list: "auth", id: "2.1", reason: "user-decision", detail: "Postgres or SQLite?" })
tasks({ action: "block", list: "auth", id: "2.2", reason: "delegated", detail: "frames are rendering", delegate: "agent-7" })
```
```json
{"ok": true}
{"ok": true, "alsoBlocked": ["2"]}
```
`alsoBlocked`: ancestors that became blocked, as a `dependency` on the blocked subtask. That reason
is internal: a caller's `dependency`/`blockedBy` is refused, because a wait on another task in the
list is not something outside the agent's control — it works on that task, or `move`s this one
behind it. `delegated` needs a `delegate` handle, counts as work in flight, and its result must
return to this session, which resumes and integrates it before ending. A `detail` is stored
verbatim; the tool never appends punctuation.

**Criteria policy.** While `tasks.acceptanceCriteria.required` is on, `create` and `add` refuse a
new leaf that carries fewer than `min` (default 1) or more than `max` (default 3) criteria, or one
longer than `maxChars` (default 300, never above the format's 300), naming the call that fixes it.
Lists written before the policy keep loading: `status` and `claim` report `criteriaMissing:
[{id, title, has}]` for unfinished leaves outside a branch, started or in-progress leaves excluded,
and `update {acceptanceCriteria: {add: [...]}}` adds them. A required policy never refuses work over
an old leaf.

**Stopping policy.** With `tasks.stopOnBlock` (default `true`) a block ends the run: `start` of
anything but the waiting task itself (or its subtasks) is refused with `The run is stopped: <id>
"<title>" waits (<label> — <detail>)`. With `false` later leaves run in order while the blocked
interval stays closed, and a resumed leaf opens a new interval; no two leaves are ever `doing`.

#### complete / fail / abandon

```js
tasks({ action: "complete", list: "auth", id: "3.1.1.1", report: { outcome: "get() reads through the keychain.", decisions: ["keychain over file — OS-managed secrets"], open: null } })
tasks({ action: "fail", list: "auth", id: "4", report: { outcome: "Migration failed: exit 1 'no such table tokens'.", decisions: null, open: null } })
tasks({ action: "abandon", list: "auth", id: "5", report: { outcome: "Docs moved to the handbook." }, supersededBy: "2.2" })
```
```json
{"ok": true}
{"ok": true, "next": {"id": "3.1.1.2", "title": "set()"}}
{"ok": true, "parentReady": "3.1.1"}
{"ok": true, "closed": ["3.1.1", "3.1"], "next": {"id": "3.2", "title": "Write path"}}
{"ok": true, "cascaded": ["3.2", "3.3"]}
```
- `next`: the next task under the nearest open ancestor, when one exists.
- `parentReady`: every subtask of that parent is finished; the agent should complete it.
- `closed`: ancestors closed automatically (when that policy applies).
- `cascaded`: subtasks abandoned with a failed/abandoned parent.
The report is not echoed.

### 3.5 Lifecycle rules

Insert and move, empty-span refusal, the review gate and the resume note keep their behavior:
- **Sequential:** leaves start in list order (§3.4 start). Repairing a bad order is `complete` for
  achieved scope, `abandon` for unwanted scope, then `add`/`move` for the rest — never a fabricated
  completion to make the order fit.
- **Only `todo` subtrees move or renumber.** Started ids are frozen because spans, records, folds
  and verdicts refer to them. Moving under a finished parent or into its own subtree is refused.
  Renumbering rewrites `blocks[].on`, `supersededBy` and `supersedes` in the same write.
- **Empty span:** `complete`/`fail` are refused (`empty_span`) when no tool call and no assistant
  text over 40 characters lies inside the task since its last `start`. Counted by `TaskCoach`,
  ancestors included, only while the tool is active; tasks started before this process are exempt.
  `abandon` stays allowed.
- **Review gate:** the tool description says a reply to the user is not a task; a result that needs
  the user's choice is `block`ed with `user-decision` before replying.
- **Resume note:** on a user prompt while a task is blocked on `user-decision`/`user-input`, one
  note (§4.4) names it.

## 4. Context delivery

### 4.1 Pins

| Field | Rule |
|---|---|
| `kind` | `rule`, `convention`, `constraint`, `standard`, `fact` |
| `text` | Verbatim quote, ≤300 chars, checked against `source` (a file or a user message of this session, whitespace-normalized) |
| `source` | `user`, `path`, `path:line`, `path:start-end`, or an anchor ref (§4.2) |
| scope | List (no `id`) or task (`id`): applies to the task and its subtree |
| caps | List pins ≤2,000 tokens, per task ≤1,500 tokens |

A pin is a quote; once pinned its text is fixed. The source is provenance only and is not
re-checked when the file changes.

### 4.2 Attachments and anchors

An attachment names a **part** of a file by what it is, not by line numbers. Anchors, strongest
first:

| Anchor | Input | Stored `ref` | Resolves to |
|---|---|---|---|
| section | `section: "Token store > Interface"` | `path#Token store > Interface` | the Markdown heading path (ATX/Setext, case-sensitive text, `>` separated, matched as a suffix of the full path) and its body up to the next heading of the same or higher level |
| symbol | `symbol: "TokenStore.get"` | `path::TokenStore.get` | the declaration found by tree-sitter (`web-tree-sitter`, already a dependency), dotted for nesting, with its doc comment |
| quote | `quote: "interface TokenStore {"` or `lines: "40-60"` | `path@q:<id>` | a W3C TextQuoteSelector (`exact` + 32-char `prefix`/`suffix`) plus a TextPositionSelector hint |
| file | path only | `path` | the whole file |

- Paths are project-relative. An absolute path is accepted only under a directory listed in
  `tasks.attachments.roots` (§12) and is stored as written; anything else, including a symlink that
  resolves outside its root, is refused, so a committed list cannot make the agent read and send
  arbitrary files.
- `lines` is input sugar only: at attach time the range becomes a quote anchor over those lines
  (`exact` = their text). Line numbers are never stored and never compared.
- Exactly one of `section`, `symbol`, `quote`, `lines` may be given. Content resolved from any
  anchor is capped at `tasks.attachments.maxLines` (default 60); a larger target is refused with
  `cap_exceeded` and a suggestion to anchor a smaller part. A target that grows past the cap after
  attaching is delivered as `state: "too_large"` without content.
- A quote must be unique in the file when attached. A hand-written `lines` range in a stored list
  is read by its lines and replaced by a quote anchor the next time the attachment is delivered.
- An attachment is delivered once per live context, keyed by its id (§4.3): edits the agent makes to
  the file while the result is still in front of the model are never sent again.
- The store keeps `hash` = sha256 of the resolved content at the time it was last **delivered**,
  and for quote anchors the `exact`/`prefix`/`suffix`/position.

Resolution and `state`:

| Anchor | Content changed, anchor found | Anchor moved | Anchor gone |
|---|---|---|---|
| section / symbol | delivered as is; `state: "changed"` only versus the last delivery | irrelevant (structural) | `state: "lost"`, no content, `fix` names candidates |
| quote | — (exact match is identical) | `state: "moved"` (exact text found elsewhere; its content is identical wherever it sits, and the stored anchor is refreshed) | fuzzy match (prefix/suffix + position, similarity ≥0.8) → `state: "fuzzy"` with the found text; else `"lost"` |
| file | `state: "changed"` versus the last delivery | — | `"lost"` |

When changes are reported:
- **Never during a task that is `doing`** for edits the agent makes; the agent caused them. Files
  are re-resolved only when content is about to be delivered (`start`, resume, `claim`, §4.4).
- At that point the result carries the current content and `state` if it differs from what was
  last delivered (`changed`) or the anchor degraded (`moved`/`fuzzy`/`lost`). After delivery the
  stored hash is updated; the agent has seen the new version.

Resolution reads files in the `tasks` tool handler, never in the `context` hook, preserving the
no-disk-I/O invariant there.

### 4.3 Delivery ledger and liveness

The tool must know what the model can still see. That is derived, not tracked:

- Every `tasks` result that delivers context records a **manifest** in its `details`:
  `delivered: { list?: { goals: {id, hash}[], pins: id[], attachments: {id, hash}[] }, tasks: {id, goals: {id, hash}[], criteria: {id, hash}[], pins: id[], attachments: {id, hash}[]}[] }`.
  `pin` records its pin ids; `attach` records attachment ids with `hash: null` (reference only).
- Ingest already copies tool-result `details` onto the Truth block (§5.1).
- **Live set** = the union of manifests on `tasks` tool-result blocks that are present in the
  authoritative Truth and not folded (`!isFolded(b)`, and not a member of a folded group). An item
  is live when a live manifest contains it with the current hash (goals and criteria by id + text hash,
  pins by id since pins are immutable, attachments by content hash; `null` never matches).
- A `start`/resume/`claim` delivers exactly `required − live`, where `required` is the list context
  plus the context of every task entering (or, for claim, in) `doing`, and for `start` that of its
  ancestors already `doing`, whose pins and attachments apply to the new task too.
- Keys are scoped by list (`<slug>/goal#…`, `<slug>/pin:p1`), since pin and attachment ids repeat
  across lists. While folding is disarmed nothing on the wire is folded, so every present
  delivery counts.
- A `start` run inside another tool (§5.3) records no live delivery: the outer tool decides what
  of the nested result reaches the model. The next direct `start` or `claim` delivers it again.

Why this is correct without extra state:
- **Folding:** a folded delivery block drops out of the live set immediately, so the next delivery
  re-sends what it carried.
- **Compaction, `/tree` navigation, fork, reload:** Truth is rebuilt from the active branch; blocks
  not on the branch do not exist, so their manifests do not count.
- **Edits:** a changed goal, criterion or attachment content changes its hash, so the old delivery no
  longer matches.
- **Other sessions:** a manifest only counts in the session whose Truth contains it.

Protection: a delivery block belongs to the span of the task it started, so it folds when that span
folds. Until then strategies must not fold it alone: the floor (§9.2), untracked records (§9.3)
and history skip `tasks` result blocks whose manifest names a `doing` task. Only a human fold can hide
it early; §4.4 covers that.

### 4.4 Out-of-band changes

Changes the agent did not make reach it as **one appended custom message** (`accordion.tasks.notice`),
persisted in the session and never an edit of an earlier message:
- while a turn runs, after a tool result, as `pi.sendMessage(…, {deliverAs: "steer"})`;
- while idle, with the next prompt through `before_agent_start`. A note that cannot be sent is kept for that prompt.

```json
{"tasks": "auth", "changed": {"goals": {"added": [{"id": "g3", "text": "…"}], "removed": ["g2"], "edited": [{"id": "g1", "text": "…"}]}, "pins": {"added": [{"id": "p7", "kind": "rule", "text": "…"}], "removed": ["p2"]}, "attachments": {"added": [{"id": "a4", "ref": "docs/auth.md#Token store"}], "removed": ["a3"]}, "tasks": {"added": [{"id": "5", "title": "…"}], "removed": ["4"], "changed": [{"id": "2", "status": "abandoned"}]}, "within": {"3.1": {"criteria": {"added": [{"id": "c4", "text": "…"}]}}}}}
{"tasks": "auth", "changed": {"by": "user-message", "ops": [{"op": "+", "kind": "pin", "target": "list", "ref": "p7", "text": "Never touch vendor/"}]}}
{"tasks": "auth", "waiting": [{"id": "1.2", "reason": "user-decision", "detail": "…"}]}
```

| Kind | Trigger | Content |
|---|---|---|
| `changed` | the user edits the list (UI, hand edit, another session) | the delta against the state the agent last saw: list goals, pins and attachments; tasks added, removed, renamed or with a new status; goals, criteria, pins and attachments of tasks on the `doing` branch (`within`, by task id). At most 20 task entries, the rest counted in `more`. Compared before each prompt and after each tool result |
| `changed` `by: "user-message"` | the extractor changed the list (§4.6) | the applied operations with the ids they created; `text` is shortened to 100 characters |
| `waiting` | user prompt while a task is blocked on `user-decision`/`user-input` | the blocked tasks and their `detail` |

"Last saw" is the list after the agent's own `tasks` call, after the last note, or after an attach
note, so the agent never hears about its own edits. File changes on disk are never notices; they are
reported at the next delivery (§4.2).

Notices are not Truth blocks (`linearize` skips custom messages), so they do not enter the delivery
ledger (§4.3). A `restored` notice, which would re-deliver context a human fold or a compaction hid
from a task in progress, is therefore not sent: `start` and `claim` re-deliver it (§4.3), and the next
`start`/resume of the task shows what is missing.

### 4.5 Removed

- The working set and the `context_with_system` suffix injection (`workingSet`, `placeWorkingSet`,
  `cachedWorkingSet`, `refreshWorkingSet`). `context_with_system` only clears request-local usage
  anchors while folding is armed.
- Prose tool results. Line-range attachments and the `changed since attached` hash check at every
  request.
- `tasks.attachments.render = "inline" | "reference"` keeps its meaning for `start` results:
  `reference` omits `content`.

### 4.6 User messages

Evidence: `.project/analyses/fold-representations/README.md` §3.4. The agent alone records a third
of durable instructions too few (recall 0.68, real nukular corrections 0/9); an extractor applied by
the extension reaches 0.93.

- A user message is **never a fold boundary**. Inside a span it folds with the span. Outside every
  span it stays raw.
- Before it may fold, its durable content must be in the list. Pipeline per user message, run
  after `before_agent_start` and off the request path:
  1. **Classify** (existing classifier): `chat | answer | directive | correction | scope-change`.
     `chat` and `answer` produce nothing.
  2. **Extract**: one structured model call (a `chat` completion, resolved through `models` like other out-of-band calls) with the list,
     the `doing` branch, the agent's last turn and the message. Output: list operations
     `{op: "+"|"-"|"~", kind: "goal"|"task"|"criterion"|"pin"|"attach", target, value, pinKind?}`,
     where `target` is the list, a task id, or an item id (`g2`, `c5`, `p3`, `a1`) for `-`/`~`.
     Questions, approvals and one-off instructions for the next step produce no operations.
     Parse the first balanced JSON object in the reply, allowing prose and fences and respecting
     quoted/escaped braces. A parse failure retries once, before any mutation, within one shared
     45-second deadline. `length` is reported as truncation; provider error/abort stops are reported
     as failures, never parse failures. Store failures and rejected operations are not retried.
  3. **Apply** through the store with `source: "user"`. A pin must occur verbatim in the message
     (existing quote check) or it is dropped. Removals and renames of started tasks follow the store's
     rules; a refused operation is dropped and logged. Identical goal/criterion additions reuse the
     existing item id without a write or change notice, including facts the agent recorded while
     extraction ran. The request is bound to its originating store/list; after asynchronous grammar
     warming, validate that binding before the synchronous mutation batch. A changed binding fails
     extraction rather than steering the replacement list.
  4. **Notify** the agent once with a §4.4 `changed` notice carrying `by: "user-message"` and the
     applied operations. The agent may revert any of them with `tasks`.
- The message's block records `details.routed = {ops: [...ids], at}` only when an operation applied
  or an existing fact id was retained. A routed message joins its span's group. An unrouted one
  (extraction failed, timed out, no list was attached, or all operations were empty/rejected) falls
  back to the classifier gate: it folds only below the loss threshold and otherwise stays raw and
  ends the run.
- Records carry `"user": [{"said": "<first 120 chars>", "ids": ["p7", "c3"]}]` for the routed messages
  inside the task's own intervals, so the agent sees where each instruction went. History entries
  (§6.3) carry no `user` links: the pins they keep are the lasting part, and `recall` returns the
  messages themselves.
- The extractor sends session content to a model: Taskfold declares both `chat` and `classifier`
  in `privacy`. Chat defaults are tried in order: `openai/gpt-6-luna`, then
  `openai-codex/gpt-6-luna`, using the host model registry. A configured model wins. If neither
  default resolves, the session model is used and a warning is shown once per session. The consent
  notice names both model types; `taskfold-chat-v1` consent replaces classifier-only consent.
- Proposing the operations to the agent instead was measured and rejected: it applied 71 % of
  proposals, 37 % when some were already applied.

## 5. Spans

### 5.1 Structured facts

The scan reads `TasksDetails` from the `tasks` tool result instead of parsing result prose.

- Ingest copies a tool result's `details` onto its `Block` as `details?: unknown` (`core/types.ts`).
  `details` is not sent on the wire and does not count in tokens.
- Snapshots carry it.
- If Pi does not persist `details` for reloaded sessions, the scan falls back to the current prose
  regexes for blocks without it.

`TasksDetails` gains:
- `delivered`: the delivery manifest (§4.3)
- `started: string[]`: the task and its auto-started or resumed ancestors
- `closed: {id, status}[]`: auto-closed parents
- `cascaded: {id, status}[]`: subtasks abandoned with their parent

### 5.2 Intervals

A task's span is a list of intervals `[open, close]`:

| Event | Effect |
|---|---|
| `start` / resume | opens an interval at the start call |
| `block` | the interval closes at the last block before the **next user message** (or at the log end, while open). The reply that asks the user belongs to the task |
| `complete` / `fail` / `abandon` | closes at the finishing result |
| auto-close (`closed` in details) | closes just before the call that moved on |
| cascaded abandon | the subtask becomes a finished node with status `abandoned`. Its intervals are the ones it had |

A node is **finished** when its status is `done`, `failed` or `abandoned`. Positional nesting no
longer implies ownership: a group of a non-descendant inside a span's range is a boundary, never a
veto.

### 5.3 Nested `tasks` calls

`tasks` may run inside another tool, most often `codemode`. The scan must see those calls: a
session that batched `complete` + `start` through codemode left every later span open and could no
longer fold anything (ANA-fold-representations §5).

- The `tasks` handler records every execution, direct or nested, as a structured **task event** on
  the outermost tool result of the step: `details.taskEvents: {action, list, id, started, finished,
  closed, cascaded, delivered}[]`, in execution order. A direct call puts one event on its own
  result.
- Mechanism (pi ≥1.5): a nested call runs through `ctx.executeTool()` with id `<outer>/<n>`, and
  its `tool_call`/`tool_result` events carry `parentToolCallId`. The `tasks` handler queues its
  event under the outer id (the id prefix before the first `/`, so calls nested twice resolve to
  the model-issued call). The extension's `tool_result` hook for the outer call returns
  `details: {...details, taskEvents}` (pi lets `tool_result` handlers replace `details`), so the
  events are persisted on the outer result. Queued events of an outer call that never produces a
  result are dropped with the turn.
- Ingest copies `details` onto every tool-result block whose `details` has `taskEvents`, not only
  on `tasks` results; the fingerprint includes it.
- The scan reads task events from any tool result. Interval boundaries for a nested event use the
  outer call/result pair: `start` opens at the outer call, `complete` closes at the outer result.
  Events in one outer call apply in order, so `complete A` then `start B` inside one script still
  closes A before B opens.
- The scan never parses tool output text or a host tool's own call log (codemode records arguments
  truncated).
- A span still open with no task event for `tasks.zombieSteps` (default 40) steps while other
  tasks start and finish is reported in `status` and the widget as `stale` and is offered to the
  agent in the next `tasks` result as `{"stale": ["3.11.1.3.3.2"]}`; it is not folded silently.

## 6. Records

Evidence: `.project/analyses/fold-representations/README.md` §3.1–3.3, §4.

### 6.1 Carrier

- Every Taskfold carrier is one `assistant` message, independent of the role of the run's first
  message. The conductor's `group` op carries `role: "assistant"` (`Group.role`, honoured only for
  conductor groups; a human group keeps the role of its run's first message). Its text starts with the task's own tag (`{#code FOLDED}`, the tag is the handle), then one
  line of compact JSON. Adjacent carriers stay separate messages; each is append-only.
- One fold code per task: `foldCode("t:<list>/<id>")` (§7.3). The group's own code is not shown.

### 6.2 Record (S)

```
{#c11k3a FOLDED} {"task":"auth/2.1","title":"Add the interface","status":"done","criteria":["…"],"outcome":"…","decisions":["choice — reason"],"open":["…"],"pins":[{"id":"p4","kind":"constraint","text":"…","source":"user"}],"user":[{"said":"…","ids":["p4"]}],"changed":["src/auth/store.ts"],"verified":["npm test → ok"],"children":[…]}
```

- Key order is fixed; empty keys are omitted. `children` holds the children's records verbatim, each
  with its own `"recall"` code instead of a leading tag.
- `changed` and `verified` come from the node's own traffic only (blocks inside its intervals and
  outside every descendant's intervals).
- `taskfold.recordTokens` (default 1,500) caps only the serialized `children` content, measured with
  the raw `core/tokens.ts` estimate. Deepest full child records become history entries (§6.3)
  until the child budget fits or none remain. Own fields and pins never veto a fold; even a
  minimum history subtree may exceed the cap rather than losing text or recovery handles.
- `taskfold.leafForm = "record" | "bracket"` (default `record`). `bracket` folds before the
  finishing call's entire assistant message, leaving that message and its results verbatim. The
  opening call folds normally. The carrier omits its own `outcome`, `decisions` and `open` because
  they remain in the original closing call; root history also omits that duplicate outcome.
- When a parent absorbs a child's closing call, that child's report returns, subject to normal
  history reduction. If child and parent share a visible closing message, the report stays raw
  without a duplicate in the record. Recovery handles cover folded prefixes, then extend through
  absorbed closing tails. Automatically closed tasks without an explicit closing call use record.
  A task entirely inside a retained closing message stays raw and gets no empty recovery handle.

### 6.3 History (H)

```
{#e1fc37 FOLDED} {"history":"auth/1","title":"Design","status":"done","subtasks":{"done":9,"abandoned":1},"outcome":"<whole outcome, up to 2,000 chars>","children":{"1.1":{"title":"Add the interface","recall":"{#ucn7c8 FOLDED}"},"1.2":{"title":"Review it","recall":"{#v6m0f5 FOLDED}"}}}
```

- One message per task; the outcome is kept whole and verbatim. `children` names the **direct** children by id, a title of at most 60 characters and their codes so the agent can find and recall a task.
- `status` is truthful about the subtree: a failed or abandoned descendant shows in `subtasks`.
- Recalling the root code returns its report with the codes of its direct children; recalling a child code returns that child's (SPEC-0003 §2.1).

### 6.4 Parts and untracked work

- A span split by a held, protected or foreign block: earlier runs carry
  `{#code FOLDED} {"part":"auth/2","of":[1,3]}`; the record rides on the last run.
- Untracked runs: `{#code FOLDED} {"untracked":"<first assistant line ≤120>","changed":[…],"verified":[…]}`.
- `taskKeyOfSummary` parses the JSON after the tag: `task`, `history`, `part`, `untracked`.

## 7. Planner

### 7.1 Pipeline

`scanTaskSpans` derives the task intervals, reports and metadata. `TaskfoldConductor.plan` selects
finished tasks and pressure-history targets, `unit` compiles them into runs and handles, and `commit` reconciles
the proposed operations and rolls back partially rejected units. **There is no `ownGroups` cache.**
Ours are the automatic groups whose summary `taskKeyOfSummary` recognizes. Every epoch recomputes the desired
state, so a group pruned by a tail resize between attachments or by a human is proposed again once it is
eligible. Exception: a node the human unfolded (`by:"you"`) is left alone for the session.

### 7.2 Compile

- A folded parent absorbs its finished descendants; the selected outermost finished node owns its
  eligible blocks. While a parent stays open, finished children are independent fold candidates.
- Each maximal run of consecutive blocks with the same owner becomes one group. Routed user
  messages (§4.6) belong to the run; unrouted ones end it.
- The owner's record rides on its last run. Earlier runs get a `part` marker (§6.4).
- Edges snap to whole messages, as today.
- Protected, held, system and foreign-group blocks end a run. A run with nothing collapsible
  (`collapsibleMessageKeys`) is dropped.

Your example tree compiles like this:

```
task 3 raw ─┬ 3.1 raw ─┬ 3.1.1 record → G(3.1.1)
            │          ├ 3.1.2 record → G(3.1.2)
            │          └ 3.1.3 open   → raw
task 1 record (1.1 → 1.1.1 composed) → G(1)
```

### 7.3 Handles (core change)

- `Group.handles?: {id: string; memberIds: string[]}[]`. The `group` op gains optional `handles`.
  A handle may name members of its carrier, other tagged automatic groups and intervening visible
  user messages, in transcript order. Truth validates it when grouping and again on use; held,
  human-curated, inaccessible or missing content makes the handle unreachable. The carrier summary
  must contain the handle's exact tag. Cross-group sources are created before the carrier.
- Handle id: `t:<list>/<id>`. Its fold code is `foldCode("t:<list>/<id>")`, stable across
  recompiles.
- `resolveRecall` resolves a handle code to its members' raw content. What the `recall` tool returns
  for it, and the session account that bounds all recall output, are specified in SPEC-0003: a task
  code returns the task's report, its transcript is reached by search or entry address.
- `resolveUnfold` on a handle code unfolds the carrier and every referenced group and emits a `state-changed` with
  `by:"agent"`. The native tasks UI sends the same handle-bearing operation through the controller
  lease with `by:"you"` and holds the selected blocks open through Truth's sticky human overrides.
  Taskfold handles both actors and recompiles the parent around the raw child. Whole-task human
  toggles retain their existing group without selective recomposition, so they remain reversible.
- An agent-opened node refolds only under pressure and only once its task age is ≥2. After a second
  agent unfold it stays open for the session. Human-held blocks never expire through this policy. Counts and open state persist in branch-local
  `accordion.taskfold.unfold` entries and survive reattachment and session resume.
- Truth snapshot, replica and protocol versions are bumped. `agentView` matches handle codes that
  are embedded inside a summary, not only leading tags.

## 8. Fold lifecycle

Evidence: `.project/analyses/fold-representations/README.md` §2–4 and §8; PLAN-0005's real-session
audit corrects the earlier simulation's assumption that a nearby lookback alone guarantees a hit.
Eager folding keeps the rewritten suffix short; it does not guarantee a cache hit. A completed root
is written once in its final form and never rewritten.

| Event | Effect at the first eligible request (timing below) |
|---|---|
| a task finishes inside an open parent | its span becomes a record (§6.2) once another message follows its closing message, or immediately with a bracket tail; pending user-message classification/routing must settle first |
| a non-root parent finishes | its span becomes one record composing its children's records |
| a root finishes | its whole span becomes history (§6.3) |
| pressure ≥ `high` inside an open root | finished subtrees, oldest first, become history until `low` |

- **Taskfold owns the tail.** It holds the `tail-size` lock with a zero tail, so a finished span
  folds at the next request instead of after it leaves the protected tail. Waiting rewrote the cache
  from a position tens of thousands of tokens back, beyond the provider's lookback, so every such
  fold re-billed the whole tail (ANA-fold-representations §8: +41 % on the nukular replay at a 20k
  tail). While attached, the user's tail dial is locked; Taskfold applies its value to pressure folds
  of open and untracked work (§9.2, §9.3). On detach the dial returns as far as it leaves every fold
  outside the tail.
- **A carrier never ends the request.** Record form waits for a following message. Bracket form
  retains the original closing call/result, so it can fold at the first post-completion request.
- **The first request after load waits for the epoch.** Taskfold declares `holdWireUpToMs`, and its
  `wire-departing` handler returns the epoch that is still committing. After a resume, restart or
  model change the host fires that epoch on attach; the hold makes the first request carry its folds
  instead of leaving one request early and paying for the rewrite on the next one (the 177k miss in
  this repository's session).
- **Finished-task timing is explicit.** `eager` (default for every provider) folds at the first safe
  request, regardless of span length. `lazy` folds only when the cache is cold/expired or pressure
  reaches `high`. `pressure` folds only at `high`. There is no 20-block or deep-span eligibility veto.
  Safety gates still apply, including the record following-message guard and pending user routing.
  A mode change applies at the next epoch and never unfolds existing groups. Pressure relief for
  open tasks and untracked work continues in every mode.
- **Cache facts are host-scoped.** `core/cacheProfiles.ts` resolves exact model, provider wildcard,
  then a conservative prefix-cache fallback (5-minute TTL, no assumed discount). It supplies cache
  family, TTL, read/write weights. The last main-provider payload overrides TTL when its retention
  is observable; a model/session change clears that observation and starts cold. `lazy` compares
  the last request's age with this TTL; mixed breakpoints conservatively use the longest retention.
- **Anthropic task frontier.** While folding is armed and Taskfold is attached, the native
  `before_provider_request` hook adds a breakpoint before the innermost open task's whole opening
  message. It matches the actual provider blocks, including merged assistant messages and sealed
  reasoning, then selects the preceding cacheable block. It changes no Truth or message content.
  The verified post-hook Claude OAuth transport gets its existing identity seeded without a marker;
  otherwise only a redundant identity marker covered by an equivalent later system marker is reused.
  Existing system/tool/tail markers and TTL order are preserved within four slots. Disabled caching,
  missing/ambiguous/uncacheable boundaries, unsupported controls or exhausted slots leave the payload
  unchanged. This applies only to Anthropic Messages requests, not other provider APIs.
- No other aging. A history entry is never rewritten, merged or shortened. (Merging all history
  under pressure was measured: up to 20× more rebilled tokens on the nukular session.)
- History within an open root rewrites from the oldest affected subtree onward: it happens only
  under pressure and in the same propose as everything else that epoch.
- A human or agent unfold (§7.3) reopens the task raw; refolding returns it to its form above.

## 9. Epoch

Every request re-evaluates eligibility under §8's timing policy, including cache expiry. Steps
2–7 run only when the projection is ≥ `high·budget`.

```
  1 records     fold eligible finished tasks in their §8 form; try safe descendants if a node cannot compile
  2 history     §8 pressure row
  3 keep-recent waive the kept root if still above
  4 floor       §9.2, if enabled
  5 untracked   untracked records (§6.4), if enabled
  6 steps       §9.4, if enabled
  7 saturated   status level error, naming the largest unfoldable holder
→ ONE propose
```

### 9.1 Keep-recent

`keepRecentTasks` (default **0**) keeps that many most recently finished tasks raw. Raising it delays
folds and multiplies rebilled tokens; it exists for experiments only.

### 9.2 Floor

- Composition, adapted from `exp/orientation-modes` `conductors/in-process/taskfold/thinning.ts`.
  Taskfold previews a `KeelLiteConductor` behind a masked host; its decisions are rebuilt from
  Truth each epoch and it does not independently commit.
- **Hidden from keel-lite:** blocks in Taskfold groups and planned groups, document and rule-file
  reads (`DOC_PATH_RE`, `RULE_FILE_RE`), the user's tail dial (§8), kept user messages.
- R1–R5 only (`maxRung: 5`); R7 is off (`groupSteps: false`).
- **Same transaction:** `planPressure` previews keel-lite's ops without committing them. Taskfold
  appends them to its epoch's op list, so there is one `propose` and one cache break.
- Scope: open spans first (oldest block first), then untracked runs.
- `unit` savings count members at their current cost (`foldedTokens` when folded).
- `taskfold.floor`: `true`/`false`, default `false`. The unseeded TF sample stayed within 16k,
  but 2/8 inline-attachment runs exceeded it; TF also cost about 12% more than directly comparable T.
  The floor is an opt-in guard, not a hard budget guarantee (measurement: §13).

### 9.3 Untracked records

When over budget after step 4, runs of at least `taskfold.untracked.minSteps` (default 8)
assistant steps outside every span and outside the tail become untracked records (§6.4).

### 9.4 Steps of open tasks

When still over budget, runs of at least `taskfold.steps.minSteps` (default 4) old finished steps
inside a still-open task become step carriers `{"steps":"<key>","label":…,"count":…}`, oldest first,
grouped per innermost open task. The task's start message, user messages, document reads and the
tail stay live. When the task finishes, its record absorbs the carriers. Without this, one long
open task saturated the session.

## 10. Task widget (amends SPEC-0001 §4.3–4.4)

### 10.1 Header

`<glyph> Tasks <list title> <done>/<total> · ≡<folded> · <duration> · <full> → <live> tok`.

The title falls back to the slug. When narrow, the title is shortened first (minimum 8 columns,
then dropped); glyph and counts are never cut.

### 10.2 Rows

```
▼ Tasks client-polish 12/30 · ≡7 · 6h 13m · 642.8k → 302.2k tok
  ├─▣≡ 1 Orientation … · 34s · 21.7k→52
  ├─▣· 2 Rebase clean continuation … · 3m 59s
  ├─◐  3 Close acceptance rows … · 6h 09m · 7✓ 1⊘ 3☐
  │ ├─ … 7 finished (6≡ · 320.0k→1.1k) · 5h 43m
  │ ├─☐  3.8 Media row …
  │ ├─▶  3.9 Live state row … · 15m 51s · 0✓ 3☐
  │ └─ … 2 upcoming
  └─☐  4 Run live, interactive …
```

- **Fold column**, a second glyph after the status glyph:

  | Glyph | Meaning |
  |---|---|
  | `≡` (`muted`) | folded, its own group or inside its parent's |
  | `·` (`dim`) | finished, raw |
  | blank | not finished |

  The `(fold …)` marker becomes the trailing `full→live` token pair on folded rows.
  A task owning a group's summary is charged for the whole group, including message-snapped
  thinking before its recovery handle. Child handles inside another task's carrier retain their
  member charges. Wire/dump charges remain additive and are not changed to repair a row.
- **Progress breakdown** over the subtree's leaves: `7✓ 2☒ 1⊘ 3☐` (done, failed, abandoned, not
  finished; blocked counts as not finished). Zero counts are omitted. `success`/`error`/`dim`/`dim`
  colours. Replaces `(done/total)`.
- **A finished parent with unfinished descendants** shows `!` in the fold column, in `warning`.
- **Hidden rows split:** `… N finished (k≡ · full→live) · duration` and `… N upcoming`. A run never
  mixes finished and unfinished siblings.
- **Legend:** one dim line under the header the first time the widget expands in a process, and on
  `?` in the panel's Tasks view: `▣ done ☒ failed ⊘ abandoned ◐ partly done ▶ doing ⧗ blocked ☐ todo · ≡ folded · raw`.
- Verified in a real terminal at 36, 57, 80 and 140 columns.

### 10.3 Inspection and export

- `g` opens list context, including an empty list's goal, scoped pins and attachment references.
- Task details expose acceptance criteria, list/ancestor/task pins, attachment anchors/notes/states,
  interval-correct facts and composed recovery handles. Block pins (`p`) remain separate from scoped facts.
- Composed child inspection resolves its record and scoped originals. Handle-based unfold goes through
  the controller lease and recomposes siblings. Fold markers reflect actual coverage, not ID ancestry.
- List snapshots reload on opening, task calls and session changes. Transcript snapshots refresh on
  Truth identity/revision changes, outside render. A stale view never reads or steers a new session.
- Paused folding is explicit; stored records are not described as the current outgoing text.
- All dump formats consume Truth's authoritative carriers once, with calibrated additive charges.
  Split/composed/untracked groups, dropped carriers, stragglers and substitutions retain their actual
  outgoing form. Structured details, handles and task metadata remain available as non-wire metadata.
  Delivery manifests are exported with their blocks. Notices are not Truth blocks (§4.4), so they
  are not in the dump; there is no transient suffix. A routed user message shows where its
  instructions went (`routed → p7, c3`) in the transcript row and its detail view.
  YAML preserves arbitrary indentation, final newlines and carriage returns; terminal control
  characters and Unicode line separators use escaped scalars rather than invalid literal blocks.

## 11. Skill `accordion-task-lists`

Location: `extension/skills/accordion-task-lists/`, shipped with the extension. Follows
`host:/mnt/shared/knowledge-base/agent-skills/ARTICLE.md` §6–7.

```
SKILL.md                  router (<200 lines): why tree and references; plan conversion
                          procedure (source inventory, decompose, criteria, attach and pin,
                          save, validate, compare); template with references; where the file
                          lives (next to its plan, symlinked); changing a list; gotchas
references/context.md     pins and attachments: delivery, pin vs attachment, which source part
                          goes on which task, anchors, JSON form, roots, checklist
references/decomposition.md, references/examples.md   sizing and worked translations
references/schema.md      field reference; read when validation fails
scripts/validate.mjs      `node validate.mjs [--project d] [--root d]… <file>`: the store's
                          validator, then every pin and attachment resolved with the store's own
                          functions; exit 1 with fixes; notes leaves with no reference
```

Description: "Write, convert or repair Accordion task lists as JSON (.pig/tasks/*.json): turn an
implementation plan, spec or research into a nested task tree with goals, acceptance criteria, pins
of the rules that must hold, and anchored attachments of the plan, spec, research and code sections
each task needs; then validate every reference. Use when drafting a plan as tasks, converting a plan
document into a task list, adding pins or attachments, keeping a list next to its plan, or editing a
list outside the tasks tool."

The skill also encodes how to size, split and nest tasks (`references/decomposition.md`): why open
tasks keep raw work in the request, orientation first, split by verifiable outcome, two to three
levels as a minimum for broad work (no maximum), no count quotas; `references/examples.md` translates
a feature, a bug, a migration, a phased plan and a research task into lists, plus a plan with a
spec, research and project rules into a list with its references, and a test keeps every shipped
example valid.

Eval: 3 prompts (convert a plan document, write from scratch, repair an invalid file), with and
without the skill. Assertions: validator passes with every reference resolved, list is ordered,
every leaf has criteria, every implementing leaf inherits or carries the plan step and spec section
it depends on.
Result (one run per case and arm, `deepseek-flash`): both arms produced a valid list in 3/3 cases; with
the skill the lists were more compact (7 tasks versus 19 and 7 versus 12; the repair case 1 in both).

## 12. Settings (`~/.accordion/config.json`)

```jsonc
{
  "debug": false,
  "tasks": {
    "attachments": { "render": "inline", "maxLines": 60, "roots": [] },
    "pins": { "listTokens": 2000, "taskTokens": 1500 },
    "adopt": "auto",
    "enforce": "coach",
    "orientationCalls": 10,
    "gateFailOpenAfter": 3,
    "stopOnBlock": true,
    "resumeOnStop": true,
    "bootstrapNote": true,
    "largeLeaf": { "budgetShare": 0.15, "toolResults": 25, "repeatEvery": 10 },
    "acceptanceCriteria": { "required": true, "min": 1, "max": 3, "maxChars": 300 }
  },
  "conductorOptions": {
    "taskfold": { "high": 0.8, "low": 0.6, "maxLoss": 0.3, "keepRecentTasks": 0 }
  },
  "taskfold": {
    "timing": "eager",
    "recordTokens": 1500,
    "leafForm": "record",
    "floor": false,
    "untracked": { "enabled": true, "minSteps": 8 },
    "steps": { "enabled": true, "minSteps": 4 }
  }
}
```

Previously stored `taskfold.high`, `taskfold.low` and `taskfold.keepRecentTasks` migrate to
`conductorOptions.taskfold`; explicit new-path values win. Earlier valid values remain effective,
even if outside the narrower editor ranges. Saves validate new edits against the registry bounds
and require `low < high`. `roots` keeps absolute paths (`~/` expanded) and drops anything else.
The extractor model resolves through `models` like other out-of-band calls.

`/accordion fold eager|lazy|pressure` records a timing dial for this session and model in
`accordion.dials`; existing numeric budget/protect entries remain valid. Resolution is the latest
session value, then `modelDefaults` exact `provider/model`, `provider/*`, `*`, then `taskfold.timing`.
For example, `"modelDefaults": { "anthropic/*": { "timing": "lazy" } }`. Settings stages the global
value until `ctrl+s`; the footer shows the resolved mode after Taskfold's name.

### 12.1 Debug diagnostics

`debug` defaults to false. `/accordion debug on|off` stores an `accordion.debug` session entry;
the latest valid entry overrides the global setting on resume. The Settings tab stages the global
default. Logs live in `~/.accordion/debug/<sessionId>.jsonl` (under `ACCORDION_HOME` when set).

Records: `request` (model, estimate, actual input/cache receipt, k and full/live tokens), `epoch`
(timing, cold/pressure state, cache profile, planned units and a reason per finished task), `fold`
(key, carrier tokens, savings, changed frontier and frontier-based rewrite/cost estimates),
`cache-profile` (main-provider retention observation), `cache-frontier` (task, physical position,
marker count or skip reason), `complete` (model, purpose, usage/cost, stop reason, first 2,000 reply
characters or error), `route-retry`, `tasks` (rejected call) and
`truth` (rebuild/resync). Rewrite estimates are not observed cache billing. A finished task still
raw after 40 tool results warns with its key and reason. Tasks covered by an ancestor's visible
recovery handle count as folded, including descendants not individually named in root history.

Writes yield off the calling hook and use asynchronous filesystem APIs. Files are mode 0600,
bounded to 50 MiB; at overflow, the oldest half is discarded on whole JSONL boundaries.
`/accordion debug bundle [file]` exclusively creates a private gzip JSON archive with named
`debug.jsonl`, `transcript.txt` and redacted `settings.json` entries. Bundles still contain
session content and must be reviewed before sharing.

## 13. Verification

| What | How |
|---|---|
| Store, validator, migration, move/insert, empty span | `bun test extension/tasks.test.ts extension/taskSchema.test.ts` |
| Results | one test per action asserting the exact JSON result; no prose |
| Anchors | section/symbol/quote resolution, moved/fuzzy/lost, `lines` → quote conversion, cap |
| Liveness | delivery folded → re-sent; compaction and `/tree` drop manifests; changed hash re-sent; live items never re-sent |
| Cache | consecutive requests are byte-identical prefixes across start, pin, attach, notices (`extension/smoke-context.mjs`) |
| Records, history | exact carrier JSON, `assistant` role for every carrier, root history with direct child codes, truthful subtree status |
| Eager timing | a finished task is folded at the next request; consecutive requests share every byte before the new fold |
| User messages | routed messages fold inside spans, unrouted ones fall back to the classifier gate; verbatim pin check; `changed` notice once; extraction failure keeps the message raw |
| Comprehension, routing | `.project/analyses/fold-representations/harness/eval.py`, `routing.py` against the implementation's real rendering |
| Tree, compile, diff, records, intervals | `bun test conductors/in-process/taskfold/*.test.ts` with real `Truth` (`TestHost`) |
| Handles | `core/truth.test.ts`, `core/agentView` recall/unfold tests |
| Regression scripts (synthetic, no private sessions) | Each must stay ≤ `low·budget` or end saturated with only unfoldable blocks, and every fold and handle code must round-trip through `recall`: blocked task with sibling work (S2 1.3.4); giant open leaf; prelude before the list; three-level tree folded in two epochs; tail-pruned group re-proposed |
| Nested calls | codemode `complete`+`start` closes and opens the right spans; truncated host logs are never parsed; stale span reported, not folded |
| Adoption | derive from a synthetic legacy session (prose results, codemode batches, v1 list): same spans as a native session, idempotent re-run, dry-run writes nothing |
| Widget | `bun test extension/tui/*.test.ts`, plus a real terminal at 36/57/80/140 |
| Gates | `npm --prefix extension run smoke`, `npm --prefix app run check`, `npm --prefix app test` |
| Measurement | Isolated synthetic fixture comparison: five runs per fixture for A, K+, T and TF; four for TF-inline and TF-ref. Budget 16k, tail 3k. Pass / mean peak input / runs over 16k / mean cost: A 10/10, 40.6k, 10/10, USD 0.0547; K+ 8/10, 20.5k, 9/10, 0.0448; T 9/10, 29.1k, 10/10, 0.0355; TF 9/10, 13.4k, 0/10, 0.0398; TF-inline 8/8, 15.1k, 2/8, 0.0378; TF-ref 4/8, 15.4k, 2/8, 0.0406. Samples are too small for a general quality claim. |

## 14. Adopting legacy sessions

A session recorded before this design (prose results, injected working set, list v1, tasks calls
inside codemode without events) is converted once so it continues under the new mechanism.

### 14.1 Trigger

- On every `session_start` the extension loads the newest `accordion.taskfold.adopted` entry and runs
  **detection**: a non-`tasks` tool result whose `nestedCalls` hold a `start` or finishing `tasks`
  call, that carries no `details.taskEvents` and is not covered by the current entry, marks the
  session legacy. Direct `tasks` results keep the existing scan (prose and `details`), so they need no
  adoption.
- `tasks.adopt` (`"auto"` default, `"ask"`, `"off"`): `auto` adopts silently; `ask` shows the
  resume dialog with the measured effect; `off` leaves the session on the legacy scan.
- Manual: `/accordion tasks adopt [--dry-run]` at any time. `--dry-run` reports the derived event
  counts without writing anything.

### 14.2 What adoption derives

Adoption never rewrites persisted messages. It writes one `accordion.taskfold.adopted` custom entry
that holds everything the scan would otherwise read from `details`:

| Derived | Source, in order of preference |
|---|---|
| Store state for direct calls | replayed from the call's arguments and result `details` (`closed`) so nested events know which ancestors are already open; no events are written for them |
| Task events for nested calls | the outer result message's `nestedCalls` record (pi ≥1.5: name, full `arguments` within pi's size limits, `status`), in call order; calls with `status: "error"` are skipped. A record marked incomplete or with omitted arguments falls back to the list file's `endedAt`/`status` for the task ids it can name; anything left unknown keeps its span open. The tool's printed output is never parsed |
| Titles, reports, criteria, pins | the list file at adoption time, by task id; the call's own `report` wins for the finishing task |
| Open spans the list says are finished | closed (deepest first) at the first non-`tasks` result at or after the task's `endedAt`, else at the last one |

The entry maps the outer `toolCallId` to its events (`extension/taskAdoption.ts`). On every ingest
the extension overlays them on those results' `details.taskEvents` before linearizing, so the scan,
the views and the dump read adopted and native events the same way; message identity and the wire
are unchanged.

### 14.3 Rules

- **Idempotent:** the entry carries `version` and a branch fingerprint. Derivation is a pure function
  of the branch and the list files; a resume whose legacy results are all covered does nothing, and
  a newer `version` re-adopts and supersedes the entry.
- **List files are read, never written.** A list that fails validation is skipped; its calls are
  replayed from arguments alone.
- **Delivery ledger:** legacy sessions have no manifests, so nothing counts as delivered. The next
  `start` or `claim` delivers the full context once.
- **Working set:** no suffix is ever re-injected. The first request after adoption may differ from
  the last legacy request; that one cache miss is the whole cost.
- **Folding:** the next epoch folds every finished span eagerly (§8). The notice and the dialog name
  the derived event and reconciliation counts.
- **Failure:** any derivation error keeps the session on the legacy scan and shows one notice; a
  partial entry is never written.

