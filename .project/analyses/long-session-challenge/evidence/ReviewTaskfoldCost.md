Definitions: N = blocks, T = tasks, G = groups, D = task-tree depth. Magnitudes below are static estimates, not timings. All findings are **verified by reading**.

## Ranked findings

1. **[P1] Index block-to-group membership instead of searching every group** | `core/truth.ts:774-776`; `core/conductor/liveHost.ts:221-227`
   Every `host.blocks()` projects N blocks, and each projection calls `inFoldedGroup`, which searches group member arrays (`core/conductor/hostAdapter.ts:47`). This is O(N² + NG) when groups cover much of the transcript. `opGroup` repeats the same membership search for every incoming member (`core/truth.ts:1772`). With 50,000 blocks and 25,000 grouped members, one projection can perform hundreds of millions of ID comparisons. **Fix:** maintain `Map<BlockId, GroupId>` and a group-ID index across group mutations.

2. **[P1] Compute diagnostic task ages without rescanning every transcript suffix** | `conductors/in-process/taskfold/taskfold.ts:896-904`
   Every plan slices and filters the remaining transcript separately for every finished task, even with debug disabled. Cost is O(TN + T²), plus temporary arrays. At N=50,000 and T=300 with evenly distributed completions, the suffix scans visit approximately 7.5 million blocks per evaluation. **Fix:** maintain cumulative tool-result counts, store each task’s finishing count, and resolve ancestors through a task-parent index.

3. **[P1] Replace quadratic absorbed-group containment checks with sets** | `conductors/in-process/taskfold/taskfold.ts:1142-1145`
   For each absorbed child group, the compiler searches `matching[0]` separately for every member ID. A child group of m members inside a run of L blocks costs O(mL). Absorbing a 20,000-block child can require roughly 200 million comparisons before other compilation work. **Fix:** construct one member-ID set per viable run and use set containment plus a block-to-run index.

4. **[P1] Protect delivered context while its task remains open** | `conductors/in-process/taskfold/taskfold.ts:959-962,1021-1022`
   Neither the floor mask nor run eligibility checks delivery manifests. With `floor:true`, keel’s R5 can fold an old `tasks start` result larger than 200 tokens. With default step folding, a later `claim` call/result can collapse inside the still-open task because it is not a start/resume anchor. Criteria, pins and attachments disappear before completion; delivery is reconsidered only on another start/claim (`extension/accordion.ts:4666-4673`). This contradicts SPEC-0002 §4.3. **Fix:** preserve delivery ownership in metadata and apply one shared active-delivery protection predicate to floor, steps and untracked compilation.

5. **[P1] Queue classification backlogs instead of exhausting the host limit** | `conductors/in-process/taskfold/taskfold.ts:639-654`
   Resync/consent draining launches every unclassified user message immediately. The live executor admits only four simultaneous model calls (`extension/accordion.ts:168,1280`). Remaining requests fail, become error verdicts, and are subsequently skipped because `verdicts.has(id)` is true. A backlog of 300 eligible messages can leave at least 296 unclassified until another resume. Each failure also triggers another complete evaluation. **Fix:** drain a bounded queue, distinguish capacity rejection from classification failure, and retry queued work when a slot settles.

6. **[P2] Require pressure before expiring an agent-opened task** | `conductors/in-process/taskfold/taskfold.ts:803-807`
   After two newer finished roots, planning clears the first-unfold protection regardless of `pressure`. Eager timing then permits refolding below the high watermark. SPEC-0002 §7.3 requires both task age ≥2 **and pressure**. In long sessions this can unexpectedly hide recently reopened material and rewrite an old wire prefix despite ample headroom. **Fix:** gate expiration on pressure; otherwise retain the open state.

7. **[P2] Stop rebuilding unchanged eligibility on every event** | `conductors/in-process/taskfold/taskfold.ts:531-553,765-774`
   Every append, turn commit and departing request invokes the complete planner. Non-auto state changes do too. A normal tool step therefore evaluates on its assistant-message append, result append and next wire departure, even when no task or eligibility boundary changed. Each evaluation copies/projects all blocks, obtains stats twice, reparses task events and reconstructs task ancestry. **Fix:** maintain dirty task/block frontiers, coalesce append events, and reserve request-time reevaluation for dirty work or timing expiry.

