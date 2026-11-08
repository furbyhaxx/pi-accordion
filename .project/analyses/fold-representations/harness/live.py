#!/usr/bin/env python3
"""Live Taskfold run on deepseek-flash through a logging proxy.

usage: live.py <out-dir> [--cap USD]
Runs two print-mode turns of the worktree's extension in an isolated agent dir, then writes
analysis.json: tool-result shapes, fold carriers, per-request prefix stability and cache use.
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[4]
CLI = ROOT / "extension/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
HERE = pathlib.Path(__file__).resolve().parent

PROMPT1 = """Use the tasks tool for all of this work. Create a list "survey" with the goal "Summarize the four notes". Tasks: 1 "Notes A and B" with subtasks 1.1 "Read a.txt" and 1.2 "Read b.txt"; 2 "Notes C and D" with subtasks 2.1 "Read c.txt" and 2.2 "Read d.txt". Work strictly in order: start a task, read its file with the read tool, then complete it with a one-sentence outcome. Complete a parent when all its subtasks are done. When everything is done, reply with a two-line summary."""
PROMPT2 = """Two things. First, from now on every summary you write must be in French and must never mention file names. Second, add a task 3 "Final digest" to the list, start it, recall what tasks 1 and 2 found (use recall on their fold codes if you do not remember), and complete it with a one-sentence digest."""

def run(cmd, env, cwd):
    return subprocess.run(cmd, env=env, cwd=cwd, capture_output=True, text=True, timeout=900)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("out"); ap.add_argument("--cap", default="2.0"); a = ap.parse_args()
    out = pathlib.Path(a.out).resolve(); shutil.rmtree(out, ignore_errors=True); out.mkdir(parents=True)
    work, cfg, sess, log = out / "work", out / "cfg", out / "session", out / "requests"
    for d in (work, cfg, sess): d.mkdir()
    (cfg / "accordion/.accordion").mkdir(parents=True)
    for n, t in zip("abcd", ["Alpha is the first letter and the codename of the intake service.", "Beta covers retries: three attempts, exponential backoff starting at 200 ms.", "Gamma is the audit log; entries are append-only and signed.", "Delta is the cleanup job that runs nightly at 02:00 UTC."]):
        (work / f"{n}.txt").write_text(t + "\n")
    proxy = subprocess.Popen([sys.executable, str(HERE / "live-proxy.py"), str(log), a.cap], stdout=subprocess.PIPE, text=True)
    port = proxy.stdout.readline().strip()
    (cfg / "models.json").write_text(json.dumps({"providers": {"deepseek": {"baseUrl": f"http://127.0.0.1:{port}", "apiKey": "proxy-only"}}}))
    (cfg / "settings.json").write_text("{}")
    (cfg / "accordion/.accordion/config.json").write_text(json.dumps({"autoArm": True, "defaultConductor": "taskfold", "doorPort": 0, "privacyConsent": {"taskfold": "2026-11-08T00:00:00.000Z"}, "modelDefaults": {"deepseek/*": {"budget": "12k", "protect": "2k"}}}))
    env = {"PATH": os.environ["PATH"], "HOME": str(out), "PI_CODING_AGENT_DIR": str(cfg), "ACCORDION_HOME": str(cfg / "accordion")}
    base = ["node", str(CLI), "--no-extensions", "--no-skills", "--no-mcp", "--no-context-files", "--tools", "read,tasks,recall,unfold", "--provider", "deepseek", "--model", "deepseek-flash", "--thinking", "off", "--session-dir", str(sess), "-e", str(ROOT / "extension/accordion.ts"), "--mode", "json", "-p"]
    t0 = time.time(); codes = []
    for i, prompt in enumerate([PROMPT1, PROMPT2]):
        p = run(base + (["-c"] if i else []) + [prompt], env, work)
        (out / f"turn{i+1}.jsonl").write_text(p.stdout); (out / f"turn{i+1}.stderr").write_text(p.stderr); codes.append(p.returncode)
    proxy.terminate()
    print(json.dumps({"exit": codes, "wall_s": round(time.time() - t0), "out": str(out)}))

if __name__ == "__main__": main()
