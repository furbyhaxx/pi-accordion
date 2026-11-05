# Accordion

## Conductor - TaskFold

### Tool renderer

` ✓ tasks start 3.2 Watch config.json`

### Above Editor Widget

#### Collapsed

> can be mouse clicked to expand (the whole line)

Collapsed view is two lines,
first line shows `▲ Tasks {numCompleted}/{numTotal} (≡{numFolded}) · {totalWorkingTime_human} · {totalUnfoldedKiloTokens} → {effectiveFoldedKiloTokens} tok`
second line shows `  ⎿ {currentTaskNumer} {currentTaskTitle} · {currentTaskWorkingTime_human}`

Example:
```
▲ Tasks 5/20 (≡5) · 5m 12s · 26.7k → 10.1k tok
  ⎿ 3.4.1 the new registry · 1m 11s
```

When all tasks are completed it show a single line like:

Example:
```
► Tasks 20/20 (≡19) · 5m 12s · 26.7k → 10.1k tok
```

#### Expanded

States:
- `☐` = not started (dim)
- `▣` = completed (green)
- `☒` = blocked (red)
- `▶` = in-progress (orange/normal blinking slowly)

The first line of the expanded widget is the same as the collapsed except the glyph changed from `▲` to `▼`.

In full it would look something like this:
```
▼ Tasks 5/20 (≡5) · 5m 12s · 26.7k → 10.1k tok
  ├─▣ 0 Orientation, Analysis, Scope & Objective clarification · 1m 12s (fold)
  ├─▣ 1 Re-run benchmark, report deltas · 1m 12s (fold)
  ├─▣ 2 Redaction hook cost grows with registry size · 1m 12s (fold)
  ├─◐ 3 Secrets Redesign · 1m 12s (3/7)
  │ ├─▣ 3.1 keys + red-sec placeholders · 1m 12s (fold)
  │ ├─▣ 3.2 vault table (+metadata) · 1m 12s (fold)
  │ ├─▣ 3.3 Secrets.toml v2 config schema · 1m 12s (fold)
  │ ├─▶ 3.4 registry rewire to vault (0/3) · 1m 12s
  │ │    ├─▶ 3.4.1 the new registry · 1m 12s
  │ │    ├─☐ 3.4.2 vault adapter
  │ │    └─☐ 3.4.3 MemoryVault
  │ ├─☒ 3.5 prompt section, drop placeholder reminder
  │ ├─☒ 3.6 v1 Secrets.toml import
  │ └─☒ 3.7 scoped registry API
  ├─☐ 4 Scheme router
  │ ├─☐ 4.1 Scheme router core
  │ ├─☐ 4.2 secrets:// handler
  │ └─☐ 4.3 ask_user secret kind
  ├─☐ 5 benchmark
  └─☐ 6 redaction
```

Individual branches are clickable to expand/collaps using the mouse (the whole line).

But it's configurable how many lines the expanded view shows by default where we apply a smart hiding that would produce something like:
```
▼ Tasks 5/20 (≡5) · 5m 12s · 26.7k → 10.1k tok
  ├─ … 2 hidden · 1m 12s (2 folded)
  ├─◐ 3 Secrets Redesign · 1m 12s (3/7)
  │ ├─ … 3 hidden · 1m 12s (2 folded)
  │ ├─▶ 3.4 registry rewire to vault (0/3) · 1m 12s
  │ │    ├─▶ 3.4.1 the new registry · 1m 12s
  │ │    ├─☐ 3.4.2 vault adapter
  │ │    └─ … 1 hidden
  │ └─ … 3 hidden
  └─… 6 hidden
```
