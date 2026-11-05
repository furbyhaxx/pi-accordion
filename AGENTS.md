Read the entirety of @CLAUDE.md for upstream engine invariants. Fork-specific behavior below supersedes its desktop-launch instructions.

## Pi-native fork

- `extension/accordion.ts` owns the per-session authoritative `Truth`, controller lease, and automatically started local HTTP/WebSocket server. `/accordion` opens `extension/tui/` inside Pi; `/accordion-web` retains the optional browser and desktop entry point.
- Keep folding opt-in, apply user actions through `Truth`, and preserve the single-controller lease across all surfaces. Fork sessions coordinate controller writes through a SQLite sidecar mutex; unmodified upstream writers do not participate. A session switch or shutdown must never let a stale panel steer the new session.
- The root `package.json` declares the Git-installable Pi package. Host-provided Pi packages are `"*"` peers; runtime dependencies belong in `dependencies`.
- Browser install maintenance: root `prepare` runs `npm run build:client`, installing locked app build dependencies and copying the static build via `extension/build-client.mjs` to `extension/dist/client/`. If the installed UI reports no browser build, repair this lifecycle path, not only a development checkout; verify a clean production install and authenticated HTTP asset requests. The server discovers assets on every request, so building them needs no Pi restart.
- The Pi footer status (`extension/tui/status.ts`) shows folding, the active conductor and its status, colored by the status `level` metric, and notifies once per degraded episode.
- Persistent settings live in `~/.accordion/config.json` (`extension/settings.ts`), supporting `autoArm`, `defaultConductor`, `compactMode`, `bindHost`, `doorPort`, `customToken` (or generated 8-char memorable tokens), `models` (per-type defaults and per-conductor overrides for out-of-band chat and classifier calls), `privacyConsent`, `taskWidget`, and `modelDefaults` (budget/tail per `provider/model`, `provider/*` or `*`).
- Budget and protected tail resolve per model in `extension/dials.ts` (session value from `accordion.dials` entries → `modelDefaults` → context window / 20k) on the first Truth build and every model change; every `setBudget`/`setProtect` command records an entry. `extension/taskCoach.ts` appends task-protocol reminders to tool results and records each agent stop's `idleVerdict` as an `accordion.tasks.idle` entry.
- Task end states are a contract shared by the store (`extension/tasks.ts`), the `tasks` tool description in `extension/accordion.ts`, Taskfold's span scan and the views (SPEC-0001 §4.15): `done`/`failed`/`abandoned` finish a task, `blocked` pauses it with a required reason (`user-decision`, `user-input`, `third-party` justify stopping; `dependency` does not). Change them together.
- While the attached conductor provides the `tasks` tool, `extension/tui/taskWidget.ts` shows this session's task list above the editor (`/accordion tasks`, `alt+t`), and `extension/tui/toolRows.ts` draws one-line rows for `tasks`, `unfold` and `recall`. The widget reads list files only on reload (session start, `tasks` calls), never while rendering. `extension/taskSession.ts` settles a resumed session's previous list (silently or via the resume dialog in `extension/tui/taskLists.ts`), records `accordion.tasks.binding` entries, and delivers agent notes through `before_agent_start`; agent-facing texts live in `extension/taskBinding.ts`. The task drill-down and `/accordion tasks tree` build their model in `extension/tui/taskTranscript.ts` (pure, no Truth) and render through `extension/tui/treeView.ts`; actions go through the controller lease like the panel. Taskfold verdicts persist as `accordion.taskfold.verdict` entries (`conductors/in-process/taskfold/verdicts.ts`).
- Conductors that send session content to models declare `privacy` in the registry. Attach them through `selectConductor`, never `liveHost.select` directly, so the one-time consent gate applies. Conductor-declared `tools` are active only while that conductor is attached.
- Request budgeting is repaired in `extension/accordion.ts`'s `context_with_system` hook: armed folding clears request-local historical usage anchors so Pi estimates the actual outgoing prefix; stored receipts and costs stay unchanged. Model changes invalidate provider calibration and pending receipt pairing. `readSessionMessages` consumes chronological `getBranch()` fallback entries. Reproduce these paths with `node extension/smoke-context.mjs` (also included in `npm --prefix extension run smoke`).
- Verify native changes with `bun test extension/settings.test.ts extension/tui/*.test.ts`, `npm --prefix extension run smoke`, `npm --prefix app run check`, and `npm --prefix app test`. Exercise UI changes in a real Pi-Bolt terminal at narrow and wide sizes.

## Worktree convention

Before making any changes to the code, **always open a dedicated worktree** — never edit in the main checkout.

1. **Create a worktree off the latest `devmain`**, placed under `.pi/worktrees/` (already gitignored):
   ```bash
   git fetch origin
   git worktree add .pi/worktrees/<short-descriptive> -b <branch> origin/devmain
   cd .pi/worktrees/<short-descriptive>
   ```
2. **Do all work in the worktree** — edits, `npm install` (deps are per-worktree), verification (`npm run check`, `npm run test`, `node smoke.mjs`, `npm pack --dry-run` as applicable), commits, and the PR to `devmain`.
3. **Delete the worktree and its folder once the branch is merged** into `devmain` (or promoted to `main`):
   ```bash
   cd <main checkout>
   git worktree remove .pi/worktrees/<short-descriptive>
   git branch -d <branch>   # safe once merged; use -D only if the branch was abandoned
   ```
4. Notes:
   - The main checkout stays on `main` (the stable, registered-binary surface). Never branch from or PR into `main` directly — see CLAUDE.md → *Branching & PR workflow*.
   - Only one worktree may run the UI server on port 1420 at a time (`npm run dev` / `tauri dev`). Other concurrent worktrees should rely on `npm run check` / `npm run test` / `node smoke.mjs`, which claim no port.
   - If the branch is abandoned without merging, still `git worktree remove` it so `.pi/worktrees/` doesn't accumulate stale trees.
- `.project/` — development artifacts; never in `docs/`; committed. Load skill `dot-project` before writing one. Every Markdown artifact needs `document:` frontmatter (`.project/AGENTS.md`).
