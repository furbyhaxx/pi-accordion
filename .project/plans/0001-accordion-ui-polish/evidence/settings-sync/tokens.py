"""Probe browser credentials against two live Pi HTTP/WebSocket servers without logging tokens."""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import live
from runtime import _save


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _port(name: str) -> int:
    port = live._at(live._current_state(name), "web", "port")
    assert isinstance(port, int) and port > 0
    return port


def _probe(
    name: str,
    *,
    token: str | None = None,
    cookie: str | None = None,
    websocket: bool = False,
    asset: bool = False,
    untrusted: bool = False,
) -> tuple[int, str | None]:
    port = _port(name)
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    headers = {"Origin": f"http://127.0.0.1:{port}"}
    if untrusted:
        headers["Origin"] = "https://untrusted.settings-fixture.invalid"
    if cookie is not None:
        headers["Cookie"] = cookie
    if websocket:
        headers.update(
            {
                "Connection": "Upgrade",
                "Upgrade": "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": base64.b64encode(secrets.token_bytes(16)).decode(),
            }
        )
    route = "/" if websocket or asset else "/__accordion/sessions"
    if token is not None:
        route += "?" + urlencode({"token": token})
    try:
        connection.request("GET", route, headers=headers)
        response = connection.getresponse()
        return response.status, response.getheader("Set-Cookie")
    except (OSError, http.client.HTTPException):
        raise RuntimeError("Loopback credential probe failed") from None
    finally:
        connection.close()


