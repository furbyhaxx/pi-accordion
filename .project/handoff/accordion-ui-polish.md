---
document:
  type: "handoff"
  id: "HO-accordion-ui-polish"
  title: "Resume: Accordion UI polish (SPEC-0001 / PLAN-0001)"
  description: "Self-contained brief to continue the Accordion panel, settings, compaction and web work in a fresh session, starting at slice S1."
  status: "published"
  revision: 2
  created_at: "2026-11-05T10:05:00+01:00"
  updated_at: "2026-11-05T12:10:31+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
    - revision: 2
      reason: "S0 grew with SPEC §4.8–4.14 and was pushed and installed"
      changes: ["state table, done list and verification updated"]
---

# Resume: Accordion UI polish

## Goal

Implement `.project/specs/0001-accordion-ui-polish.md` (SPEC-0001) slice by slice following
`.project/plans/0001-accordion-ui-polish/plan.md` (PLAN-0001). Read both completely before
writing code. The spec is decided and approved by the user; do not re-open its decisions
(§2 D1–D9). If reality forces a deviation, update the spec in the same commit and say so.

## Repository and state

| Item | Value |
|---|---|
| Repo | `/mnt/Projects/furbyhaxx/pi-accordion` (Pi-native fork of Accordion; read `AGENTS.md` and `CLAUDE.md` first) |
| Main checkout branch | `feat/pi-native` |
| Delivered work | branch `feat/taskfold-widget` (worktree `.pi/worktrees/taskfold-widget`), pushed to `origin`, not merged. The user's PiG installs `git:https://github.com/furbyhaxx/pi-accordion@feat/taskfold-widget`. |
| Next slice | S1 (panel shell, chrome, footer) |
| Host | PiG 0.5.3 (`pig`, Go binary hosting Node extensions out of process; docs in `~/.pig/docs/bundle-*/`), Pi packages `@earendil-works/*` 1.5.0 in `extension/node_modules` |

Before starting S1, ask the user whether `feat/taskfold-widget` has been merged into
`feat/pi-native`; branch S1 from whichever holds the delivered commits (plan § Branching).

## What is done (S0)

- `extension/tasks.ts`: `Task.startedAt`/`endedAt`.
- `conductors/in-process/taskfold/taskfold.ts`: exported `scanTaskSpans`, `taskKeyOfSummary`.
- `extension/settings.ts`: `taskWidget` settings (`mode`, `expanded`, `maxRows`, `toggleKey`).
- `extension/tui/taskTree.ts` (tree, summary, smart hiding), `extension/tui/taskWidget.ts`
  (render, component with blink and `handleMouse`, controller), `extension/tui/toolRows.ts`
  (self-shell rows for `tasks`/`unfold`/`recall`), tests next to each.
- `extension/accordion.ts`: widget controller wiring, `tasks` results with `details`,
  `/accordion tasks [expand|collapse|hide|show]`, `alt+t` shortcut.
- SPEC §4.8–4.14 on the same branch: resume dialog and agent notes for a session's task list,
  `/accordion tasks lists` with drill-down (task tree, details, span view, text viewer, fold/pin/
  unfold actions), `/accordion tasks tree`, task protocol repair and coaching, Taskfold
  overlap-safe edges, `keepRecentTasks`, aging ladder, persisted classifier verdicts, task
  `createdAt`, per-model budget/tail with `modelDefaults`, persisted widget expansion.
- Docs: `README.md`, `extension/README.md`, `AGENTS.md`.
- Verified at the latest S0 commit: 129 bun tests (`extension/tui`, `extension/*.test.ts`,
  `conductors/in-process/taskfold`), smoke, tsc baseline of 7, live PiG runs of every view.
  Earlier S0 checks: 72 bun tests, `npm --prefix extension run smoke`, live PiG at 36/57/80/140 with a
  real model (rows, collapsed/expanded/all-done, fold markers `(≡3)` and `8.2k → 4.0k tok`,
  hide/show, error row).

## Commands

