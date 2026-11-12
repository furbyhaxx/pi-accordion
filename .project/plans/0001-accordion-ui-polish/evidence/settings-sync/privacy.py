"""Exercise real Pi privacy lifecycles with fail-closed routing metadata, not backend calls."""

from __future__ import annotations

import json
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import live
from runtime import _save


def _reload_fixture(name: str, *, minimum_version: int = 2) -> None:
    def ready() -> bool:
        version = live._state(name).get("fixtureVersion")
        return isinstance(version, int) and version >= minimum_version

    if ready():
        return
    if live._state(name).get("panelOpen"):
        live._tmux("send-keys", "-t", f"{name}:0.0", "Escape")
        live._wait(lambda: not live._state(name).get("panelOpen"))
    live._tmux("send-keys", "-t", f"{name}:0.0", "-l", "--", "/reload")
    live._tmux("send-keys", "-t", f"{name}:0.0", "Enter")
    try:
        live._wait(ready, timeout=2)
    except TimeoutError:
        live._tmux("send-keys", "-t", f"{name}:0.0", "Enter")
        live._wait(ready, timeout=15)


def _selected_conductor(name: str) -> str:
    return next(
        (
            line.strip()
            for line in live._screen(name).splitlines()
            if line.strip().startswith("→ ")
        ),
        "",
    )


def _request_attach(name: str) -> None:
    live._control(name)
    live._tab(name, "Conductors")
    for _ in range(10):
        before = _selected_conductor(name)
        if "taskfold" in before.lower():
            break
        live._tmux("send-keys", "-t", f"{name}:0.0", "Down")

        def moved(previous: str = before) -> bool:
            return _selected_conductor(name) != previous

        live._wait(moved)
    else:
        raise RuntimeError("Taskfold was not available in the native list")
    live._tmux("send-keys", "-t", f"{name}:0.0", "Enter")
    live._wait(
        lambda: (
            live._state(name).get("conductor") == "taskfold"
            or "Attach Taskfold?" in live._screen(name)
        )
    )
    if live._state(name).get("conductor") != "taskfold":
        live._tmux("send-keys", "-t", f"{name}:0.0", "Down")
        live._wait(lambda: "→ Attach Taskfold" in live._screen(name))
        live._tmux("send-keys", "-t", f"{name}:0.0", "Enter")


def _attach(name: str) -> None:
    _request_attach(name)
    live._wait(lambda: live._state(name).get("conductor") == "taskfold")


def _verify_privacy() -> dict[str, object]:
    for name in ["a", "b"]:
        _reload_fixture(name)
        live._control(name)
        result = live._request(name, "registerRoutes")
        assert result["ok"] is True, result.get("error")
    key = live._current_state("b")["consentKey"]
    assert isinstance(key, str)
    consent = f"privacyConsent.{key}"
    obsolete = "privacyConsent.taskfold"
    stamp = datetime.now(ZoneInfo("Europe/Zurich")).isoformat()
    _save(
        {
            "models.defaults.chat": "settings-remote/chat",
            "models.defaults.classifier": "settings-remote/classifier",
            consent: stamp,
            obsolete: stamp,
        }
    )
    _attach("b")
    folding = live._state("b")["folding"]
    _save({}, remove=(obsolete,))
    assert live._current_state("b").get("conductor") == "taskfold"
    live._capture("b", "b-unrelated-consent-removed")
    _save({}, remove=(consent,))
    live._wait(lambda: not live._state("b").get("conductor"))
    assert live._state("b")["folding"] == folding
    live._capture("b", "b-native-consent-revoked")
    _save({consent: stamp})
    _attach("b")
    live._control("a")
    live._wait(
        lambda: (
            live._at(live._state("a"), "settings", "settings", "privacyConsent", key)
            == stamp
        )
    )
    started = time.monotonic()
    _save({}, name="a", remove=(consent,))
    live._wait(lambda: not live._state("b").get("conductor"), timeout=2)
    elapsed = round((time.monotonic() - started) * 1000)
    assert live._state("b")["folding"] == folding
    live._capture("b", "b-peer-consent-revoked")
    live._control("b")
    _save(
        {
            "models.defaults.chat": "settings-local/chat",
            "models.defaults.classifier": "settings-local/classifier",
        }
    )
    _attach("b")
    _save({consent: stamp})
    _save({}, remove=(consent,))
    assert live._current_state("b").get("conductor") == "taskfold"
    live._capture("b", "b-local-consent-removed")
    _save({"models.defaults.chat": "settings-remote/chat"})
    live._wait(lambda: not live._state("b").get("conductor"))
    assert live._state("b")["folding"] == folding
    live._capture("b", "b-unsafe-route-detached")
    _request_attach("b")
    live._wait(lambda: "Taskfold: privacy notice" in live._screen("b"))
    assert not live._state("b").get("conductor")
    live._capture("b", "b-remote-reattach-consent-gate")
    live._tmux("send-keys", "-t", "b:0.0", "Escape")
    live._wait(lambda: "Taskfold: privacy notice" not in live._screen("b"))
    live._wait(lambda: "Accordion › Conductors" in live._screen("b"))
    assert not live._current_state("b").get("conductor")
    for name in ["a", "b"]:
        assert live._current_state(name)["providerCalls"] == 0
    return {
        "backend": "fail-closed fixture metadata; no live model backend",
        "nativeConductorPickerUsed": True,
        "unrelatedConsentRemovalKeepsAttachment": True,
        "nativeRevocationDetaches": True,
        "peerRevocationDetachesMs": elapsed,
        "fullyLocalRoutesNeedNoConsent": True,
        "localConsentRemovalKeepsAttachment": True,
        "remoteRouteWithoutConsentDetaches": True,
        "explicitRemoteReattachRequiresConsent": True,
        "decliningConsentKeepsDetached": True,
        "nativePanelRestoredAfterDeclining": True,
        "foldingStatePreserved": True,
        "providerCalls": 0,
    }


if __name__ == "__main__":
    result = _verify_privacy()
    live._write(live.EVIDENCE / "privacy-result.json", result)
    print(json.dumps(result, indent=2))
