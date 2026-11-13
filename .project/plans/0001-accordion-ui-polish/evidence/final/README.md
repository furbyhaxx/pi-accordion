# Final live matrix (final tree)

Same isolated setup as `evidence/web-parity-live.md`, re-run after the bake fix and the guidance
correction: `pi-bolt --offline` resumed on the 982-block sample, `ACCORDION_HOME` isolated,
`doorPort: 0`, six panel tabs.

| Capture | Columns |
|---|---|
| `overview-w*.txt` | 36 / 57 / 80 / 140 at 16 rows |
| `settings-w*.txt` | 36 / 57 / 80 / 140 at 16 rows |
| `card-w*.txt` | the compaction card at 36 / 57 / 80 / 140 |

| Check | Result |
|---|---|
| Folding armed from the Settings row | `[x] armed`, footer `accordion 12% · no conductor` |
| Compact preview | pass "conductor decides", aggressive −44479, bake −107836, native unknown |
| Aggressive run | 126.6k → 73.2k, card "aggressive · 0.0s · folded 103 thinking, 92 tool results, 44 texts" |
| `/accordion compact undo` | "Undid the last compaction: 239 block(s) unfolded." |
| Served index with token | 200; the page node carrying "Session host" is 200 with the port cookie and 403 without |
| Web `settings` / `tasks` messages | settings on hello and after the save (rev pair), tasks `list: null`, `folded: 0` |
| Save from a claimed browser surface | accepted; `config.json` `taskWidget.maxRows` 9 → 10 |
