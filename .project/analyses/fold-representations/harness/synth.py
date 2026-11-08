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
VERBS = ["Parse", "Validate", "Cache", "Index", "Render", "Migrate", "Export", "Sign", "Retry", "Throttle"]
NOUNS = ["config loader", "token store", "session table", "invoice model", "audit log", "search index", "webhook queue", "user profile", "rate limiter", "report builder", "image cache", "billing job"]
import random as _r
_COMBOS = [f"{v} {n}" for v in VERBS for n in NOUNS]; _r.Random(3).shuffle(_COMBOS); _T = {}
def title(tid):
    if tid not in _T: _T[tid] = _COMBOS[len(_T) % len(_COMBOS)]
    return _T[tid]
def leaf(tid):
    parents = [".".join(tid.split(".")[:d]) for d in range(1, tid.count(".") + 1)]
    call("tasks", {"action": "start", "list": "w", "id": tid}, f'Started w/{tid} "{title(tid)}".' + "".join(f'\nAlso started parent {p} "{title(p)}" so its span covers this subtask.' for p in parents if tid.endswith(".1") and (p == parents[-1] or tid.split(".")[len(p.split("."))] == "1")))
    for k in range(calls):
        if k % 2: call("edit", {"path": f"src/{tid}/f{k}.ts"}, "ok")
        else: call("bash", {"command": f"bun test src/{tid}/f{k}.test.ts"}, f"bun test src/{tid}/f{k}.test.ts\n" + "".join(f"  ok {n} case {tid}-{k}-{n}\n" for n in range(tok // 8)))
    call("tasks", {"action": "complete", "list": "w", "id": tid, "report": {"outcome": f"{title(tid)} now handles empty input and passes its {calls} checks.", "decisions": [f"streaming parser for {tid} — avoids loading whole files"]}}, f'w/{tid} "{title(tid)}" is done.')
ent({"role": "user", "content": "Do the work."})
for r in range(1, roots + 1):
    for k in range(1, kids + 1):
        if gk:
            for g in range(1, gk + 1): leaf(f"{r}.{k}.{g}")
            call("tasks", {"action": "complete", "list": "w", "id": f"{r}.{k}", "report": {"outcome": f"{title(f'{r}.{k}')} complete across all subtasks."}}, f'w/{r}.{k} "{title(f"{r}.{k}")}" is done.')
        else: leaf(f"{r}.{k}")
        if k == 2: ent({"role": "user", "content": f"Also remember constraint {r}."})
    call("tasks", {"action": "complete", "list": "w", "id": str(r), "report": {"outcome": f"{title(str(r))} delivered end to end."}}, f'w/{r} "{title(str(r))}" is done.')
ent({"role": "assistant", "content": [{"type": "text", "text": "Done."}]})
# leave the last root open: re-open it with an unfinished leaf so cuts have a doing branch
r = roots + 1
call("tasks", {"action": "start", "list": "w", "id": f"{r}.1"}, f'Started w/{r}.1 "{title(f"{r}.1")}".\nAlso started parent {r} "{title(str(r))}" so its span covers this subtask.')
call("bash", {"command": f"bun test src/{r}.1"}, "1 failing")
with open(out, "w") as f:
    for l in lines: f.write(json.dumps(l) + "\n")
