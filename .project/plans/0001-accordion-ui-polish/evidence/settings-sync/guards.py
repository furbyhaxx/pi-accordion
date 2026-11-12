"""Exercise native Pi session/controller guards, including a real SQLite lock wait."""

from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import live
from privacy import _reload_fixture
from runtime import _save


def _cancelled(result: dict[str, object]) -> None:
    assert result["ok"] is False, "Stale native settings save succeeded"
    error = result.get("error")
    assert isinstance(error, str) and "cancelled" in error.lower(), (
        "Expected session/controller cancellation"
    )


def _verify_guards() -> dict[str, object]:
    for name in ["a", "b"]:
        _reload_fixture(name, minimum_version=5)
    live._control("a")
    assert live._request("a", "rememberHost")["ok"] is True
    live._control("b")
    live._wait(lambda: live._state("a").get("canSteer") is False)
    config = live.HOME / ".accordion/config.json"
    before = config.read_bytes()
    revision = live._at(live._state("a"), "settings", "rev")
    assert isinstance(revision, str)
    _cancelled(live._request("a", "saveOld", patch={"debug": True}, baseRev=revision))
    assert live._request("a", "budgetOld", value=123456).get("refused") == "read-only"
    assert config.read_bytes() == before
    live._capture("a", "a-lost-controller")

    live._control("a")
    live._tmux("send-keys", "-t", "b:0.0", "Escape")
    live._wait(lambda: not live._state("b").get("panelOpen"))
    live._tmux("send-keys", "-t", "b:0.0", "-l", "--", "/accordion settings")
    live._tmux("send-keys", "-t", "b:0.0", "Enter")
    try:
        live._wait(lambda: "Take control" in live._screen("b"), timeout=1)
    except TimeoutError:
        live._tmux("send-keys", "-t", "b:0.0", "Enter")
        live._wait(lambda: "Take control" in live._screen("b"))
    live._tmux("send-keys", "-t", "b:0.0", "Down")
    live._wait(lambda: "→ Take control" in live._screen("b"))
    revision = live._at(live._state("a"), "settings", "rev")
    assert isinstance(revision, str)
    connection = sqlite3.connect(
        live.HOME / ".accordion/config.json.lock.sqlite", timeout=0
    )
    with ThreadPoolExecutor(max_workers=1) as executor:
        connection.execute("BEGIN IMMEDIATE")
        try:
            pending = executor.submit(
                live._request, "a", "save", patch={"debug": True}, baseRev=revision
            )
            live._wait(
                lambda: (
                    live._state("a").get("pendingSave") is True and not pending.done()
                ),
                timeout=1,
            )
            live._tmux("send-keys", "-t", "b:0.0", "Enter")
            _cancelled(pending.result(timeout=3))
        finally:
            connection.rollback()
            connection.close()
    live._wait(lambda: live._state("b").get("canSteer") is True)
    assert config.read_bytes() == before
    live._capture("a", "a-queued-save-cancelled")

    live._control("b")
    remembered = live._request("b", "rememberHost")
    assert remembered["ok"] is True
    old_session = remembered["sessionId"]
    old_activation = live._state("b").get("activation")
    live._tmux("send-keys", "-t", "b:0.0", "Escape")
    live._wait(lambda: not live._state("b").get("panelOpen"))
    live._tmux("send-keys", "-t", "b:0.0", "-l", "--", "/new")
    live._tmux("send-keys", "-t", "b:0.0", "Enter")
    try:
        live._wait(
            lambda: live._state("b").get("activation") != old_activation, timeout=1
        )
    except TimeoutError:
        live._tmux("send-keys", "-t", "b:0.0", "Enter")
        live._wait(lambda: live._state("b").get("activation") != old_activation)
    live._control("b")
    state = live._current_state("b")
    assert state["sessionId"] != old_session and state["canSteer"] is True
    assert state.get("rememberedSessionId") == old_session
    assert (
        state.get("rememberedActivation") == old_activation
        and state.get("activation") != old_activation
    )
    budget = live._at(state, "stats", "budget")
    revision = live._at(state, "settings", "rev")
    assert isinstance(revision, str)
    _cancelled(live._request("b", "saveOld", patch={"debug": True}, baseRev=revision))
    assert live._request("b", "budgetOld", value=123456).get("refused") == "read-only"
    assert config.read_bytes() == before
    assert live._at(live._current_state("b"), "stats", "budget") == budget
    _save({"debug": True})
    _save({"debug": False})
    live._wait(
        lambda: all(
            live._at(live._state(name), "settings", "settings", "debug") is False
            for name in ["a", "b"]
        ),
        timeout=2,
    )
    live._capture("b", "b-replacement-session-guarded")
    return {
        "fixtureVersion": 5,
        "actualOldHostRetainedAcrossPiActivation": True,
        "lostControllerSettingsSaveCancelled": True,
        "lostControllerTruthCommandRefused": True,
        "queuedSaveCancelledDuringRealSqliteLock": True,
        "replacementSessionIdChanged": True,
        "replacementSessionControlsNormally": True,
        "oldSessionSettingsSaveCancelled": True,
        "oldSessionTruthCommandRefused": True,
        "staleActionsPreserveFileAndTruth": True,
        "freshSessionSettingsSaveSucceeds": True,
    }


if __name__ == "__main__":
    result = _verify_guards()
    live._write(live.EVIDENCE / "guards-result.json", result)
    print(json.dumps(result, indent=2))
