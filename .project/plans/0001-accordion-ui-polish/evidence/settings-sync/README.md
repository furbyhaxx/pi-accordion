# Live settings synchronization (S2)

`shared-result.json` records two real Pi-Bolt sessions and independent, barrier-synchronized
store writers. Native staged saves preserve unrelated changes; same-field saves conflict without
losing the staged edit. Environment and flag overrides remain effective and reject native writes.
The captures redact browser tokens. No model prompts are sent.

## Start a fresh fixture

Run from the worktree in Bash. Refuse to reuse an existing fixture directory or tmux socket;
stop and clean up a previous owned run first.

```bash
set -euo pipefail
root="$PWD"
base="$root/.pi/settings-sync"
evidence="$root/.project/plans/0001-accordion-ui-polish/evidence/settings-sync"
test ! -e "$base" || exit 1
tmux -L acc-settings-sync list-sessions >/dev/null 2>&1 && exit 1
mkdir -p "$base/home/.accordion" "$base/channels/a" "$base/channels/b" \
  "$base/project-a" "$base/project-b"
chmod 700 "$base" "$base/home" "$base/channels" "$base/channels/a" "$base/channels/b"
printf '%s\n' '{"autoArm":false,"defaultConductor":"none","doorPort":0,"debug":false,"fixtureUnrelated":"retain"}' \
  > "$base/home/.accordion/config.json"
chmod 600 "$base/home/.accordion/config.json"
for actor in a b; do git -C "$base/project-$actor" init -q; done
tmux -L acc-settings-sync new-session -d -s keeper -x 140 -y 40 'bash --noprofile --norc'
tmux -L acc-settings-sync set-option -g extended-keys on
tmux -L acc-settings-sync set-option -g extended-keys-format csi-u
for actor in a b; do
  args=(env -u ACCORDION_TOKEN -u ACCORDION_HOST -u ACCORDION_PORT -u ACCORDION_DOOR_PORT
    -u ACCORDION_AUTO_ARM -u ACCORDION_DEFAULT_CONDUCTOR -u ACCORDION_COMPACT_MODE -u ACCORDION_DEBUG
    "ACCORDION_HOME=$base/home" "ACCORDION_TEST_CHANNEL=$base/channels/$actor")
  if test "$actor" = b; then args+=(ACCORDION_AUTO_ARM=0); fi
  args+=(pi-bolt --offline --no-extensions -e "$evidence/live-extension.ts"
    --no-skills --no-prompt-templates --no-context-files --no-session --no-mcp
    --approve --name "settings-sync-$actor")
  if test "$actor" = b; then args+=(--accordion-port 0); fi
  tmux -L acc-settings-sync new-session -d -s "$actor" -x 140 -y 40 'bash --noprofile --norc'
  printf -v prefix 'cd %q && exec ' "$base/project-$actor"
  printf -v command '%q ' "${args[@]}"
  tmux -L acc-settings-sync send-keys -t "$actor:0.0" -l -- "$prefix$command"
  tmux -L acc-settings-sync send-keys -t "$actor:0.0" Enter
done
```

Wait for both session startups. In session `a`, then `b`, run `/accordion settings`.
If Enter only accepts completion, submit it again after checking the screen. When `b` asks,
choose **Take control**; `a` becomes read-only. Leave both panels open, with no staged edits.

```bash
cd "$evidence"
uv run --no-project python -B -m live
uvx ruff check --no-cache live.py
uvx mypy --strict --cache-dir "$base/mypy-cache" live.py
```

The fixture imports explicit `.ts` paths: extensionless Jiti imports can select an old generated
`accordion.js` instead. The driver checks each observer against its actual terminal process tree;
tmux's pane PID is the launcher, not necessarily the Pi child PID.

## Runtime dials

After the shared-save run, leave both panels open and `b` in control. Run
`uv run --no-project python -B -m runtime` from this directory.
`dials-result.json` verifies live peer model-default adoption while `b` retains budget/tail
values entered through the native session-only editors. The exported dials, Truth counters,
source labels and saved file agree. Neither probe sends model requests.
Run Ruff and strict mypy on both `live.py` and `runtime.py`.

