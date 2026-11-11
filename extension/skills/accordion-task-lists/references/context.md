# Pins and attachments: carrying the sources into each task

A task list without pins and attachments hands the agent a six-word title and a criterion. Everything
it read while orienting (the plan, the spec, the research, the code) is folded away as soon as that
task finishes. Pins and attachments are how the sources survive: the store delivers them in the
`start` result of the task that needs them, and delivers them again whenever folding has hidden the
earlier copy. A list for a plan that has specs, research or project rules is incomplete until its
tasks carry the parts of them they depend on.

## How delivery works

- `tasks start` returns the list's goals, pins and attachments, then each entering task's goals,
  criteria, pins and attachments, its doing ancestors' included. `claim` does the same for every task in progress.
- Only what the model cannot already see is sent. When the result that carried an item is folded or
  compacted away, the next `start` or `claim` sends it again. Nothing is added to later requests.
- An attachment arrives as its current content (`render: "inline"`, the default) or as its locator
  only (`render: "reference"`), with its `note`. The content is read from disk at delivery, so it is
  never stale; `state` says if it `changed` since it was last seen, `moved`, matched `fuzzy`, is
  `lost` or grew `too_large`.
- Pins and attachments on a task apply to that task and all its subtasks. Put them on the highest
  task they hold for, and do not repeat them on children.

## Pin or attachment

| Use | When | Limits |
|---|---|---|
| **Pin** | A sentence that must keep holding while the work runs: a rule, constraint, convention, standard or fact. The agent should obey it, not read around it. | Verbatim quote, ≤300 chars. List pins ≤2,000 tokens in total, one task's ≤1,500 |
| **Attachment** | A part of a file the agent needs to read to do the task: a spec section, a plan slice, a research finding, a function. | ≤60 lines resolved (setting `tasks.attachments.maxLines`), `note` ≤120 chars |

Task titles stay within 200 chars; acceptance criteria are at most 8 × 300 chars (1–3 recommended).
A finishing report's `outcome` is at most 2,000 chars; `decisions` and `open` are at most
12 × 1,000 chars each. Rejections report every violation; no field is silently cut.

Pin kinds: `rule` (a project or user instruction), `constraint` (a limit the work must stay within,
often a plan's "Do not"), `convention` (how things are done here), `standard` (an external norm the
result must meet), `fact` (a verified finding the work relies on).

A pin is a quote, never a paraphrase; its `text` must appear in its `source` (whitespace may differ).
Pin the sentence that carries the rule. If a rule needs its surrounding paragraph to make sense,
attach the paragraph instead.

## Where each part of the sources goes

Read the plan and every document it links before writing tasks, then place each relevant part:

| Source part | Goes to | As |
|---|---|---|
| Plan goal, scope or "Done when" | list | attachment (section) |
| Plan "Do not" section | list, or the area it constrains | attachment (section); a `constraint` pin for a bullet that reads as a complete prohibition on its own |
| Project rules that bite this work (`AGENTS.md`: test commands, layering, naming) | list | `rule`/`convention` pins |
| Plan step or slice ("Do > 2. Ledger") | the area or slice task | attachment (section, or quote of the bullet) |
| Spec section the slice implements | the slice task; a subsection to the leaf that implements it | attachment (section) |
| Spec contracts: data shapes, error tables, state machines, wireframes | the leaf that builds them | attachment (section) |
| Plan "Current" file paths, code the leaf changes | the leaf | attachment (symbol) |
| Plan "Tests", spec test scenarios | the verify leaf, or the leaf whose behavior they test | attachment (section or quote) |
| Plan "Docs" pages | the docs leaf for that page | attachment of the page section to change |
| Research or knowledge-base findings behind a decision | the leaf that implements or decides it | attachment (section); a `fact` pin for a one-line finding |
| The user's own instructions in this session | list or task | pin with `source: "user"`, only through the `tasks` tool |

Orientation tasks rarely need attachments: their job is to read. The implementing leaves do.
A leaf without any pin or attachment of its own or from a parent is acceptable only when its title
and criteria say everything the agent needs; the validator lists such leaves so you can check.

## Anchors

Name a part of a file by what it is. Give exactly one anchor; none means the whole file.

| Anchor | JSON (`anchor`) | Use for | Notes |
|---|---|---|---|
| section | `{ "section": "Delivery > Wake" }` | Markdown | The heading path, `>`-separated, matched as the end of the full path, case-sensitive. Numbered headings keep their numbers (`"4.2 Attachments and anchors"`). The section runs to the next heading of the same or higher level, children included |
| symbol | `{ "symbol": "FrameService.publish" }` | `.ts`, `.tsx`, `.js`, `.py`, `.rs` | Dotted declaration name, with its doc comment. Survives edits around it |
| quote | `{ "quote": { "exact": "2. **Ledger** — new …" } }` | One bullet, row or paragraph inside a larger section; files with no headings or symbols | Delivers exactly the quoted text, nothing around it: copy the whole bullet or paragraph, not a unique prefix. It must be unique in the file. The store adds the context it needs to find it again after edits |
| file | (no anchor) | Short files only | Refused when longer than the line cap |

Prefer section, then symbol, then quote. A section longer than 60 lines is refused: anchor a
subsection, or quote the part that matters. Do not use `lines`; line numbers break with the first edit.

## Writing them in JSON

In a hand-written list, omit ids, `at` and `hash`; the store assigns them. Paths are relative to the
project root, the directory that holds `.pig/`.

```json
{
  "pins": [
    { "kind": "rule", "text": "Update the plan's progress in the same commit as the code.", "source": ".project/plans/AGENTS.md" }
  ],
  "attachments": [
    { "path": ".project/specs/0017-frame-delivery.md", "anchor": { "section": "Ledger > State machine" }, "note": "states and allowed transitions" },
    { "path": "crates/sdk/src/frame/frame.rs", "anchor": { "symbol": "FrameDelivery" }, "note": "type this slice replaces" }
  ]
}
```

A pin's `source` may name a line or range (`"AGENTS.md:40-44"`) to make the quote easier to find.
A pin is read without its surroundings: a "Do not" bullet such as `Drop frames silently on overflow.`
reads as an instruction once its heading is gone. Pin only sentences that state the whole rule
(`Never modify vendor/.`); attach the section for the rest.

Through the `tasks` tool, `create` and `add` take the same fields per task in input form (`path`
plus one of `section`, `symbol`, `quote` as a string, `note`), and `pin`/`attach` add them to an
existing list or task. The tool checks each one immediately.

## Files outside the project

By default only files inside the project can be attached or quoted, so a committed list cannot make
an agent read and send arbitrary files. Shared research such as a knowledge base needs its directory
listed in `~/.accordion/config.json`:

```json
{ "tasks": { "attachments": { "roots": ["/mnt/shared/knowledge-base"] } } }
```

Then use the absolute path: `{ "path": "/mnt/shared/knowledge-base/agent-skills/ARTICLE.md",
"anchor": { "section": "6.3 Design the body" } }`. Every user of the list needs the same root
configured and the same path; otherwise the attachment arrives as `lost`.

## Check before saving

- The list carries the plan's goal or scope, its "Do not" section, and the project rules this work
  must follow.
- Every area or slice carries its plan step and the spec section it implements.
- Every leaf that builds a contract, a data shape, a screen or a behavior carries the spec subsection,
  research finding or code symbol it depends on.
- No pin paraphrases; no attachment exceeds the line cap; no child repeats its parent's references.
- `scripts/validate.mjs` resolves every reference and its "no pin or attachment" note names only
  leaves that need none.
