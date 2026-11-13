---
document:
  type: "plan"
  id: "PLAN-0006"
  title: "Recall v2: bounded retrieval"
  description: "Close out bounded recall, verify the shipped behavior, and deliver it to the PiG installations."
  status: "published"
  revision: 2
  created_at: "2026-11-13T12:35:13+01:00"
  updated_at: "2026-11-13T13:42:30+01:00"
  created_by: "orchestrator"
  updated_by: "orchestrator"
  changelog:
    - revision: 2
      reason: "reconcile implementation and remaining delivery with the actual evidence"
      changes: ["replace obsolete design claims with verified progress and open acceptance", "record default-on ledger and deployment work"]
---

# Recall v2 closeout

Branch `feat/recall-redesign`; worktree `.pi/worktrees/recall-redesign`. The current contract is
`.project/specs/0003-recall.md`; implementation and limits belong there rather than in this plan.

## Progress

- Done: report-first retrieval, session-wide account, search, expiry, oversized-result guard,
  bounded unfold, cited side-model answers and a default-on verified fact ledger. Test coverage is
  listed in SPEC-0003.
- Done: offline replay of session `01a1c624` fit the 272k estimated budget on the feature branch;
  the baseline did not. A live PiG run answered four questions using recall. Evidence and its
  limitations: `evidence/s8-session-replay.md`.
- Done: a small, non-independent ledger spike passed its 18/20 gate; its limitations and cost are
  in `evidence/s7-ledger-spike.md`.
- Done: the fact ledger is enabled by default; explicit `recall.ledger.enabled: false` opts out.
  Extraction uses the recall chat route and can incur cost; a different remote model requires
  prior recall consent. The settings test and default-on extension smoke pass.
- Now: run the required app, extension and Bun gates and verify report-first and expired recall
  in a live PiG session. The prior live run did not establish either of those two acceptance cases;
  its post-run citation-search hint also has not been retested.
- Next: review the final diff, merge into `feat/pi-native`, push, and update the installed PiG
  package on devlap05 and devsrv01. Verify the installed revision and a live load on each host.

## Boundaries and remaining evidence

- Admission and the guard use token estimates. They do not guarantee that an arbitrary context
  is under the provider's actual window, especially with held content, other new messages, or
  provider-tokenizer differences. The offline replay is not a live provider measurement.
- Unfolded material can remain in context; the host's normal folding policy and human overrides
  govern whether it can be folded again. Do not claim an unconditional hard budget guarantee.
- Multi-prompt ledger extraction has unit coverage for prompt bounds but no live-model quality
  evaluation. The middle of tasks requiring more than four prompts is not extracted.
- Session contents must not be committed as a fixture. The offline replay script accepts a local
  session path, and the evidence records aggregate measurements only.

## Closeout

Run `npm --prefix app test`, `npm --prefix app run check`, `npm --prefix extension run smoke`,
and `bun test extension/settings.test.ts extension/tui/*.test.ts`. Complete the remaining live
acceptance and both installations before reporting delivery. At merge, delete this plan and its
evidence with `Artifact-Deleted: PLAN-0006` and `Reason:` trailers, per `.project/AGENTS.md`.
