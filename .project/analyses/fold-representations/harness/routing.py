#!/usr/bin/env python3
"""User-message routing eval: how reliably do durable instructions in a user message reach the task list?

Arms
  A0  agent alone: sees the list and the message, must update the list itself (today's behaviour)
  A   sidecar extracts ops, injects them as a proposal; the agent applies them with `tasks`
  B   sidecar extracts ops and the extension applies them directly (score = extractor output)
  C   sidecar applies safe ops (verbatim pins, attachments) directly, proposes the rest to the agent

Usage: routing.py <corpus.json> <out-dir> [--reps N] [--workers N]; routing.py score <out-dir>
Ops: {"op": "+|-|~", "kind": "goal|task|criterion|pin|attach", "target": "list|<task id>", "value": "..."}
"""
import argparse, concurrent.futures as cf, json, os, re, sys, time

MODEL, URL = "deepseek-flash", "https://api.deepseek.com/chat/completions"
J = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))

def post(key, body, tries=4):
    import requests
    err = None
    for k in range(tries):
        try:
            r = requests.post(URL, headers={"Authorization": f"Bearer {key}"}, json={"model": MODEL, **body}, timeout=300)
            if r.status_code == 200: return r.json()
            err = r.text[:300]
        except Exception as e: err = str(e)
        time.sleep(5 * (k + 1))
    return {"error": err}

EXTRACT = """You maintain a coding agent's persistent task list. Given the list, the agent's last turn and a new user message, decide which durable changes the message makes to the list.
Change kinds: goal (list goals), task (add/remove/rename), criterion (a task's acceptance criteria), pin (a constraint, fact or decision that must survive; text MUST be copied verbatim from the user message), attach (a file, section, symbol or URL the work must use).
Only record what the user actually asked for or stated as lasting. Questions, approvals ("ok", "go ahead"), chit-chat and one-off instructions for the next step produce no ops.
Answer JSON: {"class":"chat|answer|directive|correction|scope-change","ops":[{"op":"+|-|~","kind":"goal|task|criterion|pin|attach","target":"list|<task id>","value":"<text, ref or new title>","pinKind":"constraint|fact|decision"}]}
target: for task "+" the parent id (or "list" for a root); for "-"/"~" the item's own task id; goals are always "list"."""

AGENT_SYS = """You are a coding agent. You track work in a persistent task list with the `tasks` tool. The list (goals, tasks, acceptance criteria, pins, attachments) is what survives when your context is folded: anything the user wants to last must be in it.
Keep it current: when the user adds, removes or changes goals, tasks, criteria, constraints or reference material, update the list with `tasks` before continuing. Do not record questions, approvals or chit-chat."""

