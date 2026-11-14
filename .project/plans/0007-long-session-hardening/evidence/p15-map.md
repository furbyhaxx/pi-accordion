# P15 map: task tooling (U7–U13, U16, SPEC-0002 code gaps)

Read-only investigation of the main checkout (`/mnt/Projects/furbyhaxx/pi-accordion`, `feat/pi-native`).
No files changed, no tests, builds or `git` commands run. Every line number is from the working tree
as of 2026-11-14; where the plan or the analyses cite older numbers, the symbol is named too.

Evidence sources: root `AGENTS.md`, `.project/specs/0001-accordion-ui-polish.md` (§4.15),
`.project/specs/0002-taskfold-tree.md` (§3.4, §4.6, §5.3, §6.1, §7.3, §10, §12),
`.project/analyses/long-session-challenge/README.md` (U7–U13, U16, S2),
`evidence/ReviewLongSessionUse.md` (items 7–13), `evidence/Spec0002Audit.md`.

Note on the reviewer text: `ReviewLongSessionUse.md` numbers its findings 1–13 and they map
one-to-one onto README U1–U13. Item 7 = U7 … item 13 = U13. **U16 has no reviewer proposal**
(only the README row: "`complete` on a blocked task is refused; the agent must resume first").

Test runners: `extension/**` tests are `bun:test`; `core/**` and `conductors/**` tests are
`vitest` (run through `npx --prefix app vitest run --root app ../<path>`). The gate for the
eventual units is `/mnt/Projects/furbyhaxx/pi-accordion/.pi/gate/gate.sh <worktree>`.

---

## Groups (files a change would write)

| Group | Files | Findings |
|---|---|---|
| A | `extension/taskCoach.ts` | U8, U9 |
| B | `extension/taskBinding.ts`, `extension/tasks.ts` | U7, U16, `stale` in `status` (half) |
| C | `extension/tui/taskWidget.ts`, `extension/tui/taskTree.ts` | U10, `stale` in the widget, widget text gaps |
| D | `extension/tui/taskViews.ts`, `extension/tui/taskTranscript.ts` | U11, task views half of `stale`/stable-code display |
| E | `extension/accordion.ts` (fact extraction), `core/factLedger.ts` | U12 |
| F | `extension/tui/transcriptDump.ts` | U13 |
| — | outside the six groups | stable `t:` code (`conductors/in-process/taskfold/taskfold.ts`), `tasks.zombieSteps` (`extension/settings.ts`, `settingsValidation.ts`, `tui/screens/settingsRows.ts`, `accordion.ts`, `taskfold.ts`), dropped routing logging (`extension/taskRouting.ts`, `taskfold.ts`, `accordion.ts`) |

Cross-group summary:

- **`stale` (SPEC-0002 §5.3)** spans B (`statusOf` result field), C (`TaskWidgetModel`/row), D
  (list view row, optional), and outside the groups (`taskfold.ts` scan/`ZOMBIE_STEPS`,
  `accordion.ts` result assembly and widget model wiring, `settings.ts` for
  `tasks.zombieSteps`). One unit cannot be cut by files; it is a plumbing finding.
- **Stable `t:` fold code** writes only `conductors/in-process/taskfold/taskfold.ts` (plus its
  Vitest file). It is outside every group and inside P13's file, so it must be sequenced or
  landed with P13 to avoid a conflict.
- **Dropped routing operations logged** writes `extension/taskRouting.ts` (pure, not in a group),
  `conductors/in-process/taskfold/taskfold.ts` (`routeOne`) and `extension/accordion.ts`
  (`deps`); `taskRouting.ts` is otherwise untouched by P15.
- **Widget text** writes only group C.
- **U16** writes group B (`tasks.ts` guard + tests) and also the tool description in
  `accordion.ts` (4609–4628), SPEC-0001 §4.15 (424–429) and root `AGENTS.md:16`
  ("Task end states are a contract shared by … Change them together") → shared files.

---

## A. `extension/taskCoach.ts` — U8, U9

### U8 — one-shot missing-list / missing-leaf coaching; gate fails open for the rest of the run

**Functions**

- `userPrompt(): void` — `extension/taskCoach.ts:147-154`. Resets the run state:
  ```ts
  this.calls = 0;
  this.refusals = 0;
  this.opened = false;
  this.remindedNoList = false;
  this.remindedNoLeaf = false;
  ```
- `toolResult(nested: boolean, chars = 0): string | null` — `:257-282`. The once-per-prompt
  reminders:
  ```ts
  if (!list) {
      if (this.remindedNoList) return null;
      this.remindedNoList = true;
      return noListReminder(this.calls);
  }
  const pick = nextTask(list, this.policy.stopOnBlock);
  if (!pick || this.remindedNoLeaf) return null;
  this.remindedNoLeaf = true;
  ```
  (the no-leaf text is the inline template at `:281`). Both flags are cleared only by the next
  user prompt, so after the orientation allowance a single emission is the last one for the run.
- `callStarted(nested: boolean): CallDecision` — `:167-181` (gate):
  ```ts
  if (this.calls <= policy.orientationCalls || nested || this.opened) return {};
  if (this.refusals >= policy.gateFailOpenAfter) {
      this.opened = true;
      return { opened: true };
  }
  this.refusals++;
  return { refuse: list ? noLeafRefusal(list, this.calls) : noListRefusal(this.calls) };
  ```
  `opened` is cleared only in `userPrompt()`, so the gate stays open for the remainder of that run.

**Callers / consumers.** `extension/accordion.ts`: `tool_call` hook `:3495-3510`
(`taskCoach.callStarted(...)`; `decision.refuse` becomes `{ block: true, reason }` and
`decision.opened` a `ctx.ui.notify` + `broadcast notice` at `:3504-3508`), `tool_result` hook
`:3513-3529` (the returned note is **appended to the tool result content**, `:3527-3528`), and
`before_agent_start` `:3598` (`taskCoach.userPrompt()`). `setPolicy` is called on every hook from
`coachPolicy()` (`:3614-3627`). The notes are agent-facing text only; no file or widget.

**Tests** (`extension/taskCoach.test.ts`, bun:test, local `list()` / `t()` helpers):
- `"reminds once after the orientation allowance, naming the next task"` (`:9`)
- `"a new user prompt restores the allowance and the reminder"` (`:17`)
- `"reminds once about work that belongs to no list at all"` (`:27`)
- gate `"refuses with the exact repair once the allowance is spent"` (`:109`)
- gate `"opens for the rest of the run after repeated refusals, and a prompt closes it"` (`:130`)
- `extension/smoke-context.mjs:466-475` exercises the gate/refusal path.
No test pins "how many calls later a second reminder may come", which is exactly what the finding
asks to add.

**Settings / constants.** `DEFAULT_ORIENTATION_CALLS = 10` (`taskCoach.ts:14`);
`CoachPolicy` (`:27-37`); `tasks.orientationCalls` default 10 (`settings.ts:61,153`; value rule
`settingsValidation.ts:51`; Settings row `tui/screens/settingsRows.ts:84`; documented SPEC-0002
§12:1024); `tasks.gateFailOpenAfter` default 3 (`settings.ts:63,154`; validation
`settingsValidation.ts:52`; row `settingsRows.ts:85`; SPEC-0002 §12:1025);
`tasks.enforce` `coach|gate|off` (`settings.ts:59,152`; SPEC-0002 §12:1023). Gate/open text also
names `tasks.enforce off` (`taskCoach.ts:304`).

