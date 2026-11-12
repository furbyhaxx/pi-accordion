# Anthropic frontier verification

## Marker-only probe

Live Pi-Bolt / `claude/claude-sonnet-5-5`, 12.11.2026, 01:53 Europe/Zurich. The
three-phase `marker-probe.ts` extension sends a frozen Messages payload. Phase 1 keeps
an explicit OAuth identity marker; phase 2 moves only that marker to the first user
block; phase 3 also changes that block's text as a negative control. Every response
stopped normally. No tools, Accordion extension, task projection or model-written
summaries participate.

| Phase | Cache read | Cache write (1h) |
|---|---:|---:|
| Original markers | 17,455 | 20,015 |
| Marker moved, identical content | 37,470 | 0 |
| Marker moved, text changed | 17,455 | 20,025 |

`marker-relocation.jsonl` contains all three receipts, marker locations and SHA-256
hashes of tools/system/messages after recursively removing `cache_control`.
The first two hashes are identical; the negative control differs. Moving the marker
preserved every previously cacheable token, while changing content invalidated the
message prefix. The system prefix already existed from the initial hook-observation
request; the first phase is not claimed to be wholly cold.

The initial native hook contained no identity block. The installed `pi-auth-plus`
Claude transport inserts it afterward, copying the system prompt's marker. The probe
seeds the same identity before freezing the payload so its move is explicit and the
transport does not add it again. `identityAtHook` is false for the initial native
payload and true for subsequent frozen snapshots. This transport ordering matters:
counting only markers visible in that hook can undercount the final request.

To repeat, load this fixture explicitly alongside the configured `pi-auth-plus`
provider with `--no-extensions`, `--no-tools`, `--no-context-files`,
`--no-skills`, `--no-prompt-templates`, `--no-themes`,
`--model claude/claude-sonnet-5-5 --thinking off --mode rpc` and a fixed system
prompt. Set `CACHE_MARKER_LOG` to a fresh private file and send three prompts
sequentially, waiting for `agent_end` after each. The fixture deliberately stops
accepting requests after the third.

## Contract checked

[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
read 12.11.2026: explicit breakpoints write only their own cumulative prefix;
reads search previous writes over a 20-block lookback; automatic caching consumes
one of the four slots. Marker placement itself is tested above rather than inferred
from those statements. Installed `pi-auth-plus` source:
`src/families/anthropic/provider.ts`, `transport.ts`, `request.ts`, `sanitize.ts`.
The native `ModelRegistry.isUsingOAuth(model)` API is available without reading
credential values.

## Record/frontier replay

12.11.2026, 02:31–02:32 Europe/Zurich, Pi-Bolt 1.5.0, `claude/claude-sonnet-5-5`,
low thinking, eager timing, record form. The prompt is the first user message in
`../form-live/serial/record-session.jsonl`; the project, session directory and Accordion home
were fresh and isolated. All 24 numbered `printf` calls returned their matching outputs, one
tool call per response. Both children and their root completed. Model narration after folding
still expressed uncertainty about hidden execution; the raw trace, not that narration, proves it.

| Observed | Result |
|---|---:|
| Main-provider requests / HTTP 200 | 36 / 36 |
| Maximum markers after OAuth shaping | 4 |
| Applied frontiers | 29 |
| No open task / missing raw opening boundary | 6 / 1 |
| Pre-first-task cacheable prefix | 26,603 tokens |
| Cache read at first / second leaf fold | 26,603 / 26,698 tokens |
| Cache write at first / second leaf fold | 256 / 203 tokens |
| Updated sibling prefix recovered at second fold | 95 tokens |

Request 17 writes the frontier after the first child's new record at
`/messages/4/content/0`. Its local material fingerprint remains present at the second fold
(request 33), where it is the longest prefix previously written at an explicit message marker.
The receipt reads 26,698 cached tokens instead of falling back to the 26,603-token pre-task
boundary. S5's record trial missed this updated prefix. The one missing-boundary skip is safe:
the root's original opening call has already been absorbed into the first child's carrier.

`cache-observer.ts` is test-only and loads before the authentication provider. It records final
fetch marker locations, cumulative material fingerprints, HTTP status and public usage fields;
it never writes request headers, account metadata, thinking signatures or message bodies. Local
fingerprints omit `cache_control`, transport billing blocks and metadata. They identify matching
material here, not the provider's private cache keys. Requests are capped at 45 and a fifth final
marker rejects before transport. `record-fetch.jsonl` contains these body-free observations;
`record-debug.jsonl` contains native diagnostics, and `record-session.jsonl` is sanitized history
with signatures/account metadata removed. `record-checks.json` records the count, pairing, prefix
and usage assertions. The terminal capture redacts provider-account status. The owned process
and its private door listener were stopped after collection.

To repeat, use an isolated `ACCORDION_HOME`, project and session directory, enable debug, attach
Taskfold through its normal consent gate, and select eager timing and record form. Load
`cache-observer.ts` first, the configured `pi-auth-plus` provider second, and local
`extension/accordion.ts` third, with `--no-extensions --no-skills --no-prompt-templates
--no-context-files --no-mcp --provider claude --model claude-sonnet-5-5 --thinking low`.
Set `FRONTIER_FETCH_LOG` to a new private file, pass `--session-dir`, and submit the fixture's
first user prompt. Check every numbered result and final shaped marker, not just the model's
completion sentence or aggregate cache-hit ratio.

This is one uncontrolled replay, not a general cost benchmark. It verifies the intended sibling
prefix reuse; different reasoning/request counts prevent a causal total-cost comparison with S5.
The observer adds file I/O on the fetch path, so no latency comparison is claimed.

Verification: 600 targeted Bun tests and 1,076 app tests pass (21 existing skips), Svelte check
has zero errors/warnings, and all native smoke suites pass. The custom extension TypeScript
check still reports the same seven baseline diagnostics and is not claimed as passing.
