# Worked examples: from request to task list

Each example shows the request, how it breaks into outcomes, and the resulting list. Every list
starts with an orientation task, nests at least two to three levels where the work is broad, puts
real outcomes in the leaves, and ends with a verification child where integration needs one. The
JSON blocks pass `scripts/validate.mjs`; save each under `.pig/tasks/<slug>.json`.

## The translation method

1. **List the outcomes the request implies**, in the user's words and in the plan's. Each noun
   phrase that could be demonstrated on its own is a candidate: an endpoint, a screen, a rule, a
   migration step.
2. **Group them into areas.** Areas become the top level below orientation: a layer, a surface, a
   phase or a module boundary, whichever the work divides along naturally.
3. **Test each candidate.** Can it finish alone and be verified alone? If it joins several results
   with commas or "and", split it. If it has no result of its own (just reading, thinking or
   editing), merge it into the task it serves.
4. **Add the integration check.** Where the pieces must work together, give the parent a last child
   that verifies them together. The final top-level task is the whole-work gate.
5. **Write criteria on the leaves** as observable checks (a command that passes, behavior that can
   be shown). Do not restate the title.

Splitting by activity is the usual mistake:

```
Bad                          Good
1 Read the code              1 Orientation ...
2 Implement the feature      2 Token store
3 Write tests                  2.1 Interface
4 Run tests                    2.2 In-memory implementation
                               2.3 Callers migrated
                             3 Verification
```

The bad list has three vague phases that stay open for the whole job. The good list has outcomes
that finish, fold and report one after another.

## 1. A feature across layers

Request: "Add API-key authentication to the service, with key rotation and docs."

Outcomes: key storage, request authentication, rotation, documentation. Each has a different surface and
can be checked separately; authentication and rotation each contain several results, so they get
children.

```
1 Orientation, Analysis, Scope & Objective clarification
  1.1 Read the auth design and the request pipeline
  1.2 Find existing token handling and its tests
2 Key storage
  2.1 Key model and hashing
  2.2 Persistence and lookup
3 Request authentication
  3.1 Middleware rejects missing and invalid keys
  3.2 Scopes limit each key to its routes
  3.3 Rate limit per key
4 Key rotation
  4.1 Issue a replacement key
  4.2 Old key stays valid for the grace period
  4.3 Old key is rejected afterwards
5 Documentation and final gates
  5.1 Operator and API docs
  5.2 Project test and lint gates pass
```

```json
{
  "version": 2, "slug": "api-key-auth", "title": "API-key authentication",
  "goal": "Requests authenticate with scoped API keys that can be rotated, and the behavior is documented and tested.",
  "tasks": [
    { "title": "Orientation, Analysis, Scope & Objective clarification", "subtasks": [
      { "title": "Read the auth design and the request pipeline" },
      { "title": "Find existing token handling and its tests" } ] },
    { "title": "Key storage", "subtasks": [
      { "title": "Key model and hashing", "acceptanceCriteria": ["Keys are stored only as salted hashes"] },
      { "title": "Persistence and lookup", "acceptanceCriteria": ["A stored key is found by its identifier"] } ] },
    { "title": "Request authentication", "subtasks": [
      { "title": "Middleware rejects missing and invalid keys", "acceptanceCriteria": ["Missing and invalid keys return 401"] },
      { "title": "Scopes limit each key to its routes", "acceptanceCriteria": ["A key outside its scope returns 403"] },
      { "title": "Rate limit per key", "acceptanceCriteria": ["The limit applies per key, not per client address"] } ] },
    { "title": "Key rotation", "subtasks": [
      { "title": "Issue a replacement key", "acceptanceCriteria": ["Rotation returns a new key once"] },
      { "title": "Old key stays valid for the grace period", "acceptanceCriteria": ["Both keys authenticate during the grace period"] },
      { "title": "Old key is rejected afterwards", "acceptanceCriteria": ["The old key returns 401 after the period ends"] } ] },
    { "title": "Documentation and final gates", "subtasks": [
      { "title": "Operator and API docs", "acceptanceCriteria": ["Docs describe key creation, scopes and rotation"] },
      { "title": "Project test and lint gates pass", "acceptanceCriteria": ["The project test and lint commands pass"] } ] }
  ]
}
```

## 2. A bug that needs diagnosis

Request: "The importer drops the last row of some CSV files. Fix it."

The unknown is the cause, so the cause is a task of its own, and the fix is added after it is
known. Small, but not one task: reproduction and diagnosis can fold into a short record that the
fix then relies on.

```
1 Orientation, Analysis, Scope & Objective clarification
2 Reproduce the failure
  2.1 Failing test with a file that loses its last row
  2.2 Identify which files trigger it
3 Find the cause
4 Fix and prove
  4.1 Fix the boundary handling
  4.2 Regression test stays green and covers the trigger
  4.3 Project test gate passes
```

```json
{
  "version": 2, "slug": "importer-last-row", "title": "Importer drops the last row",
  "goal": "CSV files import every row, including those without a trailing newline, with a regression test.",
  "tasks": [
    { "title": "Orientation, Analysis, Scope & Objective clarification" },
    { "title": "Reproduce the failure", "subtasks": [
      { "title": "Failing test with a file that loses its last row", "acceptanceCriteria": ["The new test fails for the reported file"] },
      { "title": "Identify which files trigger it", "acceptanceCriteria": ["The trigger condition is stated and checked on two files"] } ] },
    { "title": "Find the cause", "acceptanceCriteria": ["The defective line is identified and explained"] },
    { "title": "Fix and prove", "subtasks": [
      { "title": "Fix the boundary handling", "acceptanceCriteria": ["The reproduction test passes"] },
      { "title": "Regression test covers the trigger", "acceptanceCriteria": ["The test fails on the old code and passes now"] },
      { "title": "Project test gate passes", "acceptanceCriteria": ["The project test command passes"] } ] }
  ]
}
```

