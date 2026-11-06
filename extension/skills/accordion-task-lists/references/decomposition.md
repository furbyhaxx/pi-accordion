# Decomposing work into foldable tasks

## Why it matters

Taskfold folds a task into a short record when it finishes: its outcome, decisions, changed files,
verification and open items. Everything the agent read, ran and wrote inside the task is removed
from the request and stays recoverable by handle. The task tree is therefore the unit of memory:

- A **finished** task can fold. An open one stays raw, so every token spent inside it stays in the
  request until it ends.
- A task that bundles several features is open for the whole span. Context grows until it ends, and
  one fold then summarises everything in a single, lossy record.
- Small children finish early. Each one folds on its own and keeps its own recoverable record, so a
  parent that stays open for hours holds only short child records, not hours of raw work.
- A record can only be as precise as its span. Narrow tasks give narrow, checkable outcomes and
  acceptance criteria.

Work done outside any task is never folded as a unit, so put real work inside a task.

## How to split

1. **Start with orientation.** The first top-level task is `Orientation, Analysis, Scope &
   Objective clarification`. Reading the plan, specs and key files happens there, and its children
   can name what is read. The real tasks are added after it from what it found.
2. **Split by outcome.** A child is one independently verifiable result: it has its own acceptance
   criteria and can be reported on without the others. Split on feature, behavior, surface or
   layer, not on activity ("read", "think", "edit").
3. **Nest by scale, with a minimum depth for broad work.** Give any task that would take more than
   a few tool calls and several substantial pieces its own children. Broad features and plans need
   **at least two to three levels**: area, then feature, then step. The tree allows four. The
   volume of work decides the depth within that range; only a genuinely small change gets a flat
   list. Never split a step that has no result of its own just to add a level.
4. **Order by dependency and finish in order.** Complete each child before the next one starts so
   each can fold. Put verification of the whole parent in its own last child.
5. **Keep leaves small enough to finish in one sitting.** If a leaf turns out broader than
   expected, add children before continuing. Only unstarted tasks can be moved or renumbered.
6. **Keep titles short.** A title names the outcome. Details belong in `acceptanceCriteria`, pins
   and attachments, not in the title.

A parent has no work of its own beyond what its children leave out; its acceptance criteria are the
integration checks over them.

## Bad and good

Too coarse: each row bundles several features, stays open for hours and cannot fold until it ends.

```
3 Close acceptance rows
  3.5 Transcript row: branches, filters, previews, workblocks, completion summary, density, scrolling
  3.6 Bindings row: one action contract with display, remap, unbind and dispatch agreeing
  3.7 Models/settings row: per-model reasoning, compaction, cache warming, trust defaults, deadlines
  3.8 Media row: image downscale, placeholder, Mermaid fences, each with a setting
```

Split along outcomes and nest where a row has several:

```
3 Close acceptance rows
  3.5 Transcript row
    3.5.1 Branches
    3.5.2 Filters
    3.5.3 Previews
    3.5.4 Workblocks
    3.5.5 Completion summary
    3.5.6 Attribution and density
    3.5.7 Fine scrolling
  3.6 Bindings row
    3.6.1 Action contract
    3.6.2 Remap and unbind
    3.6.3 Dispatch agrees with display
  3.7 Models and settings row
    ...
```

The same shape as a list file, with criteria on the leaves:

```json
{
  "version": 2,
  "slug": "acceptance-rows",
  "title": "Acceptance rows",
  "goal": "Every acceptance row has behavioral regression coverage and passes the project gates.",
  "tasks": [
    {
      "title": "Orientation, Analysis, Scope & Objective clarification",
      "subtasks": [
        { "title": "Read the specification and plan" },
        { "title": "Find the affected modules and their tests" }
      ]
    },
    {
      "title": "Close acceptance rows",
      "subtasks": [
        {
          "title": "Transcript row",
          "subtasks": [
            { "title": "Branches", "acceptanceCriteria": ["Branches are distinguishable in the view"] },
            { "title": "Filters", "acceptanceCriteria": ["A filter narrows the visible messages"] },
            { "title": "Previews", "acceptanceCriteria": ["Long messages show a bounded preview"] }
          ]
        },
        {
          "title": "Bindings row",
          "subtasks": [
            { "title": "Action contract", "acceptanceCriteria": ["Display, remap and dispatch use one action list"] },
            { "title": "Remap and unbind", "acceptanceCriteria": ["An unbound action no longer dispatches"] }
          ]
        }
      ]
    },
    {
      "title": "Run live, interactive and workspace gates",
      "acceptanceCriteria": ["The project gates pass and the result is verified"]
    }
  ]
}
```

Tasks without `acceptanceCriteria` are accepted by the validator; give one to three to every leaf
that produces a verifiable result. A pure reading step like the orientation children needs none.

## Check before saving

- Does any leaf name several features, rows or surfaces joined by commas or "and"? Split it.
- Could any leaf still run for hours or dozens of tool calls? Split it.
- Does a parent have more than about seven children? Group them under intermediate parents.
- Is there a final verification child for each parent whose integration needs its own check?
- Is each split a real outcome rather than a step with no result of its own? Merge those.