8. **[P2] Compile task facts and handles from indexed intervals, not the entire log** | `conductors/in-process/taskfold/taskfold.ts:1158-1169,1213-1234`
   `spanHandle` filters all N blocks for every child and is called again during reachability computation. Recursive `record` also filters the whole transcript per node, testing descendant intervals. Even a star-shaped subtree incurs O(NT) work independently of diagnostics. N=50,000 and 300 descendants means at least 15 million visits per full handle pass. **Fix:** cache immutable completed-task facts, use interval slices/prefix indexes, and compose records bottom-up from cached child records.

9. **[P2] Avoid repeatedly cloning all group and handle memberships** | `core/conductor/liveHost.ts:225-227`; `conductors/in-process/taskfold/taskfold.ts:1062-1078`
   Every `groups()` deeply copies member arrays and handle-member arrays. `unit` requests these repeatedly, including from its boundary predicate. Hierarchical handles retain O(ND) member references; with 50,000 blocks and depth 10, a snapshot can copy hundreds of thousands of references, repeatedly for each compiled unit. **Fix:** provide a revision-stable immutable group snapshot, reuse it throughout the epoch, and represent handle coverage as stable interval ranges.

10. **[P2] Avoid rebuilding quadratic read analysis for each pressure-floor scope** | `conductors/in-process/taskfold/taskfold.ts:948-973`
    Each floor invocation constructs and attaches a fresh keel conductor, then plans again over the entire masked history. Keel’s stale-read analysis compares each read against all reads and writes (`conductors/in-process/keel-lite/keel-lite.ts:730-732`): O(N²) worst case. Both open and untracked scopes can repeat this. At 10,000 reads, that is up to 100 million read comparisons per scope. **Fix:** build newest-read/newest-write indexes by normalized path once, and share one structural analysis across both scopes.

11. **[P2] Discard classifier results after their attachment or session ends** | `conductors/in-process/taskfold/taskfold.ts:728-740`
    Unlike routing, classification does not check `this.host === host` before mutating the shared verdict ledger. Session replacement aborts old calls and then resets that same ledger (`extension/accordion.ts:3333,3410`). A late success can therefore persist an old-session verdict through the new session’s persistence callback; an aborted failure also inserts stale state into the new ledger. **Fix:** guard both success and failure mutations with attachment identity or a ledger generation.

12. **[P2] Clear saturation status when saturation no longer applies** | `conductors/in-process/taskfold/taskfold.ts:775-778`
    If a saturated session becomes healthy without another fold—for example, the user raises the budget—the no-plan, no-pressure branch returns without clearing the previous error. The host retains that status indefinitely. In a days-long session the footer can continue reporting saturation after recovery. **Fix:** explicitly transition from saturated/degraded to healthy when the condition disappears.

## Growth facts, not additional defects

- Verdicts grow O(user messages), routing-attempt IDs O(routed messages), and unfold states O(opened tasks); none is evicted during the attachment/session.
- History retention and preservation of minimum child histories beyond `recordTokens` are explicit specification decisions, not accidental cap violations.
- Debug storage is bounded: pending data and the session log have a 50 MiB cap (`extension/debug.ts:20-31,61-68`).
- `countTokens` is currently O(1) character-length arithmetic, not repeated real tokenization (`core/tokens.ts:16-18`).

## Cheaper or more usable designs

1. **Incremental task index.** Consume task lifecycle events once into task nodes containing intervals, parent links, deterministic facts, finish counters and fold state. Keep a dirty-node queue; resync rebuilds the index once. Ordinary requests then inspect changed nodes rather than rediscovering the session.

2. **Revision-stable host read model.** Expose immutable block/group snapshots backed by membership indexes, cached aggregate totals and per-group shape caches. Separate structural, overlay and calibration revisions so a receipt or sent-frontier change does not invalidate unrelated structural work.

3. **Immutable sealed task segments.** Finalize each completed segment once, then compose parent indexes from child references rather than rebuilding their transcript coverage. Keep detailed reports in recall storage and place bounded navigation records on the wire; make the standing-history budget explicit rather than silently discarding history.

4. **Explicit saturation and recovery state machine.** Record why no further reduction is possible, which changes can restore eligibility, and the irreducible token floor. Suppress repeated planning until one of those changes occurs. Surface an actionable explanation distinguishing retained history, active deliveries, protected tail and user-held content.

Verification: read-only source inspection and git diff/log/show. No tests, builds, benchmarks or >1M-token replay were run; runtime magnitude remains **UNVERIFIED**. No files changed.

BLOCKERS: none