---
document:
  type: "analysis"
  id: "ANA-history-conductor-nukular-ai"
  title: "Nukular AI session history and Accordion conductor fit"
  description: "Branch-aware local history profile and conditional conductor recommendation."
  status: "published"
  revision: 1
  created_at: "2026-11-01T14:54:36+01:00"
  updated_at: "2026-11-01T14:54:36+01:00"
  created_by: "analyst"
  updated_by: "analyst"
  changelog:
    - revision: 1
      reason: "document creation"
      changes: ["document creation"]
---

# Nukular AI history and conductor fit

## Summary

**Conditional choice: `keel-note` for coordinator continuity, but do not enable it yet.** It combines recoverable, batched pressure reduction with a compact progress note; this fits repeated decisions, delegation outcomes and unresolved failures better than age-based folding alone. This is a source-and-history assessment, not a demonstrated performance result. Before live use, address the signed-thinking and custom-frame visibility hazards below. `keel-note` also makes background model calls containing clipped session material; a future trial requires separate authorization and an appropriate privacy decision. No such calls were made here.

If those model calls are unacceptable, `keel-lite` is the closest no-model-call alternative, with weaker continuity and the same inherited visibility and signed-thinking concerns. No existing conductor demonstrably satisfies all of this workload's needs.

## Reproduction and method

A local Python scan near 14:48 on 2026-11-01, Europe/Zurich, read 965 JSONL files in 344 matching session directories, 758,085,265 bytes. No history, project source, or settings were modified; no history was sent to a model or external service. The corpus was changing during analysis: a later recount found 974 files, so numbers below describe the first scan rather than an atomic filesystem snapshot.

| Header cwd | Files | Interpretation |
|---|---:|---|
| Exact project root | 372 | Mixed coordinators, forks and root-cwd workers; **not** all main sessions |
| Project worktrees | 592 | Worktree-associated runs; do not assume every run's actual role from cwd alone |
| Other cwd in matching directory | 1 | Kept separate; directory name and header disagree |

Of the 372 root-cwd files, 340 have a `parentSession` header and 32 do not. A parent link can represent a fork, clone or child; it does not by itself prove the role. For example, root-cwd file `2026-10-19T12-36-15-757Z_01a15429-9d0d-726f-85be-f8626a55b576.jsonl`, entry `31f962cf`, is an explicitly delegated review brief. The long samples below were selected by size, parent metadata and coordination activity, not simply cwd.

**Historical** counts every stored entry, including abandoned branches. **Branch** follows `parentId` backward from the last appended entry in each file. This is the best on-disk leaf proxy, not proof of a currently running process's selected leaf. **Post-compaction slice** keeps the latest compaction summary and entries from its `firstKeptEntryId` through the tip, excluding earlier compaction entries and pre-boundary system-message deltas. It approximates, but does not reconstruct, Pi's final provider projection: `context_edit`, role projection, extension transformations, system checkpoints and live state are not fully applied. There were zero JSON parse errors, missing branch parent references, detected cycles, or missing kept-boundary IDs in this scan.

Across files, 18,698 entry lines were exact byte duplicates, totaling 101.8 MB; inherited/forked prefixes contribute. Counts and characters below are stored data, not billed tokens or cumulative provider context. A read can have occurred more than once, and copied history can be counted again.

## Evidence: measured profile

Characters are Unicode code points from stored textual content. Tool arguments use compact JSON serialization; image payloads, signatures and tool-result metadata are excluded. System-message `content` is empty in this corpus: prompt sections are measured separately below. `custom` extension-state JSON is a stored metadata measure, **not** model-facing text.

