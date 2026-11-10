---
document:
  type: "specification"
  id: "SPEC-0001"
  title: "Accordion UI polish: panel, settings, compaction, task widget and web parity"
  description: "Decided design for the Pi-native Accordion terminal panel, synced and complete settings, the /compact redesign, the Taskfold widget and tool rows, and the matching web app surfaces."
  status: "published"
  revision: 11
  created_at: "2026-11-05T09:30:40+01:00"
  updated_at: "2026-11-10T10:56:03+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 11
      reason: "task views became the Tasks and Lists tabs of the panel"
      changes: ["§4.9, §4.13, §4.14 keys are chords, opened as tabs", "§5.2 tab order, task-tab chords, takeover prompt", "§11 item 0 reduced to locked settings"]
---

# Accordion UI polish

Inputs: the approved chat wireframes of 2026-11-05 (reproduced here), the user's sketch
`.project/user-uploaded-assets/2026-11-05T09:00+01:00-taskfold-widget-sketch.md`, and the house UI
conventions (`~/.pig/agent/skills/extending-pig/references/ui-ux.md` and, for the panel,
`references/dashboard-standard.md`). The implementation plan is
`.project/plans/0001-accordion-ui-polish/plan.md`.

"MUST" marks a requirement an implementation is checked against. Everything else is explanation.

## 1. Scope

| Area | In scope |
|---|---|
| A. Taskfold visibility | task widget above the editor, one-line tool rows for `tasks`/`unfold`/`recall`. **Delivered** (§4). |
| B. Panel (`/accordion`) | dashboard-standard shell with chrome, tabs, fitted hints (**delivered**, §5.1–5.2); Overview, Context (timeline, grid, list), Inspector, Conductors, Settings, Help screens. |
| C. Settings | every `config.json` key editable; staged edits saved with `ctrl+s`; cross-instance sync; source and override display; validation errors. |
| D. Compaction | one compaction entry point with strategies `pass`, `aggressive`, `bake`, `native`; conductor settle wait; `/compact <instructions>`; threshold handling; preview; undo; result card. |
| E. Footer status | shorter, fitted status segment. |
| F. Web app | Overview, Settings (server-side), task list, compaction card, matching the TUI semantics through protocol v23. |

