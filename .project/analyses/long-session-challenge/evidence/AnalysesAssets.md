## Summary
Six of the seven artifacts are fully absorbed (code + SPEC-0001/0002 + PLAN-0005/0006); only the two `history-conductor` analyses carry real open work, plus five small gaps elsewhere. Deleting any of them needs its path citations rewritten in the same commit (spec rules forbid citing analyses: `.project/specs/AGENTS.md:5`, `.project/AGENTS.md:20`).

Legend: IMPL = in code (`path:line`), SPEC/PLAN = covered, REJ = explicitly rejected/out of scope, **GAP** = not captured anywhere.

---

## D1 `.project/analyses/2026-11-05-taskfold-session-failures/analysis.md`
| Item | Status |
|---|---|
| R1 split spans at `block` | SPEC-0002 §5.2 (`:654-668`); IMPL `taskfold.ts:182` `scanTaskSpans` (intervals) |
| R2 in-span fallback (floor) + finished subtasks inside open parent | SPEC §9.2 `:881-895`, §9.4 `:902-908`; PLAN-0006 `:216-222` |
| R3 fold untracked runs (`[untracked-work]`) | SPEC §9.3 `:897-900`, §6.4 `:745-750`; IMPL `records.ts:99` |
| R4 coach on span size | SPEC-0002 §12 `:1029`; IMPL `taskCoach.ts:197` `largeLeafNote`; PLAN-0006 `:216` |
| R4b tell the *agent* when an epoch finds nothing foldable | **GAP** — saturation is status/footer only (`taskfold.ts:785`), plus debug record (SPEC §12.1 `:1070-1072`); no agent-facing notice |
| R5 decouple consent from `tasks` tool | SPEC-0002 does not apply; IMPL `core/conductor/registry.ts:238-243` (`deferred`), `accordion.ts:965-990`, `toolSetNotice.ts`; PLAN-0006 S4 `:183-197` (shipped) |
| R6 coach when no list attached | IMPL `taskBinding.ts:143` `bootstrapNotice`, `accordion.ts:3621`; PLAN-0006 `:201-202` |
| R7a actionable lifecycle errors | PLAN-0006 S3 `:166`; IMPL `tasks.ts:888-899` |
| R7b `complete` on a blocked task | **GAP** — still refused, `tasks.ts:887-890`; SPEC §3.5 `:436-452` has no rule either way |
| R8 keep-recent by finish order + waive under pressure | SPEC §9.1 `:876-879`, §9 epoch step 3 `:868`; default 0 `taskfold.ts:69` |
| R9 bound calibration / dedupe / recount | PLAN-0006 S2 `:130-148` (shipped), ADR 0025 |
| R10 surface idle verdicts | PLAN-0006 `:209-211`; IMPL `taskCoach.ts:97` `idleVerdict`, `stopFollowUp` |
| Open B5 (S1 267k→73k drop) | REJ as out of scope, PLAN-0006 `:298` |
| Open B4 Kimi K3 scale factor | PLAN-0006 `:48` (blocked, needs funded route) |
| Open B4b does pi-auth-plus's `message_end` replacement reach Accordion | **GAP** |
| S2 replay → synthetic regression | PLAN-0006 `:276-284` (`replay.test.ts`) |

**Verdict: has open items** (R4b, R7b, B4b). References: `.project/specs/0002-taskfold-tree.md:28-29`, `.project/plans/0006-taskfold-reliability/plan.md:73`.

## D2 `.project/analyses/fold-representations/README.md`
| Item | Status |
|---|---|
| Eager folding, `keepRecentTasks` 0 | SPEC §8 `:834-836`, §9.1; IMPL `taskfold.ts:69-70`; PLAN-0005 S4 done |
| HR: root → 1–3-line history on completion | SPEC §6.3 `:735-743`, §8 `:817` |
| History children carry codes + title ≤60 | SPEC §6.3 `:741` |
| Inner form S (record), B→S; pure B costs more | SPEC §6.2 `:711-733` (`leafForm` record default `:725`) |
| T (synthetic tool pair) and HP rejected | REJ implicitly by SPEC §8 rows `:813-818` (record inside open parent, history for roots); rationale only in the analysis |
| No pressure-time consolidation, one message per root | SPEC §8 `:854-855` (explicit, with the 20× measurement) |
| User messages: extractor applies ops (B), verbatim pin check, `changed` notice | SPEC §4.6 `:589-634`; A/C rejected `:633-634` |
| Tighten extractor against one-off instructions | SPEC §4.6 step 2 `:605` |
| §8 cache model: no span veto, cache profiles, frontier, hold on load | SPEC §8 `:827-856`; IMPL `core/cacheProfiles.ts`; PLAN-0005 S4/S6 done |
| §8 "record-mode frontier verification remains necessary" | PLAN-0005 S6 `:83-89` done |
| §5 overflow: nested `taskEvents`, working set removal | SPEC §5.3 `:670-697`, §4.5 `:579-583` |
| §7 live fixes (duplicate title reuse, root fold waits) | IMPL `tasks.ts:678-693`; SPEC §8 `:827-828` |

