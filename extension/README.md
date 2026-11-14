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

Run `/accordion` to manage the current session in Pi's terminal. The panel has five tabs,
Context (map and block list, `alt+v` switches), Tasks, Lists, Conductors and Settings; `Tab` switches tabs,
typing filters the block list, `F1` lists the keys of the current tab. Every action is a modifier
chord (`alt+f` fold, `alt+p` pin, `alt+e` edit digest, `alt+c` compact, …); settings for all
sessions are staged and saved with `ctrl+s`. `/accordion context|conductors|settings` opens a tab
directly, `/accordion tasks tree|lists` the Tasks or Lists tab. Use `/accordion compact [pass|aggressive|bake|native] [instructions…]` to run a compression pass
directly and `/accordion compact undo` to reverse the last one, `/accordion tasks` to expand or
collapse the taskfold task list above the editor (also `alt+t`), `/accordion tasks lists` to browse
and attach the project's task lists (tasks show as ☐ todo, ▶/◐ in progress, ⧗ blocked with its
reason, ▣ done, ☒ failed, ⊘ abandoned) and drill into a task's details and folds. In the expanded
widget, ≡ means folded, · means finished but raw, and ! flags a finished parent with unfinished
children; progress counts are broken down by leaf status. Press `F1` in a task tab for the
legend, `alt+g` for the list's goals, pins and attachments, `alt+a` to attach or release a list, `alt+n` for a new one; task details show criteria and inherited/task-scoped facts with attachment references. Inspection uses cached snapshots refreshed on task calls or reopening, never disk reads during rendering. The panel temporarily hides the widget without changing its preferences, leaving room for content and controls in short terminals. Human child-handle unfolds recompose siblings through the controller lease and hold the selected blocks open; whole-task toggles remain reversible. `alt+p` pins transcript blocks, not scoped facts. Task lists have no fixed nesting-depth limit; invalid files are named in warnings and rejected migrations leave the original file unchanged. Use `/accordion tasks tree`
to see this session's transcript by task, `/accordion tasks dump-transcript [--format <tree|yaml|xml|md|flat> | --formats <a,b,…|all>] [file]`
to write that projection to a file. Every actual carrier appears once, including split/composed
and untracked groups; substituted results never print their original bodies. Inspection metadata
includes goals, criteria, scoped pins, attachments and recovery handles. Task context
(goals, criteria, pins, attachment content) reaches the agent once, in the result of `tasks start`
or `claim`, and folds with the task's span; it is sent again only once the model can no longer see
it (folded, compacted or edited). Every `tasks` result is one-line JSON with only what the tool
decided; refusals carry an error code. Nothing is appended to outgoing requests, so each
request extends the previous one and the provider cache stays warm. Sessions recorded before task
events are adopted on resume (`tasks.adopt`) or with `/accordion tasks adopt [--dry-run]`.
Use `/accordion budget 200k` / `/accordion tail 20k` to set the
budget and protected tail (remembered per model; `--default` or `ctrl+s` in the panel saves them under
`modelDefaults`), or `/accordion sessions` to choose another live local session. Folding auto-arms with `keel-lite` by default (configurable
in `~/.accordion/config.json` or the Settings tab) and intercepts `/compact` with a reversible
Accordion pass.

Settings saves merge only edited fields. A conflicting edit from another writer leaves your
changes staged and reports the field; unrelated edits are preserved. Environment variables and
CLI flags lock their fields in the panel, with flags taking precedence.

Compaction policies are stored in `compact.manual`, `compact.threshold` and `compact.onSaturated`.
Legacy `compactMode` configurations migrate on load and the old key is dropped on save.
`ACCORDION_COMPACT_MODE` keeps the legacy mapping and overrides all three policies on load.

Conductors that call models out of band route them through `models` in the same file. Set a
default per model type and override it per conductor id. Chat uses its tuned default, else the session model.
A classifier falls back to the model the conductor is tuned for, if it names one (taskfold uses
`openrouter/perplexity/pplx-decider-v1.2`); otherwise a conductor that needs one stays degraded
until you configure it.

Taskfold's chat extraction defaults to the first available `openai/gpt-6-luna` or
`openai-codex/gpt-6-luna`; when neither is installed it uses the session model with a warning.
Configured chat routes still win. Its privacy notice covers both classifier and chat content,
and asks again if you previously accepted only classifier use.
For example:

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

