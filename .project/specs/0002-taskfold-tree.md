---
document:
  type: "specification"
  id: "SPEC-0002"
  title: "Taskfold tree: nested task lists, composed records, pins, aging and floor"
  description: "Decided design for task list v2 (nested tree, goal, acceptance criteria, pins, attachments, move/insert), the tree planner that folds task spans into composed records, aging, the folding floor, the task widget legibility changes, the tasks protocol fixes and the task-list authoring skill."
  status: "published"
  revision: 10
  created_at: "2026-11-06T14:44:51+01:00"
  updated_at: "2026-11-06T20:05:27+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 10
      reason: "record isolated floor and attachment measurements"
      changes: ["§9.2 keep the floor opt-in", "§13 reference the measured comparison"]
---

# Taskfold tree

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
| Working set (goal, pins, attachments) | |
| Task widget title and legibility | |
| Protocol fixes: empty-span refusal, review gate, resume note | |
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
  "attachments": [ { "id": "a1", "path": "docs/plans/auth.md", "lines": "40-88", "note": "plan §3", "hash": "…", "at": "…" } ],
  "tasks": [
    { "id": "1", "title": "Survey token callers", "acceptanceCriteria": ["every caller of the token map is listed"], "status": "todo" },
    { "id": "2", "title": "Extract TokenStore", "status": "todo", "subtasks": [
      { "id": "2.1", "title": "Add the interface", "status": "todo",
        "attachments": [ { "id": "a2", "path": "docs/spec.md", "lines": "120-140" } ] }
    ] }
  ]
}
```

| Field | Rule |
|---|---|
| `version` | `2`. Absent means v1 |
| `goal` | Required for authoring and for `create`, 1–600 chars. One goal per list: the end state the whole list delivers. The store loads a list without one (v1, or created from the UI) and gates new work on it (§2.2) |
| `tasks[].subtasks` | Nested tree, up to 4 levels (`1.2.3.4`) |
| `tasks[].id` | Optional when authoring. Derived from position on load (`1`, `1.2`, …). An explicit id that disagrees with its position is a validation error |
| `acceptanceCriteria` | Optional now, 1–3 strings of ≤120 chars, checkable end-state statements |
| `status` | Optional when authoring (`todo`). Other `Task` fields (`report`, timestamps, `blocks`, `supersededBy`, `autoClosed`) keep their v1 meaning |
| `pins`, `attachments` | On the list and on any task (§4) |

`id` stays a dotted path. Everything that keys on `<list>/<id>` (span keys, records, widget,
verdicts, bindings) is unchanged.

### 2.2 Load, validate, migrate

- **Every read validates.** A file that fails validation makes the `tasks` call fail with a
  `TaskError` naming each problem and its fix, for example `tasks[1].subtasks[0]: id "2.3" does not
  match its position 2.1; remove the id or move the task`. The file is not rewritten.
- **v1 files** (flat `tasks[]`, no `version`) are converted in memory: the tree is rebuilt from the
  dotted ids. The next write stores v2.
- **Missing goal** (a migrated v1 list, or one created from the UI lists browser, which asks only
  for a title): `start`, `add` and `move` are refused until
  `tasks update {list, goal}` sets one. `list`, `status`, `claim` and the finishing actions still
  work, so a running task can always be ended.
- **Hand edits** made while a list is claimed are accepted if they validate. Changing the id or
  position of a started task is a validation error: started ids are frozen (§3.2).
- `tasks list` names files that fail to load (`<slug> — invalid file; "status" shows what to fix`)
  instead of skipping them silently.
- Validator: `extension/taskSchema.ts`, pure and import-free, used by the store
  (`requireGoal: false`) and by the skill's `scripts/validate.mjs` (goal required). The store does
  not call the JSON-Schema file at runtime. The schema is the authoring contract, and
  `extension/taskSchema.test.ts` keeps the two in sync.

## 3. `tasks` tool actions

While `tasks` is active, its system-prompt guidance asks the agent to split broad features into
independently verifiable child tasks before work, or add children if a leaf grows unexpectedly.
Finished children can then fold while their parent remains open. Do not impose a fixed task count
or split trivial steps merely for bookkeeping. Verify that the installed Pi prompt builder includes
this guidance for the active tool; a replacement system prompt may omit it.

### 3.1 Summary

| Action | Arguments | Change |
|---|---|---|
| `create` | `{list, title, goal, tasks}` | `goal` required. Tasks accept `acceptanceCriteria`, `pins`, `attachments` |
| `update` | `{list, id?, title?, goal?, acceptanceCriteria?}` | New. Without `id` it edits the list. Titles and criteria of finished tasks are frozen |
| `add` | `{list, parent?, before?, after?, tasks}` | `before`/`after` take a sibling id, under the same parent. At most one of them |
| `move` | `{list, id, parent?, before?, after?}` | New. Moves a `todo` subtree (§3.2) |
| `pin` / `unpin` | `{list, id?, items}` / `{list, pins}` | New (§4) |
| `attach` / `detach` | `{list, id?, items}` / `{list, attachments}` | New (§4) |
| `block` | unchanged | `detail` accepts up to 1,024 characters |
| `complete` / `fail` | unchanged | Refused on an empty span (§3.3) |
| others | unchanged | |

Every result keeps a `details: TasksDetails` snapshot. It gains `renumbered: {from, to}[]` when ids
move.

### 3.2 Insert and move

- **Only `todo` subtrees move or renumber.** A subtree whose root or any descendant has been
  started cannot move. Inserting before a started sibling is refused. Started ids are frozen
  because spans, records, folds and verdicts refer to them.
- Moving under a finished parent is refused. Moving a task into its own subtree is refused.
- Renumbering only shifts `todo` siblings that come after the insertion or removal point.
  `blocks[].on`, `supersededBy` and `supersedes` references are rewritten in the same write.
- Refusals name the exact call that works: `2.3 has started and cannot move. Do this: tasks add
  {list:"auth", parent:"2", after:"2.3", tasks:[…]} for the new work.`

### 3.3 Empty span

`complete` and `fail` are refused when no tool call **and** no assistant text block of more than
40 characters lies between the task's last `start` result and the finishing call. The work is
counted by the extension's tool/message hooks, ancestors included, as `TaskCoach` counts today.
`abandon` stays allowed.

Refusal text:

```
Nothing ran inside 5 since tasks start. Start a task before its first tool call and end it after its last.
If you are about to present results or ask the user, block 5 {reason:"user-decision", detail:"…"} instead, then reply.
If the work ran in the task before it, abandon 5 {supersededBy:"4"}.
```

Tasks started before this process have no count and are never refused. The refusal applies only
while the `tasks` tool is active (its conductor attached), because only then does the coach count.
A tool call batched with its `start` counts, and a resumed task keeps its count (port of
`f04f39d`). The after-the-fact "no tool work" note is removed.

### 3.4 Review gate and resume

- **Tool text** (description and guidelines, `extension/accordion.ts`). Add:
  - "Your reply to the user is not a task. When a task's result needs the user's approval or
    choice, `block` it with `user-decision` before you reply; resume it with `start` when they
    answer."
  - "Stop only when every open task is blocked on user-decision, user-input or third-party, or the
    list is finished."

  This replaces the sentence "stopping while a task is in progress … counts as stopping too early".
- **Resume note** (`extension/taskBinding.ts` text, delivered through the existing
  `before_agent_start` note path in `extension/taskSession.ts`). On a user prompt while this
  session's list has a task blocked on `user-decision` or `user-input`:
  `Tasks waiting for the user in "…": 7 "…". If this message answers one, start it before continuing or completing its work; otherwise leave it blocked.`

## 4. Pins, attachments, working set

### 4.1 Pins

Ported from `exp/orientation-modes` `extension/pins.ts` (validation, caps, file re-read). Storage
moves from session entries into the list file.

| Field | Rule |
|---|---|
| `kind` | `rule`, `convention`, `constraint`, `standard`, `fact` |
| `text` | Verbatim quote, ≤300 chars. Checked against `source`: the text must occur in the named file or in a user message of this session (whitespace-normalized). A whole user message can be pinned |
| `source` | `user`, `path`, `path:line` or `path:start-end` |
| scope | List (no `id`) or task (`id`): a task pin applies to the task and its subtree |
| caps | List pins ≤2,000 tokens, pins per task ≤1,500 tokens (char estimate) |

### 4.2 Attachments

| Field | Rule |
|---|---|
| `path` | Repo-relative. Must exist when attached |
| `lines` | `N` or `N-M`, ≤60 lines. Absent means the whole file, which is allowed only for files ≤60 lines |
| `note` | ≤120 chars, why it is attached |
| `hash` | sha256 of the attached lines at attach time |

Attachments are cached and refreshed outside the context hook, preserving the engine's no-disk-I/O
invariant. An external edit between refresh and request can briefly be stale. A hash mismatch marks
them `changed since attached`; the store never updates the hash silently.

### 4.3 Working set

One text part appended to the **last message of the outgoing wire** in the `context_with_system`
hook, after Truth ingestion and wire serialization. It is never persisted and never enters Truth.
Shown only while a list is attached:

```
[tasks] auth — Token store
goal: All token access goes through TokenStore; …
pins: constraint: Never modify vendor/ (user)
doing 2.1 "Add the interface"
  acceptance criteria: TokenStore get/set/delete exist
  attached docs/spec.md:120-140 — interface contract
    <lines when render = inline>
