**HEAD audit.** All findings below are **verified by reading**. Magnitudes are operation/allocation estimates, not measured timings. No builds, tests, benchmarks, or edits were run. N = blocks, M = messages, G = groups, C = clients, T = transcript characters, E = session entries.

### Ranked findings

1. **Index block-to-group membership before serializing** | `core/truth.ts:1939-1941`, `core/truth.ts:760-777`  
   Every armed request calls `groupOf(b)` for folded blocks; that scans groups and their `memberIds.includes`. With most blocks grouped, this is **Θ(N²)**, not merely O(NG): approximately **1.25 billion ID comparisons at 50k blocks**. Maintain `Map<blockId, Group>`; update on group/ungroup/prune/reset and reconstruct on adoption/rebuild.

2. **Remove quadratic membership checks from conductor projections** | `core/conductor/liveHost.ts:221-223`, `core/conductor/hostAdapter.ts:47`  
   Every `host.blocks()` allocates N views and calls `inFoldedGroup` for every block, repeating the same **Θ(N²)** membership search. Taskfold invokes it during `turn_start`, append handling, and `wire-departing`. At 50k grouped blocks, **another ~1.25 billion comparisons per call**, plus 50k view objects. Reuse the membership index above and cache views against content/overlay/protection revisions.

3. **Keep unfold-state persistence off the context hook** | `extension/accordion.ts:3711`, `extension/accordion.ts:3413`  
   The hook synchronously enters Taskfold’s `wire-departing → evaluate → plan`; `conductors/in-process/taskfold/taskfold.ts:807` can call `setUnfold`, whose persistence callback calls `pi.appendEntry`. Installed Pi maps this to **`appendFileSync`** (`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:813`). Trigger: a once-unfolded task has two later finished roots. One small write can stall independently of N; this directly violates the no-disk-I/O invariant. Persist the transition before departure or queue ordered persistence after the hook.

4. **Stop rebuilding Pi’s session projection just to refresh usage** | `extension/accordion.ts:1611`  
   Every request calls `ctx.getContextUsage()`. Installed Pi’s implementation (`…/agent-session.js:3528-3545`) builds a full projection, independently gets the branch, and estimates projected usage. Its helpers perform **10+ E-sized walks/copies**, including two root-path reconstructions; this also runs with folding disabled. At E≈50k, that is **hundreds of thousands of entry visits and multiple large arrays per request**. Cache usage by leaf/model/compaction identity, or update it from receipts and new-message deltas.

5. **Avoid rehashing every historical character on every request** | `extension/accordion.ts:3021-3024`, `core/wire.ts:373-409`  
   Reconciliation fingerprints all incoming history, then computes message identities for both sides: **O(T + M + N)** every request. Historical tool arguments/details are JSON-stringified again. A ~1M-token transcript entails roughly **millions of character visits per request**, regardless of how little remains on the wire. Cache fingerprints by immutable message/content identity or host entry revision; invalidate on explicit edits, branch changes, and replacement objects. Preserve rewrite detection rather than assuming durable IDs imply unchanged content.

6. **Decouple footer accounting from every broadcast** | `extension/accordion.ts:876-878`, `extension/accordion.ts:1026`, `core/truth.ts:669-672`  
   Every broadcast synchronously notifies the footer, whose `stats()` performs **two uncached N-block sums**. Normal context departure broadcasts `sent` and telemetry: **four additional full block passes, 200k visits at 50k**, even with C=0. `message_end` also broadcasts stream-abort, calibration, and append events; `agent_end` broadcasts another abort. Cache aggregate totals and coalesce presentation updates. Crucially, telemetry’s footer work runs **after `recordHook`**, so reported hook latency omits it.

7. **Bound outbound WebSocket buffering and serialize broadcasts once** | `extension/accordion.ts:861-877`, `core/replica.ts:44-52`  
   `send` JSON-stringifies separately for every client and never checks `bufferedAmount`. Snapshots cost **O(N + total group membership + C·serialized bytes)**; slow OPEN sockets retain queued frames without an application bound. At 50k blocks, each snapshot carries **all original text plus metadata**, not only the folded wire; repeated resnapshots can accumulate that size per slow client. Serialize once, enforce an outbound-byte ceiling, and disconnect lagging replicas so they reconnect from a fresh snapshot—do not silently drop ordered events.

8. **Replace repeated forward peeking in DROP-role validation** | `core/wire.ts:505-545`  
   Every pure-drop run scans later drop runs to find the next survivor. A chain of R runs costs **Θ(MR)** even when no degradation occurs; tool-pair and role fixpoints add further whole-message rounds. With 500 contiguous drop groups spanning 50k messages, one role pass can examine **~12.5 million message positions**. It runs in `applyPlan` and, for DROP accounting, through `Truth.degradedRunKeys`. Build run descriptors with next-survivor links and propagate changes through a work queue.

9. **Separate group-shape invalidation from global `rev`** | `core/truth.ts:836-849`, `core/truth.ts:974-997`, `core/truth.ts:1225-1229`  
   Group accounting is cached by global revision, while `markSent`, calibration, and unrelated appends invalidate it. Rebuilding classifies every folded group; default summaries independently classify again through `computeGroupOps → groupSummary`. Each classification builds maps, sets, arrays, and runs over its members. At 50k grouped blocks this means **repeated 50k-member reconstructions per request/response**, before fixpoint costs. Cache per-group shape/summary and use separate structural, overlay, calibration, and sent revisions.

