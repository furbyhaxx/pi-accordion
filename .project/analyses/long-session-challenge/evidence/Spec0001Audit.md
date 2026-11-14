**Summary.** The branch implements most of SPEC-0001, but the spec and the code diverge in a cluster of places: §8's compact footer was never adopted (by plan decision), several §5.3/§5.4 detail renderings are older than the spec text, §7's compaction has three real behavioural gaps (`dryRun`, threshold `bake` fallback, group undo/session reset), and the §9 web surfaces are thinner than specified (TasksPanel, MapHeader summary, CompactDialog projections, settings conflict reporting). Settings (§6) is largely faithful except lock labelling and the Web UI status words.

## Mismatches

| Spec section + quote | Code location | What differs | Which side looks right |
|---|---|---|---|
| §3.2 "Lines are built as ordered segments and fitted with `fitSegments`" | `extension/tui/screens/overview.ts:34-56` | `line()`/`wrapped()` truncate by `value.length` + `slice` instead of `visibleWidth`/`fitSegments` (ANSI- and wide-char dependent) | spec |
| §3.5 "Selection is a `→` cursor plus a bold label; no row background" | `extension/tui/screens/context.ts:216` | selected timeline cell is painted inverse (background) | spec |
| §3.8 "fixed height … `clamp(rows − 12, 3, 14)`" | `extension/tui/chrome.ts:6,47-49`; `chrome.test.ts:74` | cap is 20 (`MAX_BODY_ROWS = 20`), test asserts 20 | code/plan S1b (`plan.md:127,189` says 20); spec stale |
| §4.4 "`?` opens it in the task list view" | `extension/tui/taskViews.ts:391-397`; `panel.ts:248-257` | legend only via F1; printable `?` types into the filter | code/plan S1b ("legend moves to F1") |
| §4.12 "Panel: `b`/`t` … open an input" | `extension/tui/screens/settings.ts:18-22` | no `b`/`t` chords at all (only the Settings rows) | code + §3.6 (spec contradicts itself) |
| §5.2 "Tabs: `Context ❱ Tasks ❱ Lists ❱ Conductors ❱ Settings`" | `extension/tui/panel.ts:18,132` | `Overview` is tab 1 of 6 | code (§5.3 requires it as landing); §5.2 list stale |
| §5.3 "Context bar … bar width = `min(44, width − 30)`; label column 10 wide" | `extension/tui/map.ts:118-151` | bar = `min(44, width − suffix − 4)`; legend is one ` · `-joined line, no 10-column label | spec |
| §5.3 "Tasks … clicking/Enter opens §5.8" | `overview.ts:88-91,111-130` | row is only `<title> <done>/<total>`; no ≡/current/duration; Enter always opens Context | spec |
| §5.3 "Web UI … `0.0.0.0`/`::` show the first non-internal IPv4 … OSC 8 hyperlink" | `extension/accordion.ts:564-566,572-583` (`displayWebHost` returns `bindHost`); no `os.networkInterfaces`/OSC8 anywhere | wildcard host shown verbatim; no LAN-IP expansion, no hyperlink | spec |
| §5.4 "Cell glyph by calibrated full tokens: `▪`…`■`…`█`" | `extension/tui/timeline.ts:37-49` | `cellGlyph` always returns `▪` for tool_call/tool_result; `weightGlyph` is unused | spec |
| §5.4 label "`▣ task <key> "<title>"`" | `timeline.ts:60-71` | renders `▣ task <key>` without the title | spec |
| §5.4 "bolted `!` suffix on the system cell" | `timeline.ts:98-104`; `context.ts:212-223` | no `!` on the system cell | spec |
| §5.4 "blocks of a folded group `▣` (group color)" | `context.ts:215` | `▣` painted with `accent`, not the chestnut group colour | spec (but §3.3 "accent is always monochrome" argues for code) |
| §5.4 "prompt `clamp(12, 32, width·0.3)` … below 57 drops to 12" | `timeline.ts:117-124` | 57–79 columns get a fixed 12 (clamp would give 17–24) | ambiguous; code is the literal "below 80" reading |
| §5.4 "Grid … the `.` filler flag is removed (blank instead), `P` is shown only on the first protected cell" | `extension/tui/map.ts:183` | `.` still emitted on every unflagged cell; `P` on every protected cell | spec |
| §5.4 "List = today's list with aligned columns `kind(10) state(14) tokens(8) label(rest)`" | `context.ts:60-70` | single flowing `fitSegments` row, no aligned columns | spec |
| §5.5 header "`<kind word> · <tool or id> · <tokens> tok · <state>`"; scroll `home end` | `context.ts:107-121,261-271` | `describe()` repeats state+tokens in the header; `home`/`end` unhandled | spec |
| §5.6 privacy badge "when `entry.privacy` and the provider is not loopback" | `extension/tui/screens/conductors.ts:34` | badge shown for every privacy entry, loopback route or not | spec |
| §5.6 rows "`›`"; readiness "`✗ <reason>`" | `conductors.ts:24-35` | `→` cursor; `✗ unavailable: <reason>` | code per §3.5 |
| §6.1 "All keys, after this change" (table) | `extension/settings.ts:137-167`; `settingsValidation.ts:28-82` | table omits `debug`, all `tasks.*`, `taskfold.*`, `recall`, `guard`, `calibration`, `modelDefaults.*.tasks`, all of which exist and are editable | code |
| §6.2 "Locked rows show `<ENV or --flag>  env · locked` / `flag · locked`" | `screens/settings.ts:87-90,153,335` | shows `env · locked` / `flag · locked`; refusal says only "`<path>` is env · locked", never names the variable/flag | spec |
| §6.2 "Web UI rows: `▲ reachable on LAN`; `door held`/`door unavailable`; `generated`/`custom`" | `screens/settings.ts:96-98,160`; `settings.ts` Web UI handling | none of the three states is rendered; token row prints the token plus `(generated)` | spec |
| §6.2 sections order (This session → … → Web UI) | `screens/settings.ts:76` | adds `Taskfold`, `Tasks`, `Calibration` sections and `Models · <label>` routes the spec list does not name | code (spec list incomplete) |
| §6.3/§10 "concurrent saves of different fields both persist" | `extension/accordion.ts:3177-3185` | the WS `updateSettings` rejects *any* stale `baseRev` before `SettingsStore.save` can merge; only native saves reach the merge path | spec (store already merges) |
| §7.2 threshold: "else apply `compact.onSaturated`" | `accordion.ts:3874-3897` | `bake` fallback is gated on `trigger === "overflow"`; a saturated threshold pass with `onSaturated: "bake"` cancels with no bake | spec |
| §7.4 "records … `ungroup` for every group it created"; "a session switch clears it" | `extension/compaction.ts:128-145,192`; `accordion.ts:672-680,708` | undo records only `unfold`; `folded.groups` always 0; `lastCompact` is only cleared by undo (no session-switch reset) | spec |
| §7.6/§9 `dryRun` | `compaction.ts:112-169`; `accordion.ts:3194` | `req.dryRun` is never read: a dry-run command folds for real and records a card-less record | spec (defect) |
| §7.5 bake summary `[accordion-bake v1] <N> messages · <before> → <after> tok`, groups once, unfolded non-user blocks forced to digests | `compaction.ts:66-109` | header lacks the token counts; no group handling; unfolded blocks contribute `text.slice(0,300)`; no task-record sections; cap adds a 1000-token floor | spec |
| §7.6 panel `alt+c` preview ("instructions: (type to add…)"; bake `≈ 9.8k summary`) | `context.ts:320-341`; `accordion.ts:4460-4472`; `overview.ts:124-127` | confirm has strategies+projections but no instruction input; bake projection shows tokens *freed*, not summary size; Overview `alt+c` only jumps to Context | spec |
| §7.6 "Threshold passes that cancel quietly … update the footer status only" | `accordion.ts:3884,3892-3896,3904-3908` | cancels notify/broadcast; no footer status update | spec |
| §8 "`footerText` … segments fitted to 24 columns: `acc <usage%> · <conductor id> <level glyph>`" | `extension/tui/status.ts:33-43`; `accordion.ts:1019-1033` | see §8 detail below | plan says deliberate ("not adopted"); spec still stale |
| §9 SettingsPanel "same … staging as §6.2"; "conflict … reported, never silently overwritten" | `app/src/lib/ui/live/SettingsPanel.svelte:60-76`; `liveClient.svelte.ts:492-499` | "Saved to the session host." is shown *before* the result; staged is cleared; `commandResult.error/conflict` are ignored (only a separate `notice` toast reveals failure) | spec |
| §9 TasksPanel "tree of §4.4 (same glyphs, colors via CSS tokens, click to toggle), collapsed summary in `MapHeader.svelte`" | `TasksPanel.svelte:31-51`; `MapHeader.svelte` (no task code) | flat list; all glyphs `--muted`; no click/toggle, no ≡/hidden rows; tokens shown live/full; **no collapsed summary in MapHeader** | spec |
| §9 `tasks` "broadcast … on Truth changes that alter `folded`/`tokens` (debounced 250 ms)" | `accordion.ts:1372-1380,3301` | `broadcastTasks()` is called only from `scanTaskLists()`; Truth-change listeners call `taskWidget.sync()` only, so web `folded`/`tokens` go stale until the next list scan | spec |
| §9 CompactDialog "§7.6 preview" | `app/src/lib/ui/live/CompactDialog.svelte:17-37` | `aggressive` shows (already-realised saving → 2·live−full), not the projection; `pass` reads `settings.lastConductorSaved`, a key that does not exist; `bake` has no estimate; `dryRun` never used | spec (host `compactPreview` already exists and is unused by the web) |

