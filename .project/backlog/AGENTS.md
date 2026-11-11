Open work items. Type `backlog-item`, id `B-NNNN` from `../ids.toml`, file `B-NNNN-<slug>.md`, status `open`.

- Frontmatter adds `kind` (bug|drift|debt|feature|chore), `priority` (P1|P2|P3), `scope` (path globs).
- Body: current behavior (file:line), target behavior, why it matters. When a plan carries the work, the body is one line pointing at the plan.
- Exactly one pointer line in the `BACKLOG.md` of the deepest directory covering `scope` (repo root if cross-cutting): `- B-NNNN <kind> <prio> — <title> → .project/backlog/B-NNNN-<slug>.md`.
- Create: item + pointer, one commit. Fixed or dropped: delete item + pointer in the fixing commit, with `Artifact-Deleted` trailers. No done or wontfix files.
- Claims and progress live in project-scope `tasks`, never in these files.
