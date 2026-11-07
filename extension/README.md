<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/logo-lockup-white.png">
  <img alt="Accordion" src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/logo-lockup-black.png" width="440">
</picture>

### /compact is the naive solution. Accordion is the intelligent one.

**See everything your AI agent holds in context — and fold it like an accordion instead.**

<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/accordion-hero.gif" alt="Accordion — the context map demo: blocks folding and unfolding while the protected tail stays intact" width="820">

</div>

---

Accordion is a [pi](https://github.com/earendil-works/pi) extension that shows you your
agent's entire context window at a glance and lets you manage it — manually or with
intelligence through a **conductor**.

The extension hosts the context state and provides a native Pi terminal panel. Browser and desktop interfaces remain optional. Use Pi-Bolt or Pi with Node.js 22.19 or newer.

## Install

For this fork, use the Pi package at the repository root. From a checkout:

```bash
npm install --legacy-peer-deps
pi-bolt -ne --offline -e ./extension/accordion.ts
```

Run `/accordion` to manage the current session in Pi's terminal (`1–4` / `Tab` switches
between the Claude Code `/context` Overview + Spectrum grid, searchable Blocks list, Conductors,
and Settings), `/accordion compact` to run an immediate compression pass, `/accordion tasks` to expand or
collapse the taskfold task list above the editor (also `alt+t`), `/accordion tasks lists` to browse
and attach the project's task lists (tasks show as ☐ todo, ▶/◐ in progress, ⧗ blocked with its
reason, ▣ done, ☒ failed, ⊘ abandoned) and drill into a task's details and folds. In the expanded
widget, ≡ means folded, · means finished but raw, and ! flags a finished parent with unfinished
children; progress counts are broken down by leaf status. Press `?` in the task list view for the
legend. Press `g` for the list's goal, pins and attachments; task details show criteria and inherited/task-scoped facts with attachment references. Inspection uses cached snapshots refreshed on task calls or reopening, never disk reads during rendering. Task screens temporarily hide the widget without changing its preferences, leaving room for content and controls in short terminals. Human child-handle unfolds recompose siblings through the controller lease. `p` pins transcript blocks, not scoped facts. Task lists have no fixed nesting-depth limit; invalid files are named in warnings and rejected migrations leave the original file unchanged. Use `/accordion tasks tree`
to see this session's transcript by task, `/accordion tasks dump-transcript [--format <tree|yaml|xml|md|flat> | --formats <a,b,…|all>] [file]`
to write that projection to a file. Every actual carrier appears once, including split/composed
and untracked groups; substituted results never print their original bodies. Inspection metadata
includes goals, criteria, scoped pins, attachments and recovery handles. The transient working set
is labeled as appended or only cached, and only appended tokens enter the projection totals.
Use `/accordion budget 200k` / `/accordion tail 20k` to set the
budget and protected tail (remembered per model; `--default` or `ctrl+s` in the panel saves them under
`modelDefaults`), or `/accordion sessions` to choose another live local session. Folding auto-arms with `keel-lite` by default (configurable
in `~/.accordion/config.json` or the Settings tab) and intercepts `/compact` with a reversible
Accordion pass.

Conductors that call models out of band route them through `models` in the same file. Set a
default per model type and override it per conductor id. Chat falls back to the session model.
A classifier falls back to the model the conductor is tuned for, if it names one (taskfold uses
`openrouter/perplexity/pplx-decider-v1.2`); otherwise a conductor that needs one stays degraded
until you configure it:

```json
{
  "models": {
    "defaults": { "chat": "openrouter/google/gemini-2.5-flash", "classifier": "local/minilm" },
    "conductors": { "taskfold": { "classifier": "local/deberta" } }
  }
}
```

A conductor that sends session content to a model running off this machine asks once for consent
before it attaches. Accepted notices are stored under `privacyConsent`.

Every new Taskfold list has a goal and can hold scoped pins and file attachments. The list browser asks for the title and goal when creating a list. Pins on the list and pins,
acceptance criteria and attachments on the active task's branch are sent with requests. Attachments
accept a path and optional lines (`spec.md:12` or `spec.md:12-20`); their contents are cached and
refreshed between turns, so an external edit may briefly be stale. Configure their display and pin
limits in `~/.accordion/config.json`:

```json
{
  "tasks": {
    "attachments": { "render": "reference", "maxLines": 60 },
    "pins": { "listTokens": 2000, "taskTokens": 1500 }
  }
}
```

`render` defaults to `inline`; `reference` sends only the locator and note.

Taskfold's pressure and aging policy can also be set in the same file (read when the conductor
attaches):

```json
{
  "taskfold": {
    "high": 0.8, "low": 0.6,
    "keepRecentTasks": 1, "recordTokens": 1500,
    "aging": [3, 6, 11], "floor": false,
    "untracked": { "enabled": true, "minSteps": 8 }
  }
}
```

The newest completed work stays open when older work suffices; under pressure it can fold too.
Aging advances older records during a folding epoch, preserving their recall handles. Setting
`floor` to `true` additionally applies recoverable per-block folding inside long open tasks and
untracked work, outside the protected tail; it is off by default.

Armed folding invalidates historical token-usage anchors in outgoing requests so Pi budgets
output against the actual serialized prompt, including restored content. Stored usage and costs
remain unchanged. Model switches reset provider-specific token calibration, and resumed sessions
need no prior Accordion state.