Nothing uncaptured. **Verdict: delete-safe**, but two consequences must be handled in the deleting commit: SPEC-0002 `:591, 674, 701, 808, 823` cite it (copy the fact, drop the citation), and SPEC-0002 `:1092` points at the harness files (`harness/eval.py`, `routing.py`) that the deletion removes — either relocate the harness or drop/rewrite that verification row. References: those SPEC lines + `.project/plans/0005-fold-timing/plan.md:160, 357`.

## D3 `.project/analyses/orientation-modes/README.md`
| Item | Status |
|---|---|
| Keep A (orientation raw) as default; don't ship typed fold / agent orientation task / pins-gated orientation | REJ as out of scope, SPEC-0002 §1 `:41` ("Orientation typed fold, agent orientation task, doorman, keel-note note"); no such options exist (`registry.ts:231-236`) |
| Offer `thin:"open"` (K+, with/without note) as opt-in budget guard | SPEC §9.2 `:881-895` (`taskfold.floor`, default false `:893`), §12 `:1039` |
| Do not ship `thin:"orientation"` / `birthSkeleton` | REJ `SPEC-0002:41`; absent in code |
| Pins shipped (verbatim quotes, capped, working-set delivery) | AGENTS.md `:15`; `extension/taskPins.ts`; SPEC §4.1 `:456-467` |
| Long open task never folds → pressure relief | SPEC §9.4 `:902-908`, §9.2 |
| Nested `tasks` calls unsupported | SPEC §5.3 `:670-697` |
| Fixes: batched `start` empty span, pin with line range | SPEC §3.5 `:445-448` |
| Docs/rule reads never thinned | SPEC §9.2 `:886-887` |
| "Next lever: fewer, larger thinning epochs (raise `high`, lower `low`) and teach agents to `recall`" | **GAP** |

**Verdict: has open items** (the thinning-epoch/recall lever, one line of future work). References: `.project/specs/0002-taskfold-tree.md:27, 883`. Deleting also removes `harness/` + `evidence/` (large, incl. tier-2 session fixtures).

## D4 `.project/analyses/taskfold-classifier/README.md`
| Item | Status |
|---|---|
| Ship `pplx-decider-v1.2` | IMPL `conductors/in-process/taskfold/taskfold.ts:79-80` (comment names this analysis) |
| Four questions `keep_goal/durable_rule/overrule/loss` in one call | IMPL `taskfold.ts:86-110`; SPEC §12 `:1033` (`maxLoss`) |
| Fold below `loss` 0.3 | IMPL `taskfold.ts:46, 68, 753`; SPEC §12 `:1033` |
| No user-message lifting; `constraints` field removed | IMPL — no such field in `conductors/in-process/taskfold/records.ts`; SPEC §6.2 keys `:714` |
| Fail closed (no score / failure / opening message) | IMPL `taskfold.ts:649, 739-741, 753`; SPEC §4.6 `:621-623` |
| Wording is calibration: edit only with a re-run | IMPL comment `taskfold.ts:79, 85` |
| Limits (threshold will drift; single rater) | No action requested — risk note only |

Nothing uncaptured. **Verdict: delete-safe.** Reference: `conductors/in-process/taskfold/taskfold.ts:79` (rewrite the comment to state the calibration constraint without the path).