```

Contents: the goal, list pins, and the pins, attachments and criteria of the doing task and its
ancestors.

`tasks.attachments.render` is `"inline"` (default) or `"reference"`. With `reference` only the
`path:start-end — note` locator appears. Both are measured (§9).

When a task finishes, its pins are copied verbatim into its record (§6) and leave the working set.
List pins stay until they are unpinned.

## 5. Spans

### 5.1 Structured facts

The scan reads `TasksDetails` from the `tasks` tool result instead of parsing result prose.

- Ingest copies a tool result's `details` onto its `Block` as `details?: unknown` (`core/types.ts`).
  `details` is not sent on the wire and does not count in tokens.
- Snapshots carry it.
- If Pi does not persist `details` for reloaded sessions, the scan falls back to the current prose
  regexes for blocks without it.

`TasksDetails` gains:
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
  `by:"agent"`. Taskfold marks that node agent-open and recompiles: the parent is parted around a
  raw child.
- An agent-open node refolds only under pressure and only once its task age is ≥2. After a second
  agent unfold it stays open for the session. Counts and open state persist in branch-local
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

Configured as `taskfold.aging = [3, 6, 11]`.

Cache rule (one cache break per epoch):
1. The epoch's planned ops define the earliest changed position P.
2. Records **after** P move straight to their target level for free.
3. Records **before** P change only if the projection is still above `low · budget`. Then they go
   oldest root first, each jumping straight to its target level, then one level further if still
   short.
4. No epoch runs only for aging. Aging rides on epochs triggered by `high`.

Never aged: the newest finished root (unless waived, §9.1), kept user messages, list pins. All
previously emitted child and group tags remain visible and recoverable through later aging. Task-scoped
pins are retained verbatim with their task and source, including when child records condense or the
parent ages. If those pins prevent a record from fitting its cap, leave it raw rather than drop them.

## 9. Epoch

```
live ≥ high·budget →
  1 records     compile finished roots, oldest first, until projection ≤ low·budget
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

