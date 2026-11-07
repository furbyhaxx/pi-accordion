---
document:
  type: "specification"
  id: "SPEC-0002"
  title: "Taskfold: nested task lists, structured tool results, context delivery, composed records, aging and floor"
  description: "Decided design for task list v2 (nested tree, goal, acceptance criteria, pins, anchored attachments, move/insert), structured tasks tool results and delivered-once context, the tree planner that folds task spans into composed records, aging, the folding floor, the task widget legibility changes, the tasks protocol fixes and the task-list authoring skill."
  status: "published"
  revision: 15
  created_at: "2026-11-06T14:44:51+01:00"
  updated_at: "2026-11-07T23:31:29+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 15
      reason: "replace the injected working set with structured, delivered-once tool results"
      changes: ["JSON results for every action", "start delivers task context once; delivery ledger derived from Truth", "section/symbol/quote anchors instead of line ranges", "out-of-band changes as appended notices", "working set and request injection removed"]
---

# Taskfold

Implementation plan: `.project/plans/0002-taskfold-tree/plan.md`.

This spec amends SPEC-0001 §4.3, §4.4, §4.10, §4.11 and §4.15. Each slice that changes one of those
behaviours updates SPEC-0001 in the same commit.

Evidence it builds on:
- `.project/analyses/orientation-modes/README.md` (experiments from branch `exp/orientation-modes`)
- `.project/analyses/2026-11-05-taskfold-session-failures/analysis.md` and
  `.project/drafts/taskfold-reliability.md` (from branch `fix/failing-sessions`)

Only these artifacts were copied from the two branches. Their code is ported, not merged, except
commit `f04f39d`.

## 1. Scope

| In | Out (separate changes) |
|---|---|
| Task list file v2 (nested, `goal`, `acceptanceCriteria`, pins, attachments) and v1 migration | Synthetic usage units and calibration bounds (fixed upstream; accepted as wrong for now) |
| Store actions `update`, `move`, `add before/after`, `pin`/`unpin`, `attach`/`detach` | Sequential-order enforcement, `delegated`, HUD, gate, consent decoupling, prompt rewrite (`DRAFT-taskfold-reliability` §5–6) |
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

## 2. Task list file v2

### 2.1 Format

File: `<project>/.pig/tasks/<slug>.json`. JSON Schema shipped as
`extension/skills/accordion-task-lists/references/tasks.schema.json` (the package ships `skills/`),
referenced by `$schema`.

```json
{
  "$schema": "https://raw.githubusercontent.com/furbyhaxx/pi-accordion/feat/pi-native/extension/skills/accordion-task-lists/references/tasks.schema.json",
  "version": 2,
  "slug": "auth",
  "title": "Token store",
  "goal": "All token access goes through TokenStore; no direct map access left; npm test passes.",
  "createdAt": "…", "updatedAt": "…",
  "claim": null,
  "pins": [ { "id": "p1", "kind": "constraint", "text": "Never modify vendor/", "source": "user", "at": "…" } ],
  "attachments": [ { "id": "a1", "path": "docs/plans/auth.md", "anchor": { "section": "Rollout > Phase 3" }, "note": "plan §3", "hash": "…", "at": "…" } ],
  "tasks": [
    { "id": "1", "title": "Survey token callers", "acceptanceCriteria": ["every caller of the token map is listed"], "status": "todo" },
    { "id": "2", "title": "Extract TokenStore", "status": "todo", "subtasks": [
      { "id": "2.1", "title": "Add the interface", "status": "todo",
        "attachments": [ { "id": "a2", "path": "src/auth/store.ts", "anchor": { "symbol": "TokenStore" } } ] }
    ] }
  ]
}
```

| Field | Rule |
|---|---|
| `version` | `2`. Absent means v1 |
| `goal` | Required for authoring and for `create`, 1–600 chars. One goal per list: the end state the whole list delivers. The store loads a list without one (v1, or created from the UI) and gates new work on it (§2.2) |
| `tasks[].subtasks` | Nested tree with no fixed maximum depth |
| `tasks[].id` | Optional when authoring. Derived from position on load (`1`, `1.2`, …). An explicit id that disagrees with its position is a validation error |
| `acceptanceCriteria` | Optional now, 1–3 strings of ≤120 chars, checkable end-state statements |
| `status` | Optional when authoring (`todo`). Other `Task` fields (`report`, timestamps, `blocks`, `supersededBy`, `autoClosed`) keep their v1 meaning |
| `pins`, `attachments` | On the list and on any task (§4). `attachment.anchor` is one of `{section}`, `{symbol}`, `{quote: {exact, prefix, suffix, start}}` or absent (whole file). v2 files with `lines` are converted to a quote anchor on load |

