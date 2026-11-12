"""Replay source-loaded Settings paths in the owned sixteen-row Pi terminal."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import live

SKILL = Path("/home/furbyhaxx/.agents/skills/terminal-testing")


def _key(value: str) -> None:
    live._tmux("send-keys", "-t", "b:0.0", value)


def _capture(width: int, label: str) -> None:
    stem = f"viewport-16/{width}-{label}"
    live._capture("b", stem)
    plain = live.EVIDENCE / f"{stem}.txt"
    assert len(plain.read_text().splitlines()) == 16
    assert (live.EVIDENCE / f"{stem}.meta").read_text().strip() == f"{width}x16"
    subprocess.run(
        ["python3", str(SKILL / "scripts/check-width.py"), str(width), str(plain)],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            "bash",
            str(SKILL / "scripts/capture-to-png.sh"),
            str(live.EVIDENCE / f"{stem}.ansi"),
            "-o",
            str(live.EVIDENCE / f"{stem}.png"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def main() -> None:
    live._current_state("b")
    if live._state("b").get("panelOpen"):
        _key("C-c")
        live._wait(lambda: not live._state("b").get("panelOpen"))
    live._control("b")
    config = live.HOME / ".accordion/config.json"
    before = config.read_bytes()
    initial = live._state("b")
    assert initial["canSteer"] is True
    assert live._at(initial, "settings", "settings", "compact", "manual") in {
        "pass",
        "native",
    }
    (live.EVIDENCE / "viewport-16").mkdir(exist_ok=True)
    results: list[dict[str, object]] = []
    for width in [36, 57, 80, 140]:
        resized_at = int(time.time() * 1000)
        live._tmux("resize-window", "-t", "b:0", "-x", str(width), "-y", "16")

        def resized(stamp: int = resized_at) -> bool:
            at = live._state("b").get("at")
            return isinstance(at, int) and at > stamp

        live._wait(resized)
        live._tab("b", "Settings")
        live._select("b", "Folding")
        _capture(width, "settings")

        live._select("b", "Token budget")
        _key("Enter")
        live._tmux("send-keys", "-t", "b:0.0", "-l", "--", "175k")
        live._wait(lambda: "175,000 tokens" in live._screen("b"))
        _capture(width, "budget-editor")
        _key("Enter")
        live._wait(lambda: "This session and default" in live._screen("b"))
        _capture(width, "budget-scope")
        _key("Escape")
        live._wait(lambda: live._selected("b") == "Token budget")

        live._select("b", "Web access token")
        _key("M-r")
        live._wait(
            lambda: (
                "Keep token" in live._screen("b")
                and "Generate new token" in live._screen("b")
            )
        )
        _capture(width, "token-confirm")
        _key("Escape")
        live._wait(lambda: live._selected("b") == "Web access token")

        live._select("b", "/compact behavior")
        _key("Right")
        live._wait(lambda: "▲ 1 staged" in live._screen("b"))
        _capture(width, "staged")
        _key("C-c")
        live._wait(lambda: "Keep editing" in live._screen("b"))
        assert "Discard" in live._screen("b")
        _capture(width, "discard-confirm")
        _key("Escape")
        live._wait(lambda: live._selected("b") == "/compact behavior")
        _key("Left")
        live._wait(lambda: "▲ 1 staged" not in live._screen("b"))
        assert config.read_bytes() == before
        current = live._current_state("b")
        assert current["dials"] == initial["dials"]
        assert current["stats"] == initial["stats"]
        assert current["providerCalls"] == 0
        results.append({"columns": width, "rows": 16, "states": 6, "passed": True})
    live._write(
        live.EVIDENCE / "viewport-16/result.json",
        {
            "matrix": results,
            "configurationUnchanged": True,
            "dialsAndTruthUnchanged": True,
            "providerCalls": 0,
            "screenshotsRendered": 24,
        },
    )
    print(
        "Six Settings paths passed all four sixteen-row widths; no persistent changes"
    )


if __name__ == "__main__":
    main()
