#!/usr/bin/env python3
"""Tier-2 live runs: one headless PiG session per (fixture, arm, repetition) on a fresh copy of the
fixture repo, Accordion from this worktree with the arm's orientation options, then grading and
metrics from the session file.

    python3 tier2.py --reps 3 --arms A,C,CD,CP,AP --fixtures ratelimit,invoices --jobs 5 --cap 8
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import gzip
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parents[3]
EXT = WORKTREE / "extension" / "accordion.ts"
EVIDENCE = HERE.parent / "evidence" / "tier2"
VENV = Path("/tmp/t2-venv/bin")
SCRATCH = Path("/tmp/t2")
MODEL = "deepseek/deepseek-flash"

ARMS = {
    "A": {"fold": "off", "agentTask": False, "rules": "live", "pins": False},
    "C": {"fold": "typed", "agentTask": False, "rules": "live", "pins": False},
    "CD": {"fold": "typed", "agentTask": True, "rules": "live", "pins": False},
    "CP": {"fold": "typed", "agentTask": False, "rules": "live", "pins": True},
    "AP": {"fold": "off", "agentTask": False, "rules": "live", "pins": True},
    "CDP": {"fold": "typed", "agentTask": True, "rules": "live", "pins": True},
}

lock = threading.Lock()
spent = 0.0


def config(arm: str, budget: str, protect: str) -> dict:
    return {
        "autoArm": True,
        "defaultConductor": "taskfold",
        "doorPort": 0,
        "privacyConsent": {"taskfold": "2026-11-05T08:00:00.000Z"},
        "modelDefaults": {"deepseek/*": {"budget": budget, "protect": protect}},
        "conductorOptions": {"taskfold": {"orientation": ARMS[arm]}},
    }


def sh(cmd: list[str], cwd: Path, env: dict | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def metrics(session: Path) -> dict:
    """Usage, tool calls and protocol behaviour from a session file."""
    m = {"calls": 0, "tools": {}, "rereads": 0, "recall": 0, "unfold": 0, "pins": 0, "pin_errors": 0, "brief": False, "input": 0, "cache_read": 0, "output": 0, "cost": 0.0, "max_input": 0, "llm_calls": 0, "idle": None, "tasks_created": 0, "tool_errors": 0}
    read_paths: set[str] = set()
    pending: dict[str, dict] = {}
    for line in session.read_text().splitlines():
        e = json.loads(line)
        if e.get("type") == "custom":
            if e.get("customType") == "accordion.pins" and e["data"].get("op") == "pin":
                m["pins"] += 1
            if e.get("customType") == "accordion.tasks.idle":
                m["idle"] = e["data"].get("state")
            continue
        msg = e.get("message") or {}
        if msg.get("role") == "assistant":
            u = msg.get("usage") or {}
            m["llm_calls"] += 1
            prompt = (u.get("input") or 0) + (u.get("cacheRead") or 0)
            m["input"] += u.get("input") or 0
            m["cache_read"] += u.get("cacheRead") or 0
            m["output"] += u.get("output") or 0
            m["cost"] += (u.get("cost") or {}).get("total") or 0
            m["max_input"] = max(m["max_input"], prompt)
            for c in msg.get("content") or []:
                if c.get("type") != "toolCall":
                    continue
                name, args = c["name"], c.get("arguments") or {}
                m["calls"] += 1
                m["tools"][name] = m["tools"].get(name, 0) + 1
                pending[c["id"]] = {"name": name, "args": args}
                if name in ("recall", "unfold"):
                    m[name] += 1
                if name == "tasks" and args.get("action") in ("create", "claim") and str(args.get("brief") or "").strip():
                    m["brief"] = True
                if name == "tasks" and args.get("action") == "create":
                    m["tasks_created"] += 1
                if name == "read":
                    p = str(args.get("path", ""))
                    if p in read_paths:
                        m["rereads"] += 1
                    read_paths.add(p)
        elif msg.get("role") == "toolResult":
            call = pending.get(msg.get("toolCallId"), {})
            if msg.get("isError"):
                m["tool_errors"] += 1
                if call.get("name") == "tasks" and (call.get("args") or {}).get("action") == "pin":
                    m["pin_errors"] += 1
    return m


def grade(fixture: str, repo: Path) -> dict:
    base = HERE / "fixtures" / fixture
    work = repo.parent / "grade"
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(repo, work, ignore=shutil.ignore_patterns(".git", ".pig", "__pycache__", ".pytest_cache"))
    shutil.copy(base / "hidden" / "test_hidden.py", work / "tests" / "test_zz_hidden.py")
    env = {**os.environ, "PATH": f"{VENV}:{os.environ['PATH']}"}
    try:
        r = sh([str(VENV / "python3"), "-m", "pytest", "-q", "-p", "no:cacheprovider", "-rN"], work, env, timeout=120)
        out = r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        out = "TIMEOUT"
    hidden = sh([str(VENV / "python3"), "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_zz_hidden.py"], work, env, timeout=120) if out != "TIMEOUT" else None
    sys.path.insert(0, str(base / "hidden"))
    import importlib

    constraints = importlib.import_module("constraints")
    importlib.reload(constraints)
    sys.path.pop(0)
    try:
        violations = constraints.check(repo, base / "repo")
    except Exception as err:  # a broken file is a failed run, not a harness crash
        violations = {"grader_error": [str(err)]}
    hidden_out = (hidden.stdout + hidden.stderr) if hidden else "TIMEOUT"
    last = [line for line in hidden_out.splitlines() if "passed" in line or "failed" in line or "error" in line]
    passed = failed = 0
    if last:
        import re

        passed = int((re.search(r"(\d+) passed", last[-1]) or [0, 0])[1])
        failed = int((re.search(r"(\d+) failed", last[-1]) or [0, 0])[1]) + int((re.search(r"(\d+) error", last[-1]) or [0, 0])[1])
    total = passed + failed
    return {
        "suite_ok": "failed" not in out and "error" not in out.lower().split("passed")[-1] and "passed" in out,
        "hidden_passed": passed,
        "hidden_total": total if total else None,
        "violations": {k: v for k, v in violations.items() if v},
        "violation_count": sum(1 for v in violations.values() if v),
    }


def run(fixture: str, arm: str, rep: int, budget: str, protect: str, cap: float) -> dict | None:
    global spent
    with lock:
        if spent > cap:
            return None
    rid = f"{fixture}-{arm}-{rep}"
    d = SCRATCH / rid
    shutil.rmtree(d, ignore_errors=True)
    (d / "home" / ".accordion").mkdir(parents=True)
    (d / "sess").mkdir()
    shutil.copytree(HERE / "fixtures" / fixture / "repo", d / "repo")
    (d / "home" / ".accordion" / "config.json").write_text(json.dumps(config(arm, budget, protect)))
    sh(["git", "init", "-q"], d / "repo")
    sh(["git", "add", "-A"], d / "repo")
    sh(["git", "-c", "user.email=t2@local", "-c", "user.name=t2", "commit", "-qm", "fixture"], d / "repo")
    prompt = (HERE / "fixtures" / fixture / "prompt.txt").read_text().strip()
    env = {**os.environ, "ACCORDION_HOME": str(d / "home"), "PATH": f"{VENV}:{os.environ['PATH']}"}
    t0 = time.time()
    cmd = ["pig", "-p", "--session-dir", str(d / "sess"), "-ne", "-ns", "-nc", "-np", "--no-mcp", "--offline", "-e", str(EXT), "--model", MODEL, prompt]
    try:
        r = subprocess.run(cmd, cwd=d / "repo", env=env, capture_output=True, text=True, timeout=1500)
        status = f"exit {r.returncode}"
        tail = (r.stdout + r.stderr)[-1500:]
    except subprocess.TimeoutExpired as err:
        status = "timeout"
        tail = str(err.stdout or "")[-1500:] if err.stdout else ""
    wall = time.time() - t0
    sessions = sorted((d / "sess").glob("*.jsonl"))
    m = metrics(sessions[0]) if sessions else {}
    g = grade(fixture, d / "repo")
    res = {"id": rid, "fixture": fixture, "arm": arm, "rep": rep, "options": ARMS[arm], "budget": budget, "protect": protect, "status": status, "wall_s": round(wall), **m, **g, "tail": tail}
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / f"{rid}.json").write_text(json.dumps(res, indent=2))
    if sessions:
        with gzip.open(EVIDENCE / f"{rid}.session.jsonl.gz", "wt") as f:
            f.write(sessions[0].read_text())
    with lock:
        spent += m.get("cost", 0.0)
        print(f"{rid:24} {status:8} {wall:5.0f}s hidden {g['hidden_passed']}/{g['hidden_total']} viol {g['violation_count']} calls {m.get('calls')} maxctx {m.get('max_input')} cost ${m.get('cost', 0):.3f} total ${spent:.2f}", flush=True)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--rep-start", type=int, default=1)
    ap.add_argument("--arms", default="A,C,CD,CP,AP")
    ap.add_argument("--fixtures", default="ratelimit,invoices")
    ap.add_argument("--jobs", type=int, default=5)
    ap.add_argument("--cap", type=float, default=8.0)
    ap.add_argument("--budget", default="40k")
    ap.add_argument("--protect", default="6k")
    a = ap.parse_args()
    jobs = [(f, arm, rep) for rep in range(a.rep_start, a.rep_start + a.reps) for f in a.fixtures.split(",") for arm in a.arms.split(",")]
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        for fut in [ex.submit(run, f, arm, rep, a.budget, a.protect, a.cap) for f, arm, rep in jobs]:
            fut.result()
    print(f"spent ${spent:.2f}")


if __name__ == "__main__":
    main()