`id` stays a dotted path. Everything that keys on `<list>/<id>` (span keys, records, widget,
verdicts, bindings) is unchanged.

### 2.2 Load, validate, migrate

- **Every read validates.** A file that fails validation makes the `tasks` call fail with a
  `TaskError` naming each problem and its fix, for example `tasks[1].subtasks[0]: id "2.3" does not
  match its position 2.1; remove the id or move the task`. The file is not rewritten.
- **v1 files** (flat `tasks[]`, no `version`) are converted in memory: the tree is rebuilt from the
  dotted ids. The next write stores v2. Every serialized candidate is validated before atomic replacement; a rejected conversion leaves the original file unchanged. Native task views name invalid lists instead of treating them as absent.
- **Missing goal** (a migrated legacy list): `start`, `add` and `move` are refused until
  `tasks update {list, goal}` sets one. The native lists browser asks for title and goal when creating a list. `list`, `status`, `claim` and the finishing actions still
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
| `invalid_args` | missing/unknown field, wrong type | the call that works |
| `not_found` | list, task, pin, attachment or anchor does not exist | closest match |
| `invalid_file` | list file fails validation (§2.2) | each problem and its fix |
| `no_goal` | `start`/`add`/`move` on a list without a goal | `update {list, goal}` |
| `claimed_by_other` | list claimed by another session | `claim {force: true}` after asking the user |
| `frozen` | edit of a started id, finished title/criteria | the call that works, e.g. `add … after` |
| `invalid_transition` | e.g. complete a todo task, start a finished one | |
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
  state?: "moved" | "fuzzy" | "changed" | "lost";   // §4.2; omitted when exact
};
type TaskContext = {                 // a task entering doing
  id: string; title: string;
  criteria?: string[]; pins?: Pin[]; attachments?: Attachment[];
};
type ListContext = { goal: string; pins?: Pin[]; attachments?: Attachment[] };
type Ref = { id: string; title: string };
```

`TaskContext.title` is included because the agent may have written it long ago (folded) and the
start result becomes the task's anchor in the transcript. Titles are the only echo.

### 3.4 Actions and results

Parameters are listed in full; `null` means optional and absent.

#### create

```js
tasks({ action: "create", list: "auth", title: "Token store", goal: "All token access goes through TokenStore.",
  tasks: [{ title: "Design", acceptanceCriteria: ["Interface reviewed"], pins: null, attachments: null, supersedes: null,
            subtasks: [{ title: "Draft interface" }, { title: "Review interface" }] },
          { title: "Implement" }] })
```
```json
{"ok": true, "list": "auth", "ids": ["1", "1.1", "1.2", "2"]}
```
`ids` in authored order. The list is claimed by this session. Pins and attachments given here are
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
finished tasks (done, failed, abandoned) over all tasks.

#### claim

```js
tasks({ action: "claim", list: "auth", force: null })
```
```json
{"ok": true, "done": 7, "total": 15,
 "list": {"goal": "All token access goes through TokenStore.", "pins": [ … ]},
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
  tasks: [{ title: "get/set", acceptanceCriteria: ["get/set round-trip"], pins: null, attachments: null, subtasks: null, supersedes: null }] })