def _cookies(token: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in ["a", "b"]:
        status, header = _probe(name, token=token, asset=True)
        assert status in [200, 404] and header is not None, (
            "Browser entry failed to issue a cookie"
        )
        result[name] = header.split(";", 1)[0]
    return result


def _accepted(token: str, cookies: dict[str, str]) -> None:
    for name in ["a", "b"]:
        assert _probe(name, token=token)[0] == 200, f"{name}: bearer not accepted"
        assert _probe(name, cookie=cookies[name])[0] == 200, (
            f"{name}: cookie not accepted"
        )
        assert _probe(name, token=token, websocket=True, untrusted=True)[0] == 101, (
            f"{name}: bearer upgrade refused"
        )
        assert _probe(name, cookie=cookies[name], websocket=True)[0] == 101, (
            f"{name}: served-origin upgrade refused"
        )
        assert (
            _probe(name, cookie=cookies[name], websocket=True, untrusted=True)[0] == 403
        ), f"{name}: cross-origin cookie accepted"


def _rejected(token: str, cookies: dict[str, str]) -> None:
    for name in ["a", "b"]:
        assert _probe(name, token=token)[0] == 403, f"{name}: stale bearer accepted"
        assert _probe(name, cookie=cookies[name])[0] == 403, (
            f"{name}: stale cookie accepted"
        )
        assert _probe(name, token=token, websocket=True, untrusted=True)[0] == 403, (
            f"{name}: stale bearer upgrade accepted"
        )


def _adopted(token: str) -> bool:
    return all(
        live._at(live._state(name), "web", "tokenHash") == _hash(token)
        for name in ["a", "b"]
    )


def _rotate() -> tuple[str, int]:
    started = time.monotonic()
    result = live._request("b", "rotate")
    assert result["ok"] is True, "Native rotation failed"
    token = (live.HOME / ".accordion/door-secret").read_text().strip()
    live.TOKENS.add(token)
    assert result["tokenHash"] == _hash(token)
    live._wait(lambda: _adopted(token), timeout=2)
    return token, round((time.monotonic() - started) * 1000)


def _replace_private(file: Path, content: bytes) -> None:
    temporary = file.with_name(file.name + ".live-probe.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def _verify_tokens() -> dict[str, object]:
    live._control("b")
    original = (live.HOME / ".accordion/door-secret").read_text().strip()
    live.TOKENS.add(original)
    _save({"debug": True})
    assert live._at(live._state("b"), "settings", "settings", "customToken") is None
    original_cookies = _cookies(original)
    _accepted(original, original_cookies)
    first, rotation_ms = _rotate()
    assert first != original
    _accepted(first, _cookies(first))
    _rejected(original, original_cookies)

    custom = secrets.token_hex(4)
    live.TOKENS.add(custom)
    _save({"customToken": custom})
    live._wait(lambda: _adopted(custom), timeout=2)
    custom_cookies = _cookies(custom)
    _accepted(custom, custom_cookies)
    replacement = secrets.token_hex(4)
    live.TOKENS.add(replacement)
    _save({"customToken": replacement})
    live._wait(lambda: _adopted(replacement), timeout=2)
    replacement_cookies = _cookies(replacement)
    _accepted(replacement, replacement_cookies)
    _rejected(custom, custom_cookies)
    generated, _ = _rotate()
    generated_cookies = _cookies(generated)
    _accepted(generated, generated_cookies)
    _rejected(replacement, replacement_cookies)

    config = live.HOME / ".accordion/config.json"
    valid = config.read_bytes()
    revision = hashlib.sha256(valid).hexdigest()
    live._wait(
        lambda: all(
            live._at(live._state(name), "settings", "rev") == revision
            for name in ["a", "b"]
        ),
        timeout=2,
    )
    canary = "fixture-content-must-not-be-echoed"
    malformed = ('{"privateCanary":"' + canary + '",').encode()
    next_token = secrets.token_hex(32)
    live.TOKENS.add(next_token)
    try:
        _replace_private(config, malformed)
        started = time.monotonic()
        _replace_private(live.HOME / ".accordion/door-secret", next_token.encode())
        live._wait(lambda: _adopted(next_token), timeout=2)
        malformed_ms = round((time.monotonic() - started) * 1000)
        _accepted(next_token, _cookies(next_token))
        _rejected(generated, generated_cookies)
        result = live._request("b", "save", patch={"debug": False}, baseRev=revision)
        assert result["ok"] is False, (
            "Malformed config was overwritten by a native save"
        )
        assert canary not in str(result.get("error")), "Save error exposed file content"
        assert config.read_bytes() == malformed
        for name in ["a", "b"]:
            state = live._current_state(name)
            assert live._at(state, "settings", "rev") == revision
            assert live._at(state, "settings", "settings", "debug") is True
            assert canary not in live._screen(name), (
                "Settings notification exposed file content"
            )
    finally:
        _replace_private(config, valid)
    _save({"debug": False})
    live._wait(
        lambda: all(
            live._at(live._state(name), "settings", "settings", "debug") is False
            for name in ["a", "b"]
        ),
        timeout=2,
    )
    restored_cookies = _cookies(next_token)
    final, _ = _rotate()
    _accepted(final, _cookies(final))
    _rejected(next_token, restored_cookies)
    live._tab("b", "Settings")
    live._select("b", "Debug log")
    live._capture("a", "a-token-policy-recovered")
    live._capture("b", "b-token-policy-recovered")
    return {
        "servers": 2,
        "browserLikeOriginUsed": True,
        "httpBearerAndIssuedCookies": {"accepted": 200, "retired": 403},
        "websocketBearerWithUntrustedOrigin": {"accepted": 101, "retired": 403},
        "websocketCookieOriginGate": {"servedOrigin": 101, "untrustedOrigin": 403},
        "assetEntryStatuses": {
            name: _probe(name, token=final, asset=True)[0] for name in ["a", "b"]
        },
        "nativeRotationPeerAdoptionMs": rotation_ms,
        "customTokenChangesAdoptedAndRetired": True,
        "generatedRotationClearsCustomToken": True,
        "badConfigSecretAdoptionMs": malformed_ms,
        "badConfigRetainsLastValidSettings": True,
        "badConfigSaveRefusedWithoutEchoOrOverwrite": True,
        "validConfigRecoveryVerified": True,
        "finalGeneratedTokenLength": len(final),
    }


if __name__ == "__main__":
    result = _verify_tokens()
    live._write(live.EVIDENCE / "tokens-result.json", result)
    print(json.dumps(result, indent=2))
