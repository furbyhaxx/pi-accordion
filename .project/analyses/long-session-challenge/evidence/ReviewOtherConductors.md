1. **P1 | Shared conductor views | `core/conductor/view.ts:179`, `core/conductor/remote.ts:220-221` | verified by reading**  
   Every `blocks()` materializes the entire history. Each `viewBlockOf` additionally calls `inFoldedGroup`, which scans group member arrays (`core/conductor/hostAdapter.ts:46`, `core/truth.ts:775-777`), making materialization quadratic after substantial grouping. Approximately 50k members in one group imply **1.25 billion membership comparisons per materialization**. Doorman also invokes this for individual fresh results (`doorman.ts:129`).  
   **Fix:** index folded-group membership, cache unchanged block views, and maintain a call-ID index so fresh-result handlers need not materialize history.

2. **P1 | Thermocline | `conductors/ws/thermocline/policy.ts:699-706` | verified by reading**  
   Ladder loops repeatedly invoke `project()`, which rebuilds a complete block-ID map and walks accumulated compression state (`:272-288`). Planning M moves over N blocks costs **O(NM)**; the hard-cap loop repeats similar work. At 50k blocks and 10k moves, this means roughly **500 million block-index insertions**, before other traversals.  
   **Fix:** build the lookup once per plan and incrementally update projected cost as each move is added.

3. **P1 | Keel-lite / Keel-note | `conductors/in-process/keel-lite/keel-lite.ts:729-731` | verified by reading**  
   Each read searches every read and potentially every write for supersession: **O(R² + RW)** per pressured evaluation. Existing folded history remains included. With 10k distinct-path reads in a 50k-block session, reread detection alone performs **100 million predicate evaluations** per evaluation.  
   **Fix:** analyze backward using indexed latest full reads, range reads, and writes, preserving the existing path-matching semantics.

4. **P1 | Thermocline | `conductors/ws/thermocline/policy.ts:928-930` | verified by reading**  
   Per-block fold eligibility ignores `ViewBlock.signed`. Signed thoughts therefore receive `replace` operations, while the consuming wire handler retains their original signature (`core/wire.ts:585-587`). The rewritten text no longer matches its provider seal; one affected thought can invalidate replay or have its replacement ignored. Session size does not mitigate this.  
   **Fix:** exclude signed thinking from every per-block compression candidate and savings calculation; only use provider-safe whole-message transformations.

5. **P1 | Thermocline | `conductors/ws/thermocline/policy.ts:276-278` | verified by reading**  
   Proposed folds are priced using the block’s **existing** `foldedTokens`, not the newly generated trim/digest. `planWithRealStratumTokens` corrects strata only (`thermocline.ts:1334-1338`). A 600-character trim can cost substantially more than the engine placeholder being credited, so a supposedly fitting emergency can still send an oversized wire. Error accumulates across all newly replaced blocks.  
   **Fix:** render and count each proposed replacement, including its tag and overhead, before final projection and hard-cap enforcement.

6. **P1 | Thermocline | `conductors/ws/thermocline/policy.ts:860-862` | verified by reading**  
   DROP strata are charged zero, but the consuming wire’s role-validity floor can retain paid recap messages (`core/truth.ts:871-875`). Both planning and wire-departing checks use the same optimistic projection, so these costs remain invisible. With K fragmented degraded drops at 50k blocks, the missing cost is **K complete recap messages**, not rounding noise.  
   **Fix:** price projected drops through the canonical role-floor calculation and include recap framing in the cap check.

7. **P2 | Thermocline / Codemode | `conductors/ws/thermocline/thermocline.ts:844-845` | verified by reading**  
   HOLD computes `foldBody()` even when every resulting body is immediately discarded in favor of frozen `appliedFolds`. Deterministic codemode bodies tokenize scripts and parse full JSON outputs again (`policy.ts:1136-1141`, `:1198-1206`). Consequently, unchanged archived results are reprocessed on successive append/turn events. At 50k blocks, cost follows the total text of retained fold units, not new content.  
   **Fix:** reuse applied bodies before invoking `foldBody`; memoize immutable codemode decoding for genuinely new work.

8. **P2 | Keel-lite / Keel-note | `conductors/in-process/keel-lite/keel-lite.ts:444-446` | verified by reading**  
   Every existing group is permanently excluded from all further compression. R7 therefore accumulates an irreducible recap per chunk; there is no rung that consolidates old owned groups. A 50k-block history can retain thousands of recap messages and eventually saturate despite small roots and tail. The stall message incorrectly attributes this solely to roots and tail.  
   **Fix:** add bounded consolidation of old owned groups while preserving recoverable handles, and report the true residual floor.

9. **P2 | Thermocline | `conductors/ws/thermocline/policy.ts:347-348` | verified by reading**  
   Graduation requires **every** unit member to be folded. A tool-pair unit contains a tool call, which cannot be individually folded; therefore its folded result never graduates through the attention/dwell mechanism before grouping. At 50k blocks, every such pair remains dependent on the age-based fallback regardless of sustained cold scores.  
   **Fix:** require folded state for compression-eligible members, while retaining whole-pair grouping and touch vetoes.

10. **P2 | Keel-lite / Keel-note | `conductors/in-process/keel-lite/keel-lite.ts:730` | verified by reading**  
    Any later ranged read marks an earlier ranged read of the same file stale, even when their ranges are disjoint. Only a boolean is retained, so identical-range supersession cannot actually be checked. Repeated partial reads in long sessions consequently lose unique earlier content at R2.  
    **Fix:** retain actual ranges and only supersede a prior read when the newer read covers its range or reads the whole file.

11. **P2 | Remote conductors | `core/conductor/remote.ts:205` | verified by reading**  
    Completion abort listeners are never removed on successful or failed completion. Thermocline shares one lifetime signal across requests, retaining one callback per settled conductor completion until detach. **1,500 completed conductor calls mean 1,500 retained listeners**, irrespective of pending-map cleanup.  
    **Fix:** store cleanup with each pending completion and invoke it on result, rejection, cancellation, and connection drain.

12. **P2 | Triptych | `conductors/ws/triptych/triptych.ts:283-290` | verified by reading**  
    `skelCache` retains every evaluated ID and successful skeleton until reattach, including skeletons already consumed into summaries and blocks removed by resync. Memory grows with **all historically generated skeleton text**, rather than the active middle band. At 50k blocks, 10k cached 4-KiB skeletons retain roughly **40 MiB of text**, excluding runtime representation and map overhead.  
    **Fix:** evict consumed skeletons after successful summary coverage and remove vanished entries on resync.

**Transport assessment:** `core/conductor/remote.ts:337-364` consumes incremental events, not snapshots on every event. Attach/resync synchronously parses and hydrates the full raw transcript, overlays, and group membership (`core/replica.ts:44-91`): **O(total transcript bytes + metadata)** even after extensive folding. Exact 50k-block snapshot bytes, RSS, and latency are **UNVERIFIED**.

**Verification:** Source inspection only; no builds, tests, or long-session replay executed. Magnitudes above are conditional analytical counts, not measured timings. No files changed.

BLOCKERS: none