| Root-cwd content | Historical chars | Last-appended branch chars | Post-compaction slice chars |
|---|---:|---:|---:|
| Tool results | 129,601,134 | 108,993,604 | 85,995,916 |
| Tool-call arguments | 23,731,623 | 18,786,755 | 10,278,031 |
| Custom messages | 17,888,538 | 15,812,605 | 10,073,751 |
| Assistant thinking | 8,670,972 | 7,442,574 | 4,210,260 |
| Assistant text | 4,953,806 | 3,946,145 | 2,216,688 |
| User text | 2,965,118 | 2,930,896 | 2,819,232 |
| Compaction summaries | 2,196,486 | 1,957,180 | 197,286 |
| Extension `custom` state JSON, separate | 59,011,558 | 43,674,267 | 31,423,666 |

The compact-JSON choice explains why another scan using JSON's default spaces can report approximately 24.02M argument characters. Root-cwd histories contain 131 compactions in 18 files historically, versus 112 on the last-appended paths of 12 files; only their 12 latest summaries remain in the post-compaction slice. One 39.7 MB history has 6,574 historical entries but only 417 on the last-appended branch. Worktree histories had no recorded compactions in this snapshot and had 96,142,508 tool-result, 13,333,141 argument, 3,113,907 thinking, 619,259 assistant-text, 4,119,312 user and 2,878,145 custom-message characters.

### Tools, result content and repetition

| Historical result grouping | Root chars | Worktree chars | Interpretation |
|---|---:|---:|---|
| `codemode` | 50,557,997 | 49,061,567 | 39.0% / 51.0% of respective tool-result text; mixed content |
| `bash` | 30,394,304 | 22,505,188 | Shell output, tests, logs and mixed content |
| Direct `read` | 29,037,670 | 14,275,654 | Root: 10.34M source-file, 17.64M docs/data, 1.05M other by path extension |
| `grep` | 8,156,883 | 6,533,087 | Search results, potentially including code and logs |
| `web_fetch` | 5,612,266 | 3,036,486 | Fetched research/reference material |
| `get_subagent_result` / `agent` | 2,961,666 / 1,126,168 | Not comparable to coordinator workload | Reports and delegation/control results |

These are whole-result/tool and direct-path buckets, not a content classifier: `codemode` and shell outputs mix source, logs, research, instructions and reports, and an extension or path is not semantic proof of content. Nested-call metadata records 7,668 root historical `read` calls; root `codemode` results containing at least one nested read total 44.65M characters. That is **container mass**, not 44.65M characters of source; containers can include other nested calls and must not be added to the `codemode` total. There were 472 nested `agent` and 402 nested `get_subagent_result` calls.

Root historical result size over 29,833 results: median 962, p90 12,295, p99 40,232, maximum 268,185 characters; 5,641 results were at least 6,000 characters. On the root branch, the corresponding distribution over 25,620 is 974 / 11,861 / 40,232 / 51,425, with 4,719 at least 6,000. Worktree historical p50 / p90 / p99 / max is 1,548 / 16,677 / 40,233 / 64,233 over 16,769 results. Characters are not exact token thresholds.

On root last-appended paths, 1,087 of 4,076 direct reads with a path repeat a path already read in that session; separately, 1,953 of 5,930 metadata-recorded nested reads repeat a nested-read path. Ranges, writes and filesystem changes are not resolved, and repeats across direct and nested sets are not combined: this is a revisit signal, not proof a read was redundant. Within-file exact duplicate result text accounts for 945 root branch results and 526,307 characters.

### Instructions and usage

Of 17.89M root historical custom-message characters, 15.42M are `wb-frame` and 1.32M are `subagent-notification`. The `wb-frame` total includes 13.42M characters in instruction-kind frames, 1.22M in notices, 0.48M in info and 0.29M in warnings. Frame counts include wrappers and repeated/superseded deliveries; they are not all current instructions or necessarily a provider's final message role.

System sections changed in 467 root historical system-message entries, containing 20.17M characters of stored section deltas. Replaying section names on each last-appended path and the latest available compaction checkpoint gives a median of 44,951 characters of current named section strings across root files; this excludes provider tool schemas and is not an exact wire measurement. It is wrong to interpret empty `message.content` as an absent system prompt.

