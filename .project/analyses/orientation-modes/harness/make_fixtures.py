#!/usr/bin/env python3
"""Build the tier-2 fixture repos: small projects whose task needs facts and rules that are only
stated in long orientation material (spec, plan, notes, AGENTS.md), with planted traps and a hidden
grader. Deterministic: rerunning produces identical files.

    python3 make_fixtures.py   # writes fixtures/<name>/{repo,hidden}
"""
from __future__ import annotations

import random
import shutil
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "fixtures"

TOPICS = [
    "observability", "deployment history", "capacity planning", "incident review", "naming",
    "backwards compatibility", "security review", "performance notes", "team ownership",
    "glossary", "open questions", "rejected alternatives", "migration notes", "testing strategy",
]
WORDS = (
    "service request tenant route latency budget window queue cluster region shard replica cache "
    "metric dashboard alert owner rollout canary release review latency throughput backlog upstream "
    "downstream gateway proxy policy quota token header client server retry backoff jitter timeout"
).split()


def filler(rng: random.Random, sections: int, title: str) -> str:
    """Plausible but irrelevant prose: sections a reader has to skim past."""
    out = []
    for i in range(sections):
        topic = rng.choice(TOPICS)
        out.append(f"## {title} — {topic} ({i + 1})\n")
        for _ in range(rng.randint(3, 5)):
            words = [rng.choice(WORDS) for _ in range(rng.randint(40, 70))]
            s = " ".join(words)
            out.append(textwrap.fill(s[0].upper() + s[1:] + ".", 100) + "\n")
    return "\n".join(out)


def write(base: Path, rel: str, text: str) -> None:
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    # Templates are indented 8 spaces in this file; inserted filler is not, so strip line by line.
    lines = [line[8:] if line.startswith(" " * 8) else line for line in text.lstrip("\n").split("\n")]
    p.write_text("\n".join(lines))


# ── fixture 1: rate limiter ─────────────────────────────────────────────────────────────────────

