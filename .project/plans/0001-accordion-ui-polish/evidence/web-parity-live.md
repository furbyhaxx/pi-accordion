# S6 web parity — live check

Session: `pi-bolt --offline` resumed on the 982-block sample, extension bundle from this worktree,
`ACCORDION_HOME=/tmp/acc-live/home`, `doorPort: 0`. Served page on port 46211.

| Check | Result |
|---|---|
| Served index with token | 200, contains the built app |
| Authenticated asset (`Cookie: accordion_token_p<port>=…`) | 200; bundles contain "Session host", "Compact the context", "No list attached" |
| `settings` on hello | rev present, 15 root keys, `taskWidget.maxRows` 9 |
| `tasks` on hello | `list: null`, `folded: []`, `tokens` equal full/live |
| Save from a browser surface after `claimController` | accepted, `config.json` `taskWidget.maxRows` 9 → 11 → 13 |
| Second save with the stale rev | `conflict: true`, "settings changed; reload and stage again"; file keeps 13 |
| Command from a socket that is not the controller | `refused: "read-only"` |
| `compact` command | `compaction` broadcast: `aggressive 126571 -> 126571`, notice "folded 0 block(s)" (applied after the earlier undo left every block open) |

Terminal captures for the panel and the compact preview: `evidence/tabs/` (`*-w36|57|80|140.txt` and `.ansi`).
Footer live: `accordion 12% · no conductor`.

## Full gates after the slices

| Gate | Result |
|---|---|
| `bun test extension/{settings,settingsStore,sidecarLock,tasks,dials}.test.ts extension/tui/ conductors/in-process/taskfold/` | 335 pass, 0 fail |
| `npm --prefix app test -- ../core/conductor/{liveHost,remote}.test.ts` | 63 pass |
| `npm --prefix extension run smoke` (with the built client) | OK, thermocline spawn and autoArm included |
| `npm --prefix app run check` | 0 errors, 0 warnings |
| `npm --prefix app test` | 1106 pass, 21 skipped |
| `npm --prefix extension pack --dry-run` | 502 files, 36.3 MB, `dist/client/index.html` and the skills present |

Core tests are vitest-only (`vi.advanceTimersByTimeAsync`); running them under `bun test` reports
seven failures that are an environment mismatch, not regressions — they pass under `app`'s vitest.
