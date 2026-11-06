---
name: "accordion-task-lists"
description: "Create, edit, or validate Accordion task-list JSON files in .pig/tasks: turn an implementation plan into a nested task tree with a goal and acceptance criteria, or repair an invalid list. Use when a user asks to write a plan directly as tasks JSON or edit an existing task list outside the tasks tool."
---

# Author an Accordion task list

Use the `tasks` tool for normal progress and for changes to a running list. Direct JSON authoring is useful for converting a detailed plan into a new list. The file is project state: inspect the existing list and its claim before editing; do not overwrite a list held by another session. Never edit task status, reports, claims, or started tasks by hand.

## Create a plan

1. Read the source plan and applicable project instructions. Write one `goal`: the end state the whole list delivers, not a list of activities.
2. Order the tasks by dependency. Split broad features into independently verifiable child outcomes so completed work can fold while its parent remains open. If a leaf grows to include several substantial features, split it; do not create trivial tasks just to reach a count.
3. Give each leaf 1–3 concise, checkable `acceptanceCriteria`. Preserve required verification and unresolved prerequisites. Do not invent a requirement that the source does not support.
4. Save `.pig/tasks/<slug>.json`. Slugs use lowercase letters, digits and hyphens. The filename and `slug` must match. Omit task IDs when creating the list: the store derives dotted IDs from their positions. The tree may be at most four levels deep.
5. Validate with Node 22.19 or later, using the script next to this skill:

   ```sh
   node <skill-directory>/scripts/validate.mjs .pig/tasks/<slug>.json
   ```

   Resolve the reported errors and rerun it. A valid file is not proof that the plan is complete; compare it against the source plan. Then claim it with `tasks` before starting work.

```json
{
  "version": 2,
  "slug": "transcript",
  "title": "Transcript",
  "goal": "The transcript displays branches and filters with regression coverage.",
  "tasks": [
    {
      "title": "Transcript view",
      "subtasks": [
        { "title": "Show branches", "acceptanceCriteria": ["Branches are distinguishable in the view"] },
        { "title": "Filter the transcript", "acceptanceCriteria": ["A filter narrows visible messages"] }
      ]
    }
  ]
}
```

## Change an existing list

Inspect its current structure and claim first. Use `tasks add` with `before` or `after`, or `tasks move`, for insertions and moves: only unstarted subtrees may be moved or renumbered, and started IDs are referenced by session history. Use `tasks update` for the goal, title, or criteria. Do not rewrite a claimed list concurrently with its owner.

Use `tasks pin` for a durable rule or constraint and `tasks attach` for source material. Give file references as `path:line` or `path:start-end`; use the narrowest relevant range. The tool validates pins and attachments and handles IDs and hashes. List pins apply throughout the list; task pins apply to that task and its descendants. Do not fabricate a quoted constraint or a source location.

For the complete field shapes and limits, read `references/schema.md`. The machine-readable schema is `references/tasks.schema.json`. The validator checks structure, not semantic completeness, file ownership, concurrent edits, or whether a plan is good.
