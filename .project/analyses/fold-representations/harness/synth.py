#!/usr/bin/env python3
"""Synthetic Pi session: nested task tree with configurable shape. Usage: synth.py out.jsonl roots kids grandkids calls tokens"""
import json, sys, itertools
out, roots, kids, gk, calls, tok = sys.argv[1], *map(int, sys.argv[2:])
ids, prev, n = itertools.count(), [None], itertools.count()
lines = []
def ent(msg):
    i = f"e{next(ids)}"; lines.append({"type": "message", "id": i, "parentId": prev[0], "message": msg}); prev[0] = i
def call(name, args, out):
    c = f"c{next(n)}"
    ent({"role": "assistant", "content": [{"type": "thinking", "thinking": "plan " * 40}, {"type": "toolCall", "id": c, "name": name, "arguments": args}]})
    ent({"role": "toolResult", "toolCallId": c, "toolName": name, "content": [{"type": "text", "text": out}], "isError": False})
def leaf(tid):
    call("tasks", {"action": "start", "list": "w", "id": tid}, f"Started w/{tid}.")
    for k in range(calls):
        if k % 2: call("edit", {"path": f"src/{tid}/f{k}.ts"}, "ok")
        else: call("bash", {"command": f"bun test {tid} #{k}"}, ("line " * (tok // 1)))
    call("tasks", {"action": "complete", "list": "w", "id": tid, "report": {"outcome": f"Did {tid} fully with all checks passing.", "decisions": [f"choice for {tid} — reason"]}}, "ok")
ent({"role": "user", "content": "Do the work."})
for r in range(1, roots + 1):
    for k in range(1, kids + 1):
        if gk:
            for g in range(1, gk + 1): leaf(f"{r}.{k}.{g}")
            call("tasks", {"action": "complete", "list": "w", "id": f"{r}.{k}", "report": {"outcome": f"Finished {r}.{k}."}}, "ok")
        else: leaf(f"{r}.{k}")
        if k == 2: ent({"role": "user", "content": f"Also remember constraint {r}."})
    call("tasks", {"action": "complete", "list": "w", "id": str(r), "report": {"outcome": f"Root {r} delivered."}}, "ok")
ent({"role": "assistant", "content": [{"type": "text", "text": "Done."}]})
with open(out, "w") as f:
    for l in lines: f.write(json.dumps(l) + "\n")