```
```json
{"ok": true, "ids": ["2.1"]}
{"ok": true, "ids": ["3"], "renumbered": {"3": "4"}}
{"ok": true, "ids": ["2.3"], "abandoned": ["2.1"]}
```
`renumbered` maps old → new for shifted `todo` tasks. `abandoned` lists tasks closed by
`supersedes`. If the new task is a child of a `doing` task, nothing about it is delivered yet; its
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
tasks({ action: "update", list: "auth", id: null, title: null, goal: "Every token read/write goes through TokenStore.", acceptanceCriteria: null })
tasks({ action: "update", list: "auth", id: "1.1", title: "Draft TokenStore interface", goal: null, acceptanceCriteria: ["get/set/delete signatures exist"] })
```
```json
{"ok": true}
```

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
 "list": {"goal": "All token access goes through TokenStore.",
          "pins": [{"id": "p1", "kind": "constraint", "text": "Never touch vendor/.", "source": "user"}]},
 "started": [
   {"id": "3", "title": "Implement"},
   {"id": "3.1", "title": "Store core", "pins": [{"id": "p4", "kind": "fact", "text": "Use the platform keychain.", "source": "docs/auth.md:12"}]},
   {"id": "3.1.1", "title": "Read path", "criteria": ["get() never touches disk directly"]},
   {"id": "3.1.1.1", "title": "get()", "criteria": ["get/set round-trip passes"],
    "attachments": [{"id": "a2", "ref": "docs/auth.md#Token store > Interface", "note": "interface contract",
                     "content": "## Interface\n\n```ts\ninterface TokenStore { … }\n```"}]}]}
```
Next sibling, ancestors' context live:
```json
{"ok": true, "started": [{"id": "3.1.1.2", "title": "set()", "criteria": ["set overwrites atomically"]}]}
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
for every task that enters `doing` with this call. `list` appears when list context is missing.
Each item is included only if it is not live (§4.3). An attachment whose content changed since it
was attached carries `state` (§4.2).

#### block

```js
tasks({ action: "block", list: "auth", id: "2.1", reason: "dependency", detail: "Needs the approved interface.", blockedBy: "1.2" })
```
```json
{"ok": true}
{"ok": true, "alsoBlocked": ["2"]}
```
`alsoBlocked`: ancestors that became blocked. The follow-up rules (tell the user, work on the
dependency) live in the tool description. A `detail` is stored verbatim; the tool never appends
punctuation.

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

### 3.5 Lifecycle rules (unchanged)

Insert and move, empty-span refusal, the review gate and the resume note keep their behavior:
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

- `lines` is input sugar only: at attach time the range becomes a quote anchor over those lines
  (`exact` = their text). Line numbers are never stored and never compared.
- Exactly one of `section`, `symbol`, `quote`, `lines` may be given. Content resolved from any
  anchor is capped at `tasks.attachments.maxTokens` (default 1,500); larger targets are refused
  with `cap_exceeded` and a suggestion to anchor a subsection.
- The store keeps `hash` = sha256 of the resolved content at the time it was last **delivered**,
  and for quote anchors the `exact`/`prefix`/`suffix`/position.

Resolution and `state`:

| Anchor | Content changed, anchor found | Anchor moved | Anchor gone |
|---|---|---|---|
| section / symbol | delivered as is; `state: "changed"` only versus the last delivery | irrelevant (structural) | `state: "lost"`, no content, `fix` names candidates |
| quote | — (exact match is identical) | `state: "moved"` (exact found elsewhere, nearest to the hint, disambiguated by prefix/suffix) | fuzzy match (prefix/suffix + position, similarity ≥0.8) → `state: "fuzzy"` with the found text; else `"lost"` |
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
  `delivered: { list?: { goal: hash, pins: id[], attachments: {id, hash}[] }, tasks: {id, criteria: hash, pins: id[], attachments: {id, hash}[]}[] }`.
  `pin` records its pin ids; `attach` records attachment ids with `hash: null` (reference only).
- Ingest already copies tool-result `details` onto the Truth block (§5.1).
- **Live set** = the union of manifests on `tasks` tool-result blocks that are present in the
  authoritative Truth and not folded (`!isFolded(b)`, and not a member of a folded group). An item
  is live when a live manifest contains it with the current hash (`criteria`/goal hashed text,
  pins by id since pins are immutable, attachments by content hash; `null` never matches).
- A `start`/resume/`claim` delivers exactly `required − live`, where `required` is the list context
  plus the context of every task entering (or, for claim, in) `doing`.

Why this is correct without extra state:
- **Folding:** a folded delivery block drops out of the live set immediately, so the next delivery
  re-sends what it carried.
- **Compaction, `/tree` navigation, fork, reload:** Truth is rebuilt from the active branch; blocks
  not on the branch do not exist, so their manifests do not count.
