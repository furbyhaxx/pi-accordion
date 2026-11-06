# Isolated Taskfold floor comparison

## Decision

Keep `taskfold.floor` **off by default**, with the setting available as an opt-in budget guard. Keep attachment rendering **inline** by default. The samples are too small to establish a universal quality or cost advantage, and a floor cannot guarantee the budget when protected or otherwise ineligible content dominates.

## Setup

Two synthetic coding fixtures (`ratelimit`, `invoices`), two prompts each, 16k budget, 3k protected tail. The floor comparison has five repetitions per fixture and arm; the attachment comparison has four. `results.json` contains 56 individual results and aggregates. The taskfold-tree snapshot was commit `3aef51e`; the experiment baseline was `4827a3b`.

| Arm | Conductor | Floor | Attachments |
|---|---|---|---|
| A | experiment branch | off | none seeded |
| K+ | experiment branch | separate-proposal thinning | none seeded |
| T | taskfold tree | off | none seeded |
| TF | taskfold tree | same-proposal floor | none seeded |
| TF-inline | taskfold tree | same-proposal floor | relevant spec range inline |
| TF-ref | taskfold tree | same-proposal floor | same range as reference |

The attachment arms used identical prewritten task lists and prompts; each run started the task carrying the attachment. A local mock confirmed that the outgoing inline request included the range's text and the reference request only its locator. All runs completed both prompts without an agent transport error. A passing run passed the combined visible and hidden tests **and** all fixture constraint checks.

The sandbox exposed only the synthetic fixture to the agent's shell. It used a nested network-isolated shell, a read-only task-list mount, frozen code, and a localhost model proxy that retained the provider credential outside the agent sandbox. Pi and the tested extension were outside the shell's filesystem view. The task tool's project boundary and the baseline's disabled pin action were checked with local mock calls. The proxy imposed a conservative spending cap. The recorded costs are Pi's estimates from provider-reported usage, not an invoice.

## Results

| Arm | Pass | Mean peak input | Highest peak | Runs over 16k | Mean cost | Cache-read ratio |
|---|---:|---:|---:|---:|---:|---:|
| A | 10/10 | 40,611 | 76,641 | 10/10 | USD 0.0547 | 96.3% |
| K+ | 8/10 | 20,493 | 33,182 | 9/10 | USD 0.0448 | 88.4% |
| T | 9/10 | 29,052 | 36,982 | 10/10 | USD 0.0355 | 94.0% |
| TF | 9/10 | 13,381 | 14,206 | 0/10 | USD 0.0398 | 82.4% |
| TF-inline | 8/8 | 15,071 | 20,079 | 2/8 | USD 0.0378 | 81.9% |
| TF-ref | 4/8 | 15,400 | 25,190 | 2/8 | USD 0.0406 | 84.1% |

TF's mean cost was 27% below A, satisfying the originally proposed cost comparison, but approximately 12% above its directly comparable T arm. Although TF stayed under 16k in the unseeded sample, both attachment arms exceeded it in 2/8 runs; TF passed 9/10 compared with A's 10/10 and T's 9/10. These observations do not justify promising a hard budget or making the floor the default. The inline/reference difference favours inline in this small sample, but does not establish why.

Shell commands mentioning `docs/spec.md` numbered 98 in TF-inline and 111 in TF-ref; these are only a heuristic, not verified read or re-read counts. No exact re-read measurement is claimed. Actual `recall` calls were 12 for TF and 3 in each attachment arm.

The agent had `bash`, `tasks`, `recall` and `unfold`, rather than the usual separate read/edit/write tools, to enforce the isolation boundary. Both arms in each comparison used the same tool set. Costs and pass rates are therefore specific to this harness and fixture sample, not production estimates. The earlier unsandboxed skill experiment and the first floor attempt with an incorrect config path are excluded.

## Harness

`runner.py`, `safe-shell`, `proxy.py` and `preflight.py` are the captured local scripts. They intentionally contain machine-specific paths and need adaptation before reuse. In particular, do not run the proxy on a shared host without adding local-client authentication; it binds loopback and limits spending but does not authenticate clients. The proxy obtains a credential at runtime and never writes it to this evidence directory. Verify the filesystem and network boundaries with a local mock before any provider call. Raw synthetic sessions remain outside the repository; `results.json` contains the per-run metrics and constraint failures without transcripts.