**Smallest change points.** Add a bounded recurrence counter (work increments since the last
emission) next to `calls`/`remindedNo*`, replace the `remindedNoList`/`remindedNoLeaf` booleans
with "last emitted at count" comparisons, and shorten the escalation text (`noListReminder`
`:298-300`, the inline leaf text `:281`). Gate: replace the permanent `opened` with a "reopen
every N refusals / M work increments" rule and keep the one-time UI notice in
`accordion.ts:3504-3508` truthful (it currently says "for the rest of this run").
**Obstacles.** The emitted text is appended to a tool result, so every extra emission is new
wire content (U1's accounting gap applies). `started()` (`:157-161`) resets `calls`; a recurrence
counter must not reset there. `remindedNoLeaf` is also gated on `nextTask()` returning non-null,
so a recurrence must handle "nothing to name" without repeating. `gateFailOpenAfter` is part of
the documented contract (SPEC-0002 §12 and its `validateSetting` rule), so a semantic change
needs a spec sentence in §12 or §3.4.

### U9 — gate mode suppresses span-size and floor notes; coach mode repeats the large-leaf text

**Functions**

- `toolResult(nested, chars)` — `:257-258`:
  ```ts
  if (this.policy.enforce !== "coach") return this.countOnly(chars);
  ```
  In `gate` and `off` the method returns before `this.floorNote = null` (`:259-260`) and before
  `largeLeafNote` (`:266`), so neither a pressure-fold note nor a large-leaf tap ever reaches the
  agent; a pending `floorNote` stays set until some later coach-mode call consumes it.
- `largeLeafNote(list, current): string | null` — `:197-214`. First tap when `over` and no
  recorded tap; then repeats every `tap.repeatEvery` tool results with no cap (`:209-212`).
- `floorTap(spans)` — `:235-241` and `floorFoldNote` (`taskBinding.ts:191-196`).

**Callers / consumers.** `tool_result` hook `accordion.ts:3527-3528` (text appended to the
result). `floorTap` is driven from the conductor's broadcast status metrics:
`const floorSpans = status?.metrics?.floor_spans; if (...) taskCoach.floorTap(floorSpans.split(","))`
(`accordion.ts:1040-1041`), which runs on the footer/broadcast path, not on the hook.

**Tests.** `extension/taskCoach.test.ts`: `"taps once the result count is reached, then only after
the repeat interval"` (`:163`), `"taps on the budget share of accumulated content, not only on
result count"` (`:173`), `"stays quiet for a leaf with no ceiling, and inside a nested call's own
result"` (`:182`), `"names the current leaf only when a pressure fold touched its span"` (`:194`);
gate `"stays silent inside a task and in coach or off mode"` (`:141`) pins today's suppression and
would have to change.

**Settings / constants.** `tasks.largeLeaf {budgetShare: 0.15, toolResults: 25, repeatEvery: 10}`
(`settings.ts:71,158`; sanitize `settings.ts:317-321`; value rules `settingsValidation.ts:56-58`;
documented SPEC-0002 §12:1029). `TEXT_WORK_CHARS = 40` (`taskCoach.ts:110`).

**Smallest change points.** Split the early return into "count work in every mode" +
"choose notes by mode": in `gate`, emit short state-change notes for a fold that touched the
current leaf and for a leaf crossing the threshold (never the full reminder prose); in `coach`,
cap the large-leaf repeat by a state change or a larger interval instead of `repeatEvery` forever.
Text builders `largeLeafReminder` / `floorFoldNote` (`taskBinding.ts:173-196`) need concise
variants. Tests to update: the gate silence test plus the repeat tests.
**Obstacles.** A refused call in gate mode has no tool result to ride on (the note must be
attached to the next allowed result). `floorTap` arrives from a status broadcast, so ordering is
not deterministic; the note must be idempotent per fold. `repeatEvery` is a documented setting
(SPEC-0002 §12), so "forever" cannot simply be replaced by a constant without a spec sentence.

---

## B. `extension/taskBinding.ts` + `extension/tasks.ts` — U7, U16 (+ `stale` in `status`)

### U7 — a changed resume sends the whole task tree

**Functions**

- `agentNotice(situation: ResumeSituation, outcome: AttachOutcome): string | null` —
  `extension/taskBinding.ts:105-119`. Today a changed reclaim and every replaced attachment embed
  the full list outline:
  ```ts
  if (outcome.kind === "reclaimed") {
      if (outcome.list.slug !== slug) return attachedNotice(outcome);
      return changed ? `Task list "${slug}" is attached to this session again, but its tasks changed since you last used it. Current state:\n${renderList(outcome.list)}` : null;
  }
  ```
- `attachedNotice(outcome: AttachOutcome): string` — `:122-132`:
  ``return `The user attached task list "${outcome.list.slug}" to this session. Current state:\n${renderList(outcome.list)}`;``
  (line 126; `created`/`without` variants carry no tree).
- `changedSince(prev, list)` — `:72-76` + `taskFingerprint(list)` (`tasks.ts:1024-1028`) decide the
  `changed` flag; `resumeSituation` `:83-87`.
- `renderList(list: TaskList): string` — `extension/tasks.ts:1039-1047`. One line **per task,
  finished included**, plus goals:
  ```ts
  const lines = [`${list.slug} — ${list.title}${list.claim ? `  (claimed ${list.claim.at})` : ""}`, ...(list.goals?.length ? ... )];
  for (const t of list.tasks) {
      const b = currentBlock(t);
      const note = b ? `  (blocked: ${blockLabel(b)} — ${b.detail})` : t.supersededBy ? `  (superseded by ${t.supersededBy})` : "";
      lines.push(`${"  ".repeat(t.id.split(".").length)}${MARK[t.status]} ${t.id} ${t.title}${note}`);
  }
  ```
  (`MARK` at `tasks.ts:996`: `[ ] [~] [=] [x] [!] [-]`).

**Callers / consumers.** `extension/taskSession.ts`: `settle()` `:97-103` pushes
`agentNotice(...)`; `noticingHost()` `:169-191` pushes `attachedNotice(...)` on attach/create
(`:176`, `:187`, plus `releasedNotice` `:182`). Notices are drained by `takeNotice()`
(`taskSession.ts:278-294`) and delivered as **agent-facing text** by
`pi.on("before_agent_start")` → `{ message: { customType: NOTICE_MESSAGE, content } }`
(`accordion.ts:3596-3607`) or as a steer message in `flushTaskNotices`
(`accordion.ts:3583-3592`). Nothing reads the note elsewhere. `renderList` has exactly one
consumer, `taskBinding.ts` (`:8`, `:110`, `:126`) — it is not used by the `tasks` tool.

**Tests.** `extension/taskBinding.test.ts` (bun:test; temp dirs, `call()` entry builder):
`"a list another session took over and changed is reported with its holder"` (`:52`; asserts
`reclaimed` contains `"changed since you last used it"` and `"[~] 1 One"` — the `renderList`
output, `:63-65`), `"a resumed list that no longer exists is reported with its replacement"`
(`:83`). `extension/taskSession.test.ts` (bun:test; `setup()` helper):
`"resuming offers the previous list; reclaiming a changed list tells the agent its state"` (`:121`),
`"a list held elsewhere: choosing another list tells the agent who holds the old one"` (`:144`),
`"a reload silently reclaims a free, unchanged list and tells the agent nothing"` (`:111`).
Note `:111` and `:174` already pin the unchanged-resume silence the reviewer relies on.

**Settings / constants.** None. `OWN_WRITE_SLACK_MS = 2000` (`taskBinding.ts:32`).
Notice contract: SPEC-0002 §4.4 (the audit's §4.4 row cites the 20-task cap in
`extension/taskNotices.ts:88-115`) and root `AGENTS.md:17`.

**Smallest change points.** One new bounded renderer (e.g. `renderOrientation(list)`: counts,
the `doing` branch, blocked rows with reasons, `next`, and the ids that changed since the last
seen fingerprint) and switch the two `renderList` call sites to it; `changedSince` already knows
the fingerprint but not *which* tasks changed — a diff needs the previous list, which
`ResumeSituation` does not carry (only `prev.fingerprint`). Either extend `previousBinding` to
store a compact per-task digest, or compare against `TaskSession.seen` (the session only has it
in memory, `taskSession.ts:238-244`). `renderList` itself can stay for other uses (it has none).
**Obstacles.** The note is the agent's only view of a list it did not attach; dropping detail must
not lose (a) blocked reasons, (b) goals, (c) the next startable id — `nextTask`/`nextTaskOf`
(`taskCoach.ts:61-80`, `tasks.ts:1175-1191`) already compute the last one. Tests assert exact
strings (`taskBinding.test.ts:60-65`, `:83-85`), so wording changes break them by design.
`renderList` also prints `(superseded by …)` and `blocked` notes that the agent needs.
A second consumer risk: `taskNotices.ts` caps *its* entries (`within` uncapped per
`Spec0002Audit.md` §4.4) — a longer/bounded orientation note shares the same delivery channel.

### U16 — `complete` on a blocked task is refused

**Function.** `TaskStore.finish(slug, id, status, report, supersededBy?)` —
`extension/tasks.ts:877-931`. The guard is `:887-891`:
```ts
if (status === "abandoned" ? FINISHED.has(task.status) : task.status !== "doing") {
    if (task.status === "blocked") throw new TaskError("invalid_transition", `Task ${id} is blocked. Resume it with start before you ${verb} it, or abandon it.`);
    if (task.status === "todo") throw new TaskError("invalid_transition", `Task ${id} was never started. Start it first, or abandon it with a report if it is no longer needed.`);
    throw new TaskError("invalid_transition", `Task ${id} is ${task.status}, not in progress. Check "status".`);
}
```
For `complete` on a blocked task the agent sees exactly
`Task <id> is blocked. Resume it with start before you complete it, or abandon it.`
(`verb = "complete"`, `:886`; `TaskError.toResult` makes it `{"ok":false,"error":"invalid_transition","message":"…"}`,
`tasks.ts:105-117`). Only `abandon` is accepted from `blocked` today.

**Spec sentence that decides it.**
`.project/specs/0001-accordion-ui-polish.md` §4.15 "Task end states (delivered)", table
`:424-429`:
> `| done | the goal was reached | yes | complete (only from doing) |`
> `| blocked | cannot continue because of something outside the agent's control; resumes with start | no | block (only from doing) |`

So the refusal follows the spec as written; allowing `complete` from `blocked` is a **spec
change**, not a bug fix. Companion text: SPEC-0002 §3.4/§3.5 (`:416-452`) does not mention the
blocked case; the `tasks` tool description says
`"Lifecycle: todo → start → doing → complete (done) | fail (failed) | abandon (abandoned); doing → block (blocked) → start again to resume."`
(`accordion.ts:4611`) and `"complete and fail are refused when nothing ran inside the task since its start."`
(`accordion.ts:4616`). Root `AGENTS.md:16` lists the end states as a contract shared by store,
tool description, Taskfold's span scan and the views. The skill
`extension/skills/accordion-task-lists/references/examples.md:625-629` tells the agent to
"resume after the answer", it does not say whether `complete` may follow a block.

**Smallest change points.** Relax `finish()` for `status === "done"` (and `"failed"` if the unit
says so) from `blocked`, closing the open block (`blocks[last].resumedAt`, as `abandon()` does at
`tasks.ts:975-982`) so `taskDuration`/`taskBlockLabel` stay coherent; update the tool description
(`accordion.ts:4611,4616`), SPEC-0001 §4.15 `:426,429`, `AGENTS.md:16`, and the regression test.
**Obstacles.** The same guard is the only thing that stops `complete` from `todo` (a separate,
intended refusal) — the branch must stay. `start` from `blocked` currently records `resumedAt`
and returns `resumed`; a direct `complete` skips that, so the block history needs an explicit
close and the interval rules in SPEC-0002 §5.2 (`:654-664`) still say "`block` closes at the last
block before the next user message … `complete`/`fail`/`abandon` closes at the finishing result".
Test that pins the refusal today: `extension/tasks.test.ts:287`
`expect(() => runTasks(s, { action: "complete", list: "w", id: "1.1", report })).toThrow(/is blocked. Resume it with start/);`
inside `"a blocked task freezes the agent under stopOnBlock: false, keeps its reason and resumes with start"` (`:271`).
Also `"block details accept up to 1024 characters…"` (`:260`) covers block reporting.

---

## C. `extension/tui/taskWidget.ts` + `extension/tui/taskTree.ts` — U10, `stale`, widget text

### U10 — revealing hidden rows bypasses the row budget

**Functions**

- `applyTaskWidgetHit(view: TaskWidgetView, hit: TaskWidgetHit): boolean` —
  `extension/tui/taskWidget.ts:220-226`:
  ```ts
  else for (const id of hit.ids) view.revealed.add(id);
  ```
  A click on one `{ kind: "reveal", ids: row.ids }` hit (`renderTaskWidget` `:210`) adds **every**
  id the hidden row represents; `TaskWidgetView.revealed` (`:39`) is never pruned, only rebuilt by
  `TaskWidgetController.freshView()` (`:380-384`) on attach/session start.
- `layoutTaskTree(roots, options)` — `extension/tui/taskTree.ts:204-248`. Revealed ids are exempt
  from the budget twice:
  ```ts
  visible: siblings.map((s) => path.has(s) || revealed.has(s.task.id))   // :218
  ...
  level.visible[i] = true;
  if (rows().length > options.maxRows) level.visible[i] = false;         // :243 (non-revealed only)
  ```
  Hidden rows are produced by `render()` (`:250-295`), rendering `count`/`finished`/`durationMs`/
  `folded` (`:268-277`); the widget renders them in `hiddenRowLine` (`taskWidget.ts:175-180`).

**Callers / consumers.** `TaskWidgetComponent.render` (`taskWidget.ts:305-316`) and
`handleMouse` (`:318-325`) — the widget above the editor; output is terminal lines. The panel's
Tasks/Lists tabs do **not** use `revealed` (only `TaskViews`' own tree state), so this bug is
widget-only.

**Tests.** `extension/tui/taskWidget.test.ts` (bun:test; helpers `task()`, `list()`, `secrets()`,
`view()`, `plain` theme, `NOW`, `shape()`): `"honours a revealed hidden run and a closed branch"`
(`:83-89`, passes `revealed: new Set(["4","5","6"])` and asserts every id is laid out) and
`"expanded draws glyphs and fits every width; clicks toggle and reveal"` (`:114-130`). Both pin
today's unbounded reveal. `panel.test.ts` renders the widget indirectly through the Tasks tab
(`"tasks: alt+e flips the widget's expanded default and says so"`, `:618`).

**Settings / constants.** `taskWidget.maxRows` default 12 (`settings.ts:147`; sanitize
`settings.ts:275-286`; value rule `settingsValidation.ts:42`; Settings row
`settingsRows.ts:75`; applied live in `TaskWidgetController.sync` `taskWidget.ts:413`).
SPEC-0001 §4.3–4.4 + SPEC-0002 §10.2 (`:919-947`) define the row budget and hidden-row wording.

**Smallest change points.** Bound the reveal inside `applyTaskWidgetHit` (cap the ids added to
`view.maxRows` — available on the view — and rotate/drop older reveals on the next render) or
replace the `reveal` hit with "open the Tasks panel at that subtree". Both are inside
`taskWidget.ts`; `taskTree.ts` only changes if a page/offset concept is added to
`TaskLayoutOptions`.
**Obstacles.** The widget has no scrolling; a bounded reveal must be stable between renders (the
view is long-lived and the model is cached by `taskWidget.ts:512-522`). `layoutTaskTree` also uses
`revealed` to keep a branch visible, and the `"honours a revealed hidden run"` test asserts all
three ids appear — a cap changes that test deliberately. The hidden row aggregates ids of
siblings *and* their subtasks (`count(item)`), so "first N ids" is not necessarily "first N rows".

### Widget text (SPEC-0002 §10 vs code) — group C

Decisive code:

- Header: `headerLine` `taskWidget.ts:66-84`
  ```ts
  sum.folded ? theme.fg("muted", ` (≡${sum.folded})`) : "",            // :74  (spec: " · ≡7")
  model.tokens ? `${sep}${theme.fg("muted", `${formatCompactTokens(model.tokens.full)} → ${formatCompactTokens(model.tokens.live)} tok`)}` : "", // :76
  ```
- Rows: `taskRowLine` `:155-173` — fold column `≡`/`·`/`!` (`:159`), token pair `full → live`
  with spaces from `arrow()` (`:129`), whole progress marker painted `muted` (`:167-171`).
- Hidden rows: `hiddenRowLine` `:175-180` → `… N finished · duration (k≡ · full→live)`.
- Legend: `:204` `"  ≡ folded · raw ! inconsistent · ▣ done ☒ failed ⊘ abandoned ◐ partly done ▶ doing ⧗ blocked ☐ todo"`.

Spec lines: §10.1 header `:914` (`… <done>/<total> · ≡<folded> · <duration> · <full> → <live> tok`),
§10.2 example rows and rules `:921-947` (row token pair `21.7k→52`, hidden row
`… 7 finished (6≡ · 320.0k→1.1k) · 5h 43m`, progress colours `success`/`error`/`dim`/`dim`).

Which side changes (per the audit's own verdicts in `Spec0002Audit.md:47-53`):
| Gap | Spec line | Audit verdict |
|---|---|---|
| Header ` (≡N)` and no `·` before it | §10.1:914 | **one side must change**; §10.2's example row uses `≡7`, so the **code** is the odd one |
| Row token pair `21.7k → 52` vs `21.7k→52` | §10.2:923 | same row; code |
| Hidden row order `… N finished · duration (…)` | §10.2:926 | **spec** ("order swapped" → code stays) |
| Progress painted one colour | §10.2:946-947 | **spec** |
| Legend wording | §10.2 and `TASK_LEGEND` (`taskViews.ts:389-397`) | **spec** (three wordings today: spec, widget, panel legend) |

**Tests pinning the text.** `taskWidget.test.ts` `"collapsed shows the summary and the running
task"` (`:92`, exact `"▲ Tasks Secrets 6/20 (≡4) · 6m 21s · 26.7k → 10.1k tok"`), `"fits long list
titles…"` (`:97`, widths 36/57/80/140), `"folded rows show their tokens…"` (`:141`), `"shows a
width-fitted legend without assigning it a click action"` (`:158`, expects `"≡ folded · raw"`),
`"draws each end state apart…"` (`:171`). `taskViews.test.ts` `"explains the glyphs in the help
legend"` (`:252`, `"finished but raw"`). Changing §10.1 wording deliberately breaks `:92`.
**Obstacle.** Header order interacts with `fitSegments`/`fitRow` width fitting (`taskWidget.ts:80-98`)
and with the sweep in `panel.test.ts:661-689` (every line fits at 36/57/80/140, fixed height).

### `stale` in the widget — crosses B, C, D (see the SPEC-0002 gap section)

`TaskWidgetModel` has no stale field (`taskWidget.ts:25-32`: `list`, `folded`, `foldTokens`,
`tokens`); `TaskWidgetController.model()` (`:512-522`) builds it from the list file + Truth only.
`taskRowLine` has no marker for it. The Taskfold status text is the only stale report today
(`taskfold.ts:816`).

---

## D. `extension/tui/taskViews.ts` + `extension/tui/taskTranscript.ts` — U11

### U11 — task-tree construction rebuilt per render and per key

**Functions**

- `TaskViews.ensure(): void` — `extension/tui/taskViews.ts:430-463`. Caches the `TranscriptSource`
  plus `transcriptSpans(src)` by Truth identity/rev/folding and clears `foldCache`/`recordCache`
  when lists change:
  ```ts
  const changed = !truth || this.cache?.truth !== truth || this.cache.rev !== truth.rev || this.cache.folding !== folding;
  ...
  const src = transcriptSource(truth, (id) => this.host.verdict(id), this.host.threshold(), { folding, lists, listIssues: this.invalidLists });
  this.cache = { truth, rev: truth.rev, folding, data: { src, spans: transcriptSpans(src) } };
  ```
- `TaskViews.nodes(s, data)` — `:475-487` builds nodes from scratch every call:
  `listNodes(...)` (cached folds but rebuilt tree), `transcriptNodes(spanTranscript(...))`,
  `transcriptNodes(sessionTranscript(data.src))`.
- `TaskViews.view()` — `:524-561`; `const nodes = this.nodes(s, data);` (`:555`) and
  `s.tree.render(nodes, width, rows, …)` (`:556`).
- `TaskViews.route()` — `:654-686`; every key rebuilds for the cursor:
  `tree.rows(this.nodes(s, this.data()));` (`:675`).
- `sessionTranscript(src)` — `extension/tui/taskTranscript.ts:258-291`. `transcriptSpans(src)`
  (`:143-145` → `scanTaskSpans(src.blocks, …)`), `taskForest` (`:215-226`, sorts), then
  `taskNode` per task (`:232-252`) which loops `for (let i = span.start; i <= span.end; i++)`
  and calls `spanTokens(ix.src, span)`.
- `spanTokens(src, span)` — `:294-299`: builds an id set by filtering all blocks, then scans all
  projections and all blocks again:
  ```ts
  const ids = new Set(spanBlocks(src, span).map((b) => b.id));
  for (const p of src.projection) if (p.groupId && taskKeyOfSummary(...) === span.key) for (const b of p.members) ids.add(b.id);
  return blockTokens(src.blocks.filter((b) => ids.has(b.id)));
  ```
- `index(src)` `:178-186` (two maps over all blocks/groups), `spanTranscript` `:339-392`
  (recomputes `index` + `transcriptSpans` + `taskForest` per open span).

**Callers / consumers.** Panel shell `extension/tui/screens/tasks.ts:17-18` constructs
`new TaskViews(...)` for the Tasks and Lists tabs; `panel.test.ts` drives it. Output is terminal
lines only; nothing persisted.

**Tests.** `extension/tui/taskViews.test.ts` (bun:test; helpers `blocks()`, `truthOf()`, `data()`,
`open()`, `flattenTree()`, `alt()`/`ESC`/`ENTER`): `"renders cached snapshots and rebuilds them
once per change"` (`:177-198`, counts `projections`/`reads` — the only existing cache assertion),
`"does not reuse a different session's transcript at the same revision"` (`:200`), `"keeps every
screen's body inside the rows it was given"` (`:216`), `"shows subtask progress, time and folds in
the list tree"` (`:97`), `"lists plan time, wait, run, report and the recorded facts in the
details"` (`:123`), `"distinguishes stored records from outgoing text while folding is paused"`
(`:240`). `extension/tui/taskTranscript.test.ts` (bun:test; `Log` helper):
`"nests subtasks under auto-started parents and keeps work outside tasks as untracked runs"`
(`:78`), `"keeps paused siblings and untracked gaps outside the resumed task"` (`:97`),
`"shows a span as start, folds with their members, kept user messages and finish"` (`:122`).
`panel.test.ts` `"task tabs: printable keys never act, every line fits, the height stays fixed"`
(`:661`).

**Settings / constants.** None (`rows` comes from the frame; `maxRows` is the widget's).

**Smallest change points.** Extend the existing `cache` record in `TaskViews` with the built
`TNode[]`/`TreeNode[]` per screen kind and key (`list:<slug>`, `session`, `span:<key>`), keyed by
the same `(truth, rev, folding)` + `lists` identity; return the `index` and `spans` from
`taskTranscript` so they are built once with the source. Elapsed-time labels must be re-derived
per render (`data()` already sets `now: Date.now()`, `:465-469`) — keep the structure cached and
the durations computed at render.
**Obstacles.** `data()` returns a fresh object with `theme()` and `now` on every call, and node
labels already contain theme-escaped strings, so caching nodes caches ANSI text; the theme is
stable within a panel session but not guaranteed. `TreeState` mutates rows
(`tree.rows(...)`, `route()` `:675`) and holds the cursor, so nodes must be re-fed, not replaced
wholesale. The `"rebuilds them once per change"` test counts `project()` calls on Truth; adding a
node cache must not add per-render Truth reads. `foldedTaskTokens`/`taskSpanTokens`
(`taskWidget.ts:240-270`) still filter all blocks per list and are called from `listNodes`
(`taskViews.ts:109`), so a node-only cache leaves a per-render cost.

---

## E. `extension/accordion.ts` fact extraction + `core/factLedger.ts` — U12

### U12 — background fact extraction has per-task caps but no session budget

**Functions**

- `noteFacts(): Promise<void>` — `extension/accordion.ts:4829-4870`. Fires from every tool result
  off the hook (`if (settings.recall.ledger.enabled) setTimeout(() => void noteFacts(), 0);`,
  `:3779-3780`). Bound state: `ledgerBusy`, `ledgerTried` (task keys tried in this process,
  `:460-465`), `ledgerIdleRev` (last rev where all folded tasks had a ledger, `:4841`),
  `ledgerWarned`. Per task:
  ```ts
  const next = foldedTasks(t).find((f) => !factLedger.has(f.task) && !ledgerTried.has(f.task) && reportOf(f.task)?.status);
  ...
  ledgerTried.add(next.task);
  if (next.entries.reduce((n, b) => n + b.tokens, 0) < LEDGER_MIN_TOKENS) { factLedger.set(next.task, []); continue; }
  ...
  for (const chunk of ledgerChunks(next.entries).chunks) {
      const res = await runCompletion({ system: LEDGER_SYSTEM, prompt: chunk.prompt, maxOutputTokens: LEDGER_OUTPUT_TOKENS }, new AbortController().signal, "recall");
      const found = verifiedRows(res.text, chunk, (id) => t.get(id)?.text ?? "");
      if (!found) throw new Error("the model returned no row list");
      rows.push(...found);
  }
  ```
  There is no total token/call budget and no re-use of a descendant's ledger.
- `ledgerChunks(entries)` — `core/factLedger.ts:62-81`. `CHUNK_CHARS = 24_000 * 4` chars, at most
  `MAX_CHUNKS = 4` prompts per task (first + last when longer, `:79`), `PART_CHARS` = half a chunk,
  task-tool entries skipped (`:66`), each entry shown whole.
- `foldedTasks(truth)` — `core/recallView.ts:398-403` → `foldedTaskCodes` `:406-418` →
  `sourceOf` `:156-167`. A task code's `entries` are the members of its `t:` handle
  (deduplicated, ordered); `spanHandle` (`taskfold.ts:1215`) includes **every block inside the
  task's intervals**, so a parent's entries contain its children's work — the "parents reread
  their children" part of the finding.
- `FactLedger` (`has`/`set`/`all`/`reset`) `:140-161`; persistence `ledgerData`/`ledgerOf`
  `:164-184` (`LEDGER_ENTRY = "accordion.recall.ledger"`); restore on session start
  `accordion.ts:3423-3426`.

**Callers / consumers.** The ledger feeds `recall`: `recallView(... { facts: factLedger.all() })`
(`accordion.ts:4962`) and `askMaterial(... facts: factLedger.all())` (`:4898`); rows are agent-facing
text in `recall` output. Side-model calls go out via `runCompletion` with type `"recall"`, gated by
`askModelAllowed()` (`:4873-4892`). No widget, no file other than the session log entry.

**Tests.** `core/factLedger.test.ts` (vitest; helpers `session()`, `blk()`, `foldedTasks`):
`"keeps a row only when its value is verbatim in the entry it cites"` (`:33`),
`"shows every entry whole, continues a long one as parts, skips task-tool entries and reads the
first and last parts of a task too long for four prompts"` (`:59`),
`"recall shows matching rows before hits…"` (`:79`),
`"round-trips through session entries; a later entry for a task replaces the earlier one"` (`:100`).
The extension path is pinned by a **smoke check** `extension/smoke-context.mjs:992-1051`
`"a folded task gets a fact ledger once, recall finds a value by the ledger's words, and a resume
keeps it"`: asserts one `accordion.recall.ledger` entry per folded task with the invented value
dropped (`:1034-1038`), `prompts[0]` contains `<transcript>`, and that a task with a ledger is not
read again (`:1045`) and a resumed session spends nothing (`:1046-1051`). Nothing asserts a session
budget or child re-use.

**Settings / constants.** `recall.ledger.enabled` default `true` (`settings.ts:98,164`; value rule
`settingsValidation.ts:77`; documented in SPEC-0003 §8 via the `factLedger.ts` header and the
Settings/README text); `LEDGER_MIN_TOKENS = 2_000` (`factLedger.ts:24`),
`LEDGER_OUTPUT_TOKENS = 4_000` (`:22`), `MAX_CHUNKS = 4` (`:28`), `ROWS_PER_CHUNK = 60`,
`MAX_ROWS = 120` (`:32-33`), `CHARS_PER_TOKEN = 4` (`:26`). There is no key for a budget; any new
key belongs next to `recall.ledger` (`settings.ts:96-98,164`; Settings rows in
`settingsRows.ts`).

**Smallest change points.** (1) Compute each task's *own* uncovered entries: subtract blocks that
sit inside a descendant task with a ledger (`foldedTasks` gives no hierarchy, but
`scanTaskSpans`/`spanContains` do, or `factLedger` can expose which descendant keys exist);
(2) add a session budget (tokens or calls) around the `for(;;)` loop in `noteFacts`, counted from
`ledgerChunks(...).chunks` prompt lengths and `LEDGER_OUTPUT_TOKENS`, plus progress (a status text
or a `recall` note) — the finding asks for "expose a session-wide extraction budget and progress".
(3) Optionally, when a parent is noted, seed its ledger from child rows instead of re-reading.
**Obstacles.** `ledgerIdleRev` records "nothing left" and suppresses the whole scan until the
next rev — a budget that stops early must not set it, or the remaining tasks are never tried.
`ledgerTried` marks a task before its calls, so a budget stop must not burn keys. The side-model
call is `host`-independent (`runCompletion`), but the consent prompt (`askModelAllowed`) may open
UI; a budget must not trigger it per task. `smoke-context.mjs:992-1051` already pins the
once-per-task behavior and the no-re-read rule, so a budget must keep both true.

---

## F. `extension/tui/transcriptDump.ts` — U13

### U13 — every dump format carries all task metadata

**Functions**

- `dumpDocument(input: DumpInput): DumpDoc` — `extension/tui/transcriptDump.ts:155-226`. Builds the
  full metadata unconditionally:
  ```ts
  const metadata = { task_lists: source.lists ?? [], list_issues: source.listIssues ?? [],
      groups: source.groups.map((g) => ({ id: g.id, memberIds: g.memberIds, ...(g.handles ? { handles: g.handles } : {}), folded: g.folded })),
      block_details: source.blocks.filter((b) => b.details !== undefined).map((b) => ({ id: b.id, details: b.details })) };
  return { meta: input.meta, system: input.system, totals: input.totals, generatedAt: dumpStamp(input.generatedAt),
      metadata, orientation, body, tail, wire: entries.map((e) => e.node) };
  ```
- `hasMetadata(doc)` `:234` (`Object.values(doc.metadata).some((xs) => xs.length > 0)`) and one
  emission per format: tree `:281-284` (pretty JSON), flat `:311`, yaml `:386`
  (`  metadata: ${json(doc.metadata)}`), xml `:451` (CDATA), md `:511` (fenced JSON).
- Surface: `DumpFormat` `:23`, `DUMP_FORMATS` `:26`, `FORMAT_EXTENSION` `:29-35`,
  `EXTENSION_FORMAT` `:37-45`, `formatOfPath` `:48-52`, `withExtension` `:55-59`,
  `parseFormatSpec` `:75-87`, `renderDump` `:516-529`.
- Command: `dumpTranscript(args, ctx)` — `extension/accordion.ts:4200-4280` (flags `:4205-4225`,
  format resolution `:4230-4238`, source + lists `:4249-4253`, document `:4255-4261`, write
  `:4264-4274`); usage string `:4204`; completion entry `:4304`; command list `:4405`.
  Documentation: `extension/README.md:46-49`, root `AGENTS.md:20`, SPEC-0002 §10.3 (`:955-972`,
  esp. `:965-967` "Structured details, handles and task metadata remain available as non-wire
  metadata").

**Callers / consumers.** `/accordion tasks dump-transcript` (user-facing files on disk) and the
debug bundle path `accordion.ts:4320-4324` (renders `"tree"` into the gzip bundle). No agent
consumption.

**Tests.** `extension/tui/transcriptDump.test.ts` (bun:test; `Log`, `doc()`, `source()`,
`renderDump`, `Bun.YAML`): `"exports scoped metadata and distinguishes an appended working set
from an available cache"` (`:221-243`) requires `"Deliver reliable exports"`, `"Every carrier
exactly once"`, `"Keep the scoped fact"`, `"spec.md"`, `"handles"`, `"block_details"` in **every**
format (`:234-237`); `"accounts for every block exactly once, so no region drops or doubles the
wire"` (`:181`); `"writes body text whole, in every format"` (`:208`); `"prints one entry per wire
block in flat order…"` (`:271`). `extension/smoke-context.mjs:978-982` parses the flat metadata
block back out. A compact export must therefore be **additive** (new format/flag), not a change to
`hasMetadata`.

**Settings / constants.** None.

**Smallest change points.** Add a `compact` axis: either a new `DumpFormat` value(s)
(`wire`, `summary`) in `DumpFormat`/`DUMP_FORMATS`/`FORMAT_EXTENSION`/`EXTENSION_FORMAT`, or a
`--compact` flag parsed in `dumpTranscript` (`accordion.ts:4205-4225`) and threaded into
`DumpInput`; then `dumpDocument` builds an empty/`summary` metadata object, `hasMetadata` and the
five renderers honor it, `parseFormatSpec` accepts the new names, and the help/completion text
(`:4204`, `:4304`, `:4405`) plus `extension/README.md:46` and SPEC-0002 §10.3 gain the option.
**Obstacles.** `metadata` is the only place list/task data appears in the dump (`wire` and `body`
carry only carrier text); "compact" must still say what a folded span stands for, which is the
carrier itself (`n.wire`), not metadata. `renderTree`'s metadata block is also what makes the
default export inspectable (SPEC-0002 §10.3:965-967), so the existing formats must keep it. The
debug bundle uses the tree renderer (`accordion.ts:4320-4324`) and should not silently lose
metadata.

---

## Findings outside the six groups

### 1. SPEC-0002 `stale` in `status`, widget and results (code gap)

**Code today**

- `statusOf(list, criteria?)` — `extension/tasks.ts:1145-1169`. Returns
  `{done, total, goal?, doing?, blocked?, next?, criteriaMissing?}`; no stale. Call sites:
  `runAction` `claim` (`:1233`) and `status` (`:1283-1284`).
- `TaskResult` (`:1100-1130`) and the `complete`/`start` result assembly (`:1294-1299`,
  `:1309-1315`) — no stale.
- The only stale computation: `staleSpans(spans, blocks, steps)` — `taskfold.ts:365-374`
  (open span, at least `steps` tool calls after its last event, while other tasks moved);
  consumed at `taskfold.ts:813` for the saturation status text (`:816`) and `:933-934` for the
  debug raw warning. `ZOMBIE_STEPS = 40` (`taskfold.ts:126`).
- Widget/views have no marker: `TaskWidgetModel` (`taskWidget.ts:25-32`),
  `taskRowLine` (`:155-173`), `listNodes` meta (`taskViews.ts:120-126`).

**Spec line.** SPEC-0002 §5.3, `:695-697`:
> `- A span still open with no task event for tasks.zombieSteps (default 40) steps while other tasks are started and finished is reported in status and the widget as stale and is offered to the agent in the next tasks result as {"stale": ["3.11.1.3.3.2"]}; it is not folded silently.`
`status` result shape to extend: §3.4 `:229-243`. Widget rows: §10.2 `:919-947`.
`Spec0002Audit.md:39` records it as an open code gap and quotes
`.pig/tasks/taskfold-reliability-fixes.json:1958` ("tasks-result `stale` field lands with JSON
results (slice 4)").

**Verdict: the code changes** (the spec sentence is explicit and no other passage contradicts it).

**Smallest change points / why it is not a one-file unit.** (a) `statusOf` gains an optional stale
list and spreads it (tasks.ts); (b) the extension must compute stale ids where Truth is available
and inject them into every successful `tasks` result — the result object is assembled in
`accordion.ts:4707-4747` and in the `status` case inside `tasks.ts:1283-1284`, which has no Truth;
(c) the widget needs the ids in `TaskWidgetModel` (`taskWidget.ts:512-522` computes it from
`deps.truth()`) and a marker in `taskRowLine`; (d) the panel list can show it in `listNodes`.
`staleSpans` also needs `zombieSteps`, which is the next gap. The scan (`scanTaskSpans`) is
already exported from `taskfold.ts` and used by the TUI (`taskWidget.ts:9`,
`taskTranscript.ts:8`), so no new dependency direction is needed; but `tasks.ts` is the
Pure/store layer and must stay free of Truth, so the ids must be passed in, not computed there.

### 2. SPEC-0002 `tasks.zombieSteps` setting (code gap)

- Spec: §5.3 `:695` "`tasks.zombieSteps` (default 40)".
- Code: `export const ZOMBIE_STEPS = 40` (`taskfold.ts:126`), used at `:813` and `:933`; no key in
  `TaskSettings` (`settings.ts:52-74`), `DEFAULT_SETTINGS.tasks` (`:148-160`), `sanitizeTaskSettings`
  (`:295-329`), `validateSetting` (`settingsValidation.ts:44-62`), or the Settings tab rows
  (`settingsRows.ts:77-88` lists the `tasks.*` rows). Options that reach the conductor are
  `TASKFOLD_DEFAULTS` (`taskfold.ts:65-77`) merged from `settings.taskfold` + registry options in
  `accordion.ts:924-925`; `tasks.*` is not threaded there.
- **Verdict: the code changes** (spec already names the key and its default). Spec §12 settings
  block `:1019-1042` already omits it, so §12 must gain the key in the same change (spec edit, no
  new decision).
- Change points: `settings.ts` (interface, defaults, sanitize), `settingsValidation.ts`
  (`"tasks.zombieSteps": number(1, …)`), `settingsRows.ts` (row), `accordion.ts:924-925` (pass it
  into `TaskfoldConductor`), `taskfold.ts` (an option + replace the two `ZOMBIE_STEPS` uses, keep
  the exported constant as the default), SPEC-0002 §12:1019-1042. **The conductor file is shared
  with P13.**

### 3. SPEC-0002 one stable `t:` fold code per task (code gap)

- Spec: §6.1 `:709` "One fold code per task: `foldCode("t:<list>/<id>")` (§7.3). The group's own
  code is not shown."; §7.3 `:790-791` "Handle id: `t:<list>/<id>`. Its fold code is
  `foldCode("t:<list>/<id>")`, stable across recompiles."
- Code: `taskfold.ts:1244`
  `const tag = rootCovered ? foldTag(\`t:${span.key}\`) : foldTag(\`g:${lastRun[0].id}\`);`
  with `spanHandle` (`:1215`), `covered()` (`:1216`), handle set + filter (`:1218-1221`), and the
  carrier-tag reachability filter `const visible = usable.filter((h) => shown.has(foldTag(h.id)));`
  (`:1252-1253`); part carriers use `foldTag(\`g:${r[0].id}\`)` (`:1258-1260`).
  Consequence: when the carrier cannot own the whole span, no `t:` tag is written, no `t:` handle
  is exposed, and `recallView.foldedTaskCodes` (`core/recallView.ts:406-418`) finds no task code
  for that task — its report is unreachable by code (entries remain reachable via search).
- **Verdict: the code changes** (the spec sentence is explicit). Tests pin the tag and the
  handles: `conductors/in-process/taskfold/taskfold.test.ts` (vitest; `Session` + `TestHost`
  helpers) — `"folds a finished root into a one-line history carrier on an assistant group"`
  (`:522-536`, `expect(g!.summary!.startsWith(foldTag("t:work/1"))).toBe(true)` at `:530` and
  `resolveRecall(host.truth, [foldCode("t:work/1")])` at `:533`), `"writes a finished subtask as a
  full JSON record inside its still-open parent"` (`:538`), the composed/partial-handle tests
  (search `resolveRecall` and `canRecallHandle` in the file), and
  `"reports an open span that other tasks left behind as stale"` (`:434`).
- **Why it is harder than it looks.** AGENTS.md's "the tag is the handle" rule
  (`AGENTS.md:57`): the `{#code FOLDED}` prefix is the only route for the agent, and
  `core/agentView.ts`'s `agentReachable`/`groupAgentReachable` require the block's **own** tag.
  Writing `t:` unconditionally would claim a handle that `covered()` refused, and Truth validates
  handles on use, so the code would be present but unreachable (and `recall` would address members
  the carrier does not hold). The honest fix is to make the carrier own every message of the span
  (whole-message snap/tail/excluded-group handling in `unit()` `:1139-1210`), or to keep the `g:`
  tag and additionally write the `t:` code as a non-handle marker — both touch the planner that
  P13 rewrites. Fold codes are stateless hashes (`core/digest.ts:107-119`), so stored
  `accordion.taskfold.unfold` state (keyed by `t:<key>`, `accordion.ts:3429-3431`) is not at risk.

### 4. SPEC-0002 dropped routing operations are not logged (code gap)

- Spec: §4.6 `:610-612` "Removals and renames of started tasks follow the store's rules; a refused
  operation is dropped and logged."
- Code: `applyRoutedOps` returns `dropped: DroppedOp[]` (`extension/taskRouting.ts:33-42`,
  `:197-225`); `createRouting(...).apply` appends `extraction.rejected` and returns only
  `{ids, applied, dropped: number}` (`:244-256`, esp. `:252-255`); the conductor uses only
  `result.applied`/`result.ids` (`taskfold.ts:710-713`) and logs only extraction **errors**
  (`host.setStatus`, `:720`; `host.debug({type:"route-retry"})`, `:716`). The extension's
  `applied` callback fires only when `outcome.applied.length > 0` (`taskRouting.ts:253`) and
  receives the outcome but does nothing with `dropped` (`accordion.ts:3476-3482`).
- **Verdict: the code changes** (the spec says "logged").
- Change points: pass a log/debug callback through `RoutingDeps` (`taskRouting.ts:227-233`) and
  call it with `outcome.dropped` in `createRouting.apply`; wire it in `accordion.ts:3468-3483` to
  the existing `debug(...)` helper (used at `accordion.ts:4761`) or to `host.setStatus`; optionally
  include the dropped ops in the routed notice (`taskSession.noteRouted`, `taskSession.ts:247-251`).
  Tests: `extension/taskRouting.test.ts` (bun:test; `fixture()`) — `"drops a pin that is not a
  quote of the message and a rename of a finished task, applying the rest"` (`:106`),
  `"drops operations on unknown ids instead of failing the batch"` (`:122`),
  `"drops a task and attaches a file by section"` (`:134`), `"never ends a started task"` (`:211`);
  none asserts a log line, so a new assertion is needed.
- **Obstacle.** `taskRouting.ts` is pure by design (header comment) and has no host; logging must
  be injected. A batch of only-dropped ops currently never reaches `deps.applied`, so a naive
  "log in applied" misses exactly the case the finding is about.

---

## Per-finding index (functions, consumers, tests, settings)

| Finding | Functions (file:lines) | Consumers | Tests (runner) | Settings/constants |
|---|---|---|---|---|
| U7 | `agentNotice` taskBinding.ts:105-119; `attachedNotice` :122-132; `changedSince` :72-76; `renderList` tasks.ts:1039-1047 | `TaskSession.settle` taskSession.ts:97-103, `noticingHost` :169-191, `takeNotice` :278-294 → `before_agent_start` accordion.ts:3596-3607, `flushTaskNotices` :3583-3592 | taskBinding.test.ts:52,83 (bun); taskSession.test.ts:111,121,144 (bun) | `OWN_WRITE_SLACK_MS` 2000; SPEC-0002 §4.4 |
| U8 | `userPrompt` taskCoach.ts:147-154; `toolResult` :257-282; `callStarted` :167-181 | tool_result hook accordion.ts:3513-3529 (appended to result); tool_call :3495-3510 (block/notify) | taskCoach.test.ts:9,17,27,109,130 (bun); smoke-context.mjs:466-475 | `tasks.orientationCalls` 10, `tasks.gateFailOpenAfter` 3, `tasks.enforce`; SPEC-0002 §12:1023-1025 |
| U9 | `toolResult` :257-258; `largeLeafNote` :197-214; `floorTap` :235-241 | same hook; `floorTap` from status metrics accordion.ts:1040-1041 | taskCoach.test.ts:141,163,173,182,194 (bun) | `tasks.largeLeaf` 0.15/25/10; SPEC-0002 §12:1029 |
| U10 | `applyTaskWidgetHit` taskWidget.ts:220-226; `layoutTaskTree` taskTree.ts:204-248 (`:218`, `:243`); `hiddenRowLine` :175-180 | widget above the editor (`render` :305-316, `handleMouse` :318-325) | taskWidget.test.ts:83,114 (bun); panel.test.ts:618 | `taskWidget.maxRows` 12; SPEC-0002 §10.2 |
| U11 | `TaskViews.ensure` taskViews.ts:430-463; `nodes` :475-487; `view` :555-556; `route` :675; `sessionTranscript` taskTranscript.ts:258-291; `taskNode` :232-252; `spanTokens` :294-299; `spanTranscript` :339-392 | Tasks/Lists tabs (screens/tasks.ts:17-18) | taskViews.test.ts:97,123,177,200,216 (bun); taskTranscript.test.ts:78,97,122 (bun); panel.test.ts:661 | none |
| U12 | `noteFacts` accordion.ts:4829-4870; `ledgerChunks` factLedger.ts:62-81; `foldedTasks` recallView.ts:398-403; `sourceOf` :156-167; `FactLedger` :140-161 | `recall` (`facts:` accordion.ts:4962, :4898); side model via `runCompletion`; session log `LEDGER_ENTRY` | core/factLedger.test.ts:33,59,79,100 (vitest); smoke-context.mjs:992-1051 | `recall.ledger.enabled` true; `LEDGER_MIN_TOKENS` 2000, `LEDGER_OUTPUT_TOKENS` 4000, `MAX_CHUNKS` 4, `ROWS_PER_CHUNK` 60, `MAX_ROWS` 120 |
| U13 | `dumpDocument` transcriptDump.ts:155-226 (`:221-225`); `hasMetadata` :234; renderers :281-284/:311/:386/:451/:511; `parseFormatSpec` :75-87; `dumpTranscript` accordion.ts:4200-4280 | files on disk; debug bundle accordion.ts:4320-4324 | transcriptDump.test.ts:181,208,221,271 (bun); smoke-context.mjs:978-982 | none; SPEC-0002 §10.3:955-972 |
| U16 | `finish` tasks.ts:877-931, guard `:887-891` | `tasks` tool `complete`/`fail`/`abandon` (tasks.ts:1301-1316), agent-facing JSON error | tasks.test.ts:271,287 (bun) | none; SPEC-0001 §4.15:422-429 |
| stale | `statusOf` tasks.ts:1145-1169; `staleSpans` taskfold.ts:365-374; status text :811-816; raw warning :933-934 | `status`/`claim` results, widget, panel, footer status | taskfold.test.ts:434 (vitest, `staleSpans` only) | `ZOMBIE_STEPS` 40; SPEC-0002 §5.3:695-697, §3.4:229-243 |
| zombieSteps | taskfold.ts:126,813,933 | conductor options (`accordion.ts:924-925`) | none | no key; SPEC-0002 §5.3:695, §12:1019-1042 |
| stable `t:` | taskfold.ts:1215-1221, 1244, 1252-1253, 1258-1260 | `agentView` reachability, `recallView.foldedTaskCodes` :406-418, views' `taskFoldRefs` taskTranscript.ts:123-140 | taskfold.test.ts:522-536, :538 (vitest) | none; SPEC-0002 §6.1:709, §7.3:790-791 |
| dropped routing | `applyRoutedOps` taskRouting.ts:197-225; `createRouting.apply` :244-256; `routeOne` taskfold.ts:693-727; `applied` deps accordion.ts:3476-3482 | routed verdicts (`{ids, at}`), notice `noteRouted` | taskRouting.test.ts:106,122,134,211 (bun) | none; SPEC-0002 §4.6:610-612 |
| widget text | taskWidget.ts:66-84, 155-180, 204 | widget lines | taskWidget.test.ts:92,97,141,158,171 (bun) | SPEC-0002 §10.1:914, §10.2:919-947 |

---

## Practical notes for cutting units

1. **Group A (taskCoach) is self-contained** except for the note builders it imports from
   `taskBinding.ts` (`largeLeafReminder`, `floorFoldNote`; `noListReminder` is local). U8 and U9
   both change the *frequency and mode* of the same two notes, so they should land together or in
   a fixed order; splitting them risks two different recurrence counters.
2. **Group B's `tasks.ts` is the store contract** used by the `tasks` tool, the executor
   (`runTasksTracked`), routing (`taskRouting.ts` calls `runTasksTracked`) and tests; a U16 change
   there is a contract change (AGENTS.md:16). `taskBinding.ts` has no other consumers.
3. **Group C's `taskWidget.ts` is imported by a conductor's Vitest file**
   (`conductors/in-process/taskfold/taskfold.test.ts:6` imports `foldedTaskIds`,
   `foldedTaskTokens`), so a widget signature change is visible to a Vitest suite that P13 also
   touches.
4. **Group D** has no shared files with the others; U11 is a pure performance change with an
   existing cache-count test to extend.
5. **Group E** writes `extension/accordion.ts`, which every other unit also writes; a U12 unit
   must confine itself to `noteFacts`, its state variables (`:460-465`) and the trigger
   (`:3779-3780`).
6. **Group F** writes `transcriptDump.ts` and three lines of `accordion.ts` (help/usage) plus the
   README/SPEC-0002 §10.3 text; `transcriptDump.ts` has no other consumers.
7. **Everything that touches `conductors/in-process/taskfold/taskfold.ts`** (stable `t:` code,
   `zombieSteps` option, routing log) collides with P13 (`perf/taskfold-planner`), which owns that
   file.
8. **SPEC-0002 gaps: who changes**
   - `stale` reporting → **code** (§5.3:695-697 states it; §3.4:229-243 is the result shape to extend).
   - `tasks.zombieSteps` → **code**, plus §12:1019-1042 (settings block) gains the key (doc-only edit, no new decision).
   - one stable `t:` code → **code** (§6.1:709, §7.3:790-791).
   - dropped routing ops logged → **code** (§4.6:610-612).
   - widget text → **code** for the header `·`/` (≡N)` and the row token pair (audit: "one side
     should change", and §10.2's example row agrees with the spec); **spec** for the hidden-row
     order (§10.2:926), the progress colours (§10.2:946-947) and the legend (§10.2); the panel's
     third legend wording (`TASK_LEGEND`, `taskViews.ts:389-397`) is spec text too.
