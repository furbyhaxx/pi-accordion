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