10. **Append finished messages without copying all history** | `extension/accordion.ts:3146-3147`  
    Each newly finished message spreads `lastMessages` twice and `lastFps` once: **O(M)** despite linearizing only one suffix. At M=50k this copies **150k slots—about 1.2 MB with eight-byte slots—per message**, excluding allocation overhead. Use an owned append-only reconciliation array and fingerprint vector; replace them on authoritative reconciliation/rebuild. `agent_end` duplicates normally exit before this work, so its backstop is not itself a full-history replay.

11. **Gate diagnostic computations, not only diagnostic recording** | `extension/accordion.ts:3119-3120`, `extension/accordion.ts:472-473`  
    Every accepted assistant receipt evaluates `truth.liveTokens()` and `fullTokens()` before `debug()` checks whether logging is enabled: **two unnecessary N-block passes**, or **100k visits per response at 50k**, with debug off. Guard construction at the caller or accept a lazy record builder. These totals can also use the aggregate cache.

12. **Index live recall results instead of rescanning under pressure** | `core/recallExpiry.ts:47-74`, `extension/accordion.ts:3702`  
    Every near-budget armed request builds two N-sized arrays, walks all blocks backwards, then `flatMap`s all blocks again—even if no recall result exists. Cost is **O(N)** plus group-membership searches for recall candidates; at 50k, **100k visits and 100k initialized array slots per pressured request**. Maintain pending recall-result IDs, call lookup, assistant-step ordinal, and prompt ordinal; invalidate individual entries when replaced/grouped and reconstruct on rebuild.

13. **Cache the task boundary used by the provider hook** | `extension/taskCache.ts:55-76`, `extension/accordion.ts:4039-4042`  
    Each matching Anthropic Taskfold request rescans task spans (**two N-block passes**), searches source messages, flattens the provider payload, and searches every candidate offset against P source parts: **O(N + M + payloadBlocks·P)**. At 50k, this adds **100k block visits plus several payload-sized temporary arrays** after context timing has already stopped. Maintain incremental task-span state and the open-boundary message ID; resolve that boundary through a provider-conversion index. Invalidate on lifecycle events, branch/rebuild, and provider payload conversion.

14. **Reuse one branch read and one replay dispatch on resume** | `extension/accordion.ts:3396-3448`, `extension/accordion.ts:2848-2849`  
    Startup separately calls `getBranch` for dials, replay, and task binding, then independently builds session context. Replay scans the entries separately for debug, adoption, ledger, verdicts, and unfolds. `Truth.rebuildFrom` is **O(N + ΣgroupSize·log(groupSize))**, with several N-block carryover walks—not inherently quadratic. At 50k blocks, each resume constructs **50k block objects, a new index, fingerprint state, and multiple branch arrays**. Read one branch, dispatch custom entries once, and reuse it for binding/projection; checkpoint replay maps by branch entry ID with branch-change invalidation.

### Persistence and memory accounting

- `accordion.dials`: each explicit dial command; `accordion.debug`: explicit toggle; `accordion.taskfold.adopted`: adoption; `accordion.compact`: reported compaction, including potentially O(N) undo IDs.
- `accordion.taskfold.verdict`: durable message classification/routing, not every model request; routing can add another record. `accordion.taskfold.unfold`: handle-state transitions.
- `accordion.tasks.binding`: changed attachment/fingerprint only; **`accordion.tasks.idle`: every agent stop with an attached list** (`extension/accordion.ts:3558`), even when unchanged. `accordion.recall.ledger`: successful task-ledger extraction.
- No unconditional custom-entry append occurs directly in the ordinary context handler; finding 3 is a reachable synchronous conductor path.
- Truth, snapshots, and unchanged wire messages generally share string references in-process; they do **not** automatically create independent full-text copies. JSON serialization and socket queues do create additional representations.
- Hook-duration storage is capped at **256** (`extension/accordion.ts:815`). Debug pending/log storage is capped at **50 MiB** (`extension/debug.ts:20-31`); drain batching adds transient copies. Digest caches are weakly keyed. No separate retained full-text recall archive was identified.
- **UNVERIFIED:** actual hook latency, RSS, and >1M-token replay behavior; no qualifying runtime proof was performed.

### Full passes made by one context hook, in order

For an armed, append-only request with no hold, no divergence, no recall expiry, and an advancing sent frontier:

1. `refreshFromCtx → getContextUsage`: Pi projection/branch reconstruction and estimation—**10+ E-sized walks/copies**, depending on compaction/usage state.
2. Optional adoption: **one M-message map** when adopted events exist.
3. Reconciliation: **one historical content-hash walk**, plus **two message-identity constructions** per matched message.
4. Guard: only the unsent suffix normally; a loaded-session guard scans **N** once.
5. Recall-pressure check: `stats()` performs **two N-block sums**, plus protected-tail scan/cache lookup.
6. Serialization: `computeFoldOps` scans **N** with quadratic group lookups; `computeGroupOps` scans group members and may reclassify.
7. With groups: message shapes scan **M**; ownership scans **M**; tool-pair fixpoint scans **2M per round**; role fixpoint scans **M plus lookahead per round**; index remapping scans **M**.
8. `applyPlan` output construction traverses **M**, including collapsed runs.
9. Pending receipt estimate: `liveTokens()` scans **N**.
10. `markSent` broadcasts; footer `stats()` performs **two N-block sums**, potentially rebuilding group accounting.
11. Telemetry broadcasts; footer performs **two more N-block sums**, **outside recorded hook time**.
12. Separately, `context_with_system` maps the **outgoing message array**; the provider hook may add finding 13.

**Baseline: eight full N-block accounting/serialization passes, plus reconciliation, Pi’s entry walks, group-member reconstruction, and wire-message passes.** A hold adds `freshIds` scanning and another two N-block sums before conductor-specific work. The debounced WS task projection later adds **four N-block sums** because it calls `stats()` twice.

BLOCKERS: none