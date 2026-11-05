import importlib
import json
import logging
import math

import limiter.config as config
from limiter import TokenBucket, make_key
from limiter import middleware


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def _numbers():
    out = set()

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple, set)):
            for x in v:
                walk(x)
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out.add(v)

    for name, v in vars(config).items():
        if not name.startswith("_"):
            walk(v)
    return out


def test_config_values():
    nums = _numbers()
    assert 37 in nums
    assert 1500 in nums or 1.5 in nums
    assert 2 in nums or 74 in nums


def test_bucket_burst_and_refill():
    c = Clock()
    b = TokenBucket(37, 1500, clock=c)
    left = [b.take() for _ in range(37)]
    assert left[0] == 36 and left[-1] == 0
    assert b.take() == -1
    c.t += 1.5
    assert b.take() == 36


def test_key_format():
    assert make_key("acme", "/v1/orders") == "rl:acme:v1.orders"


def _fresh():
    importlib.reload(middleware)
    return middleware.check_request


def test_allowed_and_rejected(caplog):
    check = _fresh()
    c = Clock()
    for i in range(37):
        status, headers, body = check("t1", "/a", clock=c)
        assert status == 200
        assert str(headers["X-RateLimit-Remaining"]) == str(36 - i)
    with caplog.at_level(logging.WARNING, logger="limiter.reject"):
        status, headers, body = check("t1", "/a", clock=c)
    assert status == 429
    assert str(headers["X-RateLimit-Remaining"]) == "0"
    data = body if isinstance(body, dict) else json.loads(body)
    assert data["error"] == "E_RATE_429"
    assert set(data) == {"error", "retry_after_ms"}
    assert data["retry_after_ms"] == math.ceil(1500 / 37)
    recs = [r for r in caplog.records if r.name == "limiter.reject"]
    assert recs and recs[-1].levelno == logging.WARNING and recs[-1].getMessage() == "rejected rl:t1:a"


def test_retry_after_counts_down():
    check = _fresh()
    c = Clock()
    for _ in range(38):
        check("t2", "/a", clock=c)
    c.t += 0.02
    body = check("t2", "/a", clock=c)[2]
    data = body if isinstance(body, dict) else json.loads(body)
    assert data["retry_after_ms"] == math.ceil(1500 / 37 - 20)


def test_gold_tier():
    check = _fresh()
    c = Clock()
    ok = 0
    while check("gold1", "/b", tier="gold", clock=c)[0] == 200:
        ok += 1
        assert ok < 200
    assert ok == 74
    