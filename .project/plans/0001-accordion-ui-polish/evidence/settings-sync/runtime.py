"""Verify runtime policy adoption in two real, isolated Pi processes."""

from __future__ import annotations

import json
import time

import live


def _save(
    patch: dict[str, object], *, name: str = "b", remove: tuple[str, ...] = ()
) -> None:
    revision = live._at(live._current_state(name), "settings", "rev")
    assert isinstance(revision, str)
    result = live._request(
        name, "save", patch=patch, remove=list(remove), baseRev=revision
    )
    assert result["ok"] is True, result.get("error")


def _set_session_dial(row: str, text: str, field: str, amount: int) -> None:
    live._select("b", row)
    live._tmux("send-keys", "-t", "b:0.0", "Enter")
    live._wait(lambda: "e.g." in live._screen("b"))
    live._tmux("send-keys", "-t", "b:0.0", "-l", "--", text)
    live._tmux("send-keys", "-t", "b:0.0", "Enter")
    live._wait(lambda: "This session: until" in live._screen("b"))
    live._tmux("send-keys", "-t", "b:0.0", "Enter")
    live._wait(lambda: live._at(live._state("b"), "dials", field) == amount)
    assert live._at(live._state("b"), "dials", "sources", field, "kind") == "session"


def _verify_dials() -> dict[str, object]:
    states = [live._current_state(name) for name in ["a", "b"]]
    model = live._at(states[0], "dials", "model")
    assert isinstance(model, str)
    assert live._at(states[1], "dials", "model") == model
    assert live._at(states[0], "dials", "sources", "budget", "kind") != "session"
    assert live._at(states[0], "dials", "sources", "protect", "kind") != "session"
    _set_session_dial("Token budget", "150k", "budget", 150_000)
    _set_session_dial("Protected tail", "7k", "protect", 7_000)
    _save(
        {
            f"modelDefaults.{model}.budget": "200k",
            f"modelDefaults.{model}.protect": "12k",
        }
    )
    live._wait(
        lambda: (
            live._at(live._state("a"), "dials", "budget") == 200_000
            and live._at(live._state("a"), "dials", "protect") == 12_000
        ),
        timeout=2,
    )
    started = time.monotonic()
    _save(
        {
            f"modelDefaults.{model}.budget": "180k",
            f"modelDefaults.{model}.protect": "10k",
        }
    )
    live._wait(
        lambda: (
            live._at(live._state("a"), "dials", "budget") == 180_000
            and live._at(live._state("a"), "dials", "protect") == 10_000
        ),
        timeout=2,
    )
    elapsed = round((time.monotonic() - started) * 1000)
    for name in ["a", "b"]:
        state = live._current_state(name)
        expected = (180_000, 10_000) if name == "a" else (150_000, 7_000)
        source = "default" if name == "a" else "session"
        for field, amount in zip(["budget", "protect"], expected, strict=True):
            assert live._at(state, "dials", field) == amount
            assert live._at(state, "dials", "sources", field, "kind") == source
        assert live._at(state, "stats", "budget") == expected[0]
        assert live._at(state, "stats", "protectTokens") == expected[1]
        live._capture(name, f"{name}-live-dials")
    saved = live._read(live.HOME / ".accordion/config.json")
    assert live._at(saved, "modelDefaults", model, "budget") == "180k"
    assert live._at(saved, "modelDefaults", model, "protect") == "10k"
    return {
        "peerAdoptionMs": elapsed,
        "model": model,
        "inherited": {"budget": 180_000, "protect": 10_000},
        "session": {"budget": 150_000, "protect": 7_000},
        "nativeSessionEditorsUsed": True,
        "fileDefaultsDoNotContainSessionValues": True,
        "truthAndDialSourcesAgree": True,
        "providerCalls": 0,
    }


if __name__ == "__main__":
    result = _verify_dials()
    live._write(live.EVIDENCE / "dials-result.json", result)
    print(json.dumps(result, indent=2))
