## Mismatches

**§2.1** "v2 files with `lines` are converted to a quote anchor on load" | `extension/taskSchema.ts:141-146,177-184` (`upgradeV2` rewrites only `goal`), `extension/taskPins.ts:36,295-300`, `extension/tasks.ts:382-400` (`recordSeen`) | conversion happens at first *delivery*, not load; a v3 file may keep `lines` | code is right (§4.2 says the same); §2.1 sentence is stale.

**§2.2** "Changing the id or position of a started task is a validation error: started ids are frozen (§3.5)" | `extension/taskSchema.ts:290-327` (`walk`), `381-390` (`checkStatusTree`) | no started-id freeze check exists; a hand edit that renames a started id loads cleanly (only `TaskStore.renumber` refuses at write time) | spec overstates: the file carries no memory, so either the claim goes or a claim/fingerprint check is added.

**§3.2** `Err = { ok:false; error; message; fix? }` | `extension/tasks.ts:105-117` (`TaskError.toResult`) | `fix` is never emitted anywhere; every call site puts the fix into `message` | spec should drop `fix`.

**§3.4 complete/fail/abandon** lists `closed: ["3.1.1","3.1"]` as a result field | emitted at `extension/tasks.ts:1294-1299` (`start`), not at `1301-1315` (`finish`) | auto-close happens when the agent moves on, i.e. on the later `start` | code right; the spec example misattributes the field.

**§3.4 claim** "`active` … minus what is already live … Claiming a list the session already holds with all context live returns the status fields only" | `extension/accordion.ts:4681-4682`, `extension/taskPins.ts:424-432` | `deliverContext` returns an `{id,title}` entry for every `doing` task, so `active` is always present while a task is doing | code's "bare ref" form is undocumented in §3.4.

**§3.4 status/complete shapes** | `extension/tasks.ts:1163` (`noGoal`), `1184` (`next.resume`), `1312` (`resumable`) | fields not listed in §3.4's JSON (they are documented in the tool description, `extension/accordion.ts:4574`) | spec list is incomplete, not code wrong.

**§3.4 list** `claim: this | other` | `extension/tasks.ts:1226` | a *stale* claim still reports `"other"`, although `claim()` accepts it without `force` (`tasks.ts:630`) | reporting divergence only.

**§4.1 source** "`user`, `path`, `path:line`, `path:start-end`, or an anchor ref (§4.2)" | `extension/taskPins.ts:154-168` | non-`user` sources are read as a filename; `path#Heading` or `path::Symbol` fail with `not_found` | anchor-ref pin sources are not implemented; spec claims them.

**§4.2** "Exactly one of `section`, `symbol`, `quote`, `lines` may be given" | `extension/taskPins.ts:204-210` | an additional `path:N-M` suffix is accepted as line sugar (`accordion.ts:4612` documents it) | undocumented input form.

**§4.3** manifest `delivered: { list?: { goals: {id,hash}[] … }, tasks: […] }` | `extension/taskPins.ts:348-372` (`deliveryKey`), `387-433`; `extension/tui/toolRows.ts:40-41`; `extension/accordion.ts:4663-4673` | `details.delivered` is a flat `string[]` of list-scoped keys (`auth/item:g1#<hash>`, `auth/pin:p1`, `auth/att:a1`) | code right (equivalent, simpler); §4.3/§5.1 are stale.

**§4.3** "`attach` records attachment ids with `hash: null` (reference only)" | only `start`/`claim` (`accordion.ts:4666`) and `pin` (`4712`) write `delivered` | `attach` records nothing | code right: keys are by id (`att:a1`), so recording at attach would suppress the content delivery §3.4 promises.

**§4.3** "attachments by content hash; `null` never matches" | `extension/taskPins.ts:352-358,397-409` | liveness is by id only; the content hash only drives `state:"changed"` | code matches §4.2 ("keyed by its id"), contradicts §4.3.

**§4.4** "At most 20 task entries, the rest counted in `more`" | `extension/taskNotices.ts:88-115` | the cap applies only to tasks added/removed/changed; `within` entries are uncapped.

**§4.6** "`target` is the list, a task id, or an item id (`g2`, `c5`, `p3`, `a1`) for `-`/`~`" | `extension/taskRouting.ts:100-121,167-183` | item ids travel in a separate `id` field; `target` is list/task only | internal extractor protocol; spec text stale.

**§4.6** "The message's block records `details.routed = {ops: [...ids], at}`" | `conductors/in-process/taskfold/verdicts.ts:26-32,57-61,134-145`; `taskfold.ts:1218-1221`; nothing writes `details.routed` in `extension/accordion.ts` | routed state is a session verdict entry `{ids, at}` (`ids`, not `ops`), read from the ledger | code's design; spec stale.

**§4.6** "a refused operation is dropped and logged" | `extension/accordion.ts:3459-3463` | dropped ops reach `RoutingOutcome.dropped` but are never logged or notified.

**§5.1/§5.3** task event shape `{action, list, id, started, finished, closed, cascaded, delivered}` | `core/taskEvents.ts:29-41` | event carries `task`, `started`, `closed`, `cascaded`; no `finished`, no `delivered` (`delivered` is a sibling `details` field) | spec stale.

