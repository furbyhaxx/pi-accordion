Development artifacts. Committed. Never in `docs/`. Full standard: skill `dot-project`.

| Dir | Content |
|---|---|
| `specs/` | architecture, API, decisions; `NNNN-<slug>` |
| `plans/` | slices/tasks; `NNNN-<slug>/`; rolling wave |
| `research/` | online research; third-party sources |
| `analyses/` | root causes, QA, measurements; this workspace |
| `reviews/` | review reports; `YYYY-MM-DD-<slug>/` |
| `drafts/` | undecided proposals, RFCs |
| `sketches/` | wireframes, mockups, prototypes |
| `handoff/` | resume briefs for fresh sessions |
| `backlog/` | open work items `B-NNNN-<slug>.md`; pointers in code-tree `BACKLOG.md` |
| `references/` | curated maintained facts |
| `user-uploaded-assets/` | user-provided files; read-only |

- One artifact = one file or one `<slug>/` dir. Evidence in `<slug>/evidence/`, credentials redacted.
- Every Markdown artifact (except `user-uploaded-assets/`) starts with `document:` frontmatter: type, id, title, description, status (sketch|draft|published|archived), revision, created_at, updated_at, created_by, updated_by, changelog. Timestamps `date -Iseconds`.
- Revise: bump revision, update updated_*, append changelog entry.
- Superseded → status `archived` + successor path. Never delete.
- New type → dir + AGENTS.md + row here.