## §8 footer: what is rendered and where it breaks

`footerText` (`status.ts:33-43`) renders, folding on:
`accordion <usage%> · <conductor label> · <timing> · <status text>`
— `no conductor` when detached, `<timing>` only for Taskfold (`accordion.ts:1019-1020`), status text whitespace-collapsed; folding off → `accordion off`. The level is **not** a glyph: it colours the whole string (`accordion.ts:1029`) — no `✓/▲/✗`, no `acc`, conductor **label** (`Taskfold`), not id (`taskfold`). `AlertGate` (`status.ts:50-64`) is unchanged. The status text therefore did **not** move to the Overview (the Overview also shows it, `screens/overview.ts:86-87`).

Widths:
- Default limit is **72 code units** (caller passes no `max`, `accordion.ts:1027`); the cut is `${text.slice(0, max-1)}…`. Typical Thermocline status (`HOLD 82% · 12 folded · 3 strata · probe off (age fallback)`) alone exceeds 72, so the footer is routinely cut mid-status.
- The shortest folded-on string already exceeds the spec's 24 columns: `accordion 28% · Taskfold` = 25 code units; a 24-column fit would print `accordion 28% · Taskfo…`.
- `.length` is UTF-16 code units: status text containing the task title (e.g. Taskfold saturation messages) with CJK/emoji yields visible width above 72 (up to ~2× per character) and `slice` can split a surrogate pair, emitting a half character.
- The 72-column budget also competes with Pi's other footer segments (model/cwd); on an 80-column terminal ~8 columns remain for them, so Pi (or the user's prompt area) will clip the tail of the 72-column string. Exact Pi footer allotment: **UNVERIFIED** (not measured here).

