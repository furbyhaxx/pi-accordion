# Task-list v3 fields

A file lives at `.pig/tasks/<slug>.json`, or elsewhere (next to its plan) with a symlink there; the store writes through the link. `version` is `3`; `slug` matches the filename. `title` is a non-empty string up to 200 characters, `goals` 1–5 goals of up to 600 characters each, and `tasks` an array. For hand-authored lists omit `claim`, `seq`, timestamps and task IDs; the store fills them in.

Goals and criteria are written as plain strings; the store stores them as `{ id, text }` items (`g1`, `c1`, …) that results and records refer to. Item ids are unique within the list and never reused after removal (`seq` remembers the last number). An explicit item id is kept; it must have the right prefix and must not collide.

Each task has a non-empty `title` (up to 200 characters), optional `subtasks` (no fixed depth limit), optional `goals` (up to 3, 300 characters each), and optional `acceptanceCriteria`: up to 8 (1–3 recommended) non-empty statements of up to 300 characters. Missing `status` means `todo`. Explicit IDs must match their position (`1`, `1.1`, …).

Reports require `outcome` (up to 2,000 characters). Optional `decisions` and `open` each hold at most 12 strings of up to 1,000 characters. Over-limit reports are rejected with every violation and its length/limit, never truncated. Root history preserves the whole outcome; `recordTokens` caps only descendant content using raw estimates.

List and task scopes can hold `pins` and `attachments`; `context.md` explains what to put where. When authoring, omit their `id` (the store assigns `p<n>`/`a<n>` after any explicit ones), a pin's `at` and an attachment's `hash` and `at`.

- A pin is `{ kind, text, source }`: `kind` one of `rule`, `convention`, `constraint`, `standard`, `fact`; `text` a verbatim quote of up to 300 characters; `source` `"user"`, `"path"`, `"path:line"` or `"path:start-end"`. List pins total at most about 2,000 tokens, one task's about 1,500.
- An attachment is `{ path, anchor?, note? }`. `path` is project-relative, or absolute under a directory in `tasks.attachments.roots`. `anchor` is exactly one of `{ "section": "A > B" }`, `{ "symbol": "Type.method" }` or `{ "quote": { "exact": "…" } }` (the store adds `prefix`, `suffix` and `start` on first delivery); absent means the whole file. The resolved part may have at most 60 lines. `note` (up to 120 characters) says why it is attached. A legacy `lines` range is still read and replaced by a quote anchor on its next delivery.

`tasks start` delivers the task's goals, criteria, pins and attachment text (or references) once, in its result, together with what is missing of its doing ancestors (`parents`). `scripts/validate.mjs` resolves every pin and attachment; the store's `tasks` tool does the same when it creates or adds them.

When loading an older v1 or v2 list the store migrates it in memory and writes v3 on the next update, keeping the original as `<slug>.v1.json` or `<slug>.v2.json`. A v2 `goal` becomes the first goal and string criteria become items. If a list has no goals, `tasks update {list, goals: {add: ["…"]}}` supplies one before starting or adding work. Existing started tasks retain their IDs; use the tool instead of reordering them in JSON.
