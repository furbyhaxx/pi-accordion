Executable plans. Type `plan`, id `PLAN-NNNN` from `../ids.toml`. Dir `NNNN-<slug>/` with `plan.md` (+ `evidence/`).

- One plan per bug, feature or change. An agent that reads only this plan can finish it: current behavior with paths, the change, what not to do, tests, done-when.
- Overlapping plans are merged, not cross-referenced.
- Current and next slice detailed; later slices sparse. Progress list (done / now / next) updated in the same commit as the code.
- A feature branch edits only its own plan and backlog item; cross-cutting changes land on the integration branch.
- Work merged → delete the plan and its evidence, with trailers.
- Live-run captures → `evidence/`, credentials redacted.