## Spec-declared future / later / open / deferred

- §3.6 → §11: converting the §4 task views from bare keys to modifier chords is explicitly "open".
- D9, §4.6, §11.1: mouse clicks are not delivered to extension widgets/self-rendered rows by PiG 0.5.3 (wheel only); `handleMouse` exists for hosts that dispatch it; per-branch toggles have no keyboard path under PiG; §5.8 is the keyboard path; report upstream.
- §5.3 "OSC 8 hyperlink when the terminal supports it" — conditional, not implemented.
- §5.1 "Later slices add `screens/overview.ts` and `timeline.ts`" — stale, both exist.
- §11.0 "Env- and flag-locked settings are not marked in the panel until the settings store (§6.3) exists" — stale, `settingsStore.ts` exists and the panel does mark them; close the item.
- §11.2 pre-existing type errors (`agedSummaryConductor.ts` TS2612, `unfold`/`recall` execute return types) stay out of this work.
- §1 out of scope: new conductors, `core/truth.ts` folding semantics beyond §7, Tauri desktop shell, upstream package.
- Plan: S1 "Not in this slice: mouse; the footer (§8)"; Progress "`later S1c-rest` the spec's compact glyph form, if a live check shows the status text overflows" — deferred, not done (note the overflow is already demonstrable above).
- Plan stale deferrals (superseded by its own later text): "conductor options remain pending", "Hot reattachment … remain the next S2 result", "clean-production installation and authenticated asset gates remain required in S6/final verification".

BLOCKERS: none