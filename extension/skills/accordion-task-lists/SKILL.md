---
name: "accordion-task-lists"
description: "Write, convert or repair Accordion task lists as JSON (.pig/tasks/*.json): turn an implementation plan, spec or research into a nested task tree with goals, acceptance criteria, pins of the rules that must hold, and anchored attachments of the plan, spec, research and code sections each task needs; then validate every reference. Use when drafting a plan as tasks, converting a plan document into a task list, adding pins or attachments, keeping a list next to its plan, or editing a list outside the tasks tool."
---

# Author an Accordion task list

A task list does two jobs. Its **tree** decides what Accordion can fold: a finished task collapses
into a short record, so small tasks keep context small. Its **references** decide what survives the
folding: pins and attachments are delivered with `tasks start` to the task that needs them, and
delivered again when folding has hidden them. A list with a good tree and no references makes the
agent work from titles once orientation has folded away. Both are required.

Use the `tasks` tool for progress and for changes to a running list. Write JSON to convert a plan
into a new list in one pass. A list file is project state: inspect it and its `claim` first, never
overwrite a list another session holds, and never edit status, reports, claims or started tasks.

## Convert a plan into a list

1. **Read every source and inventory it.** Read the plan, every spec, design, research or
   knowledge-base article it links, the project's `AGENTS.md` files for the affected areas, and the
   code its "Current" section names. Note for each source the sections, symbols and sentences the
   work depends on, with their exact heading paths. This inventory becomes the references in step 4.
2. **Decompose by outcome.** Open with `Orientation, Analysis, Scope & Objective clarification`, then
   one task per independently verifiable result, nested area → feature → step (two to three levels
   minimum for broad work, no maximum). Never bundle several features in one leaf; never split a step
   with no result of its own. Read `references/decomposition.md` before the first list, and
   `references/examples.md` for worked translations.
3. **Write goals and criteria.** One to five list `goals`: the end state, not activities. One to
   three observable `acceptanceCriteria` per leaf (a command that passes, a behavior that shows). Keep
   the plan's required verification; do not invent requirements the sources do not support.
4. **Attach and pin the sources.** Read `references/context.md` and place the inventory: the plan's
   goal and "Do not" section and the project rules on the list; each plan step and the spec section it
   implements on its area task; each spec subsection, research finding or code symbol on the leaf that
   needs it. Pins are verbatim quotes of rules; attachments are anchored parts of files. A task's
   references apply to its subtasks too.
5. **Save it** (see "Where the file lives"). The filename and `slug` must match. Omit task ids, item
   ids, `status`, `at` and `hash`; the store fills them in.
6. **Validate and fix until it passes:**

   ```sh
   node <skill-directory>/scripts/validate.mjs .pig/tasks/<slug>.json
   ```

   It checks the structure, then resolves every reference: files exist, sections and symbols are
   found, quotes are exact and unique, attached parts fit the line cap, pin quotes appear in their
   source. `--project <dir>` sets the root for relative paths; `--root <dir>` allows a directory
   outside the project. It also lists leaves with no reference of their own or from a parent: give
   each one what it needs, or confirm its title and criteria are enough.
7. **Compare against the sources.** Every plan step, test, docs page and "Done when" condition maps
   to a task; every spec section the plan cites is attached where it is implemented. A valid file is
   not proof of a complete list. Then claim it with `tasks` before starting work.

```json
{
  "version": 3,
  "slug": "token-store",
  "title": "Token store",
  "goals": ["All token access goes through TokenStore, and the project tests pass."],
  "pins": [
    { "kind": "rule", "text": "Run npm test before every commit.", "source": "AGENTS.md" }
  ],
  "attachments": [
    { "path": "docs/plans/token-store.md", "anchor": { "section": "Do not" }, "note": "limits for the whole plan" }
  ],
  "tasks": [
    {
      "title": "Orientation, Analysis, Scope & Objective clarification",
      "subtasks": [{ "title": "Read the plan, the auth spec and the token callers" }]
    },
    {
      "title": "Token store",
      "attachments": [
        { "path": "docs/specs/auth.md", "anchor": { "section": "Token store" }, "note": "contract this area implements" }
      ],
      "subtasks": [
        {
          "title": "Interface",
          "acceptanceCriteria": ["get and set round-trip in a unit test"],
          "attachments": [
            { "path": "docs/specs/auth.md", "anchor": { "section": "Token store > Interface" } }
          ]
        },
        {
          "title": "Callers migrated",
          "acceptanceCriteria": ["No direct token map access remains"],
          "attachments": [
            { "path": "src/auth/session.ts", "anchor": { "symbol": "Session.token" }, "note": "first caller to move" }
          ]
        }
      ]
    }
  ]
}
```

## Where the file lives

The store reads `.pig/tasks/<slug>.json` in the project root. A list that belongs to a plan document
lives next to the plan, committed with it, and `.pig/tasks/` holds a **relative symlink** to it:

```sh
ln -s ../../.project/plans/0038-frame-delivery/tasks.json .pig/tasks/frame-delivery.json
```

Never copy a plan's list into `.pig/tasks/`: the copy and the plan file diverge at the first
`tasks` call. The store writes through the link, so status and reports land in the plan's file and
are committed with the plan's progress. `.pig/` is usually ignored by git: create the link in each
checkout or worktree that works on the plan, and validate through the link so the slug matches.

## Change an existing list

Inspect its structure and claim first. Use `tasks add` with `before` or `after`, or `tasks move`, to
insert and move tasks: only unstarted subtrees may be moved or renumbered, because session history
refers to started ids. Use `tasks update` for the title, goals or criteria; goals and criteria are
items with ids (`g1`, `c3`) edited with `{add, remove, edit}`. Use `tasks pin` and `tasks attach` to
add references (`id` omitted for the list), `unpin` and `detach` to remove them; the tool checks each
one immediately. Do not rewrite a claimed list concurrently with its owner.

## Gotchas

- Folding removes what was read inside a finished task. If a later task needs a section read during
  orientation, attach it to that task; "the agent read it earlier" does not hold after folding.
- A pin is read without its surroundings. A "Do not" bullet such as "Drop frames on overflow."
  reads as an instruction once its heading is gone: attach the section instead.
- `source: "user"` pins can only be made with the `tasks` tool in the session where the user said it.
- An attachment resolves to at most 60 lines. Anchor a subsection or quote a passage, not a whole spec.
- A quote delivers exactly its text. `"1. **Ledger**"` delivers those 12 characters, not the bullet:
  quote the whole bullet or paragraph.
- Section anchors are heading paths matched from the end and are case-sensitive; numbered headings
  keep their numbers (`"4.2 Attachments and anchors"`). The validator lists the closest headings.
- Files outside the project, such as a shared knowledge base, need their directory in
  `tasks.attachments.roots` in `~/.accordion/config.json` and an absolute path in the list.
- Item and task ids are positional and assigned by the store. An explicit id that disagrees with its
  position or collides is a validation error.

## Reference files

| Read | When |
|---|---|
| `references/context.md` | Before writing pins or attachments: delivery, placement table, anchors, limits, checklist |
| `references/decomposition.md` | Before splitting work into tasks: why, rules, bad and good trees |
| `references/examples.md` | Translating a feature, bug, migration, phased plan with references, or research task |
| `references/schema.md` | When validation fails or a field is unclear |
| `references/tasks.schema.json` | Machine-readable schema for editors |
