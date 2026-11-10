---
document:
  type: "plan"
  id: "PLAN-0001"
  title: "Accordion UI polish implementation"
  description: "Slices, order, files and done criteria for implementing SPEC-0001 after the delivered Taskfold visibility unit."
  status: "published"
  revision: 3
  created_at: "2026-11-05T09:55:00+01:00"
  updated_at: "2026-11-10T10:38:03+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 3
      reason: "S1 delivered on the dashboard standard instead of the bare-key shell"
      changes: ["S1 rewritten and marked done", "task views and footer split off as S1b", "evidence/ captures added"]
---

# Accordion UI polish: plan

Spec: `.project/specs/0001-accordion-ui-polish.md` (SPEC-0001). Section references (§) point there.
The spec decides *what*; this plan decides *order, branches and done criteria*. When an
implementation must deviate, update the spec in the same change.

## Progress

```
done  S0  Taskfold visibility unit and task tooling (§4)  feat/taskfold-widget  8c2fb44…HEAD (pushed)
done  S1  Panel shell on the dashboard standard (§3, §5.1–5.2)  feat/panel-shell (not merged)
now   S1b Task views inside the panel (§11 item 0)
later S1c Footer (§8)
later S2  Settings store, sync, schema (§6.1, §6.3)
later S3  Settings screen (§6.2)
later S4  Compaction (§7)
later S5  Panel screens (§5.3–5.8)
later S6  Protocol v23 and web app (§9)
```

Dependencies: S1 → S3, S5. S2 → S3, S4 (compact settings), S6. S4 → S5 (Overview compact entry) and
S6. S3 and S4 can run in parallel after S2.

## Branching and environment

- Base: `feat/taskfold-widget` until it is merged into `feat/pi-native`; then `feat/pi-native`.
  (`origin/devmain` lacks Taskfold and the `tasks` tool, so the `AGENTS.md` default base does not
  apply to this work.)
- One worktree and branch per slice under `.pi/worktrees/`:
  `git worktree add .pi/worktrees/<slug> -b <type>/<slug> <base>`. Slice branch names:
  S1 `feat/panel-shell`, S2 `feat/settings-sync`, S3 `feat/settings-screen`,
  S4 `feat/compaction`, S5 `feat/panel-screens`, S6 `feat/web-parity`.
- Dependencies: `extension/node_modules` is per worktree (`npm --prefix extension ci`); the
  root `node_modules` of the main checkout resolves root imports by directory walk.
- Type check (no project gate exists for `extension/`): run TypeScript 5.9 with a temporary
  tsconfig over `extension/accordion.ts` (see the handoff for the exact command). The baseline has
  pre-existing errors in `conductors/in-process/agedSummaryConductor.ts` (TS2612 ×3) and
  `extension/accordion.ts` (TS2345 ×2 on `origin` in the WebSocket origin check, `unfold`/`recall` execute TS2322 ×2).
  A slice MUST NOT add errors.
