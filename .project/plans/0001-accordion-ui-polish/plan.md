---
document:
  type: "plan"
  id: "PLAN-0001"
  title: "Accordion UI polish implementation"
  description: "Slices, order, files and done criteria for implementing SPEC-0001 after the delivered Taskfold visibility unit."
  status: "published"
  revision: 2
  created_at: "2026-11-05T09:55:00+01:00"
  updated_at: "2026-11-05T12:10:31+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
    - revision: 2
      reason: "S0 grew with user-requested Taskfold work"
      changes: ["S0 progress line covers SPEC §4.8–4.14 on feat/taskfold-widget"]
---

# Accordion UI polish: plan

Spec: `.project/specs/0001-accordion-ui-polish.md` (SPEC-0001). Section references (§) point there.
The spec decides *what*; this plan decides *order, branches and done criteria*. When an
implementation must deviate, update the spec in the same change.

## Progress

```
done  S0  Taskfold visibility unit and task tooling (§4)  feat/taskfold-widget  8c2fb44…HEAD (pushed)
next  S1  Panel shell, chrome, footer (§3, §5.1–5.2, §8)
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

## S1: panel shell, chrome, footer

Goal: the new frame, tabs, hint fitting and key semantics around today's screen *contents*, so
later slices only replace bodies.

Steps:
1. `extension/tui/chrome.ts`: `fitSegments(segments, width)` (moved from `taskWidget.ts`, which
   then imports it), `fitHints(hints, width)` (§3.7), `ruleLine(width, token)`,
   `renderFrame(...)` (§5.2). Unit tests in `extension/tui/chrome.test.ts`: priority dropping,
   `? keys` retention, width matrix 36/57/80/140, crumbs reduced below 57.
2. `extension/tui/screens/types.ts`: the screen contract (§5.1) verbatim.
3. Split `panel.ts`: move today's blocks/map/list, inspect, help, conductors, consent and settings
   bodies into `screens/*.ts` implementing `Screen`, unchanged in content. `panel.ts` keeps the
   `ctx.ui.custom` loop, the tab stack, read-only handling, `pending` command state and the digest
   editor round trip.
4. Keys per §3.6: Esc back-one-level (consent → conductors, editor → settings), bare letters off
   in filter mode, Tab/Shift+Tab/1–4, `ctrl+c` closes.
5. Remove the accent repaint of selected rows (§3.5); selection marker `›`.
6. Footer (§8): `footerText` → segments `acc <pct>% · <id> <glyph>`; usage pct = live/budget;
   update `extension/tui/status.test.ts`.
7. Update `extension/tui/panel.test.ts` to the new structure (assert observable frame lines and
   key outcomes, not internals).

Done when: tests and smoke pass; live capture at 36/57/80/140 × 16 rows shows no truncated
hint-critical keys and no overflow; every pre-existing panel action still works (fold, pin, auto,
group, edit digest, conductor attach with consent, settings edits).

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