Every new Taskfold list has one to five goals (a task may add up to three of its own) and can hold scoped pins and file attachments. The list browser asks for the title and a goal when creating a list. Goals, criteria, pins and attachments carry list-unique ids (`g1`, `c1`, `p1`, `a1`) that are never reused; `tasks update` edits goals and criteria with `{add, remove, edit}`. Files from earlier versions are converted on their first write and the original is kept as `<slug>.v1.json` or `<slug>.v2.json`. Goals, criteria, pins and attachments reach
the agent once, in the `tasks start` or `claim` result, and are never added to later requests.
An attachment names a part of a file by what it is, not by line numbers: a Markdown `section`
(`"Token store > Interface"`), a code `symbol` (`"TokenStore.get"`, in `.ts`, `.tsx`, `.js`, `.py`
and `.rs` files) or an exact `quote`. A `lines` range (`spec.md:12-20`) is accepted as input and
stored as a quote of those lines. A section or symbol keeps working when the file is edited around
it; a quote is found again if it moves. When an attachment is delivered, the result says if it
`moved`, matched `fuzzy`, `changed` since it was attached, is `lost` or grew `too_large`. Edits the
agent makes while the task runs are never reported. Configure their display and limits in
`~/.accordion/config.json`:

```json
{
  "tasks": {
    "attachments": { "render": "reference", "maxLines": 60, "roots": ["/mnt/shared/knowledge-base"] },
    "pins": { "listTokens": 2000, "taskTokens": 1500 }
  }
}
```

`render` defaults to `inline`; `reference` sends only the locator and note. Attachments and pin
sources must be files inside the project, or absolute paths under a directory in `roots` (default
none), so a committed list cannot make the agent read arbitrary files. A list file in `.pig/tasks/`
may be a symlink to a list kept next to its plan; the store writes through the link.

Taskfold's pressure policy can also be set in the same file (read when the conductor
attaches):

```json
{
  "taskfold": {
    "timing": "eager",
    "leafForm": "record",
    "recordTokens": 1500,
    "floor": false,
    "untracked": { "enabled": true, "minSteps": 8 },
    "steps": { "enabled": true, "minSteps": 4 }
  },
  "conductorOptions": {
    "taskfold": { "high": 0.8, "low": 0.6, "maxLoss": 0.3, "keepRecentTasks": 0 }
  }
}
```

Previously saved `taskfold.high`, `taskfold.low` and `taskfold.keepRecentTasks` are migrated to
`conductorOptions.taskfold` on the next save; explicit values at the new path take precedence.
Settings edits validate the declared ranges and require `low < high`.

Finished tasks fold at the first safe request by default (`taskfold.timing: "eager"`), independent
of span length. `/accordion fold eager|lazy|pressure` records a session/model override. `lazy` waits
for a cold/expired cache or high pressure, while `pressure` waits only for high pressure. Resolution
is session → `modelDefaults` exact model → provider wildcard → `*` → global `taskfold.timing`.
Settings stages the global value until `ctrl+s`; the footer shows the resolved mode. Changes never
unfold existing groups. Cache TTL comes from the last provider payload when observable, else the
core profile (unknown backends: 5-minute prefix cache).

Armed Anthropic Taskfold requests also place a cache breakpoint before the innermost open task.
The request-local edit preserves content, TTL order and four slots, replacing a redundant OAuth
identity marker when needed. Missing/unsafe boundaries are skipped; `cache-frontier` debug records
name the edit or skip reason. Other APIs are unchanged, and cache hits are not guaranteed.

A finished root becomes stable whole-outcome history; records inside an open root become history
under pressure (`high`, `low`). Taskfold holds the protected-tail lock so finished spans need not
leave a token tail; your locked tail dial still limits pressure folding. Record form waits for a
following message. Set `taskfold.leafForm` to `"bracket"` to fold immediately while keeping the
closing message/result and its report raw; the opening call still folds. A parent restores child
reports only when it absorbs their closing calls. Pending user routing can delay either form,
but there is no cache-lookback veto. The first
request waits for the epoch. `keepRecentTasks` delays folds intentionally. Under pressure, `steps`
groups old finished steps of a still-open task into a
recallable step carrier, so one long task cannot fill the context; the task's start message, user
messages and your tail dial stay live, and the carriers merge into the task's record when it
finishes. Setting `floor` to `true` additionally applies recoverable per-block folding inside
long open tasks and untracked work, outside your tail dial; it is off by default.

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

## Replay benchmark

From a source checkout, run `node extension/replay-session.mjs <session.jsonl> [--conductor <id>|none] [--budget <tokens>] [--tail <tokens>] [--limit-requests <n>] [--sample-every <n>] [--out <file.json>]`.
It reports hook and commit time, live and full token estimates, wire size, invalidated cache-prefix characters and folds.
Taskfold runs without privacy consent, so classifier and chat calls are not benchmarked. The output contains metrics, not session text.

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