- Live PiG runs use an isolated home: `ACCORDION_HOME=/tmp/acc-home` with a `config.json` that
  sets `doorPort: 0` (do not fight the user's running instances for the door), and
  `pig --no-session -ne -e <worktree>/extension/accordion.ts --model deepseek/deepseek-flash`.
- Commits: Conventional Commits, granular, no AI attribution. Each commit builds and tests green.

## S1: panel shell on the dashboard standard

Goal: `/accordion` follows the house dashboard standard (skill `extending-pig`,
`references/dashboard-standard.md`; reference implementation `pig-auth-plus`
`internal/ui/frame`) around today's screen *contents*, so later slices only replace bodies.
Branch `feat/panel-shell`, worktree `.pi/worktrees/panel-shell`.

Design:

- **Frame**, nine lines on every screen: top rule (crumbs `Accordion › Tab › …`, `↑ N more` in
  the middle, state on the right), tab bar (chips separated by `❱`, active chip bold on the
  accent background), search line, blank line, body, middle rule, description (or `▲ message`),
  hint row (dropped by priority, `esc` kept), bottom rule (`↓ N more`). Rules take the
  thinking-level color; text inside them is dim.
- **Height**: body rows = clamp(terminal rows − 12, 3, 14), computed on open and on resize only.
- **Tabs**: Context ❱ Conductors ❱ Settings. Context has two views, map and list (`alt+v`);
  typing in the map view switches to the list and filters. Left/Right switch tabs except in the
  map view, where they move the cell.
- **No single-key actions.** Printable keys only type into the filter or an inline input.

| Key | Action |
|---|---|
| Tab / Shift+Tab | next / previous tab |
| Enter | inspect block, attach conductor, edit or toggle a setting, choose in a confirm |
| Esc | clear filter, then back one level, then close (asks when settings are staged) |
| Ctrl+C | close at any depth (asks when settings are staged) |
| F1 | help for the current tab |
| Ctrl+U | clear the filter |
| Alt+F / Alt+P / Alt+U | fold or unfold / pin or unpin / return the block to auto |
| Alt+E / Alt+R | edit the digest / restore the engine digest (Settings: regenerate the token, asks first) |
| Alt+M / Alt+N | mark the range start / new group from the range |
| Alt+G / Alt+D | fold or unfold the group / delete the group (asks first, `Keep` first) |
| Alt+V | Context: map ↔ list; Inspector: original ↔ digest |
| Alt+O / Alt+C | folding on or off / compact now |
| Ctrl+S | Settings: save staged values |

- **Settings**: rows `label · value · source`. Session rows (folding, budget, tail) apply at once.
  Global rows are staged (`▲`), saved with `ctrl+s` through one `host.updateSettings` patch;
  source is `default`, `user`, `session` or `staged`. Toggles `[x]`/`[ ]`; cycled values
  `‹ value ›` with Left/Right. A budget or tail value is followed by a scope prompt
  (`This session` / `This session and default for <model>`).
- **Conductors**: consent is a confirm screen, `Cancel` first.
- **Colors**: theme tokens only; every state color has a glyph or word.
- The block filter is a substring match over kind, id, tool name and text, not the host's fuzzy
  matcher: fuzzy matching whole block bodies returns noise.

Not in this slice: the task views (`extension/tui/taskViews.ts`, `taskLists.ts`) still use bare
keys (`n c r v g ? t u f i d p /`); mouse (not delivered to TypeScript components, SPEC D9);
the footer (§8).

Files: `extension/tui/chrome.ts` (+ test), `extension/tui/panel.ts`, `extension/tui/screens/*.ts`,
`extension/tui/panel.test.ts`, `extension/tui/host.ts` (`thinkingLevel`), `extension/accordion.ts`
(entry points `/accordion settings|conductors|context`, thinking-level repaint).

Done when: tests and smoke pass; live capture at 36/57/80/140 columns and 16 rows shows no
overflow; a test sends every printable ASCII key to every screen and nothing fires; every
pre-existing panel action still works.

Result: delivered on `feat/panel-shell`. 217 bun tests, smoke and the tsc baseline of 7 hold.
`evidence/` holds 48 live PiG captures (12 screens at 36/57/80/140 columns, two at 16 rows), each
taken with its own `ACCORDION_HOME` so no run meets the previous one's controller lease.

## S1b: task views inside the panel

Current: `/accordion tasks lists` and `/accordion tasks tree` open their own overlay
(`TaskListsBrowser`, `TaskViews`) with a six-line frame and bare-key actions
(`n c r g ? t u f i d p v /`). The resume flow reuses the browser in `pick` mode.

Change: one dashboard. Tab order `Context ❱ Tasks ❱ Lists ❱ Conductors ❱ Settings`.

- **Tasks** = this session's transcript by task (the former tree). **Lists** = the project's task
  lists; Enter drills list → task details → span → block text. Both are `PanelTab`s built by
  `screens/tasks.ts` over one screen stack (`TaskViews` in `taskViews.ts`); the list rows move into
  it and `TaskListsBrowser` is deleted.
- The tabs exist when the host provides `tasks` (local session only; a remote session panel has
  none). Lists needs the `tasks` tool's conductor (`TaskSession`), else the tab says so.
- `/accordion tasks tree` and `/accordion tasks lists` open the panel on that tab.
- Keys: typing filters; `alt+f` fold or unfold (step, fold, task record); `alt+p` pin; `alt+i` the
  other view of a task (span from a list, details from a tree); `alt+g` list goals and context;
  `alt+v` record ↔ original, and all/tasks/untracked on the session tree; `alt+t` attach, release
  or take over a list (take-over asks, keep first); `alt+n` new list (inline title, then goal).
  The legend moves to `F1`.
- Panel body cap rises from 14 to 20 rows: the tree tabs are the tallest content.
- Resume flow: "Choose another list" becomes host `select`/`input` dialogs; the resume dialog keeps
  arrows and Enter, and its take-over confirm lists keeping first.

Do not: read list files while rendering; keep a second frame for the task views.

Tests: `taskViews.test.ts` and `taskLists.test.ts` move to the chords; both tabs join the
printable-key sweep in `panel.test.ts`.

## S2: settings store, sync and schema

Steps:
1. `extension/sidecarLock.ts`: `withSidecarLock(path, action)` and async retry wrapper extracted
   from `withControllerLeaseLock`/`claimWithControllerLeaseLock` in `extension/accordion.ts`;
   the controller lease uses it (no behavior change; smoke covers it).
2. `extension/settings.ts`: new keys `compact`, `conductorOptions` (§6.1; `modelDefaults` is
   delivered, §4.12); `compactMode` migration and `ACCORDION_COMPACT_MODE` mapping;
   strict validators returning `{ ok, error }`.
3. `extension/settingsStore.ts` (§6.3) with `sources`, `rev`, `save` (lock, re-read, conflict,
   merge, validate, atomic write), `poll`.
4. Wire into `extension/accordion.ts`: replace `settings = loadSettings(...)`/`saveSettings` uses
   with the store; poll inside `pollControllerFile`'s tick; runtime-effects table (§6.3) including
   door-secret adoption and privacy revoke detach; a `modelDefaults` change re-resolves the dials
   (`dialModel = null; applyDials()`), never overriding a value set in the session.
5. Registry option specs (§6.1): `ConductorOptionSpec`, factories receive resolved options,
   Taskfold declares `high`/`low`/`maxLoss`/`keepRecentTasks`; Taskfold status gains `saved` metric.
6. `AccordionTuiHost` (`extension/tui/host.ts`): `settings()` returns `SettingsSnapshot`;
   `updateSettings(patch, baseRev)` returns the store result.
7. Tests: `extension/settingsStore.test.ts` (merge under lock from two stores on one home,
   conflict on same field, migration, strict validation messages, sources for env/flag),
   registry option resolution.

Done when: tests and smoke pass; the two-instance check of §10 passes live.

## S3: settings screen

Implements §6.2 on the S1 shell and S2 store: sections, staging, `ctrl+s`/`ctrl+r`/`u`, locks,
pickers (conductors from the registry; models from `ctx.modelRegistry.getAvailable()` plus
`current` for chat), inputs with inline validation, Web UI and Privacy immediate actions, dirty
guard on Esc/`ctrl+c`. Done when every key of §6.1 can be changed from the panel and the change
is visible in a second instance within 2 s.

## S4: compaction

Implements §7: `LiveHost.requestPass` (in-process await, remote settle rule), additive
`turn-committed` fields, `runCompaction` and its four strategies, trigger mapping in
`session_before_compact`, `buildBakeSummary` with cap and tag stripping, undo record and
`/accordion compact [strategy] [instructions…] | undo`, `accordion.compact` custom entry and
renderer, preview screen. Remove `compactNow`. Tests: strategy selection per trigger, settle and
timeout, undo inverse, bake format and cap. Live: `/compact` with Taskfold attached shows the
card; threshold passes stay quiet when they succeed.

## S5: panel screens

Implements §5.3–5.8: Overview (landing), Context timeline (`timeline.ts` + tests) with grid and
list views, Inspector header, Conductors detail/options link, Help, Tasks view sharing the widget
controller's view state.

## S6: protocol v23 and web app

Implements §9: protocol types and version bump, host handling of the new commands (controller-only
writes), broadcasts, `liveClient` handling, `SettingsPanel` session-host section, `TasksPanel`,
`MapHeader` overview numbers, `CompactDialog`. Gates: `npm --prefix app run check`,
`npm --prefix app test`, served-build smoke (`npm run build:client`, authenticated asset request).
