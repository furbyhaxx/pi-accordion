# Compaction settings migration

12.11.2026, real Pi-Bolt 1.5.0 with the local source extension, an isolated Accordion home and
project, folding off, no model requests. The initial file contained `compactMode: "suppress"`.

The Settings picker showed `pass`; changing it to `native` and saving with `ctrl+s` removed
`compactMode` and wrote `{manual:"native", threshold:"pass", onSaturated:"warn"}`. A fresh Pi
process read that result. The selected value remained visible after real redraws at
36/57/80/140 columns, all 40 rows high; the Unicode width checker passed each capture.
`checks.json` records the persisted policies. Captures redact the throwaway web token.
Both owned terminal processes were stopped. Full strategy execution is evaluated in S4.