`recall` returns at most `callTokens` per call and keeps at most `liveTokens` of recalled text in
the context. A recall result is replaced by a one-line note naming the call once `keepSteps`
assistant messages followed it and room is needed; a call that still does not fit is refused with
one line:

```json
{ "recall": { "callTokens": 8000, "liveTokens": 24000, "keepSteps": 3, "unfoldTokens": 20000,
              "ask": { "enabled": true, "inputTokens": 24000 }, "ledger": { "enabled": true } },
  "guard": { "resultTokens": 16000 } }
```

While folding is armed, a tool result larger than `guard.resultTokens` is clipped to its first and
last 1,500 tokens before the model sees it; the agent reaches the rest with `recall` (search or
pages). `0` turns this off.

The agent's `unfold` restores a fold only when it adds at most `recall.unfoldTokens` and the context
has room for it; otherwise the fold stays folded and the agent is told to use `recall`. Your own
unfolds in the panel are not limited.

`recall({ask: "…"})` lets the agent put a question to folded context: another model call reads the
matching task reports and excerpts (at most `recall.ask.inputTokens`) and returns a short answer
with entry addresses as citations. It runs on the session's model unless you set
`models.conductors.recall.chat`; a different remote model asks for consent once. Without a usable
model the agent gets the matching excerpts instead.

By default, the fact ledger reads finished folded tasks of at least 2,000 tokens and notes values
(counts, hashes, paths, ports, errors). A note is kept only when its value occurs verbatim in the
cited entry. Recall searches show matching notes first, so the agent can find "subvolume id" even
when the transcript says `subvolid=324`. Extraction uses up to four additional model calls per task,
which can incur cost; it uses `models.conductors.recall.chat`, the default chat model, or the session
model. A different remote model requires prior recall privacy consent and is not prompted for in
the background. Set `recall.ledger.enabled` to `false` to disable extraction.

A conductor's out-of-band completion calls (the LLM calls it makes to summarize or hand off
context) never appear on the `context` hook path. If you need their cost/usage for external
accounting, set `ACCORDION_COMPLETION_LOG=<path>` and the extension appends one JSON line
per completion (success or failure) to that file.

## Debug diagnostics

Enable `debug` in Settings or `~/.accordion/config.json`, or use `/accordion debug on|off` for
this session (restored on resume). Private JSONL logs live in `~/.accordion/debug/<sessionId>.jsonl`
under `ACCORDION_HOME` when set. They explain fold declines, request estimates/cache receipts,
successful folds, out-of-band completion usage/replies and rejected task calls. Finished tasks
still raw after 40 tool results raise a warning naming the reason. Logs are mode 0600, capped
at 50 MiB per session, and written asynchronously, never synchronously on the context hook.

`/accordion debug bundle [file]` writes a mode-0600 `.json.gz` archive containing named
`debug.jsonl`, `transcript.txt` and `settings.json` files (the web token is redacted).
It refuses to overwrite an existing file. The archive contains session content: inspect it
before sharing. To inspect the archive: `gzip -dc <file> | jq .files`.

From a source checkout, `node extension/audit-tasks.mjs <session.jsonl> [--diagnostics <debug.jsonl>]`
prints aggregate task-protocol counts without message bodies. The diagnostics filename must match
the session ID, but that alone does not pair its records to requests. A complete non-forked session
starts without an active task; inherited sessions, mixed or incomplete nested batches, concurrent
calls and attachments to an unknown task state make attribution unknown.
Counts accompanied by `incompleteNested` or `incompleteTasks` are partial. Provider receipts and
current diagnostics do not provide trusted, paired token counts, so budget and leaf-token metrics
remain unknown. Out-of-order starts are counted only while the whole task tree can be reconstructed;
`orderViolationsObserved` remains a lower bound when any start is unknown. Explicit superseding
actions are counted separately from `planChanges`; neither proves the total number of semantic plan
repairs. `callsBeforeFirstStart` counts non-exempt results.

## Skills included

This package registers three Pi skills:

- **accordion-context-folding** — the `unfold` tool: restore a folded block into standing
  context (sticky, attributed to the agent).
- **accordion-context-recall** — the `recall` tool: look up folded content as a tool result
  *without* mutating the view. A task code returns its report; `query` searches all folded content
  and `code.N` reads one entry. Bounded per call and per session. Never lockable.
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
