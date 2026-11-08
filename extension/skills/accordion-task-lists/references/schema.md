# Task-list v3 fields

A file lives at `.pig/tasks/<slug>.json`. `version` is `3`; `slug` matches the filename. `title` is a non-empty string up to 200 characters, `goals` 1–5 goals of up to 600 characters each, and `tasks` an array. For hand-authored lists omit `claim`, `seq`, timestamps and task IDs; the store fills them in.

Goals and criteria are written as plain strings; the store stores them as `{ id, text }` items (`g1`, `c1`, …) that results and records refer to. Item ids are unique within the list and never reused after removal (`seq` remembers the last number). An explicit item id is kept; it must have the right prefix and must not collide.

Each task has a non-empty `title` (up to 200 characters), optional `subtasks` (no fixed depth limit), optional `goals` (up to 3, 300 characters each: what the subtree must achieve beyond its criteria), and optional `acceptanceCriteria`: up to 8 (1–3 recommended) non-empty statements of up to 120 characters. Missing `status` means `todo`. Explicit IDs must match their position (`1`, `1.1`, …). Consult `tasks.schema.json` for the remaining stored status and report fields.

List and task scopes can hold `pins` and `attachments`. Prefer the `tasks` tool to create them: it validates the source and manages IDs. A pin has an ID, kind, verbatim text, source and timestamp. An attachment has an ID, project-relative path, optional `anchor` (one of `{section}`, `{symbol}` or `{quote: {exact, prefix, suffix, start}}`; absent means the whole file), note and content hash. A legacy `lines` range is still read and replaced by a quote anchor on its next delivery. `tasks start` delivers the task's goal, criteria, pins and attachment text (or references) once, in its result.

When loading an older v1 or v2 list the store migrates it in memory and writes v3 on the next update, keeping the original as `<slug>.v1.json` or `<slug>.v2.json`. A v2 `goal` becomes the first goal and string criteria become items. If a list has no goals, `tasks update {list, goals: {add: ["…"]}}` supplies one before starting or adding work. Existing started tasks retain their IDs; use the tool instead of reordering them in JSON.
