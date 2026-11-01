---
version: 1
id: "in-core-ai-history-conductor"
title: "In-core-ai session history and conductor fit"
description: "Local read-only aggregate and sampled continuity evidence for an Accordion conductor decision."
type: "analysis"
created: "2026-11-01T14:56:02+01:00"
updated: "2026-11-01T15:00:32+01:00"
createdBy: "analyst"
updatedBy: "analyst"
status: "partially explained"
confidence: "medium"
---

# In-core-ai session history and conductor fit

## Summary

**Best existing candidate: `keel-note`, conditionally, for long coordinator sessions. Do not treat it as ready to arm on this evidence.** Its bounded progress note addresses an observed need to retain decisions, verification state and outstanding work, while its `keel-lite` core batches recoverable folds. Its note can omit material, requires a usable carrier, and sends selected history to the live model. It inherits the signed-thinking hazard and benchmark-specific root rules below. No conductor was exercised against these histories.

If live model calls containing session material are not permitted, `keel-lite` avoids those calls but has no equivalent progress note and has the same signed-thinking hazard. Until that hazard and the instruction-frame visibility issue are resolved or explicitly accepted, the conservative operating choice is to leave automatic folding disarmed; no settings were changed in this analysis.

## Scope and method

- Inspected the 319 **direct** JSONL session files in 156 matching `~/.pi/agent/sessions/--mnt-Projects-furbyhaxx-in-core-ai*--/` directories, including worktrees: approximately 589.6 MB. A further 536 nested Workbench agent `transcript.jsonl` files and two nested logs, together approximately 467.8 MB, were inventoried but excluded from the aggregate to avoid silently mixing a second corpus. They were not deduplicated against the direct files.
- Root-directory sessions: 150 files, approximately 475.2 MB. Of these, 143 headers have `parentSession`; **142** also have an explicit subagent declaration in the initial system preamble. Seven lack a parent header and are plausible coordinators; the remaining parent-linked file is unclassified. A parent header alone is not proof of subagent identity: Pi also uses it for forks. Worktree-directory sessions: 169 files, approximately 114.5 MB; all 169 have both a parent header and explicit subagent preamble. Directory/cwd is not agent role.
- Parsed each line locally. The working estimate of the latest path follows `parentId` from the last persisted entry; an unsaved live tree navigation could differ. The post-compaction projection uses the latest on-path compaction summary, its `firstKeptEntryId`, retained pre-compaction entries, later entries and recorded context edits. It is an approximation of Pi's session projection, **not** a reconstruction of every provider request or current live system prompt. The largest session grew by 372 bytes between initial inventory and the main scan, so snapshots are not atomic.
- Text sizes are Unicode code-point counts; tool arguments are compact JSON serializations. Excluded image payloads and provider-only transformations. Historical branches, copied/forked content, prompt caching, truncation, context edits and repeated calls make character totals unsuitable as billed-token or cost estimates. The user-supplied independent argument estimate used a different serialization and is not directly comparable.

## Measured profile

The root-cwd columns below are sums across **all 150 files**, including the explicit workers, not a single coordinator or one context window. Path means the estimated latest parent chain; projected means that chain after its latest compaction boundary and recorded content edits. The worktree column is all historical entries; its paths are linear in this snapshot.

| Measure | Root all | Root path | Root projected | Worktree all |
|---|---:|---:|---:|---:|
| Entries | 54,442 | 24,220 | 15,300 | 15,693 |
| Assistant messages | 15,573 | 7,859 | 5,340 | 4,336 |
| Tool results | 17,277 | 9,514 | 6,571 | 4,497 |
| User text chars | 1.369M | 1.300M | 1.280M | 2.808M |
| Assistant thinking chars | 8.575M | 7.907M | 6.968M | 2.978M |
| Assistant text chars | 2.356M | 1.763M | 1.118M | 0.409M |
| Tool argument chars, compact JSON | 19.656M | 11.250M | 7.289M | 7.318M |
| Tool-result text chars | 75.632M | 31.167M | 22.841M | 18.964M |
| Custom-message text chars | 17.847M | 5.025M | 2.431M | 2.870M |
| Stored system-section patch chars | 11.954M | 9.827M | 9.096M | 9.511M |
| Compaction-summary chars | 1.868M | 0.631M | 0.051M | 0 |
| Branch-summary chars | 2.537M | 2.140M | 0.091M | 0 |