## D5 `.project/user-uploaded-assets/2026-11-05T09:00+01:00-taskfold-widget-sketch.md`
| Wish | Status |
|---|---|
| One-line tool renderer (`✓ tasks start 3.2 …`) | SPEC-0001 §4.7 `:200-218`; `extension/tui/toolRows.ts` |
| Widget above editor, two-line collapsed, whole line clickable | §4.2-4.3 `:114-139`, §4.5 `:189`; IMPL `taskWidget.ts:222, 318-325` |
| Header `▲ Tasks done/total (≡folded) · duration · full → live tok` | §4.3 `:125-135`; SPEC-0002 §10.1 `:912-917` |
| Line 2 `⎿ <current id> <title> · time` | §4.3 `:136-138` |
| All done → single line `►` | §4.3 `:139`; IMPL `taskWidget.ts:187` |
| Glyphs `☐ ▣ ☒ ▶` | Evolved, recorded: §4.4 `:145-153` (`☒` = failed, `⧗` = blocked, `◐` partly done, `⊘` abandoned), §3 rule 4 `:71` |
| `▶` blinks slowly | §4.4 `:148` — implemented as 1 s `warning`/`text` alternation, not SGR blink (`taskWidget.ts` `blinkOn`) |
| Branch clickable to expand/collapse | §4.5 `:190`; host limitation §4.6 `:193-198` (PiG delivers no clicks; panel is the keyboard path) |
| Configurable expanded height + smart hiding | §4.4 `:173-180`; IMPL `extension/settings.ts:47, 147, 283` (`maxRows`, default 12) |
| `(fold)` marker wording | Superseded: `≡` column + `full→live` pair, §4.4 `:160-170`, SPEC-0002 §10.2 `:933-947` |

Fully processed. **Verdict: delete-safe**; fix `.project/specs/0001-accordion-ui-polish.md:21-22` (it cites the sketch as an input, which spec rules forbid).

## D6 `.project/user-uploaded-assets/task-based-folding.md`
| Wish | Status |
|---|---|
| Fold a finished task span into a report/summary | SPEC-0002 §6.2 `:711-733` |
| Variant 1: keep `start` + summary + `complete` | Evaluated and rejected in favour of record/bracket (`§6.2 :725-733`; cost evidence was in D2 §2) |
| Nested folding (`[folded] child` inside folded parent) | §6.2 `children` `:717-718`, §7.2 `:765-781` |
| Cache-friendlier: one carrier replacing start/complete calls | §6.3 history `:735-743`, §8 `:817` |
| Agent continues one level up, seeing only the summary | §6.3, §6.4 `:745-750` |

Nothing uncaptured. **Verdict: delete-safe**; no tracked file references it.

## D7 `.project/analyses/history-conductor/in-core-ai.md` + `nukular-ai.md`
| Item | Status |
|---|---|
| `keel-note` = best conditional fit for coordinator continuity, do not arm yet | **GAP** — no tracked record of the recommendation or the decision |
| `keel-lite` = no-model-call fallback | **GAP** (observation only) |
| Signed-thinking hazard | Partly IMPL: `thinkingIsSigned` `core/wire.ts:60`, keel-lite skips signed blocks `keel-lite.ts:320, 446` (+ tests); residual exposure for human/agent folds of signed thinking (`core/truth.ts` has no `signed` check) is not recorded in any spec/plan |
| Custom/`wb-frame` visibility hazard (`linearize` default only emits `summary`) | Behaviour documented `core/wire.ts:217-220`, SPEC-0002 `:574`; the accepted accounting gap is not recorded as a decision |
| `/compact` fallback bypasses the conductor ladder (`compactNow`) | Obsolete — `compactNow` no longer exists in `extension/accordion.ts` |
| keel-lite roots are benchmark-specific (`AGENT_BRIEFING.md`, newest 2 `spec_*.md`, `platform_client.py guide`) | Still true (`keel-lite.ts:14-18, 92-116`); **GAP** — no decision to generalize or accept |
| keel-note's background model calls with session content need authorization/privacy decision | **GAP / bug** — `keel-note.ts:271, 641` call `host.complete` with clipped session text, but its registry entry (`core/conductor/registry.ts:229`) declares no `privacy`, so `selectConductor` attaches it ungated (`accordion.ts:965-968` + `privacyGate.ts:15`) — contradicts AGENTS.md `:19` (thermocline has the same shape) |
| Proposed held-out trial (signed-thinking-safe, instruction-frame lifecycle, decision correction, delegated outcome fidelity, separate receipts) | **GAP** — no plan or backlog item |

**Verdict: has open items** for both files (7 rows above). No tracked file references either path (only their own frontmatter ids `ANA-history-conductor-*`). Deleting them loses the corpus measurements (589.6 MB / 758 MB profiles) — no rule depends on those numbers.

## Deletion mechanics
Each deletion needs `Artifact-Deleted` + `Reason` trailers (`.project/AGENTS.md:20`) and the directory with its `evidence/`; ids in `ids.toml` are not lowered. D5's sibling `.project/user-uploaded-assets/AGENTS.md` requires user approval, which this batch supplies.

BLOCKERS: none