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

## Cleanup

Stop only the Pi processes from this run, wait for them to exit, then remove their owned tmux
server and private `.pi/settings-sync/` directory. Killing a tmux pane alone did not reliably stop
the Pi child in the observed launcher. Keep the redacted evidence, not private channels, secrets,
compiled bytecode or tool caches.