## Privacy lifecycle

Run `uv run --no-project python -B -m privacy` next. It reloads older fixture versions,
registers local and remote **routing metadata** through Pi's actual provider registry, and
uses the real native conductor picker, lock confirmation and privacy dialog. Both provider
implementations fail closed and count unexpected calls; no backend requests are made.
`privacy-result.json` records native and peer revocation, unrelated-key and fully local
exemptions, unsafe-route detachment and declining renewed consent. Declining restores the panel.
This is a live Pi/UI/policy check, not a live model-backend or in-flight-stream evaluation.
The controller driver reopens the native panel instead of trusting its cached `canSteer`
observation. A stale observation initially skipped takeover; the native write guard correctly
cancelled that fixture save before it could write.
Check `live.py`, `runtime.py` and `privacy.py` with Ruff and strict mypy.

## Browser credentials and bad-config recovery

Run `uv run --no-project python -B -m tokens` after privacy. `tokens-result.json` records
real HTTP and WebSocket probes against both Pi servers: native generated-secret rotation,
custom-token replacement, issued-cookie retirement, secret adoption despite malformed config,
refused invalid-file saves and valid-file recovery. Credentials remain private and captures
are redacted. Check all four Python drivers with Ruff and strict mypy.

WebSocket bearer probes use an **untrusted Origin** to isolate bearer authorization. An initial
served-origin negative probe was wrong: the verified Accordion-origin path independently
authorizes a connection. HTTP probes isolate cookie retirement; WebSocket probes verify that
valid cookies work with the served Origin but do not authorize an untrusted Origin. This does
not claim that rotation revokes trusted-origin access or existing sockets. The source-only
fixture has no built browser assets (404); the final clean-production install/asset gate remains.

## Stale controllers and replacement sessions

Run `uv run --no-project python -B -m guards` next. It upgrades the fixture to v5, then
checks actual native settings and Truth callbacks after controller loss, cancels a queued
save while Python holds the real SQLite mutex, and repeats the guards after Pi's `/new`.
The fresh session still saves normally. `guards-result.json` records the outcomes.

Pi reactivates extensions on `/new` in the same process. The initial activation-local cache
silently substituted the fresh host for the supposed old callback (`replacement-diagnostic.json`).
The repaired fixture retains the actual host process-wide and checks remembered session and
activation identities before exercising it. No product guard change was needed. Run Ruff and
strict mypy on all five drivers; standalone TypeScript retains only the seven documented
baseline diagnostics, none in the fixture.

## Sixteen-row Settings matrix

Run `uv run --no-project python -B -m viewports` after the guard evaluation. The driver uses
the source-loaded `b` session, resizes its real terminal to 36/57/80/140 columns by 16 rows,
and exercises Settings, the budget editor, budget scope, token confirmation, a staged edit and
discard confirmation. It checks widths and unchanged config/dials/Truth, then renders 24 PNGs
through the terminal-testing skill. Review the PNGs; `viewport-16/visual-review.json` records
the observed selection, caret, hints, confirmations, staging and lock cues.

The initial narrow run exposed confirmation facts hiding both choices. The shared layout now
reserves question/choice rows and moves clipped facts to the description; the exact before/after
captures and the 16/24-row regression protect that behavior. Navigation recognizes clipped
labels and breadcrumbs without assuming the frame starts at the terminal's first row.
Run Ruff and strict mypy on all six Python drivers. Review copies may be scaled locally;
the original evidence PNGs remain unchanged. No provider request or persistent edit is made.

## Cleanup

Stop only the Pi processes from this run, wait for them to exit, then remove their owned tmux
server and private `.pi/settings-sync/` directory. Killing a tmux pane alone did not reliably stop
the Pi child in the observed launcher. Keep the redacted evidence, not private channels, secrets,
compiled bytecode or tool caches.
