Read the entirety of @CLAUDE.md for upstream engine invariants. Fork-specific behavior below supersedes its desktop-launch instructions.

## Pi-native fork

- `extension/accordion.ts` owns the per-session authoritative `Truth`, controller lease, and automatically started local HTTP/WebSocket server. `/accordion` opens `extension/tui/` inside Pi; `/accordion-web` retains the optional browser and desktop entry point.
- Keep folding opt-in, apply user actions through `Truth`, and preserve the single-controller lease across all surfaces. Fork sessions coordinate controller writes through a SQLite sidecar mutex; unmodified upstream writers do not participate. A session switch or shutdown must never let a stale panel steer the new session.
- The root `package.json` declares the Git-installable Pi package. Host-provided Pi packages are `"*"` peers; runtime dependencies belong in `dependencies`.
- Persistent settings live in `~/.accordion/config.json` (`extension/settings.ts`), supporting `autoArm`, `defaultConductor`, `compactMode`, `bindHost`, `doorPort`, and `customToken` (or generated 8-char memorable tokens).
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