def ratelimit() -> None:
    rng = random.Random(1)
    base = ROOT / "ratelimit"
    shutil.rmtree(base, ignore_errors=True)
    repo, hidden = base / "repo", base / "hidden"
    write(repo, "AGENTS.md", """
        # Working rules for this repository

        - Run the tests with `python3 -m pytest -q`; they must pass before you finish.
        - Every number that configures the limiter lives in `limiter/config.py`. Never hard-code a
          limit, window or multiplier anywhere else; import it from `limiter.config`.
        - Never modify anything under `vendor/`; it is generated from the upstream schema.
        - Every public function and class needs a docstring.
        - Use only the Python standard library.
    """)
    write(repo, "docs/spec.md", f"""
        # Rate limiter specification (v3, final)

        This version supersedes the September draft in `docs/notes/`. Where they differ, this spec wins.

        {filler(rng, 6, "Background")}

        ## Limits

        - Each key gets a token bucket with a burst of **37** requests.
        - Tokens refill one at a time; a full refill of the whole burst takes **1500 ms**, so one
          token is added every 1500/37 ms.
        - Tenants on the **gold** tier get **2×** the burst (the refill time stays 1500 ms).

        {filler(rng, 5, "Operations")}

        ## Keys

        A bucket key has the form `rl:{{tenant}}:{{route}}`, where `route` is the path with its leading
        slash removed and every remaining `/` replaced by `.` (so `/v1/orders` → `v1.orders`).

        {filler(rng, 4, "History")}

        ## Responses

        - An allowed request carries the header `X-RateLimit-Remaining` with the tokens left after
          this request.
        - A rejected request gets status 429 and the error code `E_RATE_429` in the body
          `{{"error": "E_RATE_429", "retry_after_ms": N}}`, where `N` is the milliseconds until the
          next token, rounded **up** to a whole number. It also carries `X-RateLimit-Remaining: 0`.
        - Every rejection is logged on the logger named `limiter.reject` at level WARNING with the
          message `rejected <key>` (e.g. `rejected rl:acme:v1.orders`).

        {filler(rng, 5, "Appendix")}
    """)
    write(repo, "docs/plan.md", """
        # Plan

        1. Put every limit from the spec into `limiter/config.py` (burst, refill time, gold multiplier).
        2. Implement `TokenBucket` in `limiter/bucket.py` (refill based on elapsed time, injectable clock).
        3. Implement `make_key` and `check_request` in `limiter/middleware.py` (allowed path only).
        4. Add the rejection path: status, body with `retry_after_ms`, header, and the rejection log.
        5. Extend `tests/` so every spec rule is covered, and run the whole suite.
    """)
    write(repo, "docs/notes/2026-09-draft.md", f"""
        # Draft (September) — superseded

        Early proposal: burst of 30 requests, refill over 1000 ms, header `X-Rate-Remaining`,
        error code `RATE_LIMITED`, a `Retry-After` header in seconds, rejections logged on `gateway`
        at INFO. Gold tenants were not special-cased.

        {filler(rng, 6, "Draft discussion")}
    """)
    write(repo, "docs/architecture.md", f"""
        # Architecture

        {filler(rng, 10, "Architecture")}
    """)
    write(repo, "vendor/schema.json", "{\n" + ",\n".join(f'  "field_{i}": {{"type": "string", "doc": "{" ".join(rng.choice(WORDS) for _ in range(12))}"}}' for i in range(220)) + "\n}\n")
    write(repo, "limiter/__init__.py", '''
        """Token-bucket rate limiting for the gateway."""
        from limiter.bucket import TokenBucket
        from limiter.middleware import check_request, make_key

        __all__ = ["TokenBucket", "check_request", "make_key"]
    ''')
    write(repo, "limiter/config.py", '''
        """Limiter configuration. Every limit lives here."""
    ''')
    write(repo, "limiter/bucket.py", '''
        """Token bucket."""


        class TokenBucket:
            """A token bucket. To be implemented (see docs/plan.md)."""

            def __init__(self, burst, refill_ms, clock=None):
                """`clock` is a zero-argument callable returning seconds (default `time.monotonic`)."""
                raise NotImplementedError

            def take(self):
                """Take one token; return the tokens left, or -1 when empty."""
                raise NotImplementedError
    ''')
    write(repo, "limiter/middleware.py", '''
        """Request admission."""


        def make_key(tenant, route):
            """Return the bucket key for a tenant and route."""
            raise NotImplementedError


        def check_request(tenant, route, tier="standard", clock=None):
            """Admit or reject one request; return (status, headers, body). `body` is a dict."""
            raise NotImplementedError
    ''')
    write(repo, "tests/test_smoke.py", '''
        import limiter


        def test_exports():
            assert set(limiter.__all__) == {"TokenBucket", "check_request", "make_key"}
    ''')
    write(hidden, "test_hidden.py", '''
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
    ''')
    write(hidden, "constraints.py", '''
        """Constraint checks: each returns a list of violations (empty when respected)."""
        import ast
        import pathlib
        import sys

        STDLIB = set(sys.stdlib_module_names)


        def check(repo: pathlib.Path, original: pathlib.Path) -> dict:
            out = {}
            # vendor untouched
            out["vendor_untouched"] = [str(p.relative_to(repo)) for p in (repo / "vendor").rglob("*") if p.is_file() and (original / p.relative_to(repo)).read_bytes() != p.read_bytes()]
            # numbers only in config.py
            bad = []
            for f in (repo / "limiter").glob("*.py"):
                if f.name == "config.py":
                    continue
                for node in ast.walk(ast.parse(f.read_text())):
                    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool) and node.value in (37, 1500, 1.5, 74, 30, 1500.0, 37.0):
                        bad.append(f"{f.name}:{node.lineno} {node.value}")
            out["constants_in_config"] = bad
            # docstrings
            missing = []
            for f in (repo / "limiter").glob("*.py"):
                for node in ast.walk(ast.parse(f.read_text())):
                    if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not node.name.startswith("_") and ast.get_docstring(node) is None:
                        missing.append(f"{f.name}:{node.name}")
            out["docstrings"] = missing
            # stdlib only
            deps = []
            for f in (repo / "limiter").glob("*.py"):
                for node in ast.walk(ast.parse(f.read_text())):
                    names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 else []
                    for n in names:
                        top = n.split(".")[0]
                        if top not in STDLIB and top != "limiter":
                            deps.append(f"{f.name}: {n}")
            out["stdlib_only"] = deps
            # exports unchanged
            init = (repo / "limiter/__init__.py").read_text()
            out["exports_unchanged"] = [] if '__all__ = ["TokenBucket", "check_request", "make_key"]' in init else ["limiter/__init__.py __all__ changed"]
            return out
    ''')
    write(base, "prompt.txt", """
        Implement the rate limiter in this repository. Read AGENTS.md, docs/spec.md, docs/plan.md, docs/architecture.md and docs/notes/ first, then work through the plan.
        Do not change the exports in limiter/__init__.py. When you are done, the test suite must pass.
    """)


