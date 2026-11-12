"""Regression checks for the fold timing measurement model."""

from __future__ import annotations

import json

import timing_sim


def test_whole_reports_and_bracket_omission() -> None:
    outcome = "Outcome " * 250
    task: dict[str, object] = {
        "key": "work/1",
        "parent": None,
        "status": "done",
        "report": {"outcome": outcome},
        "kids": [],
    }
    record = json.loads(timing_sim.carrier([], task).split("} ", 1)[1])
    bracket = json.loads(timing_sim.carrier([], task, True).split("} ", 1)[1])
    assert record["outcome"] == outcome
    assert "outcome" not in bracket


def test_lazy_waits_for_cache_expiry_without_the_old_near_tail_exception() -> None:
    roles = [
        "user",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        "assistant",
    ]
    messages: list[dict[str, object]] = [
        {
            "role": role,
            "text": str(i),
            "tok": 10,
            "blocks": 1,
            "calls": [],
            "real": (100, 0, 0) if role == "assistant" else None,
            "t": 500 if i == 9 else i,
        }
        for i, role in enumerate(roles)
    ]
    task: dict[str, object] = {
        "key": "work/1",
        "id": "1",
        "parent": None,
        "s": 1,
        "e": 4,
        "close": 3,
        "report": {"outcome": "Done"},
        "kids": [],
        "status": "done",
    }
    warm = timing_sim.simulate(messages[:8], [task], "lazy", 1, 100, 100_000, 300, 20)
    expired = timing_sim.simulate(messages, [task], "lazy", 1, 100, 100_000, 300, 20)
    assert warm["folds"] == 0
    assert expired["folds"] == 1