System-section rows are sums of stored patches, not the final effective prompt. Compaction system checkpoints add 17.449M / 4.238M / 0.381M stored chars respectively across root all/path/projected; they duplicate checkpointed state and should not be added to the section row as independent instructions. Root `custom` state contains another 76.757M serialized chars historically, but is extension persistence, not a model-facing custom message. Historical root entries contain 193 compactions in four files; 48 lie on their latest paths. The largest session alone contains 183 historical compactions, 38 on its latest path.

### Result composition and repetition

| Root all-history result family | Chars | Interpretation |
|---|---:|---|
| `codemode` | 45.005M | **59.5%** of root tool-result text; a mixed wrapper |
| Shell/job tools | 10.196M | Output/log-like; may contain code or reports |
| Direct code-file reads | 5.565M | Read-family calls with a recognized source-code extension |
| Other direct reads | 5.246M | Includes prose, data and other paths |
| Web/research tools | 2.689M | Direct tool names only |
| Direct agent and `get_subagent_result` | 1.738M | Agent output/control, not necessarily completed integration |
| Other | 5.193M | Includes unclassified tools |

These categories are exclusive but coarse. They do not classify the nested contents of `codemode`: among its 2,988 results, 2,156 originated from a call whose arguments contain a literal nested `tools.read(`, with 41.940M result chars in those **whole mixed results**. Similarly, calls containing literal `tools.agent(` account for 3.697M whole-result chars. These markers overlap each other and are lower-bound call-shape signals, not measured nested read/report text. Dynamic calls and other spellings are missed. On the root latest-path projection, `codemode` contributes 6.784M of 22.841M result chars.

Root all-history result sizes, in characters: median 547; p90 13,601; p95 26,689; p99 40,230; max 227,319. Of 17,277 results, 9,983 are under 1k, 3,992 are 1k–6k, 2,103 are 6k–20k, 1,198 are 20k–100k and one exceeds 100k. Projected-root median/p90/p99 are 668 / 9,085 / 40,228; max 51,214. Root history has 444 repeated normalized paths among 1,798 direct `read`-family calls with paths, and 145 repeated identical result texts of at least 200 chars within their respective file, totaling 657,171 repeated chars. These are reread signals, not proof of wasted work: files and ranges may change, branches may differ, and nested reads are not counted.

### Frames, effective instructions and usage

Root `wb-frame` custom messages contain 16.679M chars historically, of which 15.405M are instruction-kind frames; the envelopes account for about 0.311M chars across all `wb-frame` kinds. The estimated latest paths contain 4.727M `wb-frame` chars; post-compaction projections contain 2.304M, including 1.923M instruction-kind chars. These figures overlap the custom-message row above and are not a separate additive mass. Another 5.815M root tool-result chars historically occur in blocks containing frame-shaped markup; those occurrences could be quoted or untrusted data, not live instruction frames.

A limited replay of stored instruction records in the largest coordinator's latest path finds two currently applicable file records totaling 37,762 chars in its current compaction epoch; the recent second coordinator has four totaling 45,748. This is **stored ledger state**, not proof of current filesystem contents, provider visibility or complete trust evaluation. Workbench frames can supersede, withdraw or update earlier files, and compaction can require reinjection. Preserve effective binding instructions; do not collapse every frame merely because historical wrappers repeat.

Assistant usage receipts where present, root all-history, n=15,573 per field: `input` p50/p90/p99 372 / 5,979 / 71,330; `cacheRead` 118,144 / 208,384 / 410,322; `output` 296 / 1,597 / 7,038. There are 133, 419 and 134 zero values respectively. Receipts are per assistant message, include workers and abandoned branches, and have provider-dependent semantics. They are not a context-size distribution, nor a bill. Historical root thinking parts had 9,411 signed-or-opaque, 2,313 field-name-signature and 83 unsigned observations; this is a simple signature-field classification, not a provider-rejection count.

