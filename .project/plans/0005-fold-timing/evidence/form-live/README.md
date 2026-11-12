# Record and bracket live evaluation

12.11.2026, Pi-Bolt 1.5.0, `claude/claude-sonnet-5-5`, low thinking, eager timing.
Each form ran in its own project, session directory and Accordion home. Only the local Accordion
extension and the installed authentication-provider extension were loaded. Full session metadata,
signatures, credentials and provider-account status are not copied here; message fixtures retain only the
fields needed for replay and task-event auditing.

## Initial trial: rejected as a cost comparison

The root files preserve the first protocol and its outcome. Record ran 24 sample calls; bracket
ran only 23. Every recorded call has a result. Both agents subsequently disavowed execution that
was in the raw trace, then found it through recall. Their contradictory narration and different
counts make this an invalid cost comparison. It is a counterexample for B-0001 prompt evaluation.
The older request diagnostic says `shipped`; actual fold/config timing was eager. Source now
reports resolved timing, covered by native context smoke.

## Verified serial trial

`serial/` uses numbered outputs (`cache-sample-01` … `cache-sample-12`) twice and explicitly
requires one tool call per assistant response. It also explains that missing visible calls after
folding are not evidence of missing execution and directs the agent to recall originals.

| Observed | Record | Bracket |
|---|---:|---:|
| Correctly numbered sample calls / matching outputs | 24 / 24 | 24 / 24 |
| Multi-call responses | 0 | 0 |
| Tool calls paired with exactly one result | all | all |
| Finished child / child / root | 1.1 / 1.2 / 1 | 1.1 / 1.2 / 1 |
| Main-provider receipts | 33 | 35 |
| Total input tokens | 907,376 | 963,194 |
| Mean input tokens | 27,496 | 27,520 |
| Cache-read tokens | 883,461 | 939,041 |
| Cache-write tokens | 23,847 | 24,081 |
| Cache read at first leaf fold | 26,601 | 26,603 |
| Cache read at second leaf fold | 26,601 | 27,536 |
| Post-fold cache-read fraction | 98.88–99.25% | 99.00–99.26% |

The subsequent recall-only audit called `recall` with both child codes in each session. Both
returned without errors and included the original first report's whole outcome, decision and open
item. Both agents then confirmed the numbered executions. Initial completion commentary still
showed uncertainty about hidden evidence; explicit recovery worked. This is not proof of general
comprehension parity, nor a statistically controlled performance comparison: reasoning and request
counts differ. Keep record as the default rather than deriving a winner from this pair.

## Prefix-level decision

A near-99% aggregate hit ratio is not enough to close S6. Record mode's second leaf fold reads
26,601 tokens, exactly the cacheable prefix from before the first leaf. Its prior sibling's carrier
is unchanged (`firstChangedBlock` moves from 4 to 32), but that updated carrier prefix was not
written at the pre-second-task boundary: the first record fold had to wait until the next task
started. The remaining write is small here but can grow with retained records.

Bracket mode's second fold reads 27,536 tokens, exactly its pre-second-task cacheable prefix.
Its earlier fold could mint that boundary before the second task started. S6 therefore proceeds
for default record mode: first verify live that moving only a marker preserves cache hashes,
then add the Anthropic task-frontier breakpoint within the marker limit. No default-mode change
or cross-provider cache policy follows from this trial.

## Replay and checks

`*-checks.json` contains raw-count assertions, pre-task prefixes, post-fold receipts and recovery
audits. `*-session.jsonl` is sanitized model history; `*-debug.jsonl` contains request/fold/epoch/cache
records, not completion bodies. Terminal captures redact provider-account status.

`*-simulation.txt` replays each trace with `timing_sim.py --first-fold <index>` (32 for both serial
traces). The simulator uses whole outcomes, closing-only brackets and current lazy eligibility;
its `shipped` row deliberately represents the old 20-block-veto baseline. It remains an approximate
message/token model, not a prediction of provider invoices. Tests protect whole report/bracket
semantics and current lazy timing.

Automated verification also covers first-request folding, shared closing messages, automatic
closures, restored reports/handles through several ancestors, and absorbed descendants not being
misreported as raw after forty later tool results. A real-Truth regression covers a child starting
and finishing within its parent's closing call: no empty handle is installed, raw work stays
visible, and diagnostics explain why it cannot fold. Native context smoke verifies resolved
timing and no synchronous debug write on the context hook.

Verification at S5 closeout: 205 targeted Bun tests, two simulator regressions and 1,076 app
tests pass; Svelte check has zero errors/warnings, and all extension smoke suites pass. The
custom extension TypeScript check still fails with the same seven baseline diagnostics; it is
not claimed as passing. All four owned live-test processes were stopped after collecting evidence.