```bash
# per worktree
npm --prefix extension ci
bun test extension/settings.test.ts extension/tasks.test.ts extension/tui/ conductors/in-process/taskfold/
npm --prefix extension run smoke
npm --prefix app run check && npm --prefix app test          # S6, or when shared types change
```

Type check (there is no project gate for `extension/`). Write this tsconfig with `W` set to the
worktree path, then `npx -y -p typescript@5.9 tsc -p /tmp/tsconfig.acc.json`:

```json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true,
    "noEmit": true, "skipLibCheck": true, "allowImportingTsExtensions": true, "types": ["node"],
    "typeRoots": ["W/extension/node_modules/@types"], "baseUrl": "W",
    "paths": { "@earendil-works/*": ["extension/node_modules/@earendil-works/*"], "typebox": ["extension/node_modules/typebox"] } },
  "files": ["W/extension/accordion.ts"] }
```

Baseline: exactly 7 pre-existing errors (TS2612 ×3 in `agedSummaryConductor.ts`; in
`accordion.ts` TS2345 ×2 on `origin` in the WebSocket origin check and TS2322 ×2 on the
`unfold`/`recall` `execute` return types). Adding any is a failure; fixing them is out of scope.

Live run (isolated, never touches the user's Accordion state or door):

```bash
rm -rf /tmp/acc-home /tmp/acc-proj && mkdir -p /tmp/acc-home/.accordion /tmp/acc-proj && git -C /tmp/acc-proj init -q
cat > /tmp/acc-home/.accordion/config.json <<'EOF'
{ "autoArm": true, "defaultConductor": "taskfold", "doorPort": 0,
  "privacyConsent": { "taskfold": "2026-11-05T08:00:00.000Z" },
  "taskWidget": { "mode": "auto", "expanded": false, "maxRows": 9, "toggleKey": "alt+t" } }
EOF
tmux new-session -d -s acc -x 100 -y 40 \
  "cd /tmp/acc-proj && ACCORDION_HOME=/tmp/acc-home pig --no-session -ne -e <worktree>/extension/accordion.ts --model deepseek/deepseek-flash"
tmux capture-pane -p -t acc            # -e for colors; tmux resize-window -t acc -x 36 for widths
```

PiG warns about skill name collisions with the installed fork; harmless. Drive the agent with a
prompt that tells it to use only the `tasks` (and `bash`) tools. To force folding, open
`/accordion`, set budget (`b`) to ~6000 and tail (`t`) to ~500.

## Traps

- **PiG does not deliver mouse clicks to extension components.** Wheel events arrive; clicks on the
  widget and on self-rendered tool rows do nothing (SGR click injection verified). Keep every click
  action reachable by key (SPEC §4.6, §5.8, D9).
- **Fake Pi objects in smoke harnesses** (`extension/smoke*.mjs`) must gain any new `pi.*`
  registration you call at load time (S0 added `registerShortcut: () => {}` to six fake objects across four files).
- **Smoke contexts lack `sessionManager`**; guard with `typeof ctx.sessionManager?.getSessionId ===
  "function"` like existing code does.
- **`Group.digest`** (`core/types.ts`, the Truth's groups) holds a group's summary text; the
  conductor view (`core/conductor/contract.ts`, `host.groups()`) calls the same field `summary`.
- **Custom messages reach the model** (`convertToLlm` maps `custom` to `user`). Use
  `pi.appendEntry` + `registerEntryRenderer` for transcript-only cards (SPEC §7.6).
- **Shortcuts register at load**, so a changed `taskWidget.toggleKey` applies on the next Pi start.
- **`origin/devmain` lacks Taskfold**; never branch this work from it.
- Do not edit `~/.pig/agent/settings.json`, push, or open PRs without asking the user.
- Tool and conductor IO stays off the `context` hook path (`CLAUDE.md` invariant); the task widget
  reads list files only on reload, never in `render`.

## Open items

1. PiG click routing for extension components: to be reported upstream by the user.
2. Merge of `feat/taskfold-widget` into `feat/pi-native` (user decision) before S1 branches.
