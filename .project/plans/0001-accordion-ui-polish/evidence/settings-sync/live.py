"""Drive the two isolated Pi instances used by the settings synchronization evaluation."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
BASE = ROOT / ".pi/settings-sync"
HOME = BASE / "home"
EVIDENCE = Path(__file__).resolve().parent
ROWS = (
    "Folding",
    "Token budget",
    "Protected tail",
    "Arm on startup",
    "Default conductor",
    "/compact behavior",
    "Web UI address",
    "Web UI door port",
    "Web access token",
    "Debug log",
    "Task fold timing",
)
TOKENS: set[str] = set()


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError("Expected a JSON object")
    result: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise TypeError("Expected a string JSON key")
        result[key] = item
    return result


def _read(file: Path) -> dict[str, object]:
    value: object = json.loads(file.read_text())
    return _object(value)


def _at(value: object, *keys: str) -> object:
    for key in keys:
        value = _object(value)[key]
    return value


def _write(file: Path, value: object) -> None:
    temporary = file.with_suffix(file.suffix + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")
    temporary.replace(file)


def _tmux(*args: str) -> str:
    return subprocess.run(
        ["tmux", "-L", "acc-settings-sync", *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout


def _state(name: str) -> dict[str, object]:
    return _read(BASE / "channels" / name / "state.json")


def _screen(name: str, *, ansi: bool = False) -> str:
    return _tmux("capture-pane", "-p", *(["-e"] if ansi else []), "-t", f"{name}:0.0")


def _wait(condition: Callable[[], bool], *, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() >= deadline:
            raise TimeoutError("Live fixture condition did not become true")
        time.sleep(0.03)


def _selected(name: str) -> str | None:
    for line in _screen(name).splitlines():
        for row in ROWS:
            if re.match(r"\s*→ " + re.escape(row) + r"\s", line):
                return row
    return None


def _select(name: str, row: str) -> None:
    _wait(lambda: _selected(name) is not None)
    while (current := _selected(name)) != row:
        if current is None:
            raise RuntimeError("Settings row lost selection")
        step = 1 if ROWS.index(row) > ROWS.index(current) else -1
        expected = ROWS[ROWS.index(current) + step]
        _tmux("send-keys", "-t", f"{name}:0.0", "Down" if step > 0 else "Up")

        def reached(wanted: str = expected) -> bool:
            return _selected(name) == wanted

        _wait(reached)


def _capture(name: str, label: str) -> None:
    TOKENS.add((HOME / ".accordion/door-secret").read_text().strip())
    custom = _read(HOME / ".accordion/config.json").get("customToken")
    if isinstance(custom, str):
        TOKENS.add(custom)
    for suffix, ansi in [("txt", False), ("ansi", True)]:
        screen = _screen(name, ansi=ansi)
        for token in TOKENS:
            if token:
                screen = screen.replace(token, "[TOKEN]")
        (EVIDENCE / f"{label}.{suffix}").write_text(screen)
    (EVIDENCE / f"{label}.meta").write_text(
        _tmux(
            "display-message", "-p", "-t", f"{name}:0.0", "#{pane_width}x#{pane_height}"
        )
    )


def _request(name: str, action: str, **values: object) -> dict[str, object]:
    identifier = time.time_ns() // 1_000
    directory = BASE / "channels" / name
    _write(directory / "request.json", {"id": identifier, "action": action, **values})
    response = directory / "response.json"
    _wait(lambda: response.exists() and _read(response).get("id") == identifier)
    return _object(_read(response)["result"])


def _writers(
    label: str, patches: tuple[dict[str, object], dict[str, object]]
) -> list[dict[str, object]]:
    directory = BASE / "writers" / f"{label}-{time.time_ns()}"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    prefixes = [directory / name for name in ["a", "b"]]
    processes = [
        subprocess.Popen(
            [
                "bun",
                str(EVIDENCE / "store-writer.ts"),
                str(HOME),
                str(prefix),
                json.dumps(patch),
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for prefix, patch in zip(prefixes, patches, strict=True)
    ]
    try:
        _wait(lambda: all(Path(f"{prefix}.ready.json").exists() for prefix in prefixes))
        assert (
            _read(Path(f"{prefixes[0]}.ready.json"))["rev"]
            == _read(Path(f"{prefixes[1]}.ready.json"))["rev"]
        )
        for prefix in prefixes:
            _write(Path(f"{prefix}.go"), True)
        for process in processes:
            _, error = process.communicate(timeout=20)
            if process.returncode:
                raise RuntimeError(f"Store writer failed: {error[:2000]}")
        return [_read(Path(f"{prefix}.result.json")) for prefix in prefixes]
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


def _current_state(name: str) -> dict[str, object]:
    state = _state(name)
    pid = state["pid"]
    assert isinstance(pid, int)
    parent = subprocess.check_output(
        ["ps", "-o", "ppid=", "-p", str(pid)], text=True, timeout=5
    ).strip()
    pane = _tmux("display-message", "-p", "-t", f"{name}:0.0", "#{pane_pid}").strip()
    assert parent == pane, (
        "Observer does not belong to the current terminal process tree"
    )
    assert time.time() * 1000 - int(str(state["at"])) < 1000, "Observer is stale"
    return state


def _check_shared() -> None:
    for name in ["a", "b"]:
        state = _current_state(name)
        assert state["panelOpen"] is True
        assert _at(state, "settings", "settings", "debug") is False
        assert _at(state, "settings", "settings", "taskfold", "timing") == "eager"
        assert _at(state, "settings", "settings", "compact", "manual") == "pass"
    assert _at(_state("b"), "settings", "sources", "autoArm") == "env"
    assert _at(_state("b"), "settings", "sources", "doorPort") == "flag"
    _select("b", "Debug log")
    _tmux("send-keys", "-t", "b:0.0", "Enter")
    _wait(lambda: "▲ staged" in _screen("b"))
    started = time.monotonic()
    _tmux("send-keys", "-t", "b:0.0", "C-s")
    _wait(
        lambda: all(
            _at(_state(n), "settings", "settings", "debug") is True for n in ["a", "b"]
        ),
        timeout=2,
    )
    latency = time.monotonic() - started
    assert all("Debug log" in _screen(n) and "[x] on" in _screen(n) for n in ["a", "b"])
    _capture("a", "a-synchronized")
    _capture("b", "b-synchronized")

    _select("b", "/compact behavior")
    _tmux("send-keys", "-t", "b:0.0", "Right")
    _wait(lambda: "▲ staged" in _screen("b"))
    external = _writers("unrelated", ({"taskfold.timing": "lazy"}, {"autoArm": True}))
    assert all(result["ok"] is True for result in external)
    _wait(
        lambda: _at(_state("b"), "settings", "settings", "taskfold", "timing") == "lazy"
    )
    _tmux("send-keys", "-t", "b:0.0", "C-s")
    _wait(
        lambda: (
            _at(_state("b"), "settings", "settings", "compact", "manual") == "native"
            and "▲ staged" not in _screen("b")
        )
    )
    config = _read(HOME / ".accordion/config.json")
    assert _at(config, "compact", "manual") == "native"
    assert _at(config, "taskfold", "timing") == "lazy"
    assert config["fixtureUnrelated"] == "retain"
    _wait(lambda: _at(_state("a"), "settings", "settings", "autoArm") is True)
    assert _at(_state("b"), "settings", "settings", "autoArm") is False

    _select("b", "Task fold timing")
    _tmux("send-keys", "-t", "b:0.0", "Right")
    _wait(lambda: "▲ staged" in _screen("b"))
    external = _writers(
        "conflict-baseline", ({"taskfold.timing": "eager"}, {"taskWidget.maxRows": 9})
    )
    assert all(result["ok"] is True for result in external)
    _wait(
        lambda: (
            _at(_state("b"), "settings", "settings", "taskfold", "timing") == "eager"
        )
    )
    _tmux("send-keys", "-t", "b:0.0", "C-s")
    _wait(lambda: "changed" in _screen("b").lower())
    assert "pressure" in _screen("b") and "▲ staged" in _screen("b")
    assert _at(_read(HOME / ".accordion/config.json"), "taskfold", "timing") == "eager"
    _capture("b", "b-staged-conflict")
    _tmux("send-keys", "-t", "b:0.0", "Right")
    _wait(lambda: "▲ staged" not in _screen("b"))

    same = _writers(
        "same-field", ({"taskfold.timing": "lazy"}, {"taskfold.timing": "pressure"})
    )
    assert sum(result["ok"] is True for result in same) == 1
    assert sum(result.get("conflict") is True for result in same) == 1
    winner = _at(_read(HOME / ".accordion/config.json"), "taskfold", "timing")
    _wait(
        lambda: all(
            _at(_state(n), "settings", "settings", "taskfold", "timing") == winner
            for n in ["a", "b"]
        )
    )
    _capture("b", "b-concurrent-save")
    revision = _at(_state("b"), "settings", "rev")
    assert isinstance(revision, str)
    flag_denied = _request("b", "save", patch={"doorPort": 0}, baseRev=revision)
    env_denied = _request("b", "save", patch={"autoArm": True}, baseRev=revision)
    assert flag_denied["ok"] is False and "flag" in str(flag_denied.get("error"))
    assert env_denied["ok"] is False and "environment" in str(env_denied.get("error"))
    _select("b", "Web UI door port")
    _tmux("send-keys", "-t", "b:0.0", "Enter")
    _wait(lambda: "locked; remove" in _screen("b"))
    _capture("b", "b-locked-field")
    result = {
        "realPiInstances": 2,
        "sourceExplicitlyLoaded": True,
        "observerPidsMatchTerminalProcessTrees": True,
        "peerAdoptionMs": round(latency * 1000),
        "unrelatedNativeSaveMerged": True,
        "stagedConflictRetained": True,
        "independentWriterResults": same,
        "environmentOverrideWins": True,
        "flagOverrideVisible": True,
        "lockedNativeWritesRejected": True,
        "unknownFileFieldPreserved": True,
    }
    _write(EVIDENCE / "shared-result.json", result)
    print(json.dumps(result, indent=2))


def main() -> None:
    """Evaluate live shared saves without issuing any model prompts."""
    _check_shared()


if __name__ == "__main__":
    main()