Add children under "Find the cause" with `tasks add` if diagnosis turns out to branch.

## 3. A refactor or migration

Request: "Move all callers from the legacy `Session` store to the new `SessionRepository`."

Split on module boundaries, not on files. The seam comes first, callers follow one group at a time
so each group's work can fold, and the legacy removal is the last, separately verified step.

```
1 Orientation, Analysis, Scope & Objective clarification
  1.1 Map callers of the legacy store by module
  1.2 Capture behavior that must not change
2 New repository seam
  2.1 Interface and adapter over the legacy store
  2.2 Characterization tests pass against both
3 Migrate callers
  3.1 HTTP handlers
  3.2 Background jobs
  3.3 CLI commands
  3.4 Test fixtures
4 Remove the legacy store
  4.1 No remaining references
  4.2 Delete the legacy implementation
  4.3 Project gates pass
```

```json
{
  "version": 2, "slug": "session-repository", "title": "Migrate to SessionRepository",
  "goal": "All code uses SessionRepository and the legacy Session store is removed with behavior unchanged.",
  "tasks": [
    { "title": "Orientation, Analysis, Scope & Objective clarification", "subtasks": [
      { "title": "Map callers of the legacy store by module" },
      { "title": "Capture behavior that must not change" } ] },
    { "title": "New repository seam", "subtasks": [
      { "title": "Interface and adapter over the legacy store", "acceptanceCriteria": ["The adapter implements the whole interface"] },
      { "title": "Characterization tests pass against both", "acceptanceCriteria": ["The same tests pass against the legacy store and the repository"] } ] },
    { "title": "Migrate callers", "subtasks": [
      { "title": "HTTP handlers", "acceptanceCriteria": ["Handlers use the repository and their tests pass"] },
      { "title": "Background jobs", "acceptanceCriteria": ["Jobs use the repository and their tests pass"] },
      { "title": "CLI commands", "acceptanceCriteria": ["Commands use the repository and their tests pass"] },
      { "title": "Test fixtures", "acceptanceCriteria": ["Fixtures build sessions through the repository"] } ] },
    { "title": "Remove the legacy store", "subtasks": [
      { "title": "No remaining references", "acceptanceCriteria": ["A search finds no use of the legacy store outside its own module"] },
      { "title": "Delete the legacy implementation", "acceptanceCriteria": ["The module is gone and the build succeeds"] },
      { "title": "Project gates pass", "acceptanceCriteria": ["The project test, lint and type checks pass"] } ] }
  ]
}
```

## 4. A large plan document with phases

Request: a plan with phases, each with several rows ("Transcript row: branches, filters, previews,
scrolling"; "Bindings row: one action contract, remap, dispatch").

This is the case that goes wrong most easily: each row reads like a task but contains several
results. Keep the phases and rows as parents, make each result in the row a leaf, and nest to three
levels. One row then folds as seven small records instead of staying open for hours.

```
1 Orientation, Analysis, Scope & Objective clarification
2 Close acceptance rows
  2.1 Transcript row
    2.1.1 Branches
    2.1.2 Filters
    2.1.3 Previews
    2.1.4 Fine scrolling
  2.2 Bindings row
    2.2.1 One action contract
    2.2.2 Remap and unbind
    2.2.3 Dispatch agrees with display
  2.3 Media row
    2.3.1 Image downscale
    2.3.2 Placeholder for unsupported terminals
    2.3.3 Mermaid fences
3 Live verification
  3.1 Terminal captures at 36, 57, 80 and 140 columns
  3.2 Project gates pass
```

Rules of thumb for plans:

- Keep the plan's own phase and row names as parents, so the list and the document stay comparable.
- A row that lists N results becomes N leaves. Do not shorten it by summarising.
- Keep verification the plan demands (live runs, widths, gates) as its own tasks, not as a
  criterion hidden in a leaf.
- Keep the plan's constraints as list or task pins, and its source sections as attachments.

## 5. Research or review that ends in a report

Request: "Compare three queue libraries and recommend one."

The outcomes are answers, so split by question and candidate, and make the report the last task.

```
1 Orientation, Analysis, Scope & Objective clarification
2 Evaluate candidates
  2.1 Library A: delivery guarantees and maintenance
  2.2 Library B: delivery guarantees and maintenance
  2.3 Library C: delivery guarantees and maintenance
3 Compare against requirements
  3.1 Throughput and latency on the fixture workload
  3.2 Operational cost and failure modes
4 Recommendation
  4.1 Draft the recommendation with evidence
  4.2 Every claim cites a source or measurement
```

Each candidate leaf reports its findings in `outcome`, so the final comparison reads short records
instead of three long research sessions.

## When a plan changes mid-way

- A leaf grows broader than expected: before continuing, `tasks add` children to it (or split the
  rest into new siblings). Do not carry on in one long span.
- A new requirement appears: `tasks add` it where it belongs, with `before` or `after`.
- Blocked on a decision only the user can make: `tasks block` it with reason `user-decision`, ask
  the question, and resume after the answer, rather than guessing.
- A started task cannot be moved or renumbered; add the new work beside it instead.