**§5.3** "`tasks.zombieSteps` (default 40)" | `conductors/in-process/taskfold/taskfold.ts:126` (`export const ZOMBIE_STEPS = 40`), `782,902` | fixed constant; no setting key exists in `extension/settings.ts` | spec asks for a setting.

**§5.3** "reported in `status` and the widget as `stale` and is offered … as `{"stale": […]}`" | only the saturation status text, `taskfold.ts:782-785` | no `stale` in `statusOf` (`extension/tasks.ts:1145-1169`), no widget marker (`tui/taskWidget.ts`, `tui/taskTree.ts`), no `stale` in any `tasks` result | code missing this. `.pig/tasks/taskfold-reliability-fixes.json:1958` records it as open ("tasks-result `stale` field lands with JSON results (slice 4)").

**§6.1/§7.3** "One fold code per task: `foldCode("t:<list>/<id>")` … stable across recompiles" | `taskfold.ts:1158-1187` | the carrier's leading tag is `foldTag("t:<key>")` only when the carrier fully owns the span (`covered(rootHandle)`); otherwise `foldTag("g:<first block of last run>")` and the `t:` code appears nowhere in the carrier | code fallback is unstable across recompiles; spec's one-code rule looks right.

**§6.2** pins `[{"id":"p4","kind":…,"text":…,"source":…}]` | `extension/tui/toolRows.ts:62`, `core/taskEvents.ts:15`, `taskfold.ts:1246` | real spans carry the store `Pin`, so carriers include `at` too (`RecordObj.pins` declares neither `id` nor `at`) | extra timestamp on the wire; key list in the spec is "fixed".

**§7.3** "An agent-opened node refolds only under pressure and only once its task age is ≥2" | `taskfold.ts:803-811` and `864-867` | the `open` flag is cleared when `state.count === 1` **and** ≥2 later roots have finished, with no pressure test; normal timing (default `eager`) then refolds on the next epoch | spec's pressure+age gate is not what the code does.

**§10.1** header `… <done>/<total> · ≡<folded> · <duration> …` | `extension/tui/taskWidget.ts:73-77` | emits ` (≡N)` (parenthesised, no `·`); row token pair is `full → live` with spaces vs the spec row's `21.7k→52` | one side should change; §10.2's example row shows `≡7`.

**§10.2** progress "`success`/`error`/`dim`/`dim` colours" | `taskWidget.ts:167-170` | whole `7✓ 2☒ 1⊘ 3☐` marker painted `muted` | spec.

**§10.2** hidden rows `… N finished (k≡ · full→live) · duration` | `taskWidget.ts:175-180` | emits `… N finished · duration (k≡ · full→live)` — order swapped.

**§10.2** legend text | `taskWidget.ts:204` | `≡ folded · raw ! inconsistent · ▣ done … ☐ todo` vs spec `▣ done ☒ failed ⊘ abandoned ◐ partly done ▶ doing ⧗ blocked ☐ todo · ≡ folded · raw` | spec; the panel's `?` legend is a third wording (`extension/tui/taskViews.ts`, `TSK_LEGEND`).

Nothing else checked differs: §2.1 limits (200/600/5/300/3/8/300/2000/12×1000, notes 120), §2.2 migration and refusals, §3.1, §3.3, §3.4 order/stopOnBlock messages/empty-span 40 chars/process exemption, §4.1 caps and verbatim checks, §4.2 anchors/refs/similarity 0.8/32-char context/maxLines 60/`too_large`, §4.5 removals, §6.2 `recordTokens` 1500 and shrink order, §6.3 history, §6.4 parts/untracked, §7.1/§7.2 pipeline, §8 tail lock + zero tail + `holdWireUpToMs`, timing modes, cache frontier/four slots, §9 epoch order and defaults (0.8/0.6/0.3/0/1500/record/false/8/4), floor `maxRung:5`/`groupSteps:false`, §10.1 title shortening (8 cols), §10.3 `g`/list context/paused-fold wording/dump metadata, §11 skill+validator, §12 defaults and legacy migration, §12.1 debug records, §14 adoption/overlay/detection.

## Spec-declared future/open items

The spec names no TBD/“not yet”/open question; line 21 defers tracking to project tasks and `BACKLOG.md` (`B-0001`, `B-0003` are open). What it does leave conditional or unverified:

- §3 "Verify that the installed Pi prompt builder includes this guidance for the active tool; a replacement system prompt may omit it." — code relies on `promptGuidelines` (`extension/accordion.ts:4577-4584`); not verified here.
- §5.1 "If Pi does not persist `details` for reloaded sessions, the scan falls back to the current prose regexes" — contigency; the regexes exist (`taskfold.ts:290-330`).
- §8 "Eager folding … does not guarantee a cache hit" — caveat.
- §9.2 "The floor is an opt-in guard, not a hard budget guarantee" — caveat.
- §12.1 "Rewrite estimates are not observed cache billing." — caveat.
- §13 "Samples are too small for a general quality claim." and the §11 eval ("one run per case and arm") — measurement caveats.
- §13 rows that are verification duties rather than code: real terminal at 36/57/80/140, `bun`/`npm` gates, the comprehension/routing harness.

BLOCKERS: none. I ran no builds or tests; `find`'s judge backend was down (`every judge candidate failed … jev-1.14 rejected the account recently`), so I used `grep`/`read` only.