Eval: 3 prompts (convert a plan document, write from scratch, repair an invalid file), with and
without the skill. Assertions: validator passes, list is ordered, every leaf has criteria.
Evidence lives in the plan's `evidence/`.

## 12. Settings (`~/.accordion/config.json`)

```jsonc
{
  "tasks": {
    "attachments": { "render": "inline", "maxLines": 60 },
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
| Tree, compile, diff, records, aging, intervals | `bun test conductors/in-process/taskfold/*.test.ts` with real `Truth` (`TestHost`) |
| Handles | `core/truth.test.ts`, `core/agentView` recall/unfold tests |
| Regression scripts (synthetic, no private sessions) | Each must stay ≤ `low·budget` or end saturated with only unfoldable blocks, and every fold and handle code must round-trip through `recall`: blocked task with sibling work (S2 1.3.4); giant open leaf; prelude before the list; three-level tree folded in two epochs; tail-pruned group re-proposed |
| Widget | `bun test extension/tui/*.test.ts`, plus a real terminal at 36/57/80/140 |
| Gates | `npm --prefix extension run smoke`, `npm --prefix app run check`, `npm --prefix app test` |
| Measurement | Isolated synthetic fixture comparison: five runs per fixture for A, K+, T and TF; four for TF-inline and TF-ref. Includes pass/constraint results, peak context, estimated cost and cache reads. See `PLAN-0002`'s `evidence/floor-comparison/README.md` for results and limitations. |
