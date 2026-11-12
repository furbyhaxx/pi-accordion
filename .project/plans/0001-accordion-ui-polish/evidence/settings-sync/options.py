"""Evaluate option reattachment in two Pi terminals using synthetic task history."""

from __future__ import annotations

import hashlib
import json
import time

import live
import privacy
from runtime import _save


def _count(name: str) -> int:
    value = live._current_state(name)["attachCount"]
    assert isinstance(value, int)
    return value


def _group(name: str) -> dict[str, object] | None:
    value = live._current_state(name)["seedGroup"]
    return None if value is None else live._object(value)


def _reattached(previous: dict[str, int]) -> None:
    live._wait(
        lambda: all(_count(name) == previous[name] + 1 for name in previous), timeout=3
    )


def main() -> None:
    for name in ("a", "b"):
        privacy._reload_fixture(name, minimum_version=11)
        live._control(name)
        assert live._request(name, "registerRoutes")["ok"] is True
    _save(
        {
            "models.defaults.chat": "settings-local/chat",
            "models.defaults.classifier": "settings-local/classifier",
            "taskfold.timing": "eager",
            "conductorOptions.taskfold.keepRecentTasks": 1,
            "conductorOptions.taskfold.high": 0.8,
            "conductorOptions.taskfold.maxLoss": 0.3,
        }
    )
    for name in ("a", "b"):
        privacy._attach(name)
        assert live._request(name, "seedTask")["ok"] is True
    previous = {name: _count(name) for name in ("a", "b")}
    _save({"conductorOptions.taskfold.high": 0.85})
    _reattached(previous)
    time.sleep(0.3)
    assert all(_group(name) is None for name in ("a", "b"))
    previous = {name: _count(name) for name in ("a", "b")}
    _save({"conductorOptions.taskfold.keepRecentTasks": 0})
    _reattached(previous)
    live._wait(lambda: all(_group(name) is not None for name in ("a", "b")), timeout=5)
    before = {name: _group(name) for name in ("a", "b")}
    hashes = {}
    for name, group in before.items():
        assert group is not None
        summary = group["digest"]
        assert isinstance(summary, str) and "Fixture finished" in summary
        hashes[name] = hashlib.sha256(summary.encode()).hexdigest()
    previous = {name: _count(name) for name in ("a", "b")}
    _save({"conductorOptions.taskfold.maxLoss": 0.5})
    _reattached(previous)
    for name in ("a", "b"):
        group = _group(name)
        assert group is not None
        summary = group["digest"]
        assert isinstance(summary, str)
        assert hashlib.sha256(summary.encode()).hexdigest() == hashes[name]
        assert group["by"] == "you"
    previous = {name: _count(name) for name in ("a", "b")}
    debug = live._at(live._current_state("b"), "settings", "settings", "debug")
    assert isinstance(debug, bool)
    _save({"debug": not debug, "conductorOptions.taskfold.maxLoss": 0.5})
    time.sleep(1.3)
    assert all(_count(name) == previous[name] for name in ("a", "b"))
    assert all(live._current_state(name)["providerCalls"] == 0 for name in ("a", "b"))
    for name in ("a", "b"):
        live._control(name)
        live._tab(name, "Conductors")
        live._capture(name, f"{name}-options-reattached")
    result = {
        "instances": 2,
        "runtime": "Pi-Bolt terminals with source-loaded extension",
        "history": "synthetic task blocks appended through the test fixture",
        "modelRequests": 0,
        "keepOneLeavesTaskOpen": True,
        "keepZeroFoldsTask": True,
        "nativeAndPeerReattach": True,
        "foldSummariesPreserved": True,
        "foldOwnershipAfterReattach": "you",
        "unrelatedAndNoopDoNotReattach": True,
    }
    live._write(live.EVIDENCE / "options-result.json", result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