## Representative longitudinal sample

The following five largest non-parent-header root sessions were sampled by branch-aware inspection. The B, C and D steering entries were additionally read and paraphrased below; the other markers are discovery signals. Filenames are relative to the root-cwd session directory above; IDs identify stored entries. This is not a semantic audit of every entry.

- **A:** `2026-10-24T19-25-43-720Z_01a16f60-49a8-73f0-a647-bef36dc73bef.jsonl`, 277.7 MB. Of 32,717 stored non-header entries, 7,735 were on the estimated path. User entry `8b231547` contains a forgetting-related marker; assistant `9718822d` contains decision, wrongness and verification markers. Those markers do **not** establish that the assistant lost a specific decision. Agent notification `b43bb653` records `completed`; no verification-shaped tool call appeared in the next 30 path entries. Recent `82f46653` is an error-marked shell result. Neither worker integration nor resolution of that error was proved by this bounded inspection.
- **B:** `2026-10-29T09-02-32-532Z_01a186e5-8a54-77e1-966f-4b5f0468e40b.jsonl`, 20.5 MB. In `72d73c20`, the user challenges whether the Android app was actually tested and reports that voice recording and the live flow do not work. Preserve this as a **user-observed functional acceptance failure** ahead of any test-pass claims. Resolution requires an actual Android run and checks of those flows; successful builds or worker reports alone would not settle it. The historical complaint is not independent QA by this analysis. Notification `3f8c6a64` records completion, while `27ce633e` is an error-marked verification-related shell result. These distinct events do not prove integration or repair.
- **C:** `2026-10-21T10-16-41-346Z_01a15df6-8c82-73c6-84fb-2ab1c4acb95f.jsonl`, 17.8 MB. In `77c675b6`, the user authorizes autonomous exploration of multiple approaches, independent evaluation at decision points, and continuing past interim reports instead of stopping to report. The message also records spending approval for that historical run; it does **not** override the current analysis restriction against model calls with session content. The earlier 31,298-char user-role entry `a173f43a` begins with an expanded `selecting-worker-model` skill. It is not evidence of a 31,298-char user-authored task; skill expansion and direct user intent must be separated.
- **D:** `2026-10-22T14-07-57-129Z_01a163f0-a2c8-76ba-b72a-9310f6c924ab.jsonl`, 13.2 MB. In `81a84f0c`, the user says previously parked project thoughts were not preserved verbatim and asks for clarification of feedback-loop, time-awareness, classifier and observability ideas. These include sensing effects of the system's own outputs and tracking elapsed time so potentially stale knowledge can be revisited; asynchronous operation is another question to investigate. Preserve their epistemic status as hypotheses rather than agreed decisions, along with original user wording where available and information about freshness. Do not reconstruct missing wording as if verbatim. Assistant `3be81d95` contains prior-work and verification markers; this does not establish that a prior decision was forgotten. The classifier/observability characterization incorporates the user's cross-reading of this entry.
- **E:** `2026-10-22T15-27-28-752Z_01a16439-71f0-7635-9a9c-874570dc3885.jsonl`, 12.7 MB. Only 60 of 2,448 stored entries are on the estimated latest path. The large user entry `adcf19c2` is **off-path**, whereas `885db3f5` is on-path. Treating all historical entries as current instructions would conflate abandoned and active branches.

**Retention implications:** Keep the user-observed Android acceptance failure ahead of test-pass claims, while marking its resolution and independent verification as unknown. Preserve the then-current autonomy/decision-review instruction and the feedback-loop, time, classifier and observability hypotheses with their uncertainty, original wording where available, and freshness. Keep these distinct from accepted decisions. Record worker completion separately from integration, and open errors separately from verified fixes.