# ── fixture 2: invoice export ───────────────────────────────────────────────────────────────────

def invoices() -> None:
    rng = random.Random(2)
    base = ROOT / "invoices"
    shutil.rmtree(base, ignore_errors=True)
    repo, hidden = base / "repo", base / "hidden"
    write(repo, "AGENTS.md", """
        # Working rules

        - Money is always `decimal.Decimal`, never `float`; parse amounts with `Decimal(str)`.
        - VAT rates and currencies live only in `export/rates.py`.
        - Do not edit anything under `tests/fixtures/`; it mirrors production data.
        - Run `python3 -m pytest -q` before you finish; it must pass.
        - Standard library only.
    """)
    write(repo, "docs/spec.md", f"""
        # Monthly invoice export (final)

        Supersedes the draft in `docs/notes/`.

        {filler(rng, 6, "Context")}

        ## File

        - One file per month named `invoices-YYYYMM.csv` (e.g. `invoices-202610.csv`).
        - Fields are separated by **semicolons** (`;`), UTF-8, `\\n` line endings, one header line.
        - Columns, in this order: `invoice_id;issued_on;customer;net;vat;gross;currency`.
        - `issued_on` is ISO `YYYY-MM-DD`.

        {filler(rng, 5, "Process")}

        ## Amounts

        - `vat` = `net` × rate of the customer's country, rounded **half-even** to 2 decimals.
        - `gross` = `net` + `vat`. All three printed with exactly 2 decimals.
        - Rates: CH **8.1%**, DE **19%**, AT **20%**, FR **20%**. Currency: CH → `CHF`, all others → `EUR`.
        - Customers from any other country are skipped and reported on stderr as `skipped <invoice_id>`.

        ## Summary file

        Next to the CSV, write `invoices-YYYYMM.summary.txt`: one line per currency present, sorted
        by currency code, as `<currency> <count> <gross total>` with the total printed with 2 decimals
        (e.g. `CHF 3 1234.50`), then a last line `skipped <n>` with the number of skipped invoices.

        {filler(rng, 5, "Appendix")}
    """)
    write(repo, "docs/plan.md", """
        # Plan

        1. Put the rates and currencies into `export/rates.py`.
        2. Implement `compute(net, country)` in `export/amounts.py` returning (vat, gross, currency).
        3. Implement `export_month(invoices, year, month, outdir)` in `export/writer.py`, returning the CSV path.
        4. Add the summary file to `export_month`.
        5. Cover the spec with tests and run the suite.
    """)
    write(repo, "docs/notes/draft.md", f"""
        # Draft — superseded

        Comma-separated, columns `id,date,customer,amount,tax,total`, CH VAT 7.7%, round half-up.
        Summary as JSON (`summary.json`) with net totals per country.

        {filler(rng, 6, "Draft")}
    """)
    write(repo, "docs/operations.md", f"""
        # Operations

        {filler(rng, 10, "Operations")}
    """)
    write(repo, "export/__init__.py", '''
        """Monthly invoice export."""
    ''')
    write(repo, "export/rates.py", '''
        """VAT rates and currencies per country."""
    ''')
    write(repo, "export/amounts.py", '''
        """Amount computation."""


        def compute(net, country):
            """Return (vat, gross, currency) for a net amount, or None for an unsupported country."""
            raise NotImplementedError
    ''')
    write(repo, "export/writer.py", '''
        """CSV writer."""


        def export_month(invoices, year, month, outdir):
            """Write the month's invoices; return the path of the file written."""
            raise NotImplementedError
    ''')
    write(repo, "tests/fixtures/invoices.json", '[\n' + ",\n".join(f'  {{"invoice_id": "INV-{i:04d}", "issued_on": "2026-10-{(i % 28) + 1:02d}", "customer": "C{i}", "country": "{rng.choice(["CH", "DE", "AT", "FR", "US"])}", "net": "{rng.randint(100, 99999) / 100:.2f}"}}' for i in range(120)) + "\n]\n")
    write(repo, "tests/test_smoke.py", '''
        import export


        def test_import():
            assert export
    ''')
    write(hidden, "test_hidden.py", '''
        import pathlib
        from decimal import Decimal

        from export.amounts import compute
        from export.writer import export_month


        def test_rates_and_rounding():
            vat, gross, cur = compute(Decimal("100.00"), "CH")
            assert (str(vat), str(gross), cur) == ("8.10", "108.10", "CHF")
            vat, gross, cur = compute(Decimal("0.125"), "DE")
            assert cur == "EUR"
            assert str(compute(Decimal("10.25"), "AT")[0]) == "2.05"
            assert compute(Decimal("1.25"), "DE")[0] == Decimal("0.24")
            assert compute(Decimal("1"), "US") is None


        def test_file(tmp_path, capsys):
            inv = [
                {"invoice_id": "A1", "issued_on": "2026-10-03", "customer": "Acme", "country": "CH", "net": "100.00"},
                {"invoice_id": "A2", "issued_on": "2026-10-04", "customer": "Beta", "country": "US", "net": "5.00"},
                {"invoice_id": "A3", "issued_on": "2026-10-05", "customer": "Gamma", "country": "FR", "net": "10.00"},
            ]
            path = pathlib.Path(export_month(inv, 2026, 10, tmp_path))
            assert path.name == "invoices-202610.csv"
            lines = path.read_text().splitlines()
            assert lines[0] == "invoice_id;issued_on;customer;net;vat;gross;currency"
            assert lines[1] == "A1;2026-10-03;Acme;100.00;8.10;108.10;CHF"
            assert lines[2] == "A3;2026-10-05;Gamma;10.00;2.00;12.00;EUR"
            assert len(lines) == 3
            assert "skipped A2" in capsys.readouterr().err
            summary = (tmp_path / "invoices-202610.summary.txt").read_text().splitlines()
            assert summary == ["CHF 1 108.10", "EUR 1 12.00", "skipped 1"]
    ''')
    write(hidden, "constraints.py", '''
        """Constraint checks."""
        import ast
        import pathlib
        import sys

        STDLIB = set(sys.stdlib_module_names)


        def check(repo: pathlib.Path, original: pathlib.Path) -> dict:
            out = {}
            out["fixtures_untouched"] = [str(p.relative_to(repo)) for p in (repo / "tests/fixtures").rglob("*") if p.is_file() and (original / p.relative_to(repo)).read_bytes() != p.read_bytes()]
            floats = []
            for f in (repo / "export").glob("*.py"):
                for node in ast.walk(ast.parse(f.read_text())):
                    if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "float":
                        floats.append(f"{f.name}:{node.lineno}")
                    if isinstance(node, ast.Constant) and isinstance(node.value, float):
                        floats.append(f"{f.name}:{node.lineno} {node.value}")
            out["no_float_money"] = floats
            rates = []
            for f in (repo / "export").glob("*.py"):
                if f.name == "rates.py":
                    continue
                src = f.read_text()
                for needle in ("8.1", '"19"', "'19'", "0.19", "0.081", '"CHF"', "'CHF'"):
                    if needle in src:
                        rates.append(f"{f.name}: {needle}")
            out["rates_in_rates_py"] = rates
            deps = []
            for f in (repo / "export").glob("*.py"):
                for node in ast.walk(ast.parse(f.read_text())):
                    names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 else []
                    for n in names:
                        if n.split(".")[0] not in STDLIB and n.split(".")[0] != "export":
                            deps.append(n)
            out["stdlib_only"] = deps
            return out
    ''')
    write(base, "prompt.txt", """
        Build the monthly invoice export in this repository. Read AGENTS.md, docs/spec.md, docs/plan.md, docs/operations.md and docs/notes/ first, then work through the plan.
        Do not change the function signatures in export/. When you are done, the test suite must pass.
    """)


if __name__ == "__main__":
    ratelimit()
    invoices()
    for f in sorted(ROOT.glob("*/repo")):
        size = sum(len(p.read_text()) for p in f.rglob("*") if p.is_file())
        print(f"{f.parent.name}: ~{size // 4} tokens of repo text")