- **Edits:** a changed goal, criteria or attachment content changes its hash, so the old delivery no
  longer matches.
- **Other sessions:** a manifest only counts in the session whose Truth contains it.

Protection: a delivery block belongs to the span of the task it started, so it folds when that span
folds. Until then strategies must not fold it alone: the floor (§9.2), untracked records (§9.3)
and aging skip `tasks` result blocks whose manifest names a `doing` task. Only a human fold can hide
it early; §4.4 covers that.

### 4.4 Out-of-band changes

Changes the agent did not make reach it as **one appended custom message**, persisted in the
session, sent through `pi.sendMessage({customType: "accordion.tasks.notice", content, display: true}, {deliverAs: "steer"})`
while a turn runs, or with the next prompt through `before_agent_start` when idle. Never an edit of
an earlier message.

```json
{"tasks": "auth", "changed": {"goal": "…", "pins": {"added": [{"id": "p7", …}], "removed": ["p2"]}, "attachments": {"added": [{…, "content": "…"}], "removed": ["a3"]}, "tasks": {"renumbered": {"4": "5"}}}}
{"tasks": "auth", "restored": {"list": {…}, "tasks": [{"id": "3.1", …}]}}
{"tasks": "auth", "waiting": [{"id": "1.2", "reason": "user-decision", "detail": "…"}]}
```

| Kind | Trigger | Content |
|---|---|---|
| `changed` | the user edits the list (UI, hand edit, another session) and the edit touches the goal or a `doing` branch | only the delta; detected by comparing list fingerprints before each agent start and after each tool batch |
| `restored` | the live set misses items required by `doing` tasks (human fold of a delivery, compaction) | only the missing items, computed with §4.3 |
| `waiting` | user prompt while a task is blocked on `user-decision`/`user-input` | the resume note |

A notice carries its own manifest in `details`, so it counts as delivery. File changes on disk are
never notices; they are reported at the next delivery (§4.2).

### 4.5 Removed

- The working set and the `context_with_system` suffix injection (`workingSet`, `placeWorkingSet`,
  `cachedWorkingSet`, `refreshWorkingSet`). `context_with_system` only clears request-local usage
  anchors while folding is armed.
- Prose tool results. Line-range attachments and the `changed since attached` hash check at every
  request.
- `tasks.attachments.render = "inline" | "reference"` keeps its meaning for `start` results:
  `reference` omits `content`.

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

## 6. Records

### 6.1 Shape (full level, L2)

```
{#p1c2x9 FOLDED} [task-record] auth/2 "Extract TokenStore"  status: done
acceptance criteria:
  - no direct map access left
outcome: …
decisions:
  - choice — reason
pins:
  - constraint: Never modify vendor/ (user)
changed: src/auth/store.ts
verified:
  - `npm test` → ok
open:
  - …
children:
  {#c11k3a FOLDED} [task-record] auth/2.1 "Add the interface"  status: done
    acceptance criteria: …
    outcome: …
    changed: …
    children: …
```

- Field order is fixed. Empty fields are omitted.
- `changed` and `verified` come from the node's **own** traffic only: blocks inside its intervals
  and outside every descendant's intervals.
- Children are composed **verbatim**, indented two spaces per level, each with its own fold code
  (§7.3). A record never re-summarizes a child.
- Size cap per root record: `taskfold.recordTokens` (default 1,500). Over the cap, children are
  condensed bottom-up (§8 L2c) until it fits. Never truncated mid-field; if its own fields and
  recoverable handles still exceed the cap, keep the task raw and report saturation.
- Part markers: `{#code FOLDED} [task-part] <key> "<title>" part i/n; the record follows the kept message(s) below.`
- Untracked records: `{#code FOLDED} [untracked-work] <first assistant line ≤120>` plus `changed`
  and `verified`.
- `taskKeyOfSummary` recognizes `task-record`, `task-part`, `task-archived` and
  `untracked-work` (key `untracked`).

## 7. Planner

### 7.1 Pipeline