TASKS_TOOL = {"type": "function", "function": {"name": "tasks", "description": "Task list. Actions: status; add {parent?, tasks:[{title, acceptanceCriteria?}]} (parent omitted = root); update {id?, title?, goals? (list only, full new array), acceptanceCriteria? (task, full new array)}; abandon {id, report:{outcome}}; pin {id? (omit = list), items:[{kind: constraint|fact|decision, text, source}]}; unpin {id?, pins:[ids]}; attach {id?, items:[{ref, note?}]} (ref = path, path#Section, path::symbol or URL); detach {id?, attachments:[ids]}; start/complete as usual.",
    "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "list": {"type": "string"}, "id": {"type": "string"}, "parent": {"type": "string"}, "title": {"type": "string"}, "goals": {"type": "array", "items": {"type": "string"}}, "acceptanceCriteria": {"type": "array", "items": {"type": "string"}}, "tasks": {"type": "array", "items": {"type": "object"}}, "items": {"type": "array", "items": {"type": "object"}}, "pins": {"type": "array", "items": {"type": "string"}}, "attachments": {"type": "array", "items": {"type": "string"}}, "report": {"type": "object"}}, "required": ["action"]}}}
OTHER = [{"type": "function", "function": {"name": n, "description": d, "parameters": {"type": "object", "properties": {p: {"type": "string"}}, "required": [p]}}} for n, d, p in (("bash", "Run a shell command.", "command"), ("read", "Read a file.", "path"))]

def find(lst, tid):
    for t in lst["tasks"]:
        if t["id"] == tid: return t
    return None

def agent_ops(lst, calls):
    """Translate the agent's tasks calls into normalized ops by diffing against the list."""
    ops = []
    for name, a in calls:
        if name != "tasks": continue
        act, tid = a.get("action"), a.get("id")
        if act == "add":
            for t in a.get("tasks") or [{}]: ops.append({"op": "+", "kind": "task", "target": a.get("parent") or "list", "value": t.get("title", "")})
        elif act == "abandon" and tid: ops.append({"op": "-", "kind": "task", "target": tid})
        elif act == "update":
            if a.get("title") and tid: ops.append({"op": "~", "kind": "task", "target": tid, "value": a["title"]})
            if a.get("goals") is not None: ops += diff("goal", "list", lst.get("goals", []), a["goals"])
            if a.get("acceptanceCriteria") is not None and tid:
                old = (find(lst, tid) or {}).get("criteria", [])
                ops += diff("criterion", tid, [c["text"] for c in old], a["acceptanceCriteria"])
        elif act in ("pin", "attach"):
            for it in a.get("items") or [{}]:
                ops.append({"op": "+", "kind": act, "target": tid or "list", "value": it.get("text") or it.get("ref") or it.get("path") or ""})
        elif act in ("unpin", "detach"):
            for _ in a.get("pins") or a.get("attachments") or [None]: ops.append({"op": "-", "kind": "pin" if act == "unpin" else "attach", "target": tid or "list"})
    return ops

def diff(kind, target, old, new):
    txt = lambda s: s.get("text") or s.get("title") or J(s) if isinstance(s, dict) else str(s)
    old, new = [txt(x) for x in old], [txt(x) for x in new]
    norm = lambda s: re.sub(r"\W+", " ", s.lower()).strip()
    o, n = [norm(x) for x in old], [norm(x) for x in new]
    added = [x for x, k in zip(new, n) if k not in o]
    removed = [x for x, k in zip(old, o) if k not in n]
    ops = []
    while added and removed: ops.append({"op": "~", "kind": kind, "target": target, "value": added.pop(0)}); removed.pop(0)
    ops += [{"op": "+", "kind": kind, "target": target, "value": x} for x in added]
    ops += [{"op": "-", "kind": kind, "target": target, "value": x} for x in removed]
    return ops

def verbatim(op, msg):
    n = lambda s: re.sub(r"\s+", " ", s.lower()).strip(" .\"'")
    return op["kind"] != "pin" or op["op"] != "+" or (n(op.get("value", "")) and n(op["value"]) in n(msg))

def safe(op, msg):
    return op["op"] == "+" and op["kind"] in ("pin", "attach") and verbatim(op, msg)

def extract(key, item):
    body = {"messages": [{"role": "system", "content": EXTRACT}, {"role": "user", "content": J({"list": item["list"], "agentLastTurn": item["last"], "userMessage": item["msg"]})}], "response_format": {"type": "json_object"}, "max_tokens": 4000}
    r = post(key, body)
    try: out = json.loads(r["choices"][0]["message"]["content"])
    except Exception: out = {"ops": [], "error": str(r.get("error"))[:200]}
    return out, r.get("usage", {})

def agent(key, item, note):
    lst = item["list"]
    msgs = [{"role": "system", "content": AGENT_SYS},
            {"role": "user", "content": item.get("request", "Implement the work in the task list.")},
            {"role": "assistant", "content": None, "reasoning_content": "", "tool_calls": [{"id": "s0", "type": "function", "function": {"name": "tasks", "arguments": J({"action": "status", "list": lst["list"]})}}]},
            {"role": "tool", "tool_call_id": "s0", "content": J({"ok": True, **lst})},
            {"role": "assistant", "content": item["last"], "reasoning_content": ""},
            {"role": "user", "content": item["msg"] + (f"\n\n[accordion] {note}" if note else "")}]
    calls, usage = [], {}
    for _ in range(3):
        r = post(key, {"messages": msgs, "tools": [TASKS_TOOL] + OTHER, "max_tokens": 4000})
        for k, v in (r.get("usage") or {}).items():
            if isinstance(v, int): usage[k] = usage.get(k, 0) + v
        if "choices" not in r: break
        m = r["choices"][0]["message"]; tcs = m.get("tool_calls") or []
        if not tcs: break
        msgs.append({"role": "assistant", "content": m.get("content"), "reasoning_content": m.get("reasoning_content") or "", "tool_calls": [{"id": t["id"], "type": "function", "function": t["function"]} for t in tcs]})
        stop = False
        for t in tcs:
            n = t["function"]["name"]
            try: a = json.loads(t["function"]["arguments"] or "{}")
            except Exception: a = {}
            calls.append((n, a))
            if n != "tasks": stop = True
            msgs.append({"role": "tool", "tool_call_id": t["id"], "content": J({"ok": True}) if n == "tasks" else J({"ok": False, "error": "unavailable in this evaluation"})})
        if stop: break
    return calls, usage

def run_item(key, item, rep):
    ex, u1 = extract(key, item)
    ops = [o for o in ex.get("ops", []) if isinstance(o, dict)]
    res = {"id": item["id"], "rep": rep, "extract": ex, "usage": {}}
    def add(u):
        for k, v in u.items():
            if isinstance(v, int): res["usage"][k] = res["usage"].get(k, 0) + v
    add(u1)
    res["B"] = ops
    c0, u = agent(key, item, None); add(u); res["A0"] = agent_ops(item["list"], c0); res["A0_calls"] = c0
    note = J({"proposed": ops}) + " — list changes derived from this message. Apply them with `tasks` (skip any you disagree with), then continue." if ops else None
    ca, u = agent(key, item, note); add(u); res["A"] = agent_ops(item["list"], ca); res["A_calls"] = ca
    applied = [o for o in ops if safe(o, item["msg"])]; rest = [o for o in ops if not safe(o, item["msg"])]
    parts = []
    if applied: parts.append(J({"applied": applied}) + " — already recorded in the list.")
    if rest: parts.append(J({"proposed": rest}) + " — apply these with `tasks` (skip any you disagree with).")
    cc, u = agent(key, item, " ".join(parts) + " Then continue." if parts else None); add(u)
    res["C"] = applied + agent_ops(item["list"], cc); res["C_calls"] = cc
    return res

# ---------- scoring ----------

def matches(g, p):
    kinds = g["kind"] if isinstance(g["kind"], list) else [g["kind"]]
    ops = g["op"] if isinstance(g["op"], list) else [g["op"]]
    if p.get("kind") not in kinds or p.get("op") not in ops: return False
    t = g.get("target")
    if t in (None, "any"): return True
    ts = t if isinstance(t, list) else [t]
    return str(p.get("target", "list")).split("/")[-1] in ts

def owner(lst, ref):
    """Resolve an item id (p1, a1, c1, g1) used as a target to the list or task that owns it."""
    if not re.fullmatch(r"[pacg]\d+", str(ref)): return ref
    if any(p.get("id") == ref for p in lst.get("pins", [])): return "list"
    for t in lst["tasks"]:
        if any(x.get("id") == ref for x in t.get("criteria", []) + t.get("attachments", []) + t.get("pins", [])): return t["id"]
    return "list"

def score_item(gold, pred, msg, lst):
    pred = [dict(p, target=owner(lst, p.get("target", "list"))) for p in pred if isinstance(p, dict)]
    req = [g for g in gold if not g.get("optional")]
    used, hit = set(), 0
    for g in req:
        for i, p in enumerate(pred):
            if i not in used and matches(g, p): used.add(i); hit += 1; break
    for g in gold:
        if g.get("optional"):
            for i, p in enumerate(pred):
                if i not in used and matches(g, p): used.add(i)
    fp = len(pred) - len(used)
    exact = hit == len(req) and fp == 0
    pins = [p for p in pred if p.get("kind") == "pin" and p.get("op") == "+"]
    return {"tp": hit, "req": len(req), "fp": fp, "exact": exact, "pins": len(pins), "pins_verbatim": sum(1 for p in pins if verbatim(p, msg))}

def score(args):
    corpus = {it["id"]: it for it in json.load(open(os.path.join(args.out, "corpus.json")))}
    agg, usage = {}, {}
    for f in sorted(os.listdir(args.out)):
        if not f.startswith("res-"): continue
        r = json.load(open(os.path.join(args.out, f))); it = corpus[r["id"]]
        for k, v in r["usage"].items(): usage[k] = usage.get(k, 0) + v
        for arm in ("A0", "A", "B", "C"):
            s = score_item(it["gold"], r[arm], it["msg"], it["list"])
            a = agg.setdefault(arm, {"tp": 0, "req": 0, "fp": 0, "exact": 0, "n": 0, "neg_ok": 0, "neg": 0, "pins": 0, "pins_verbatim": 0})
            for k in ("tp", "req", "fp", "pins", "pins_verbatim"): a[k] += s[k]
            a["exact"] += s["exact"]; a["n"] += 1
            if not [g for g in it["gold"] if not g.get("optional")]: a["neg"] += 1; a["neg_ok"] += s["fp"] == 0
        # apply rate of proposals in A
        ops = [o for o in r["B"] if isinstance(o, dict)]
        if ops:
            a = agg.setdefault("_apply", {"proposed": 0, "applied": 0})
            a["proposed"] += len(ops)
            pa = list(r["A"])
            for o in ops:
                for i, p in enumerate(pa):
                    if p.get("kind") == o.get("kind") and p.get("op") == o.get("op"): pa.pop(i); a["applied"] += 1; break
    print("arm | items | recall | precision | exact items | no-op items kept clean | pins verbatim")
    for arm in ("A0", "A", "B", "C"):
        a = agg[arm]; pp = a["tp"] + a["fp"]
        print(f"{arm} | {a['n']} | {a['tp']/max(1,a['req']):.2f} ({a['tp']}/{a['req']}) | {a['tp']/max(1,pp):.2f} | {a['exact']/a['n']:.2f} | {a['neg_ok']}/{a['neg']} | {a['pins_verbatim']}/{a['pins']}")
    ap = agg.get("_apply", {"proposed": 0, "applied": 0})
    print(f"\nA: agent applied {ap['applied']}/{ap['proposed']} proposed ops ({ap['applied']/max(1,ap['proposed']):.2f})")
    print("usage:", J(usage))

def run(args):
    key = json.load(open(os.path.expanduser("~/.pig/agent/auth.json")))["deepseek"]["key"]
    corpus = json.load(open(args.corpus)); os.makedirs(args.out, exist_ok=True)
    json.dump(corpus, open(os.path.join(args.out, "corpus.json"), "w"))
    jobs = [(it, r) for r in range(args.reps) for it in corpus if not os.path.exists(os.path.join(args.out, f"res-{it['id']}-{r}.json"))]
    print(f"{len(jobs)} items")
    def go(j):
        it, r = j
        try: res = run_item(key, it, r)
        except Exception as e: print("item failed", it["id"], r, e); return
        json.dump(res, open(os.path.join(args.out, f"res-{it['id']}-{r}.json"), "w"))
    with cf.ThreadPoolExecutor(args.workers) as ex: list(ex.map(go, jobs))

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "score":
        ap = argparse.ArgumentParser(); ap.add_argument("cmd"); ap.add_argument("out"); score(ap.parse_args()); return
    ap = argparse.ArgumentParser(); ap.add_argument("corpus"); ap.add_argument("out"); ap.add_argument("--reps", type=int, default=2); ap.add_argument("--workers", type=int, default=8)
    run(ap.parse_args())

if __name__ == "__main__": main()