Instruction records have lifecycles, not a simple age cutoff. Replaying stored instruction-frame/state operations without live trust re-evaluation gives, for example, six surviving file records and 69,159 content characters in the largest coordinator (including global, ancestor and nested scopes; entries `b448eee1` and `ba43205f`), and 13 records / 38,711 characters in the 31.9 MB coordinator. These are stored record states, **not proof that every byte is currently in the model request**: compaction epochs, trust, duplicate/relocation handling, deltas and provider projection matter. Later instructions can replace or withdraw earlier ones; some current `AGENTS` instructions are binding. Do not indiscriminately discard or summarize all `wb-frame` messages. Workbench's frame contract is in `~/.pi/agent/git/git.viitrium.io/furbyhaxx/pi-workbench/docs/frames.md`.

Usage below is per stored assistant message on last-appended paths, including zero reports. It is not a bill: providers differ in reporting, forks duplicate receipts, and standalone `usage` and auxiliary compaction calls are excluded.

| Scope / field | n | p50 | p90 | p99 |
|---|---:|---:|---:|---:|
| Root input | 20,641 | 277 | 5,993 | 48,574 |
| Root cacheRead | 20,641 | 114,304 | 226,135 | 397,275 |
| Root output | 20,641 | 305 | 1,422 | 5,542 |
| Worktree input | 15,467 | 626 | 7,223 | 19,063 |
| Worktree cacheRead | 15,467 | 50,688 | 128,339 | 235,459 |
| Worktree output | 15,467 | 168 | 1,095 | 4,657 |

## Evidence: qualitative sample

Paths below are filenames under `~/.pi/agent/sessions/--mnt-Projects-nukular-nukular-ai--/`. Entry IDs refer to stored entries; these are paraphrases, not sensitive excerpts. Three are among the four largest coordinator-looking files; two are recent.

1. `2026-10-26T12-51-41-002Z_01a17844-3f49-72ee-b5d9-c9ab0936e835.jsonl`: entry `9c279d47` labels a delegation notification completed while the embedded result reports blocked before implementation. Entry `65938fe8` records a later direction change; latest compaction `e488c824` carries decisions and outstanding verification. A completion signal must not erase the report's actual outcome. This branch has 39 compactions.
2. `2026-10-29T13-04-50-071Z_01a187c3-5d97-74ef-9337-0ae8fb627f2a.jsonl`: user entry `7ec67660` establishes a long-lived constraint on dynamic context framing; entry `706cb2d9` later reports a candidate panic fix but explicitly cannot prove it was the observed crash. Preserve both constraint and uncertainty, not merely a completed-fix headline. This branch has 27 compactions.
3. `2026-10-27T09-56-13-511Z_01a17cc9-f847-70e4-a4be-1ae4a5b63125.jsonl`: compaction `f4674a0d` records both a user concurrency decision and a reproduced edit/read batch race; final assistant entry `0d189eb7` reports a delivered slice and checks. Retention must distinguish an earlier diagnosed failure, later reported work and what was independently verified. This branch has 18 compactions.
4. `2026-10-31T14-16-48-882Z_01a19251-fbf1-72d0-8197-9734a1085a45.jsonl`: user entry `8fe378eb` adds automatic migration; assistant entry `6863406d` records a narrowly scoped durability exemption, and `6df8e695` reports a test-flake diagnosis with remaining work. These are active decisions and status transitions in a recent, uncompacted branch.
5. `2026-10-31T14-42-26-370Z_01a19269-71c2-7718-8a1e-8e2b699799dc.jsonl`: assistant entry `2e199947` explicitly corrects its earlier instruction-lifecycle analysis, and `5ff97bd7` presents proposed fixes rather than claiming completion. Entry `3a7f7cfe` records an **agent-stated** user preference for an agent-mediated handoff and selective carryover; it is not itself a fresh user authorization for any Accordion strategy.

## Recommended conductor and root causes of safety gaps

