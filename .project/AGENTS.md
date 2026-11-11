Development artifacts. Committed. Never in `docs/`. Full standard: skill `dot-project`.

Only what currently applies or is planned stays here. Agents act on whatever they read, so a stale file is a wrong instruction.

| Dir | Content | Deleted when |
|---|---|---|
| `specs/` | architecture, API, decisions; `NNNN-<slug>` | nothing current depends on it |
| `plans/` | executable work; `NNNN-<slug>/plan.md` | its work is merged |
| `backlog/` | open work items `B-NNNN-<slug>.md`; pointers in code-tree `BACKLOG.md` | fixed or dropped |
| `references/` | maintained facts other rules depend on | no rule depends on it |
| `research/` | project-specific third-party findings | decision recorded in a spec or plan |
| `analyses/` | root causes, QA, measurements | findings are in a plan, item or spec |
| `reviews/` | ranked findings; `YYYY-MM-DD-<slug>/` | every finding fixed or a backlog item |
| `drafts/` | undecided proposals | decided or dropped |
| `sketches/` | wireframes, prototypes | accepted into a spec or dropped |
| `handoff/` | resume briefs | consumed |
| `user-uploaded-assets/` | user files | processed into items or plans |

- Same topic, new facts: overwrite in place, bump `revision`, replace the single changelog entry. No second file, no "superseded" sections.
- No longer applies: delete it (with its `evidence/`) in the commit that makes it obsolete. Trailers: `Artifact-Deleted: <id>`, `Reason: <one line>`, optional `Superseded-By: <id>`. Fix every reference to its path or id in the same commit. No archived status, no archive dir.
- Do not read deleted artifacts from git history unless the user asks.
- Ids: take the next number from `ids.toml` and increment it in the same commit. Never lower a counter or reuse an id.
- Frontmatter on every Markdown artifact except `AGENTS.md`, `user-uploaded-assets/`, `evidence/`: type, id, title, description, status, revision, created_at, updated_at, created_by, updated_by, changelog (one entry). Timestamps `date -Iseconds`.
- New type → dir + AGENTS.md + row here.