`scanTaskSpans` derives the task intervals, reports and metadata. `TaskfoldConductor.plan` selects
finished roots and aging targets, `unit` compiles them into runs and handles, and `commit` reconciles
the proposed operations and rolls back partially rejected units. **There is no `ownGroups` cache.**
Ours are the automatic groups whose summary `taskKeyOfSummary` recognizes. Every epoch recomputes the desired
state, so a group pruned by protected-tail growth or by a human is proposed again once it is
eligible. Exception: a node the human unfolded (`by:"you"`) is left alone for the session.

### 7.2 Compile

- A folded parent absorbs its finished descendants; the selected outermost finished node owns its
  eligible blocks. While a parent stays open, finished children are independent fold candidates.
- Each maximal run of consecutive blocks with the same owner, excluding kept user messages,
  becomes one group.
- The owner's record rides on its last run. Earlier runs get `[task-part]`.
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
- `resolveRecall` resolves a handle code to its members' raw content.
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

## 8. Aging

**Task age** of a finished root is the number of finished roots that finished after it. Children
share their root's age.

| Level | Form | Target by age (defaults) |
|---|---|---|
| L2 | full record, children verbatim | 0–2 |
| L2c | full record; children condensed to one line each (`{#code} id "title" status · outcome≤160`), deepest first | 3–5 |
| L3 | one line: `{#code} [task-record] key "title" status · outcome≤200 · recall {#code} instead of re-reading` | 6–10 |
| L4 | `{#code} [task-archived] key "title" status; recall {#code} instead of re-reading` | ≥11 |

Configured as `taskfold.aging = [3, 6, 11]`. Every shortened record also retains named descendant
recovery rows (key, title, status, outcome≤160 and handle) and exact pinned text.

Cache rule (one cache break per epoch):
1. The epoch's planned ops define the earliest changed position P.
2. Records **after** P move straight to their target level for free.
3. Records **before** P change only if the projection is still above `low · budget`. Then they go
   oldest root first, each jumping straight to its target level, then one level further if still
   short.
4. No epoch runs only for aging. Aging rides on epochs triggered by `high`.

Never aged: the newest finished root (unless waived, §9.1), kept user messages, list pins. All
previously emitted child and group tags remain visible and recoverable through later aging. Child
recovery entries retain their task key, title, status and short outcome beside the handle, rather
than reducing completed work to an anonymous collection of tags. Task-scoped
pins are retained verbatim with their task and source, including when child records condense or the
parent ages. If those pins prevent a record from fitting its cap, leave it raw rather than drop them.

## 9. Epoch

```
live ≥ high·budget →
  1 records     compile finished roots, oldest first; try safe descendants if a root cannot compile; stop at ≤ low·budget
  2 aging       §8
  3 keep-recent waive the kept root if still above
  4 floor       §9.2, if enabled
  5 untracked   [untracked-work] records, if enabled
  6 saturated   status level error, naming the largest unfoldable holder
→ ONE propose
```

### 9.1 Keep-recent

`keepRecentTasks` (default 1) keeps the most recently **finished** roots raw, by finish order. It is
waived when step 2 still leaves the projection above `low · budget`.

### 9.2 Floor

- Composition, adapted from `exp/orientation-modes` `conductors/in-process/taskfold/thinning.ts`.
  Taskfold previews a `KeelLiteConductor` behind a masked host; its decisions are rebuilt from
  Truth each epoch and it does not independently commit.
- **Hidden from keel-lite:** blocks in Taskfold groups and planned groups, document and rule-file
  reads (`DOC_PATH_RE`, `RULE_FILE_RE`), the protected tail, kept user messages.
- R1–R5 only (`maxRung: 5`); R7 is off (`groupSteps: false`).
- **Same transaction:** `planPressure` previews keel-lite's ops without committing them. Taskfold
  appends them to its epoch's op list, so there is one `propose` and one cache break.
- Scope: open spans first (oldest block first), then untracked runs.
- `unit` savings count members at their current cost (`foldedTokens` when folded).
- `taskfold.floor`: `true`/`false`, default `false`. The unseeded TF sample stayed within 16k,
  but 2/8 inline-attachment runs exceeded it; TF also cost about 12% more than directly comparable T.
  The floor is an opt-in guard, not a hard budget guarantee. Evidence: `PLAN-0002`'s
  `evidence/floor-comparison/README.md`.

### 9.3 Untracked records

