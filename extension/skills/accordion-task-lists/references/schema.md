# Task-list v2 fields

A file lives at `.pig/tasks/<slug>.json`. `version` is `2`; `slug` matches the filename. `title` is a non-empty string up to 200 characters, `goal` a non-empty string up to 600 characters, and `tasks` an array. For hand-authored lists omit `claim`, timestamps and task IDs; the store fills them in.

Each task has a non-empty `title` (up to 200 characters), optional `subtasks` (no fixed depth limit), and optional `acceptanceCriteria`: 1–3 non-empty strings of up to 120 characters. Missing `status` means `todo`. Explicit IDs must match their position (`1`, `1.1`, …). Consult `tasks.schema.json` for the remaining stored status and report fields.

List and task scopes can hold `pins` and `attachments`. Prefer the `tasks` tool to create them: it validates the source and manages IDs. A pin has an ID, kind, verbatim text, source and timestamp. An attachment has an ID, project-relative path, optional line or line range, note and content hash. `tasks start` delivers the task's goal, criteria, pins and attachment text (or references) once, in its result.

When loading an older v1 list the store migrates it in memory and writes v2 on the next update. If it has no goal, `tasks update {list, goal}` supplies one before starting or adding work. Existing started tasks retain their IDs; use the tool instead of reordering them in JSON.