**Gap:** The bounded sample did not establish an actual model continuity failure, independently reproduce the reported Android defects, or establish the final resolution of the cited failures. No raw session excerpts or credentials are reproduced. These examples are not a measured failure rate.

## Conductor choice and source-level hazards

| Candidate | Fit and material tradeoff |
|---|---|
| `keel-note` | Best candidate for coordinator continuity: `conductors/in-process/keel-note/keel-note.ts` defines a 600-token note covering goal, verified work, failed attempts, current failure and next step. Its asynchronous `host.complete` uses the session's model route and sends clipped prior content; its 12k-token span buffer can discard older spans. Signed thoughts cannot carry the note, so lack of a small text carrier delays placement. The note is lossy and its quality on this workload is unverified. |
| `keel-lite` | Model-call-free and recoverable, but no durable progress note. `conductors/in-process/keel-lite/keel-lite.ts:118–124,650–704` recognizes only specific read/write/shell families and special `AGENT_BRIEFING.md` / `spec_*.md` roots. Ordinary project instructions, research and worker reports receive no comparable special root treatment. |
| `doorman` | Intercepts fresh large results, but `conductors/in-process/doorman/classify.ts:49–62,165–200` recognizes direct read/shell families, not `codemode` nested reads or agent reports. A sufficiently large, non-error `codemode` result is therefore eligible for a generic birth-fold before first delivery, rather than classified report preservation or code skeletonization. It is not a whole-session continuity strategy. |
| `thermocline` | Attention/age gating and summaries may help, but it requires additional machinery/model calls and its final budget ladder permits dropping deep content; no evidence here ranks it above the note. |
| `triptych` | Code-read skeletons do not address the dominant mixed `codemode` family; its oldest band is recursively lossy and it locks agent unfolding. |
| `compaction-naive` / `handoff` | Lossy recursive summary approaches; handoff also intentionally removes agent recovery of the old context. Useful comparisons, not the conservative first candidate for decisions that may later need exact recovery. |

**Visibility and safety qualifications:**

1. `core/wire.ts:154–205` linearizes user, assistant and tool-result content, but its default case emits only `summary`; custom/system messages represented solely by `content` can therefore be absent from Truth's block inventory. The main system prompt may separately be supplied through `Truth.setSystemPrompt`, and Workbench may project frames into other roles. The measured custom-message mass is an **at-risk upper bound**, not a demonstrated count of missing live tokens. This affects both budget accounting and the idea that any conductor is protecting every effective instruction.
2. `keel-lite` folds eligible thinking first (`keel-lite.ts:326–339`), and `keel-note` delegates trimming to it. `core/wire.ts:565–567` replaces thinking text while spreading the original part, retaining any signature. The caller independently reproduced this with synthetic signed thinking; a real provider rejection was **not observed** here. Signed parts are common in this corpus, so this is an enable-safety caveat even though keel-note avoids signed thoughts as *note carriers*.
3. `extension/accordion.ts:508–526` implements `compactNow`: after notifying the conductor, if there is no immediate reduction it folds all eligible unheld, ungrouped, unprotected wire-foldable blocks. This fallback does not consult keel-lite's special root selection. `session_before_compact` at `extension/accordion.ts:2957–2985` invokes it for manual Accordion-mode compaction and overflow; native mode differs. Thus `/compact` fallback behavior is not identical to the selected conductor's nominal ladder. Actual user settings were not inspected or changed.

## Verification and limitations

Ran local streaming Python aggregation on all 319 direct histories, a separate frame/worker classification pass, fixed-pattern scans for five coordinator files, and a targeted read of the B, C and D steering entries; all completed successfully with zero JSON parse or parent-link errors in the main scan. The scripts and intermediate aggregate were temporary and are not retained. The initial exploratory schema script and one classifier attempt failed due to scratch-script errors; successful corrected passes supplied the reported results. No external request, model completion, conductor replay, project-source change or settings change was made. No benchmark demonstrates conductor effectiveness, no provider request was reconstructed, and semantic continuity/failure resolution remains unverified.