When over budget after step 4, runs of at least `taskfold.untracked.minSteps` (default 8)
assistant steps outside every span and outside the tail become `[untracked-work]` groups.

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
  Delivery manifests and notices are exported with their blocks; there is no transient suffix.
  YAML preserves arbitrary indentation, final newlines and carriage returns; terminal control
  characters and Unicode line separators use escaped scalars rather than invalid literal blocks.

## 11. Skill `accordion-task-lists`

Location: `extension/skills/accordion-task-lists/`, shipped with the extension. Follows
`host:/mnt/shared/knowledge-base/agent-skills/ARTICLE.md` §6–7.

```
SKILL.md              router (<200 lines): when to author JSON vs use the tool; v2 template;
                      planning rules (top-to-bottom order, leaf = 5–20 tool calls, 1–3
                      acceptanceCriteria, one goal); pins vs attachments; validation loop;
                      gotchas (started ids frozen, edit only unclaimed or own lists, ids optional)
references/schema.md  field reference; read when validation fails
scripts/validate.mjs  `node validate.mjs <file>`: the store's validator, exit 1 with fixes
```

Description: "Write or edit Accordion task lists as JSON files (.pig/tasks/*.json): turn an
implementation plan into an ordered task tree with a goal, acceptance criteria, pins and file
attachments. Use when drafting a plan as tasks, converting a plan document into a task list, or
editing a list outside the tasks tool."

The skill also encodes how to size, split and nest tasks (`references/decomposition.md`): why open
tasks keep raw work in the request, orientation first, split by verifiable outcome, two to three
levels as a minimum for broad work (no maximum), no count quotas; `references/examples.md` translates
a feature, a bug, a migration, a phased plan and a research task into lists, and a test keeps every
shipped example valid.

Eval: 3 prompts (convert a plan document, write from scratch, repair an invalid file), with and
without the skill. Assertions: validator passes, list is ordered, every leaf has criteria.
Evidence lives in the plan's `evidence/`.

## 12. Settings (`~/.accordion/config.json`)

```jsonc
{
  "tasks": {
    "attachments": { "render": "inline", "maxTokens": 1500 },
    "pins": { "listTokens": 2000, "taskTokens": 1500 }
  },
  "taskfold": {
    "high": 0.8, "low": 0.6,
    "keepRecentTasks": 1,
    "recordTokens": 1500,
    "aging": [3, 6, 11],
    "floor": false,
    "untracked": { "enabled": true, "minSteps": 8 }
  }
}
```

Sanitized like existing settings: an invalid value is reported and ignored, and the default
applies. `low < high`, aging thresholds strictly increasing.

## 13. Verification

| What | How |
|---|---|
| Store, validator, migration, move/insert, empty span | `bun test extension/tasks.test.ts extension/taskSchema.test.ts` |
| Results | one test per action asserting the exact JSON result; no prose |
| Anchors | section/symbol/quote resolution, moved/fuzzy/lost, `lines` → quote conversion, cap |
| Liveness | delivery folded → re-sent; compaction and `/tree` drop manifests; changed hash re-sent; live items never re-sent |
| Cache | consecutive requests are byte-identical prefixes across start, pin, attach, notices (`extension/smoke-context.mjs`) |
| Tree, compile, diff, records, aging, intervals | `bun test conductors/in-process/taskfold/*.test.ts` with real `Truth` (`TestHost`) |
| Handles | `core/truth.test.ts`, `core/agentView` recall/unfold tests |
| Regression scripts (synthetic, no private sessions) | Each must stay ≤ `low·budget` or end saturated with only unfoldable blocks, and every fold and handle code must round-trip through `recall`: blocked task with sibling work (S2 1.3.4); giant open leaf; prelude before the list; three-level tree folded in two epochs; tail-pruned group re-proposed |
| Widget | `bun test extension/tui/*.test.ts`, plus a real terminal at 36/57/80/140 |
| Gates | `npm --prefix extension run smoke`, `npm --prefix app run check`, `npm --prefix app test` |
| Measurement | Isolated synthetic fixture comparison: five runs per fixture for A, K+, T and TF; four for TF-inline and TF-ref. Includes pass/constraint results, peak context, estimated cost and cache reads. See `PLAN-0002`'s `evidence/floor-comparison/README.md` for results and limitations. |