The optional browser and desktop entry point is `/accordion web` (or `/accordion-web`), using
memorable 8-character tokens (or a custom token) and an optional custom bind address (`ACCORDION_HOST`)
with single-port Door session proxying. Git installs build browser assets automatically. The package
excludes `.project/` development evidence, task-list state, worktrees and installed dependencies.
If installation scripts were disabled, run `npm run build:client` from the repository root;
see the [project README](https://github.com/furbyhaxx/pi-accordion).
Only one surface may steer at a time; another surface may ask to take control.

Do not load this fork and `npm:@a-fig/accordion` together: both register the same
tools and context hook.

## How it works

The **context Map** is the whole window at a glance: one square per block, sized by token
weight (a dice face, 1–6), colored by kind — **user** messages, **assistant** responses,
**thinking**, **tool calls**, and **tool results** each get their own hue. Bright = live;
recessed and hatched = folded.

Three hands share the controls:

- **You** — fold, unfold, pin, and peek by hand. Your overrides always win.
- **The agent** — reaches back to unfold or pin context it needs mid-task, or **recall**
  a folded block as a tool result (like `read_file`) without changing what's standing in
  context.
- **The Conductor** — an automatic strategy that, between turns, folds what's gone cold
  and unfolds what's becoming relevant. Collaborative by default; an *exclusive*
  conductor you approve can take over specific controls, and **detach** is always your
  kill switch.

Every block is **Full**, **Folded** (shown as a short tagged summary), or **Pinned**
(locked open). Folds are **content substitution, never removal** — provider-safe and
fully reversible. The most recent ~20k tokens are a **protected working tail** the agent
reasons over at full fidelity.

**Conductors are opt-in, same as folding itself** — pick one from the header's Conductor
menu, or leave it on "None" for fully manual steering. `compaction-naive`, `handoff`,
`doorman`, `keel-lite`, `keel-note`, and `taskfold` run right inside this extension, no extra setup. Two more, `thermocline`
(attention-gated compression under a hard budget invariant) and `triptych` (pressure-gated
thirds with tree-sitter code skeletons), each run as their own out-of-process Node program.
The root Git-installable package includes their runners; availability also depends on their runtime
dependencies. The separately bundled extension package may omit them. Picking a
conductor that takes over any steering control shows you a consent screen first — cancel or
detach anytime and your own edits are preserved.

<div align="center">
<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/attention-conductor.png" alt="Attention conductor view — each block tinted by how much the working tail still attends back to it" width="600">
</div>

## How the live link works

The extension holds the **authoritative** context state for your session — every fold,
pin, and group lives there, not in the browser tab. The GUI connects as a **replica**: it
hydrates from a full snapshot on connect, then stays in sync over a stream of small,
replayable events — no polling, and no round trip on the model-call path. Steering actions
(fold, pin, group, the budget/tail dials) are sent to the extension as commands; the
extension applies them to its own state and echoes the result back to every connected
client, so there's never more than one copy of the truth to disagree with. Only the one
surface currently holding control may send a command that actually changes anything —
every other connected client is a live mirror, so multiple open tabs/windows can never
silently race each other to steer the same session.

Folding is **opt-in and off by default** — flip the **Folding** toggle in the header to
start steering what the agent sees. When it's off, pi's `context` hook is a no-op and your
messages reach the model untouched. When it's on, the hook applies your **current** fold
state locally, in-process, immediately before the model call: there's no GUI round trip and
no timeout to tune, because the state the extension already holds *is* the state applied,
synchronously, every time.

A conductor's out-of-band completion calls (the LLM calls it makes to summarize or hand off
context) never appear on the `context` hook path. If you need their cost/usage for external
accounting, set `ACCORDION_COMPLETION_LOG=<path>` and the extension appends one JSON line
per completion (success or failure) to that file.

## Skills included

This package registers three Pi skills:

- **accordion-context-folding** — the `unfold` tool: restore a folded block into standing
  context (sticky, attributed to the agent).
- **accordion-context-recall** — the `recall` tool: read a folded block's full content as
  a tool result *without* mutating the view, like `read_file`. Never lockable.
- **accordion-task-lists** — create and validate nested task-list JSON from an implementation plan;
  includes a Node validator and field reference.

## What works today

- ✅ Browser-served UI — no desktop app required
- ✅ Live link to a running pi session
- ✅ Opt-in live steering — apply your fold plan to what the agent is shown
- ✅ Reversible, provider-safe folding with deterministic `{#code FOLDED}` digests
- ✅ Agent-driven unfold + `recall`, involvement locks
- ✅ The Conductor — automatic fold/unfold between turns
- ✅ LLM-generated summaries, computed once and cached

## Links

- **Fork source & docs:** [github.com/furbyhaxx/pi-accordion](https://github.com/furbyhaxx/pi-accordion)
- **Upstream:** [github.com/a-Fig/Accordion](https://github.com/a-Fig/Accordion)
- **Vision:** [VISION.md](https://github.com/a-Fig/Accordion/blob/main/VISION.md)
- **pi (the harness):** [github.com/earendil-works/pi](https://github.com/earendil-works/pi)

---

<div align="center">

🏆 &nbsp;Built at the **AI Hackathon 2026 @ UC Berkeley** — a winning project.

🪗

</div>