Out of scope: new conductors, changes to folding semantics in `core/truth.ts` beyond what §7 names,
the desktop (Tauri) shell, the upstream (unforked) Accordion package.

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Overview is the landing tab of `/accordion`. | The first question is "how full is it and is folding working", not "which block". |
| D2 | Context has three views: timeline (default), grid (today's map), list. | Timeline shows turn structure; grid stays for density; list for search. |
| D3 | Global settings are staged and saved with `ctrl+s`. Session values (folding, budget, tail) apply immediately. | House standard; session values are Truth commands every surface already shares. |
| D4 | `bake` compaction is included. | Taskfold records and digests make a structured, permanent summary. |
| D5 | Task widget follows the user's sketch exactly, collapsed by default. | User decision. |
| D6 | Web app gets the same surfaces through protocol v23. | User decision: all surfaces. |
| D7 | `compactMode` is replaced by a `compact` object; the old key is migrated on load and dropped on the next save. | Three behaviors (manual, threshold, saturation) cannot share one enum. |
| D8 | Settings sync piggybacks on the existing ~1 s controller poll and uses a SQLite sidecar mutex like `controller.json`. | Reuses a proven primitive; no new timers or watchers. |
| D9 | Mouse is optional everywhere; every click action has a key or command. | PiG 0.5.3 does not deliver clicks to extension components (§4.6). |

## 3. Cross-cutting UI rules

These apply to every TUI surface in this spec. Each MUST hold.

1. **Width.** Every line fits its width, measured with `visibleWidth`, cut with
   `truncateToWidth(text, width, "…")`. Verified at 36, 57, 80 and 140 columns, and at 16 rows.
2. **Truncation order.** Lines are built as ordered segments and fitted with `fitSegments`
   (identity first, secondary metrics last). Never a blind right-truncate of a joined string.
   `fitSegments` moves from `extension/tui/taskWidget.ts` to `extension/tui/chrome.ts` and is
   shared.
3. **Theme tokens.** Chrome uses `theme.fg(token)` only: `accent`, `muted`, `dim`, `success`,
   `warning`, `error`, `text`, `border`, `borderAccent`. The block-kind palette
   (`extension/tui/map.ts` `KIND_RGB`) is data color and stays, but kind is never shown by color
   alone: the selected-block strip names it, and `?` shows the legend.
4. **Glyphs.** `✓ ✗ ▲ ● ○ ◐ ▶ ☐ ▣ ☒ ⧗ ⊘ › · …` plus the box-drawing set. No emoji (`⏸` renders as
   one in common terminals; blocked uses `⧗`).
5. **Selection** is a `→` cursor plus a bold label; no row background. The selected row keeps its
   kind colors.
6. **Keys.** Enter confirms or drills in. Esc clears a filter, then goes back one level, then closes.
   `ctrl+c` closes from any depth. Both ask before discarding staged settings. Tab/Shift+Tab cycle
   tabs; Left/Right too, unless the screen moves or changes a value with them. `F1` opens help.
   **No single-key actions in the panel:** a printable key types into the filter or an inline
   input and does nothing else; every action is a modifier chord (§5.2). A test sends every
   printable ASCII key to every screen and asserts that nothing fired. The task views of §4 predate
   this rule and still use bare keys; converting them is open (§11).
7. **Hints.** One hint row per screen, built from a priority-ordered list; the highest priority
   number is dropped first and the cancel key is always kept. Key names come from the user's
   bindings (`keys.getKeys`).
8. **Height.** The panel body has a fixed height while open: `clamp(rows − 12, 3, 14)`, computed
   on open and on resize only. Switching tabs, filtering, drilling in, help and confirms never
   change it; content scrolls inside and the rules show `↑ N more` / `↓ N more`.
9. **Session binding.** A panel belongs to the session that opened it (unchanged rule in
   `AGENTS.md`); late async results after a session switch touch nothing.
10. **Untrusted text** (block text, task titles, model output) goes through the existing `clean()`
    sanitizer before styling.

## 4. Area A: Taskfold visibility (delivered)

Delivered on branch `feat/taskfold-widget` (commits `8c2fb44`…`b61afcb`). This section is the
contract it implements; changes to it MUST update this section.

### 4.1 Data

- `Task` gains optional `startedAt` / `endedAt` (ISO), set by `TaskStore.start` / `finish`
  (`extension/tasks.ts`). Lists written before this change render without durations.
- `scanTaskSpans(blocks, textOf)` and `taskKeyOfSummary(summary)` are exported from
  `conductors/in-process/taskfold/taskfold.ts`. Spans include open ones (`status: null`, `end` = last
  block index); the conductor folds finished spans only.
- `tasks` tool results carry `details: TasksDetails` (`extension/tui/toolRows.ts`), with
  `renumbered` when `add`/`move` renumbered unstarted tasks.
- List files are v2 nested trees with a `goal` and per-task `acceptanceCriteria`; format, migration,
  `update`, `add before|after` and `move` are specified in SPEC-0002 §2–3.
- `TaskClaim` gains optional `name` (the claiming session's display name). `claimState(list,
  session)` returns `mine`, `free`, `held` (another session, active within `CLAIM_STALE_MS`) or
  `stale`. `taskFingerprint(list)` hashes ids, statuses, titles and `updatedAt`; claim changes do not
  alter it. `slugFor(title, taken)` derives a free slug.

### 4.2 Visibility

The widget (key `accordion-tasks`, placement `aboveEditor`) is shown iff all hold:
interactive TUI; `taskWidget.mode === "auto"`; the attached conductor's registry entry declares
the `tasks` tool; this session claims a list with at least one task; not hidden for the session.
The shown list is the claimed one with a task in progress, else the most recently updated one.
List files are read on session start, after every `tasks` call of this session and on
`/accordion tasks`, never during render.

### 4.3 Collapsed (default)

```
▲ Tasks Secrets 6/20 (≡6) · 6m 21s · 26.7k → 10.1k tok
  ⎿ 3.4.1 the new registry · 1m 11s
```

- The header includes the list title, shortened or omitted when narrow to preserve counts and metrics.
- `6/20`: tasks with status `done` / all tasks.
- `(≡6)`: tasks inside a folded Taskfold group; subtasks of a folded task count. Omitted at 0.
- `6m 21s`: sum of the durations of the outermost started tasks. Omitted when no task has timing.
- `26.7k → 10.1k tok`: tokens of this session's spans of the list at full size → as currently sent
  (a folded group counts once, at its live size). Omitted without spans.
- Line 2: the innermost task in progress and its running time; when none is in progress, the
  innermost blocked task with its reason (`⎿ ⧗ 3 Deploy · needs user decision`), else
  `⎿ next <id> <title>`; omitted when nothing is left to do.
- All tasks finished (`done`, `failed` or `abandoned`): a single line with `►`.

### 4.4 Expanded

The header uses `▼`. Rows: `<prefix><glyph> <id> <title> · <duration> <marker>`.

| Glyph | State | Color |
|---|---|---|
| `☐` | todo | `dim` (id and title dim too) |
| `▶` | in progress, no finished subtask | alternates `warning` / `text` every 1 s (color only) |
| `◐` | in progress with ≥1 finished subtask | `warning` |
| `⧗` | blocked | `warning`; the row adds ` · <reason label>` in `warning` |
| `▣` | done | `success` |
| `☒` | failed | `error` |
| `⊘` | abandoned | `dim`; id and title dim and struck through (SGR 9); the glyph stays plain; superseded rows add ` · → <id>` |

Reason labels: `needs user decision`, `needs user input`, `waits on third party`, `waits for <id>`.
Durations exclude blocked periods.

A second glyph distinguishes folded (`≡`), finished but raw (`·`), and a finished task with unfinished descendants (`!`). First expansion shows a legend; `?` opens it in the task list view. Hidden rows distinguish finished and upcoming siblings. Progress is a breakdown of leaf states, e.g. `3✓ 1☒ 2☐`.

Markers, joined with ` · ` inside one pair of parentheses:

| Row | Marker |
|---|---|
| task owning folded group(s) | `≡` and `(35.2k → 400)`: full → live tokens of its groups (parts summed) |
| subtask folded inside its parent's group | `≡`, only when it ran; a never-started subtask shows no fold marker |
| any task with subtasks | leaf-status counts, e.g. `(3✓ 1☒ 2☐)` |
| closed branch with folded descendants | `(2≡ · 20.0k → 500)`, after progress |
| hidden run | `… N finished` or `… N upcoming`, duration and folded totals when available |

When the row is too narrow for token counts the short form (`(2≡)`) is used.
Finished tasks' subtasks are closed by default.

**Smart hiding**, when the full tree exceeds `taskWidget.maxRows` (default 12) tree rows:
the anchor is the innermost task in progress, else the first todo, else the last task. The anchor's
ancestor path and the anchor's first unfinished subtask stay visible even beyond the budget. All
other siblings on each level of the path collapse into `… N finished` or `… N upcoming` rows
(N counts hidden subtasks too). Siblings are then revealed nearest-first (deepest level first; at
equal distance the upcoming sibling before the earlier one) while the row count stays within the
budget. A hidden run of one is shown as the task itself. Narrow rows drop the duration before the
title is truncated; the marker drops when the title would keep fewer than 8 columns.

### 4.5 Controls

| Input | Effect |
|---|---|
| `alt+t` (`taskWidget.toggleKey`) | expand ⇄ collapse; shows a hidden widget |
| `/accordion tasks [expand\|collapse\|hide\|show]` | as named; `show` restores the configured default state; reports why the widget is not shown |
| `/accordion tasks lists` | the task list browser (§4.9) |
| click header line | expand ⇄ collapse |
| click a task row with subtasks | open ⇄ close that branch |
| click a `… N hidden` row | reveal those tasks for the session |

### 4.6 Known limitation

PiG 0.5.3 delivers wheel events but not clicks to extension components (widget and self-rendered
tool rows; verified live 2026-11-05). Click handling is implemented (`handleMouse`) for hosts that
dispatch it. Per-branch toggles therefore have no keyboard path under PiG yet; the panel's Tasks
view (§5.8) is the keyboard path.

### 4.7 Tool rows

`renderShell: "self"`, one line, expanded with Pi's tool-expand key or a click:

```
 ✓ tasks start 3.2 Watch config.json
 ✓ tasks complete 3.2 Watch config.json · 1m 12s          (failed/abandoned add the status word; failed in error color)
 ✓ tasks abandon 3.2 load test · abandoned · → 4          (→ replacement when superseded)
 ✓ tasks block 2 Deploy to prod · needs user input        (expanded: waits on <detail>)
 ✓ tasks start 2 Deploy to prod · resumed
 ✓ tasks create demo Demo · 9 tasks
 ✓ tasks status demo · 4/5 done
 ✗ tasks start 2 · Task 2 is done. Add a follow-up task instead of restarting it.
 ✓ unfold #3f9a2c · 1 unfolded
 ▲ recall #3f9a2c #000001 · 1 recalled · 1 not found
```

Expanded: the report (`outcome`/`decision`/`open`) for finishing actions, the outline for
`create`/`status`/`claim`/`list`, the full text for `unfold`/`recall` and errors.

### 4.8 Session binding, resume and agent notes

Modules: `extension/taskBinding.ts` (pure), `extension/taskSession.ts` (flow),
`extension/tui/taskLists.ts` (dialogs).

**Memory.** The session file records the attached list: a custom entry
`accordion.tasks.binding` with `{ slug: string | null, fingerprint? }` is appended whenever the
attached list or its tasks changed since the last entry (checked at `agent_end` and after every
dialog action). Sessions without such entries fall back to their successful `tasks` calls
(`create`/`claim`/`add`/`start`/`complete`/`fail`/`abandon` attach, `release` detaches). The
attached list of a session is the one it claims with a task in progress, else its latest updated.

**Settling on `session_start`** (only when the conductor provides `tasks`; `reason: "new"` has no
previous list):

| Previous list now | Interactive TUI | No TUI |
|---|---|---|
| claimed by this session | keep, no dialog | keep |
| free or stale, `reload`, unchanged | reclaim silently | reclaim silently |
| free or stale, otherwise | resume dialog | reclaim silently |
| held by another session | resume dialog | leave it, continue without |
| missing | resume dialog | continue without |

Resume dialog (opens after `session_start` returns):

```
 Accordion › This session's task list
 Reattach the task list this session used before?
 demo — Demo
 ▣ 1/5 ▶ 2.1 Core · updated 12s ago · 1m 30s worked
 ▲ its tasks changed since this session last used it
 ▲ currently claimed by session 22222222 "Beta session", active 12s ago
› Take over "demo" from session 22222222 "Beta session"     (free: Reclaim "demo"; missing: absent)
  Choose another list…                                     (browser in pick mode)
  Start a new list…                                        (inline title input)
  Continue without a task list                             (also Esc)
```

Taking over a held list or reclaiming releases this session's other claimed lists (one attached
list per session). A failed action keeps the dialog open and shows the error.

**Agent notes.** Notes are queued and delivered on the next prompt through `before_agent_start` as
a displayed custom message `accordion.tasks.notice` (rendered as `▲ tasks note to the agent · …`).
`before_agent_start` waits for an open resume dialog first. Texts (`agentNotice`, `attachedNotice`,
`releasedNotice`):

| Outcome | Note |
|---|---|
| same list reclaimed, unchanged | none |
| same list reclaimed, changed | `Task list "<slug>" is attached to this session again, but its tasks changed since you last used it. Current state:` + outline |
| previous held elsewhere, anything else chosen | `Your previous task list "<slug>" is now claimed by session <id8> "<name>"; you cannot change it from this session.` + outcome sentence |
| previous missing | `Your previous task list "<slug>" no longer exists.` + outcome sentence |
| previous free, not reclaimed | `Your previous task list "<slug>" is no longer attached to this session.` + outcome sentence |
| outcome: other list | `The user attached task list "<slug>" to this session. Current state:` + outline |
| outcome: new list | `The user started a new empty task list "<slug>" ("<title>") for this session. Add its tasks with action "add" before starting work.` |
| outcome: none | `The user chose to continue without a task list; claim or create one only if the user asks.` |

"Changed" compares the recorded fingerprint; for sessions recorded only by tool calls, a task
`updatedAt` later than 2 s after the session's last `tasks` result counts as a change.

### 4.9 Task list browser

Creating a list in the browser or resume dialog collects its title and required goal before writing it.

`/accordion tasks lists` (alias `list`) opens the panel's Lists tab over `.pig/tasks/*.json`
(frame and keys: §5.2; the sketch shows the rows):

```
 Accordion › Task lists · 2 lists
› ● follow-up-work empty   this session · 15s
  ○ demo           ▣ 1/5   held · session 22222222 "Beta session" · 1m · 2m · Demo
 ↑↓ select · enter open · r release · n new · esc close
```

Rows: `●` attached to this session / `○` not, slug, progress (`☐ 0/n` none done, `▣ done/total`,
`✓ n/n` all done, `empty`; the detail view adds `▶ <task>` in progress), claim (`this session`, `free`, `held · <holder> · <claim age>`,
`stale · …`; short words `yours`/`free`/`held`/`stale` when narrow), list age, title. Enter opens a detail
view with the full tree (§4.4 glyphs, no smart hiding, scrollable). Keys: `alt+a` attaches (claims
and releases this session's other lists; a held list asks first), or releases an own list;
`alt+n` new list (inline title, slug from `slugFor`). Every attach, release and create
from the browser queues the matching agent note (§4.8); re-attaching the same unchanged list does
not.

### 4.10 Task protocol (delivered)

The agent's task spans are only as good as its calls, so the store repairs structure and the
extension coaches. Implemented in `extension/tasks.ts` and `extension/taskCoach.ts`.

- **Auto-started parents.** `start <id>` starts every unstarted ancestor first; the result adds
  `Also started parent <id> "<title>" so its span covers this subtask.` per ancestor.
- **Parent ready.** Finishing the last open subtask of an open parent appends
  `All subtasks of <id> "<title>" are finished: complete <id> now with its own report, or add more
  subtasks to it.`
- **Auto-closed parents.** Starting a task outside an open parent whose subtasks are all finished
  closes that parent instead of rejecting the call: status `done` when all subtasks are `done`, else
  `failed`; report outcome `Closed automatically after its subtasks: <id> <status>: <outcome>; …`
  (capped to 600 chars); `autoClosed: true` on the task. The result adds
  `Closed <id> "<title>" as <status> from its subtasks' reports, because you moved on without
  completing it. …`. An open task with unfinished subtasks still blocks, naming the innermost one.
- `scanTaskSpans` reads both result lines: an auto-started parent's span starts at the subtask's
  start call; an auto-closed parent's span ends at the block before the moving-on call.
- **Guidance.** The `tasks` tool description and prompt guidelines state: start before the first
  tool call of a task's work and finish right after its last; work only inside a started task; never
  start and finish with no work between; finish a parent with its own report after its last
  subtask. If finishing requires the user's approval or choice, block on `user-decision` before
  replying. A later prompt reminds the agent to resume only if it resolves the block.
- **Reminders** (`extension/taskCoach.ts`, appended to tool results by a `tool_result` handler,
  never blocking): with a list attached, a todo task left and none in progress, the 3rd consecutive
  top-level non-`tasks` tool result and then every 8th (`OUTSIDE_FIRST`, `OUTSIDE_EVERY`) get
  `[accordion tasks] <n> tool calls in a row ran while no task of "<list>" is in progress, so this
  work belongs to no task record. If it is part of a planned task, call tasks start {…} before
  continuing (next to do: <id> "<title>"); if it is new work, add a task for it first.` Finishing a
  task whose span saw no other tool result (counted in memory since its `start` in this process,
  ancestors included) and assistant texts over 40 characters is refused (SPEC-0002 §3.5); a task
  started before this process is never refused.

### 4.11 Taskfold folding (delivered)

- **Overlap-safe edges.** A span snaps outward to whole messages as before; a boundary message
  already in another group (or planned in this epoch) pulls that edge inward to the next whole
  message, so `complete A` + `start B` in one assistant message folds both tasks. Interior blocks
  in a foreign group still reject the span.
- **`keepRecentTasks`** (default 1): the newest N finished top-level spans are never fold
  candidates. The token tail still applies to every fold.
- **Aging ladder.** When folding every candidate still leaves the projection above `low · budget`,
  Taskfold rewrites its own folded records, oldest first, skipping the newest record and any group
  touched in the same epoch: level 1 for all of them first (`<tag> [task-record] <key> "<title>"
  status: <s> · <outcome ≤200>`), then level 2 (`<tag> [task-archived] <key> "<title>" <s>; recall
  the code for its record and transcript.`), until enough is freed. Each rewrite is `ungroup` +
  `group` with the same member ids, so group id, fold code and `recall` of the raw span stay.
  `taskKeyOfSummary` recognizes all three tags.
- **Protected trailing message.** A span's last message that is protected or held (e.g. `complete A`
  batched with B's work into the newest message) pulls the record's end in before it, like a
  boundary message in another group.

### 4.12 Budget and protected tail per model (delivered)

Implemented in `extension/dials.ts` and `extension/accordion.ts`.

- **Amounts:** `200000`, `200k`, `1M`, `0.5M`, `1_000k`, or `85%` of the model's context window
  (`parseTokens`); shown with `formatTokens` (`200k`, `1.5M`).
- **Resolution** for model `provider/id`: the last value set in this session for that model, else
  `modelDefaults` by most specific key (`provider/id`, `provider/*`, `*`), else the context window
  (budget) or 20k (tail). The budget is capped at the window.
- **When:** on the first Truth build of a session start, and on every model change (`model_select`
  and the late-learned model in `refreshFromCtx`); the budget follows the model.
- **Session memory:** every `setBudget`/`setProtect` command (panel, web, `/accordion budget|tail`)
  appends `accordion.dials` `{ model, budget | protect }`; a resume reads them from the branch.
- **Panel:** `b`/`t` (and Settings rows) open an input accepting amounts with a live parse preview,
  the current value and its source (`set in this session`, `default <key>`, `model window`,
  `built-in`). `enter` applies to the session; `ctrl+s` applies and saves
  `modelDefaults["provider/id"]`.
- **Command:** `/accordion budget|tail [<amount>] [--default]`; without an amount it reports the
  value and its source.

### 4.13 Task drill-down (delivered)

Implemented in `extension/tui/taskTranscript.ts` (pure model), `extension/tui/treeView.ts` (shared
tree component) and `extension/tui/taskViews.ts` (one screen stack behind the Tasks and Lists tabs,
wired by `screens/tasks.ts`). Enter in the §4.9 Lists tab opens it.

- **Data.** Tasks record `createdAt` (absent on older lists). Taskfold's user-message verdicts are
  stored as `accordion.taskfold.verdict` session entries with `loss`, `source`
  (`classifier | harness | opening | error`), the other classifier answers (`keep_goal`,
  `durable_rule`, `overrule` as probabilities of yes), `confidence`, `model` and `at`. A resume
  reuses them and never classifies a stored block again; `error` verdicts are not stored.
- **Task tree** `Accordion › Task lists › <slug>`: the list's tasks with §4.4 glyphs, `done/total`
  on parents, `≡n` folds, duration, tokens `full → live` from this session's transcript. Enter opens
  details, `alt+i` the span, `alt+f` unfolds/refolds the task's record.
- **Details** `… › <slug> › <id>`: task position, planned time and wait, ran from → to and
  duration, status (`closed automatically` when auto-closed), outcome, decisions, open, changed
  files and checks (from the span), span size and tokens, and per record its code, aging level
  (`record`, `one line`, `archived`), block count and tokens. Values wrap under the value column.
- **Span view** `… › <id> span`: start edge; subtasks as rows that open their own span; folds as
  `≡ {#code} <level> · n items` with their steps beneath; steps as one call with its result
  (`✓`/`✗`, tool, first argument line, `pinned`/`folded`/`tail`); user messages with their verdict;
  finish edge with status and outcome.
- **User message verdicts** read `kept`/`folded` plus the reason: `loss x < t` / `loss x ≥ t`
  against Taskfold's `maxLoss`, `folds with its task` (eligible, its task not folded yet), `no task
  covers it` (eligible, between tasks), `harness pattern`, `opening message`, `classifier failed`,
  `unclassified`. Enter shows the verdict, every answer, model and time, and the classifier input
  rebuilt from the transcript (`session_goal`, `previous_user_message`, `assistant_last_reply`,
  `message`).
- **Text viewer**: a step shows call and result with token counts; a fold shows the record as the
  agent sees it, `alt+v` toggles the original members.
- **Actions** through the controller lease (the panel's): `alt+f` folds/unfolds a step (a call
  folds through its result; user messages fold only inside a record) or a record, `alt+p`
  pins/unpins. Refusals name the reason in words (`inside the protected working
  tail`, …). Without control the views stay read-only.
- **Keys**: arrows, `→`/`←` expand/collapse, PgUp/PgDn, typing filters, Enter, Esc one level back,
  Ctrl+C closes. Printable keys never act (§3.6).

### 4.14 Session tasks tree (delivered)

`/accordion tasks tree` shows this session's transcript by task: top-level tasks with subtasks
(prefixed `<list>/` when the session used several lists), user messages between tasks with their
verdicts, assistant answers between tasks as `A` rows, and tool calls outside any task as
`⋯ untracked · n calls · ▲ no task in progress`. Untracked work is visible by default; `alt+v` cycles
all → tasks only → untracked only. Enter opens a task's span (§4.13).

### 4.15 Task end states (delivered)

| Status | Meaning | Finished | Set by |
|---|---|---|---|
| `done` | the goal was reached | yes | `complete` (only from `doing`) |
| `failed` | tried, the goal was not reached, not pursued further; the report quotes the failing command or error | yes | `fail` (only from `doing`) |
| `abandoned` | stopped on purpose without a verdict: not wanted, replaced, user changed course | yes | `abandon` (from `todo`, `doing` or `blocked`), cascades, `add … supersedes` |
| `blocked` | cannot continue because of something outside the agent's control; resumes with `start` | no | `block` (only from `doing`) |

- **`block {list, id, reason, detail, blockedBy?}`.** `reason` ∈ `user-decision` (the user must
  choose), `user-input` (information, credentials or access only the user can give), `third-party`
  (external service, review, release), `dependency` (another task first; `blockedBy` names a task
  outside the task's own branch that is not finished). `detail` is required, ≤240 chars. A task with
  a subtask in progress cannot be blocked (block the subtask). Ancestors in progress with no other
  task in progress beneath them are blocked too, reason `dependency` on the blocked task, so the
  agent may start other work. Each block is appended to `Task.blocks[]`
  (`{reason, detail, on?, at, resumedAt?}`); `start` on a blocked task (or an ancestor chain) sets
  `resumedAt` and returns `Resumed …` / `Also resumed parent …`. `startedAt` is kept.
- **Idle justification.** `IDLE_REASONS` = `user-decision`, `user-input`, `third-party`: waiting on
  them justifies stopping. `dependency` does not: the block result says `Work on <id> now`. Every
  `agent_end` appends an `accordion.tasks.idle` session entry `{list, at, state, …}` from
  `idleVerdict(list)` (`extension/taskCoach.ts`): `in-progress` (a task still doing) and `pending`
  (startable work left) are premature stops; `waiting` (every remaining task waits on an idle
  reason, listed with its reason) and `finished` are allowed.
- **Coach.** `nextTask(list)` suggests resuming a task blocked on a dependency that has finished,
  else the first `todo` task outside a branch waiting on an idle reason; the outside-work reminder
  names it (`next: resume <id> …, which was waiting for <dep>`).
- **Parent completion.** `complete` on a parent is refused while any subtask is `todo` or `blocked`:
  `Subtask 3.2 (not started) of 3 is unfinished. Start and finish it, or abandon it with a report
  (and "supersededBy" when another task replaces it) before completing 3.` `fail` and `abandon` on a
  parent abandon its `todo` and `blocked` subtasks (`Abandoned with its parent <id> (<status>).`).
  Parents blocked on a finished task stay blocked and are named in the result.
- **Superseding.** `abandon … supersededBy: "<id>"` links the replacement (not inside the abandoned
  branch). `add` accepts `supersedes: "<id>"` per task: the old task (not `doing`, not `done`) is
  abandoned with `Superseded by <new id>.` when still open, and gets `supersededBy` either way.
  `create` rejects `supersedes`. A finished task cannot be restarted; the error suggests
  `add … supersedes`.
- **Tool description.** States the lifecycle, the four endings with their definitions, the block
  reasons and which justify stopping, the parent and branch rules, and the report contents;
  guidelines add "pick the ending that is true", "block instead of leaving in progress", "stopping
  while a task is in progress or unblocked work remains counts as stopping too early".
- **Views.** Details show `Blocked`/`Paused` periods (`<label> — <detail> · from → to`),
  `Superseded by <id>` and `Replaces <ids>`; a never-started task shows `Span none · never started`.
  The list tree keeps blocked tasks open and shows their reason.
- **Taskfold.** Blocked spans are open spans and never fold; `scanTaskSpans` reads `Resumed …` /
  `Also resumed parent …` and keeps the span from the task's first start.

## 5. Area B: the panel

### 5.1 Module structure (delivered)

| File | Owns |
|---|---|
| `extension/tui/panel.ts` | `openAccordionPanel(ctx, host, start?)`: the `ctx.ui.custom` loop, tab switching, key routing, filter, help, confirm screens, `pending` command state, the digest-editor round trip |
| `extension/tui/chrome.ts` | the frame: `renderFrame`, `ruleLine`, `crumbText`, `tabBar`, `searchLine`, `hintRow`, `makeChrome` (rule and chip painters), `fitSegments`, `bodyRowsFor` |
| `extension/tui/screens/types.ts` | `PanelTab`, `TabView`, `Shell`, `ConfirmSpec`, `DigestAction` |
| `extension/tui/screens/context.ts` | Context tab: map and list views, Inspector, block actions |
| `extension/tui/screens/conductors.ts` | Conductor list and consent |
| `extension/tui/screens/settings.ts` | Settings rows, inline editors, staging |

Later slices add `screens/overview.ts` and `timeline.ts` (§5.3–5.4). A tab implements `PanelTab`:
it returns a `TabView` (body lines, extra breadcrumb levels, description, hints, scroll counts),
handles the keys the shell did not take, and reports `typing()`, `query()`, `dirty()`. Help is
generated by the shell from the tab's hints plus its `legend()`.

### 5.2 Frame (delivered)

The nine lines of the dashboard standard, on every screen:

```
── Accordion › Settings ──────────── ▲ 2 staged · 8.1k/425.0k tok · ● folding ──   top rule
 ❱ Context ❱ Tasks ❱ Lists ❱ Conductors ❱ Settings                                 tab bar
 ⌕ Type to filter…                                                                 search line

 …body, fixed height…
────────────────────────────────────────────────────────────────────────────────   middle rule
 Conductor attached when a session starts armed. Stored in ~/.accordion/config.…   description
 enter next value · ctrl+s save · ←→ change · f1 help · esc close                  hint row
─────────────────────────────────── ↓ 7 more ───────────────────────────────────   bottom rule
```

- Rules take the thinking-level color (`theme.getThinkingBorderColor`, repainted on
  `thinking_level_select`), `border` without it. Text inside rules is dim.
- Top rule: breadcrumbs left (`Accordion › Tab › Drill-in`; the earliest levels drop first), `↑ N
  more` in the middle, state right in this order, dropped from the end, each shown whole or not at
  all: `READ-ONLY` (warning), `▲ N staged` (warning), `<live>/<budget> tok`, `● folding` /
  `○ folding off`, `<conductor> ✓|▲|✗` by status level.
- Tab bar: chips separated by `❱`; the active chip is bold on the accent background, inactive
  chips on a neutral background (`toolPendingBg`, `selectedBg`, else the `borderMuted` color). It
  never wraps: it scrolls around the active tab with `…` and `n/N`.
- Search line: always present; empty on screens without a filter. `ctrl+u` clears.
- Description: one line about the selected row. A result or refusal replaces it until the next
  key: results plain, refusals `▲` (warning), failures `✗` (error). A read-only panel prefixes
  `read-only · reopen /accordion`.
- Drill-in screens (Inspector, inline editor, confirm, scope prompt, help) keep the tab bar and add
  a breadcrumb level. A confirm lists the safe choice first.

| Key | Action |
|---|---|
| Tab / Shift+Tab | next / previous tab |
| Enter | inspect block, attach conductor, edit or toggle a setting, choose in a confirm |
| Esc | clear filter, then back one level, then close (asks when settings are staged) |
| Ctrl+C | close at any depth (asks when settings are staged) |
| F1 | help for the current tab |
| Ctrl+U | clear the filter |
| Alt+F / Alt+P / Alt+U | fold or unfold / pin or unpin / return the block to auto (Settings: stage the default) |
| Alt+E / Alt+R | edit the digest / restore the engine digest (Settings: regenerate the token, asks first) |
| Alt+M / Alt+N | mark the range start / new group from the range |
| Alt+G / Alt+D | fold or unfold the group / delete the group (asks first) |
| Alt+V | Context: map ↔ list; Inspector: original ↔ digest |
| Alt+O / Alt+C | folding on or off / compact now |
| Ctrl+S | Settings: save staged values |

Tabs: `Context ❱ Tasks ❱ Lists ❱ Conductors ❱ Settings`. Tasks and Lists (§4.9, §4.13, §4.14)
exist for the local session only. `/accordion context|conductors|settings` and
`/accordion tasks tree|lists` open the panel on that tab.

Task tabs: typing filters; `alt+f` fold or unfold (step, fold, task record), `alt+p` pin, `alt+i`
the other view of a task (span from a list, details from the tree), `alt+g` list goals and
context, `alt+v` record ↔ original and all / tasks only / untracked only, `alt+a` attach, release
or take over a list (take-over asks, keeping first), `alt+n` new list (title, then goal).

Taking control from another surface asks with `Open read-only` first and `Take control` last.

### 5.3 Overview (landing)

```
 Context   ███████████▓▓▓▓▒░░░░░░░░░░░░░░░░░░░░░░░░░░░   105.1k / 372.0k   28%
           ■ system 55.2k  ■ user 0.1k  ■ answer 7.1k  ■ thinking 0.3k
           ■ calls 8.4k    ■ results 34.0k                       ░ free 266.9k
 Saved     −42.7k (29%) · 38 blocks folded · 4 groups · tail 20.0k protected
 Pressure  folds start at 80% (297.6k) · pi auto-compact: accordion pass

 Conductor Taskfold                                                 ✓ healthy
           Epoch 3: folded 2 task group(s), ~18400 tokens.
 Tasks     tui-polish 6/20 (≡6) · ▶ 3.4.1 the new registry · 1m 11s
 Web UI    http://192.168.1.20:24318/?token=ceka3xaz      2 clients · door ●
```

| Row | Source | Rule |
|---|---|---|
| Context bar | `buildContextBreakdown` (`map.ts`) | bar width = `min(44, width − 30)`; label column 10 wide; numbers `formatCompactTokens` |
| Saved | breakdown + `truth.groups` | omitted when nothing folded |
| Pressure | the attached conductor's resolved `high` option (§6.1) when it declares one, else omitted; `settings.compact.threshold` | `folds start at <high·100>% (<high·budget>)`; `pi auto-compact: <label of compact.threshold>`; `folding off: pi compacts natively` when disarmed |
| Conductor | `host.activeConductor()`, `host.conductorStatus()` | line 1 label and level (`✓ healthy` / `▲ warning` / `✗ error`); line 2 the status text, wrapped to 2 lines max |
| Tasks | task widget controller summary | only when a list is shown; clicking/Enter opens §5.8 |
| Web UI | `host.webInfo()` | URL host: the bind host, except `0.0.0.0`/`::` which show the first non-internal IPv4 of `os.networkInterfaces()` and fall back to `127.0.0.1`; OSC 8 hyperlink when the terminal supports it |

Keys (priority): `enter` context (1), `alt+c` compact… (2), `alt+o` folding on/off (3),
`alt+t` tasks (4).

### 5.4 Context: timeline (default view)

```
  turn  prompt                         blocks  ▪<500 ■<5k █≥5k     live    full
  ⛨     system prompt                  █!                         55.2k   55.2k
  1     analyze the tui panel…         U H ▪▪■█ ▪■ A               12.4k   12.4k
  2     ▣ task tui/1 "Analyze"         ▣▣▣▣▣▣▣▣▣▣▣▣                 0.6k   11.8k
  3     now wireframes                 U H ▪█ ▪■ ▪▪ A               8.1k    8.1k
› 4     tail (protected)               U H ▪■ ▪[█] ▪■ ┃            20.0k   20.0k
────────────────────────────────────────────────────────────────────────────────
 R  result · read panel.ts · 7.2k tok · live · protected tail
    import type { ExtensionContext } from "@earendil-works/pi-coding-agent"…
```

Model (`extension/tui/timeline.ts`, pure):

```ts
export interface TimelineCell { blockId: string; glyph: string; kind: BlockKind; folded: boolean; groupId?: string }
export interface TimelineRow { turn: number; label: string; cells: TimelineCell[]; live: number; full: number; protected: boolean; system: boolean; folded: boolean }
export function buildTimeline(truth: Truth): TimelineRow[];
```

- One row per `block.turn`; turn 0 with the system block renders as `⛨ system prompt`.
- `label`: first line of the turn's first user block, `clean`ed; a turn whose blocks are all in one
  folded group whose summary parses with `taskKeyOfSummary` shows `▣ task <key> "<title>"`;
  a turn wholly in the protected tail and last shows `tail (protected)`.
- Cell glyph by calibrated full tokens: `▪` < 500, `■` < 5 000, `█` ≥ 5 000; user blocks `U`,
  answer text `A`, thinking `H` (letters, kind-colored); folded blocks dim; blocks of a folded group
  `▣` (group color); bolted `!` suffix on the system cell; the protected-tail boundary `┃` between
  the last unprotected and first protected cell.
- `live`/`full`: calibrated (`calBlockTokens`), per row.
- Columns: turn 4, prompt `clamp(12, 32, width·0.3)`, blocks flexible, live 7, full 7. Below 80
  columns `full` drops; below 57 the prompt column drops to 12; at 36 only turn, blocks, live.
- A row whose cells exceed the blocks column shows a window around the selection with `‹`/`›`.
- Selection: `↑↓` turn (keeps the cell index, clamped), `←→` cell, `pgup/pgdn` page,
  `home/end` first/last turn. The detail strip (2 rows) shows kind letter + kind word, tool name or
  id, tokens, state (`live`/`folded −N%`/`pinned`/`held:<x>`/`protected tail`/`group:<id>`), and
  the first line of text.

Views: `alt+v` cycles timeline → grid → list. Grid = today's `buildContextMap` with these changes:
the `.` filler flag is removed (blank instead), `P` is shown only on the first protected cell, the
cell pitch stays 6. List = today's list with aligned columns
`kind(10) state(14) tokens(8) label(rest)`.

Block keys (all views): the chords of §5.2. Budget and tail are rows in Settings › This session.

### 5.5 Inspector

Header row: `<kind word> · <tool or id> · <tokens> tok · <state>`; body: text or digest (`alt+v`
toggles, the active one named in the description), scroll with `↑↓ pgup pgdn home end`; position in the
rules (`↑ N more` / `↓ N more`). `alt+e` edits the digest of a folded block or group from here.

### 5.6 Conductors

List rows: `›`, `◉`/`◯` attached, label, readiness (`● ready` success / `✗ <reason>` error),
`privacy` badge (`▲ sends content off-machine` warning) when `entry.privacy` and the provider is
not loopback, `locks: …`. Below the list: the selected conductor's `description` wrapped to 3 rows
and its current status when attached. Enter attaches (through `selectConductor`, keeping the
consent gate), the `None` row detaches, `alt+i` opens that conductor's options in Settings (§6.2, section
`Conductor: <label>`).

### 5.7 Help (delivered)

`F1` on any tab: the tab's keys, one per line, then its legend; scrollable; staged edits are kept.

### 5.8 Tasks view

Opened with `alt+t` from Overview or `/accordion tasks open` (new verb). Full-panel rendering of
§4.4's tree with keyboard: `↑↓` move, `enter`/`→` open branch or reveal a hidden run, `←` close
branch, `alt+e` toggles expanded as the widget default for this session. Uses the widget controller's
view state, so changes show in the widget too.

## 6. Area C: settings

### 6.1 Schema (`~/.accordion/config.json`)

All keys, after this change. Types are TypeScript; "env/flag" lists overrides that lock the field.

| Key | Type / default | Section | Editor | Env / flag | Applies |
|---|---|---|---|---|---|
| `autoArm` | `boolean` / `true` | Defaults | toggle | `ACCORDION_AUTO_ARM` | next session start |
| `defaultConductor` | conductor id or `"none"` / `"keel-lite"` | Defaults | picker (registry, readiness shown) | `ACCORDION_DEFAULT_CONDUCTOR` | next session start |
| `modelDefaults.<pattern>.budget` / `.protect` **delivered** | amount string (`"200k"`, `"1M"`, `"85%"`); pattern `provider/model`, `provider/*` or `*` | Budget & tail | list of patterns; add/edit/remove; amounts as in §4.12 | – | on the next resolution (session start, model switch) |
| `compact.manual` **new** | `"pass" \| "aggressive" \| "bake" \| "native"` / `"pass"` | Compaction | picker | – | immediately |
| `compact.threshold` **new** | `"pass" \| "native"` / `"pass"` | Compaction | picker | – | immediately |
| `compact.onSaturated` **new** | `"native" \| "bake" \| "warn"` / `"native"` | Compaction | picker | – | immediately |
| `models.defaults.chat` | spec / unset (= session model) | Models | model picker + `current` | – | immediately |
| `models.defaults.classifier` | spec / unset | Models | model picker | – | immediately |
| `models.conductors.<id>.<type>` | spec | Models › Per conductor | list of overrides; add/remove | – | immediately |
| `privacyConsent.<id>` | ISO timestamp | Privacy | list; `alt+d` revokes | – | immediately (§6.4) |
| `conductorOptions.<id>.<key>` **new** | per declared option | Conductor: `<label>` | per option type | – | re-attach of that conductor on save |
| `taskWidget.mode` | `"auto" \| "off"` / `"auto"` | Task widget | toggle | – | immediately |
| `taskWidget.expanded` | `boolean` / `false` | Task widget | toggle | – | next session start |
| `taskWidget.maxRows` | `1–100` / `12` | Task widget | number | – | immediately |
| `taskWidget.toggleKey` | key id / `"alt+t"` | Task widget | text, validated `^((ctrl\|alt\|shift\|super)\+)*[a-z0-9]$` | – | next Pi start (shortcuts register at load); the row says so |
| `bindHost` | host / `"127.0.0.1"` | Web UI | text | `ACCORDION_HOST`, `--accordion-host` | immediately (door rebind) |
| `doorPort` | `0–65535` / `24317` | Web UI | number, `0` disables | `ACCORDION_DOOR_PORT`, `ACCORDION_PORT`, `--accordion-port` | immediately (door rebind) |
| `customToken` | `string \| null` / `null` | Web UI | text (3–64 `[A-Za-z0-9._~-]`), empty = generated | `ACCORDION_TOKEN`, `--accordion-token` | immediately |

Migration (D7): when `compact` is absent and `compactMode` is present, `loadSettings` maps
`accordion → {manual:"pass", threshold:"pass", onSaturated:"native"}`,
`suppress → {manual:"pass", threshold:"pass", onSaturated:"warn"}`,
`native → {manual:"native", threshold:"native", onSaturated:"native"}`. `saveSettings` writes
`compact` and never `compactMode`. `ACCORDION_COMPACT_MODE` keeps working through the same map
and locks the three fields.

Conductor options are declared in the registry (`core/conductor/registry.ts`):

```ts
export interface ConductorOptionSpec {
  key: string; label: string; description: string;
  type: "fraction" | "number" | "boolean";
  min?: number; max?: number; default: number | boolean;
}
// RegistryEntry gains: options?: readonly ConductorOptionSpec[]; and the factory receives the
// resolved values: inProcess((opts) => new TaskfoldConductor(opts)).
```

v1 declares options for Taskfold only: `high` (fraction 0.5–0.95, 0.8, "Start folding at this
share of the budget"), `low` (fraction 0.3–0.9, 0.6, "Fold until live tokens reach this share";
MUST be < `high`, else the save is rejected with that message), `maxLoss` (number 0–3, 0.3,
"Fold a user message when its predicted loss is below this"), `keepRecentTasks` (number 0–10, 1,
"Newest finished top-level tasks that stay open"; already a `TaskfoldOptions` field, §4.11).

### 6.2 Settings screen

```
 Accordion › Settings                               ~/.accordion/config.json
 Overview  Context  Conductors  [Settings]                        ● 2 unsaved
────────────────────────────────────────────────────────────────────────────────
 THIS SESSION                                                  applies at once
   Folding                       ● armed
   Budget                        372.0k  (model window)                      ›
   Protected tail                20.0k                                       ›
 DEFAULTS · ALL SESSIONS
   Arm on startup                on
 › Default conductor             taskfold *                                  ›
   …
 WEB UI                                                  shared across sessions
   Bind address                  0.0.0.0                   ▲ reachable on LAN
   Access token                  ACCORDION_TOKEN  env · locked
────────────────────────────────────────────────────────────────────────────────
 Conductor attached automatically when a session starts with "Arm on startup".
 ↑↓ move · enter edit · space toggle · ctrl+s save · ctrl+r reload · esc back
```

Sections in order: This session, Defaults · all sessions, Budget & tail (`modelDefaults`), Compaction, Models, Privacy,
Conductor: `<label>` (one per conductor declaring options), Task widget, Web UI.

- Row: label column 20 (16 below 57 columns), value, right-aligned source (`session`, `default`,
  `user`, `▲ staged`). Toggles `[x]`/`[ ]`; cycled values `‹ value ›`. Locked rows show `<ENV or --flag>  env · locked` / `flag · locked` in dim and refuse
  edits with a status message naming the override.
- Description row (dim, 1–2 lines) under the list: the selected row's description from a table in
  `screens/settings.ts`.
- Top-rule state: `▲ N staged` (warning) when dirty; the save result shows in the description line.
- Editors: toggles flip on `enter`; cycled values change with Left/Right; pickers push a searchable `SelectList` screen with one
  description line per option; number/text push a single-line input with inline validation
  (`✗ <reason>` under the input; `enter` refuses invalid input).
- Keys: `ctrl+s` save, `alt+r` reload from disk (discards staged, asks when dirty), `alt+u` stage
  the default for the selected row, `esc` back (asks when dirty, `Keep editing` first).
- Web UI rows: bind address shows `▲ reachable on LAN` (warning) for non-loopback; door port
  shows `door held` / `door held by another session` / `door unavailable`; access token shows
  `generated` or `custom` and `alt+r` on that row regenerates (immediate action, confirms first, not staged).
- Privacy rows: one per consent, `alt+d` revokes (confirm; immediate, not staged).

### 6.3 Store and sync

New module `extension/settingsStore.ts`:

```ts
export interface SettingsSnapshot { settings: AccordionSettings; sources: Record<SettingPath, "default" | "file" | "env" | "flag">; rev: string }
export class SettingsStore {
  constructor(homeDir: string, env: NodeJS.ProcessEnv, flags: () => Partial<Record<SettingPath, string>>);
  current(): SettingsSnapshot;
  /** Apply a patch to the latest file content under the lock; rejects invalid values and stale baseRev. */
  save(patch: SettingsPatch, baseRev: string): { ok: true; snapshot: SettingsSnapshot } | { ok: false; error: string; conflict?: boolean };
  /** Re-read the file; returns the changed paths (empty when unchanged). */
  poll(): SettingPath[];
}
```

- `rev` = SHA-256 of the file bytes (empty string when absent).
- `save`: take the SQLite sidecar mutex `~/.accordion/config.json.lock.sqlite` (`BEGIN IMMEDIATE`,
  retry 25 ms up to 2 s, the same helper shape as `withControllerLeaseLock`; extract a shared
  `withSidecarLock(path, action)` in `extension/accordion.ts`'s scope or a new
  `extension/sidecarLock.ts`, used by both); re-read the file; if its rev ≠ `baseRev` and any
  patched path changed on disk, return `conflict`; else merge the patch into the **file** content
  (not the in-memory copy), validate every patched value (errors name the field and the rule),
  write atomically (tmp + rename, mode 0600), return the new snapshot.
- Validation functions return `{ ok: false, error }` instead of substituting defaults
  (`sanitizeBindHost` etc. keep their load-time leniency; the store uses strict variants).
- `poll` runs inside the existing controller poll tick (~1 s). On change: replace `settings`, apply
  runtime effects (table below), `notifyNative()`, broadcast `settings` (§9).
- Door secret: the same poll compares `~/.accordion/door-secret` content with `doorSecret`; on
  change it adopts it (fixes stale tokens after another instance regenerates).

| Changed path | Runtime effect in every instance |
|---|---|
| `bindHost`, `doorPort` | `closeDoor(); doorForeign = false; tryBindDoor()` (as today, but in all instances) |
| `customToken` | `webToken` = custom or regenerate per session as today |
| `compact.*`, `models.*`, `taskWidget.mode`, `taskWidget.maxRows` | none beyond re-read; next use reads the new value; widget `sync()` |
| `privacyConsent.<id>` removed | if `<id>` is attached and needs consent (`leavesMachine`), detach it and notify "Taskfold detached: privacy consent revoked" |
| `conductorOptions.<id>` | if `<id>` is attached, re-select it (detach + attach) |
| others | none (apply at next session start) |

## 7. Area D: compaction

### 7.1 Entry point

```ts
type CompactTrigger = "manual" | "threshold" | "overflow" | "panel" | "command";
type CompactStrategy = "pass" | "aggressive" | "bake" | "native";
interface CompactRequest { trigger: CompactTrigger; strategy: CompactStrategy; instructions?: string; dryRun?: boolean }
interface CompactRecord {
  id: string; at: number; trigger: CompactTrigger; strategy: CompactStrategy; conductor: string | null;
  before: number; after: number; durationMs: number;
  folded: { blocks: number; groups: number; byKind: Partial<Record<BlockKind, number>> };
  undo: Op[] | null;                    // null for bake/native
  message: string;
}
async function runCompaction(req: CompactRequest): Promise<CompactRecord>;
```

All entry points call it: `session_before_compact` (manual/threshold/overflow), `/accordion compact
[strategy] [instructions…]`, the panel's `c`. `compactNow()` is removed.

### 7.2 Strategies

| Strategy | Behavior |
|---|---|
| `pass` | Arms folding and attaches the default conductor if none (as today). Calls `liveHost.requestPass({ reason: "compact", instructions })` and awaits it (§7.3). If live tokens did not drop, escalates to `aggressive` and records `strategy: "aggressive"` with message "conductor freed nothing; folded all eligible blocks". |
| `aggressive` | Folds every block that is not protected, not folded, not held, not grouped, `wireFoldable`, and whose folded size is smaller (today's fallback), in one `truth.apply(…, "auto")`. |
| `bake` | Only from `session_before_compact`. Runs `aggressive` over the range, then returns `{ compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, estimatedTokensAfter, details: { accordionBake: 1 } } }`. Summary: `buildBakeSummary(truth, preparation.messagesToSummarize, instructions)` (§7.5). |
| `native` | Returns nothing from `session_before_compact` (pi summarizes with `customInstructions`). From the panel/command it calls `ctx.compact({ customInstructions })`. |

Trigger mapping while folding is armed (folding off ⇒ pi always compacts natively, unchanged):

| Trigger | Strategy |
|---|---|
| `/compact [text]` (manual) | `settings.compact.manual`; `bake`/`native` honor the text |
| threshold | `settings.compact.threshold`. With `pass`: cancel when `after ≤ contextWindow − reserveTokens` (from `preparation.settings`), else apply `compact.onSaturated` |
| overflow | `pass`; if still saturated, `compact.onSaturated` (`warn` cancels and notifies error-level "context overflow: Accordion cannot free more; switch /compact to native or bake") |
| panel `alt+c` / `/accordion compact` | dry-run preview (§7.6), then the chosen strategy |

### 7.3 Waiting for the conductor

`LiveHost` gains `requestPass(opts): Promise<"settled" | "timeout" | "no-conductor">`:

- In-process: fire `{ type: "turn-committed", turn, rev, reason: "compact", instructions }` and
  await `Promise.allSettled` of the listeners' returned promises (today's `fire` drops them), max
  10 s.
- Remote: send `turnCommitted` with the same optional fields; resolve when a `propose` from that
  conductor has been applied **and** 300 ms passed without another, or on `setConductorStatus`,
  or after 10 s.
- `HostEvent` `turn-committed` gains optional `reason?: "turn" | "compact"` and
  `instructions?: string` (additive; conductors that ignore them keep working).

### 7.4 Undo

`runCompaction` records, for `pass`/`aggressive`, the inverse ops: `unfold` for every block id it
folded, `ungroup` for every group it created. `/accordion compact undo` (and `alt+u` on the result card
row in the panel's Overview) applies them with actor `"you"` (sticky open, so the conductor does not
immediately refold) if `truth.rev` lineage still contains them; ids no longer folded are skipped and
reported. Only the latest record is undoable; a session switch clears it.

### 7.5 Bake summary

```
[accordion-bake v1] <N> messages · <before> → <after> tok
instructions: <customInstructions, if any>
── turn 3 · user
<user text verbatim when Taskfold kept it, else its digest>
── task demo/1 "Survey" done
<Taskfold record without its {#code FOLDED} tag>
── turn 4 · results
<digest lines, one per folded block>
```

Rules: fold codes are stripped (`stripFoldTags`) because baked blocks can no longer be recalled;
groups appear once at their first member; unfolded non-user blocks in the range are forced to their
digests; the summary is capped at `min(20 000, 0.1 · contextWindow)` tokens by dropping the oldest
turn sections first and adding `… <k> earlier turns omitted`. After pi saves it, the existing
`session_compact` handler rebuilds the Truth (unchanged).

### 7.6 Preview and result card

Panel `alt+c` opens a confirm screen:

```
 Accordion › Overview › Compact
   › pass         Taskfold decides                       ≈ −18.4k (last epoch)
     aggressive   fold every eligible block             −62.7k → 42.4k
     bake         permanent summary, no recall           ≈ 9.8k summary
     native       pi summarizes (model call)             unknown
   instructions:  (type to add, optional)
 enter run · ↑↓ strategy · esc cancel
```

Projections: `aggressive` exact from `truth.foldedTokensOf`; `bake` from `buildBakeSummary(...,
dryRun)` token count; `pass` from the conductor's last `saved` status metric when it reports one,
else "conductor decides"; `native` "unknown". Taskfold's epoch status gains the metric
`saved: <tokens>` (today it reports `epochs`, `groups`, `live_tokens`, `budget`, optional `level`).

Every completed `runCompaction` appends a custom **entry** (not a message, so it never reaches the
model): `pi.appendEntry("accordion.compact", record)` with an entry renderer
(`registerEntryRenderer`):

```
 ✓ accordion compact · pass (taskfold) · 1.4s
   before ███████████████████░░░░░░░  105.1k
   after  ██████████░░░░░░░░░░░░░░░░   62.4k   −42.7k (41%)
   folded 3 task spans · 12 tool results · 2 user messages
   /accordion compact undo · /accordion to inspect
```

Threshold passes that cancel quietly append no entry; they update the footer status only.

## 8. Area E: footer status

`footerText` (`extension/tui/status.ts`) becomes segments fitted to 24 columns:
`acc <usage%> · <conductor id> <level glyph>`, e.g. `acc 28% · taskfold ✓`,
`acc off`, `acc 81% · taskfold ▲`. The status text moves to the Overview; the one-shot
`AlertGate` notification is unchanged.

## 9. Area F: web app and protocol v23

`PROTOCOL_VERSION` 22 → 23. Additions (all additive; a v22 client ignores them):

```ts
// ServerMessage
| { type: "settings"; snapshot: SettingsSnapshot }                 // on hello and on every change
| { type: "tasks"; list: TaskList | null; folded: string[]; tokens: { full: number; live: number } | null }
| { type: "compaction"; record: CompactRecord }
// WireCommand
| { kind: "updateSettings"; patch: SettingsPatch; baseRev: string }   // controller only
| { kind: "compact"; strategy: CompactStrategy; instructions?: string; dryRun?: boolean }
| { kind: "undoCompact" }
// CommandResult gains optional: error?: string; conflict?: boolean; compaction?: CompactRecord
```

Web surfaces (`app/src/lib/ui/…`):

| Surface | Change |
|---|---|
| `SettingsPanel.svelte` | adds a "Session host" section driven by `settings` messages: same sections, fields, locks and staging as §6.2 (Save button = `ctrl+s`); local display preferences (`foldDisplayMode`) stay in localStorage under "Display". Read-only clients see values without editors. |
| new `ui/live/TasksPanel.svelte` | tree of §4.4 (same glyphs, colors via CSS tokens, click to toggle), collapsed summary in `MapHeader.svelte` |
| `MapHeader.svelte` | Overview numbers of §5.3 (saved, pressure, conductor status) |
| new `ui/live/CompactDialog.svelte` | §7.6 preview and run; `compaction` records shown as a toast via `notice.svelte.ts` styling with an Undo action |
| `lib/live/liveClient.svelte.ts` | handle `settings`, `tasks`, `compaction`; send the new commands |

The `tasks` message is broadcast on the same triggers as the widget reload (§4.2) and on Truth
changes that alter `folded`/`tokens` (debounced 250 ms).

## 10. Verification

Each area MUST pass, in the worktree, before it merges:

- `bun test extension/settings.test.ts extension/tasks.test.ts extension/tui/ conductors/in-process/taskfold/`
- `npm --prefix extension run smoke`
- `npm --prefix app run check` and `npm --prefix app test` (Areas F and any shared type change)
- New pure modules have unit tests: `timeline.ts`, `chrome.ts` (`fitHints` drops by priority),
  `settingsStore.ts` (merge-under-lock, conflict, migration, strict validation), compaction
  (`aggressive` set, undo inverse, bake summary cap and tag stripping), `requestPass` (in-process
  awaits, timeout).
- Live PiG capture at 36/57/80/140 columns and 16 rows of every screen, using
  `~/.pig/agent/skills/extending-pig/scripts/tui-capture.sh` or tmux, with an isolated
  `ACCORDION_HOME` and `doorPort: 0`; captures go to the plan's `evidence/`.
- Two-instance sync check: two PiG sessions on one `ACCORDION_HOME`; save in one; the other's
  panel shows the new value within 2 s; concurrent saves of different fields both persist;
  concurrent saves of the same field report a conflict in the second.

## 11. Open items

0. Env- and flag-locked settings are not marked in the panel until the settings store (§6.3) exists.

1. PiG click routing to extension widgets and self-rendered tool rows (§4.6): report upstream to
   PiG; until then §5.8 is the keyboard path.
2. Pre-existing type errors (`agedSummaryConductor.ts` TS2612, `accordion.ts` execute return types
   of `unfold`/`recall`) are unrelated and stay out of this work.
