# pi-accordion

A Pi-native fork of [Accordion](https://github.com/a-Fig/Accordion) for inspecting and
folding agent context in the terminal. Run `/accordion` for the current session or
`/accordion sessions` to choose another. See [Quick start](#quick-start).

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-lockup-white.png">
  <img alt="Accordion" src="docs/assets/logo-lockup-black.png" width="440">
</picture>

### /compact is the naive solution, Accordion is the intelligent one.

**See everything your AI agent holds in context — and fold it like an accordion instead.**

<img src="docs/assets/accordion-hero.gif" alt="Accordion — the context map demo: blocks folding and unfolding while the protected tail stays intact" width="820">

<sub>Your whole context window split in 2 sections. The lower section represents your agent's most recent context and is protected against any interference</sub>

[Upstream project](https://get-accordion.dev/) &nbsp;·&nbsp; [VISION.md](VISION.md)
</div>

---

This fork of [Accordion](https://github.com/a-Fig/Accordion) is a Pi extension for inspecting and managing an agent's context inside the terminal, manually or with an automatic conductor.

<div align="center">

<a href="docs/assets/accordion-demo.mp4"><img src="docs/assets/map-hero.png" alt="Accordion's context Map — a live pi session rendered as a grid of colored blocks" width="860"></a>

</div>

When folding is armed, Accordion clears historical token-usage anchors only in the outgoing
request, allowing Pi to size output against the actual folded or restored prompt. Stored usage
and costs are unchanged. Switching models also resets provider-specific token calibration;
resumed sessions can start without any prior Accordion state.

## Why it's different

#### 1. No blocking calls for compaction
> your context window is automatically managed for you in the background, keeping you below your limit

#### 2. Longer, more useful sessions
> The relevance of each block is ranked so we only fold bloat, and keep what's important.

#### 3. Cheaper inference costs
> Accordion keeps your context window lean, with cache optimizations in mind.

Every long-running agent hits the same wall: the context fills up, and something has to
go. Today's answers are dumb and dumber:

- **Compaction** blasts your whole history into one lossy summary — slow, destructive,
  all-or-nothing.
- **Sliding windows** just drop the oldest tokens — the agent simply forgets.

| | Sliding window | `/compact` | skills & memory | 🪗 Accordion |
|---|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ if retrieved | ✅ |
| **Reversible** to full detail | ❌ | ❌ | ❌ | ✅ |
| No mid-task stall | ✅ | ❌ | ✅ | ✅ |
| Per-section, not all-or-nothing | ❌ | ❌ | ⚠️ | ✅ |
| You can see and steer it | ❌ | ❌ | ❌ | ✅ |
| No extra infra (no vector DB) | ✅ | ✅ | ❌ | ✅ |

## The proof — early, but pointed

Accordion ships with a catalog of interchangeable **Conductors**. The strongest so far,
**[Thermocline](conductors/ws/thermocline/)**, scores each block relevance to the most recent context using the attention from a 500M parameter model as a proxy.

In a test run on **SlopCodeBench** (a long-horizon coding benchmark), Thermocline at a
100k-token budget outperformed naive compaction with the same constrained context budget. Both used DeepSeek V4 Pro.

| Conductor | Context Budget | Score | Checkpoints reached |
|---|:---:|:---:|:---:|
| **Thermocline** | 100k | **83.3%** | 5 / 6 |
| naive compaction | 100k | 33.3% | 2 / 6 |

> ⚠️ **Read this as a signal, not a guarantee.** It's a single hackathon-scale run on a
> subset of the problems — not a published benchmark. Broader, repeatable evaluation is on the roadmap.

## How it works

The **context Map** is the whole window at a glance: one square per block, sized by token
weight (a dice face, 1–6), colored by kind — **user** messages, **assistant** responses,
**thinking**, **tool calls**, and **tool results** each get their own hue. Bright = live;
recessed and hatched = folded.

Three hands share those controls:

- **You** — fold, unfold, pin, and peek by hand. Your overrides always win.
- **The agent** — reaches back to unfold or pin context it needs mid-task, or **recall**
  a folded block as a tool result (like `read_file`) without changing what's standing in
  context.
- **The Conductor** — an automatic strategy that, between turns, folds what's gone cold
  and unfolds what's becoming relevant. Collaborative by default; an *exclusive*
  conductor you approve can take over specific controls, and **detach** is always your
  kill switch.

Every block is **Full**, **Folded** (shown as a short tagged summary), or **Pinned**
(locked open).

<div align="center">
<img src="docs/assets/attention-conductor.png" alt="Attention conductor view — each block tinted by how much the working tail still attends back to it" width="600">
<br><sub>Folded blocks are shown with dull colors </sub>
</div>

Folds nest: cold turns fold into groups, groups into bigger groups, so a session of
thousands of turns stays small enough to fit and complete enough to recover. And the
recent past is always safe — the most recent ~20k tokens are a protected working tail the
agent reasons over at full fidelity (the thick-bordered box below the fold line).

→ Capability matrix, full walkthrough, and the deep spec: **[VISION.md](VISION.md)**

## The conductors

A conductor is a strategy for deciding what gets folded. It watches the session and proposes
edits between turns, and every edit goes through the same rules your own hand folds do, so a
conductor can never do something you couldn't do yourself. Seven ship today. Pick one from the
header menu, or leave it on None and steer everything by hand.

**[thermocline](conductors/ws/thermocline/)** is the strongest one so far, and the one the
benchmark above used. It combines two earlier experiments: a small probe model that scores how
much the recent context still attends to each block, which decides the order things get
compressed in, and real LLM summaries, which decide how far each one gets compressed. On top of
both it enforces a hard budget, and when your cap is genuinely impossible to hit it says so
instead of quietly blowing past it.

**[triptych](conductors/ws/triptych/)** came out of asking what actually fills a coding session
up, which is almost always file reads. It splits the context into three bands by age: the recent
third is left alone, the middle band turns code reads into tree-sitter skeletons that keep every
signature and drop the bodies, and the oldest third gets summarized. The skeletons stay
recoverable, so the agent can pull the full source back with `recall` when it needs it.

**[doorman](conductors/in-process/doorman/)** takes its idea from
[The Token Company](https://thetokencompany.com): shrink content on the way to the model,
before it ever costs you full price. A huge tool result lands inside the protected tail the
moment it arrives, so the model sees it at full size on the very first call, and doorman
catches those on their way out and folds them before they reach the model at all. It's a cheap
proof of concept, so don't reach for it as a real strategy.

**[keel-lite](conductors/in-process/keel-lite/)** is the deterministic one: no model calls, no
locks. When the context passes 85% of the budget it runs one batched epoch that folds the
cheapest-to-lose content first (old reasoning, then stale file reads, then long command output)
until it is back under 65%, and never touches the task brief or the current spec. Every edit is
recoverable, and batching the edits keeps prompt-cache breaks rare.

**[keel-note](conductors/in-process/keel-note/)** is keel-lite plus a memory. The trim stays
exactly keel-lite's, synchronous, but as trims drop old turns a batched background model call folds
them into a short first-person progress note (goal, what's built, what failed, the current error,
the next step). The note sits where the trimmed history meets the live turns and moves forward
with every trim, in the same request, so it adds little to cache cost. The trim never waits for the
note: room for it is reserved in the budget from the first turn.

**[taskfold](conductors/in-process/taskfold/)** folds by task. The agent plans in a persistent,
nested task list (the `tasks` tool) and ends each task with a short report. Once the context gets
tight, finished tasks fold into fixed-shape records: outcome, decisions, files changed, checks run,
open items. User messages stay verbatim unless a classifier model says losing them costs nothing,
as with approvals, status checks and step steering.

While taskfold is attached, the task list sits above the editor. Collapsed it shows progress,
folded tasks (`≡`), working time and the tokens the task spans take before and after folding,
plus the task in progress; expanded it shows the task tree, hiding the tasks furthest from the
current one when it gets long:

```
▼ Tasks 5/20 (≡5) · 5m 12s · 26.7k → 10.1k tok
  ├─ … 3 hidden · 3m 36s (3 folded)
  ├─◐ 3 Secrets Redesign · 2m 45s (3/7)
  │ ├─▶ 3.4 registry rewire to vault · 1m 21s (0/3)
  │ │ ├─▶ 3.4.1 the new registry · 1m 11s
  │ │ └─☐ 3.4.2 vault adapter
  │ └─ … 3 hidden
  └─ … 6 hidden
```

`alt+t` or `/accordion tasks` expands and collapses it; `/accordion tasks hide` hides it for the
session. `/accordion tasks lists` browses the project's task lists to attach, release or start one.
When you resume a session that used a list, Accordion offers it back (or tells you which session
holds it now) and tells the agent on your next prompt if its list changed or was replaced. Defaults live under `taskWidget` in `~/.accordion/config.json`:
`{ "mode": "auto" | "off", "expanded": false, "maxRows": 12, "toggleKey": "alt+t" }`.

**[handoff](conductors/in-process/handoff/)** is `/handoff`, automatic. The manual version is to
ask the agent to write a handoff document, kill the session, and paste that document into a
fresh one. This does all three for you without you leaving the session.

**[compaction-naive](conductors/in-process/compaction-naive/)** re-implements the `/compact` you
already have in Claude Code, ChatGPT and everywhere else. It is the baseline the other six get
measured against, and it makes the point that Accordion covers what exists today before it does
anything past that.

Conductors are opt-in, same as folding itself. An exclusive one shows you a consent screen
naming which controls it takes over, and detaching converts everything it did into your own
edits so its work survives being removed.

thermocline and triptych run as their own process and ship with the repo. They aren't in the
npm package, so they only show up in the picker when you run Accordion from a checkout. Details
on each are in **[conductors/](conductors/)**.

## What works today

- ✅ Browser-served UI: the full Map with no desktop app and no Rust.
- ✅ Desktop app (Tauri + SvelteKit): the Map view, token budget, inspector, protected
  working tail.
- ✅ Live link to a running pi session, with auto-discovery.
- ✅ Multi-session: every live pi session on the machine in one sidebar, switchable.
- ✅ Opt-in live steering — apply your fold plan to what the agent is shown.
- ✅ Reversible, provider-safe folding with deterministic `{#code FOLDED}` digests the
  agent can ask to unfold.
- ✅ Involvement locks — exclusive conductors, the consent gate, freeze-on-detach, and
  agent `recall`.
- ✅ Seven conductors — automatic fold/unfold between turns, based on context.
- ✅ LLM-generated summaries, computed once and cached.
- ✅ Read-only browsing of saved Claude Code transcripts.

Honest about what's **not** there yet: no agent-driven pinning, no hierarchical (nested)
groups, no replay. That's the build ahead.

## Roadmap

- [x] Core fold/unfold engine — reversible, tool-pair safe
- [x] The separate window — desktop app: Map view, budget, inspector
- [x] Live link to pi + auto-discovery, opt-in steering
- [x] Agent-driven unfold + `recall`, involvement locks
- [x] LLM-generated summaries, computed once and cached
- [x] The Conductor — automatic fold/unfold between turns
- [x] Browser-served UI and multi-session, no desktop app required
- [ ] Broader benchmarks: more than one run, published
- [ ] Hierarchical folding for million-turn sessions
- [ ] Agent-driven pin
- [ ] Replay — scrub how context evolved across a session
- [ ] Better conductors — research, develop, and test stronger context strategies
- [ ] Expand accordion beyond pi

## Quick start

This fork runs Accordion's context controls inside the Pi TUI. The extension starts its
local session service automatically; no desktop app is required. It runs on Pi-Bolt or
Pi with Node.js 22.19 or newer.

From a checkout:

```bash
npm install --legacy-peer-deps
pi-bolt -ne --offline -e ./extension/accordion.ts
```

Run `/accordion` in the session to open its context panel (with tabs `1–4` / `Tab`:
**Context Map**, **Blocks**, **Conductors**, and **Settings**). The Context view shows a
Claude Code `/context`-style proportional category bar, token savings, and a 2D Spectrum-colored
Unicode block grid (`■` live, `▫` folded, `▣` grouped, `⛨` bolted system).

- `m` switches between the colored 2D context map and the searchable block list (`/` filters blocks).
- `C` or `/accordion compact` runs an immediate Accordion compression pass.
- Folding auto-arms with the `keel-lite` conductor by default (configurable in `~/.accordion/config.json`
  or the `s` Settings tab), replacing Pi's native `/compact` and threshold auto-compaction with
  reversible folding while falling back to native compaction only if a hard overflow is already saturated.
- `/accordion sessions` selects another live Pi session on the same machine.
- `/accordion tasks [lists | expand | collapse | hide | show]` browses task lists and controls the taskfold task list above the editor.

The fork is also a Pi package and can be installed from Git once this branch is published:

```bash
pi-bolt install git:github.com/furbyhaxx/pi-accordion
```

Remove the upstream Accordion package before installing this fork to avoid registering
the same commands, tools and context hook twice. Restart Pi after installing it.

### Optional browser and desktop interfaces

The existing browser and desktop interfaces remain available through `/accordion-web`.
Git package installation and updates build the browser assets automatically through the
root `prepare` script. It installs the locked app build dependencies, builds the static
client, and copies it to `extension/dist/client/`; no desktop build is involved.

If lifecycle scripts were disabled during installation, rebuild explicitly from the
installed package directory:

```bash
npm run build:client
```

The command (or `/accordion web`) prints a Browser URL with a short, memorable 8-character
token (e.g. `kave4ton`) or your custom static token (`ACCORDION_TOKEN` / `customToken` in
`~/.accordion/config.json` / Settings tab). You can also bind the Web UI to another address
(e.g. `0.0.0.0` or a Tailscale IP) via `--accordion-host`, `ACCORDION_HOST`, or the Settings tab;
switching sessions in the browser routes over the single Door port automatically. The desktop
app additionally supports read-only Claude Code transcript browsing; see
[CONTRIBUTING.md](CONTRIBUTING.md) for its build prerequisites. Only one surface can
steer at a time; the others are read-only until they take control. Fork sessions use a
SQLite sidecar lock to coordinate controller claims and heartbeats; unmodified upstream
sessions do not honor that lock and may race. Avoid running both versions concurrently.

The in-process conductors need no separate server. Thermocline and Triptych run as
separate processes; Triptych also needs its local tree-sitter dependencies installed.
See [the conductor catalog](conductors/README.md).

## Contributing

An experiment in context engineering — contributions, ideas, and benchmarks welcome.
Setup, the quality gate, and platform gotchas are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Our main frontier right now is **better conductors**: researching which context actually
matters, developing stronger strategies, and testing them against real sessions. We're not
chasing a long tail of mediocre ones — the goal is one to three conductors that genuinely
hold up. The seven listed above run against a small, frozen contract
(`core/conductor/contract.ts`): a conductor attaches to a host, reacts to context-change
events, and proposes fold/group edits between turns — clamped by the exact same rules a
human fold goes through, never a privileged write path. If you don't need that finer-grained event stream, `core/conductor/view.ts`'s
`ViewConductor` adapter lets you write the simpler `conduct(view) → Command[]` shape instead
(what `compaction-naive` and `handoff` do); one line in `core/conductor/registry.ts` registers
it. Strategies can range from simple oldest-first folding to scoring each block's relevance
with a small model. If you have a theory about what an agent should keep and what it can let
go, that's the surface to prove it — and the place where outside help is most valuable right
now.

---

**The north star: your agent's memory should be something you can see and steer — not a
black box that silently forgets.**

<div align="center">

🏆 &nbsp;Built at the **AI Hackathon 2026 @ UC Berkeley** — a winning project.

<sub>Tyler Darisme &nbsp;·&nbsp; Aaditya Desai &nbsp;·&nbsp; Sheel Shah &nbsp;·&nbsp; Thy Tang</sub>

🪗

</div>