| Conductor | Fit and limitation for this evidence |
|---|---|
| `keel-note` | Best conditional continuity fit: inherits the recoverable ladder and adds goal, verified work, failed attempts, current error and next-step note. The 600-token default and bounded, clipped span can omit old decisions; note updates are lossy, asynchronous model calls and real-workload quality was not tested here. Signed thinking cannot carry the note, and a suitable small text carrier may be unavailable. |
| `keel-lite` | No model calls, no locks; recoverable ladder and 85%/65% hysteresis. Its root exceptions are benchmark-specific: `AGENT_BRIEFING.md` and newest two `spec_*.md` reads, plus a `platform_client.py guide` bash exception, not this project's general plans, reports or instruction frames (`conductors/in-process/keel-lite/keel-lite.ts:118-125,648-705`). Old thinking is not the dominant recorded root mass here. |
| `doorman` | Can fold large fresh results **before first exposure**. Neither its direct read/shell classifier nor keel-lite's read/staleness sets recognize `codemode` nested reads or agent reports as separate inputs; a mixed `codemode` result is a generic result, not separately protected source or report (`conductors/in-process/doorman/classify.ts:50-52,163-179`). |
| `thermocline` | Budget-oriented, with an age fallback and agent unfold; takes the human-steering lock, may call a model, and was not evaluated against these histories. |
| `triptych` | Loses older material into an agent-unrecoverable summary and locks human steering and agent unfold. Its tree-sitter engine ships TypeScript/TSX/JavaScript/Python grammars, not Rust (`conductors/ws/triptych/skeleton.mjs:56-60,110-113`). |
| `compaction-naive` | Lossy recursive summary and exclusive locks; no evidence it retains corrections or exact constraints reliably in this corpus. |
| `handoff` | Superficially matches the recorded handoff preference, but simulates a fresh start by summarizing the whole session, including user messages, into an untagged group with zero protected tail and all three locks. It does **not** create a fresh fork or selectively carry messages (`conductors/in-process/handoff/handoff.ts:17-47,153-169`). |

**Visibility hazard.** `core/wire.ts:154-205` linearizes `user`, `assistant` and `toolResult`; other message roles emit a block only from `summary`. Thus `custom`/frame content and stored system-message content forms can be absent from Truth's block accounting and cannot be assumed protected by a conductor. The host separately captures the current effective system prompt via `getSystemPrompt` (`extension/accordion.ts:1179-1189`), so this is not a claim that all system-prompt bytes are always invisible. The exact model request also depends on Workbench role projection. No live wire trace was taken.

**Signed-thinking hazard.** The lead independently reproduced synthetically that folding `signed: true` thinking changes the thinking text while retaining the signature. Source inspection agrees: `core/wire.ts:555-568` spreads the original part and replaces `thinking`; keel-lite's first rung folds thinking without a signed exclusion. `keel-note` avoids signed thinking as a *note carrier*, which does not stop its wrapped keel-lite from folding signed thoughts. On root last-appended paths, 14,716 of 16,899 thinking parts met `thinkingIsSigned`'s source predicate. This is exposure evidence, **not an observed provider rejection** or a tested failure rate.

**Manual `/compact` is a separate policy.** In `extension/accordion.ts:508-526`, the host fires the conductor and, if no immediate saving is seen, directly folds all eligible unprotected, unheld foldable blocks. This fallback does not apply keel-lite's benchmark root list; the manual and overflow hooks invoke it at `extension/accordion.ts:2959-2978`. Therefore nominal conductor guarantees must not be advertised as guarantees of the host fallback.

## Open questions / follow-ups

The selection is provisional. No conductor replay, provider call, billed-token calculation, live request capture or project configuration change was performed. The sampled session reports are observations of what those agents recorded, not independent proof that their underlying project changes or validations succeeded. The running corpus changed while scanned. Evaluate a future authorized trial on held-out coordinator branches with actual projected messages, signed-thinking-safe behavior, effective instruction-frame lifecycle, decision correction, delegated outcome fidelity, unresolved errors, and request/cache receipts measured separately. Retain a no-model-call baseline and verify note placement and recall before drawing performance conclusions.
