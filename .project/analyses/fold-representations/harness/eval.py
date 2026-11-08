#!/usr/bin/env python3
"""Live comprehension eval of folded-task representations.

Usage:
  eval.py build <session.jsonl> <out-dir> [--cuts N]      render contexts per representation (no network)
  eval.py run <out-dir> [--reps S,B,...] [--limit N]       send probes to deepseek-flash, store raw replies
  eval.py score <out-dir>                                  score replies, print table

Representations: S, B, T, BS (B->S), HR (root history on completion), HP (parent history on completion).
Every finished task is folded eagerly (at the request after it finished). Probes are scored from the
model's first reply only; tools are offered but never executed.
"""
import argparse, concurrent.futures as cf, hashlib, json, os, random, re, sys, time

REPS = ["S", "B", "T", "BS", "HR", "HP", "REAL"]
MODEL, URL = "deepseek-flash", "https://api.deepseek.com/chat/completions"

def code(key):
    return hashlib.sha1(key.encode()).hexdigest()[:6]

def tag(key):
    return "{#" + code(key) + " FOLDED}"

# ---------- session ----------

def load(path):
    entries = [json.loads(l) for l in open(path)]
    by_id = {e.get("id"): e for e in entries if e.get("id")}
    e = next(e for e in reversed(entries) if e.get("type") == "message")
    chain = []
    while e:
        chain.append(e); e = by_id.get(e.get("parentId"))
    msgs = []
    for e in reversed(chain):
        if e.get("type") != "message": continue
        m = e["message"]; role = m["role"]
        c = m.get("content")
        if role in ("user", "system"):
            text = c if isinstance(c, str) else "\n".join(p.get("text", "") for p in c or [] if p.get("type") == "text")
            msgs.append({"role": "user", "content": text})
        elif role == "assistant":
            text = "\n".join(p.get("text", "") for p in c or [] if p.get("type") == "text")
            calls = [{"id": p["id"], "name": p["name"], "arguments": p.get("arguments") or {}} for p in c or [] if p.get("type") == "toolCall"]
            msgs.append({"role": "assistant", "content": text, "calls": calls})
        elif role == "toolResult":
            text = "\n".join(p.get("text", "") for p in c or [] if p.get("type") == "text")
            msgs.append({"role": "tool", "content": text, "id": m.get("toolCallId"), "name": m.get("toolName"), "error": m.get("isError", False)})
    return msgs

def tasks_of(msgs):
    result_at = {m["id"]: i for i, m in enumerate(msgs) if m["role"] == "tool"}
    T, status = {}, {}
    def node(lst, tid, i):
        k = f"{lst}/{tid}"
        return T.setdefault(k, {"key": k, "id": tid, "title": "", "s": i, "e": None, "report": None, "status": "doing", "kids": []})
    for i, m in enumerate(msgs):
        for c in m.get("calls", []):
            if c["name"] != "tasks": continue
            a = c["arguments"]; act, lst, tid = a.get("action"), a.get("list"), a.get("id")
            ri = result_at.get(c["id"])
            if ri is None or msgs[ri]["error"] or not tid: continue
            out = msgs[ri]["content"]
            if act == "start":
                parts = tid.split(".")
                for d in range(1, len(parts) + 1):
                    sub = ".".join(parts[:d]); k = f"{lst}/{sub}"
                    if k not in T or status.get(k) == "todo": node(lst, sub, i); status[k] = "doing"
                    else: status[k] = "doing"
                for mt in re.finditer(r'(?:Started|parent) (?:\S+/)?([\d.]+) "([^"]*)"', out):
                    k = f"{lst}/{mt.group(1)}"
                    if k in T and not T[k]["title"]: T[k]["title"] = mt.group(2)
            elif act in ("complete", "fail", "abandon") and f"{lst}/{tid}" in T:
                t = T[f"{lst}/{tid}"]
                t.update(e=ri, report=a.get("report") or {}, status={"complete": "done", "fail": "failed", "abandon": "abandoned"}[act])
                mt = re.search(r'"([^"]+)"', out)
                if mt and not t["title"]: t["title"] = mt.group(1)
                status[t["key"]] = "fin"
    return T

def forest(T, a):
    """Tasks visible before request index a, nested by containment; finished ones crossing a parent stay raw."""
    vis = [dict(t, kids=[], fin=t["e"] is not None and t["e"] < a) for t in T.values() if t["s"] < a]
    vis.sort(key=lambda t: (t["s"], -(t["e"] if t["fin"] else 10**9)))
    roots, stack = [], []
    for t in vis:
        end = t["e"] if t["fin"] else 10**9
        while stack and (stack[-1]["e"] if stack[-1]["fin"] else 10**9) < t["s"]: stack.pop()
        if stack and end > (stack[-1]["e"] if stack[-1]["fin"] else 10**9): t["fin"] = False; t["crossing"] = True; continue
        t["parent"] = stack[-1]["key"] if stack else None
        (stack[-1]["kids"] if stack else roots).append(t); stack.append(t)
    return roots

def walk(ns):
    for n in ns:
        yield n; yield from walk(n["kids"])

# ---------- rendering ----------

def facts(msgs, t):
    inner = set()
    for k in t["kids"]:
        if k["fin"]: inner.update(range(k["s"], k["e"] + 1))
    changed, verified = [], []
    for i in range(t["s"], t["e"] + 1):
        if i in inner: continue
        for c in msgs[i].get("calls", []):
            a = c["arguments"]
            if c["name"] in ("edit", "write") and a.get("path") and a["path"] not in changed: changed.append(a["path"])
            if c["name"] == "bash" and len(verified) < 6: verified.append(str(a.get("command", ""))[:100])
    return changed[:10], verified

def record(msgs, t, own_only=False):
    r = {"task": t["key"], "title": t["title"], "status": t["status"], "recall": tag(t["key"])}
    if not own_only:
        for f in ("outcome", "decisions", "open"):
            if t["report"].get(f): r[f] = t["report"][f]
    ch, ve = facts(msgs, t)
    if ch: r["changed"] = ch
    if ve: r["verified"] = ve
    if not own_only and t["kids"]: r["children"] = [record(msgs, k) for k in t["kids"] if k["fin"]]
    return r

def history(t):
    n = {}
    for k in walk(t["kids"]): n[k["status"]] = n.get(k["status"], 0) + 1
    h = {"history": t["key"], "title": t["title"], "status": t["status"], "recall": tag(t["key"])}
    if n: h["subtasks"] = n
    if t["report"].get("outcome"): h["outcome"] = t["report"]["outcome"][:160]
    return h

J = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))

SEEN = set()

def emit_raw(msgs, i, out):
    # a start that auto-started ancestors opens several brackets with one call; emit it once
    if i in SEEN: return
    SEEN.add(i); out.append(dict(msgs[i]))

def emit_folded(msgs, t, rep, out, hist):
    if hist(t):
        out.append({"role": "assistant", "content": J(history(t)), "calls": []}); return
    r = rep
    if rep in ("HR", "HP"): r = "S"
    if rep == "BS": r = "S" if any(k["fin"] for k in t["kids"]) else "B"
    if r == "S":
        out.append({"role": "assistant", "content": J(record(msgs, t)), "calls": []})
    elif r == "T":
        cid = "fold_" + code(t["key"])
        out.append({"role": "assistant", "content": "", "calls": [{"id": cid, "name": "tasks", "arguments": {"action": "started-and-completed", "list": t["key"].split("/")[0], "id": t["id"]}}]})
        out.append({"role": "tool", "id": cid, "name": "tasks", "content": J(record(msgs, t))})
    else:  # B: original start pair, own work record, nested child brackets, original finish pair
        s, e = t["s"], t["e"]
        emit_raw(msgs, s, out)
        j = s + 1
        while j < e and msgs[j]["role"] == "tool": emit_raw(msgs, j, out); j += 1
        out.append({"role": "assistant", "content": J({"work": t["key"], **{k: v for k, v in record(msgs, t, own_only=True).items() if k in ("changed", "verified", "recall")}}), "calls": []})
        for k in t["kids"]:
            if k["fin"]: emit_folded(msgs, k, "B" if rep == "B" else rep, out, hist)
        f = e
        while f > s and msgs[f]["role"] == "tool": f -= 1
        for x in range(f, e + 1): emit_raw(msgs, x, out)

def render(msgs, lo, hi, nodes, rep, out, hist):
    i = lo
    for t in nodes:
        if t["s"] >= hi: break
        while i < t["s"]: emit_raw(msgs, i, out); i += 1
        if t["fin"]:
            emit_folded(msgs, t, rep, out, hist); i = t["e"] + 1; continue
        render(msgs, i, hi, t["kids"], rep, out, hist); i = hi if not t["fin"] else t["e"] + 1
    while i < hi: emit_raw(msgs, i, out); i += 1

def sanitize(out):
    """OpenAI pairing: every tool_call answered, no orphan tool messages, no empty assistant messages."""
    answered = {m["id"] for m in out if m["role"] == "tool"}
    called = set()
    res = []
    for m in out:
        if m["role"] == "assistant":
            calls = [c for c in m.get("calls", []) if c["id"] in answered]
            called.update(c["id"] for c in calls)
            if not calls and not m["content"].strip(): continue
            res.append(dict(m, calls=calls))
        elif m["role"] == "tool":
            if m["id"] in called: res.append(m)
        else: res.append(m)
    return res

def to_openai(out):
    res = []
    for m in out:
        if m["role"] == "assistant":
            o = {"role": "assistant", "content": m["content"] or None, "reasoning_content": ""}
            if m.get("calls"): o["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}} for c in m["calls"]]
            res.append(o)
        elif m["role"] == "tool":
            res.append({"role": "tool", "tool_call_id": m["id"], "content": m["content"][:60000]})
        else:
            res.append({"role": "user", "content": m["content"][:60000] or "(empty)"})
    # merge adjacent user messages (provider-safe)
    merged = []
    for m in res:
        if merged and m["role"] == "user" and merged[-1]["role"] == "user": merged[-1]["content"] += "\n\n" + m["content"]
        else: merged.append(m)
    return merged

SYSTEM = """You are a coding agent working in a repository. You track multi-step work with the `tasks` tool (persistent nested task list; ids like 3.2.1).
Finished tasks are folded: their raw work is replaced by a compact record or a one-line history entry. Each carries a recall code like {#abc123 FOLDED}. `recall(codes)` returns the full original content of that task, including its subtasks. Use recall instead of re-running or re-reading finished work. `tasks status` shows the live list.
Answer the user directly when the context already holds the answer; call a tool when it does not."""

TOOLS = [
    {"type": "function", "function": {"name": "tasks", "description": "Task list actions: status, start, complete, add, block, ...", "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "list": {"type": "string"}, "id": {"type": "string"}, "parent": {"type": "string"}, "after": {"type": "string"}, "tasks": {"type": "array", "items": {"type": "object", "properties": {"title": {"type": "string"}}}}}, "required": ["action"]}}},
    {"type": "function", "function": {"name": "recall", "description": "Read the full original content of folded context by its codes.", "parameters": {"type": "object", "properties": {"codes": {"type": "array", "items": {"type": "string"}}}, "required": ["codes"]}}},
    {"type": "function", "function": {"name": "bash", "description": "Run a shell command.", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {"name": "read", "description": "Read a file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "edit", "description": "Edit a file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "oldText": {"type": "string"}, "newText": {"type": "string"}}, "required": ["path"]}}},
]

# ---------- probes ----------

def probes(roots, rng):
    nodes = list(walk(roots))
    doing = [n for n in nodes if not n["fin"] and not n.get("crossing")]
    leaf = max(doing, key=lambda n: n["id"].count("."), default=None)
    fin = [n for n in nodes if n["fin"]]
    deep_done = [n for n in fin if n.get("parent")] or fin
    with_verify = [n for n in fin if n.get("_verified")] or deep_done
    P = []
    if leaf:
        P.append({"kind": "current", "q": "Which task are you working on right now, and what is its parent task? Give the ids.",
                  "gold": {"leaf": leaf["id"], "parent": (leaf.get("parent") or "").split("/")[-1]}})
    if deep_done:
        x = rng.choice(deep_done)
        P.append({"kind": "status", "q": f'Did task "{x["title"]}" get finished, and what was its outcome? Answer briefly.',
                  "gold": {"key": x["key"], "status": x["status"], "outcome": x["report"].get("outcome", ""), "codes": chain_codes(x, nodes)}})
    if with_verify:
        x = rng.choice(with_verify)
        P.append({"kind": "recall", "q": f'Show me the exact output of the checks you ran for task "{x["title"]}".',
                  "gold": {"key": x["key"], "codes": chain_codes(x, nodes), "own": code(x["key"])}})
    if leaf:
        P.append({"kind": "continue", "q": "Continue.", "gold": {"finished": [n["id"] for n in fin], "doing": [n["id"] for n in doing]}})
    if deep_done:
        x = rng.choice(deep_done)
        P.append({"kind": "place", "q": f'Task "{x["title"]}" needs one follow-up check. Add it as a new subtask of the same parent task that "{x["title"]}" belongs to, right after it.',
                  "gold": {"parent": (x.get("parent") or "").split("/")[-1], "after": x["id"], "codes": chain_codes(x, nodes)}})
    return P

def chain_codes(x, nodes):
    by = {n["key"]: n for n in nodes}; out = []; k = x["key"]
    while k:
        out.append(code(k)); k = by[k].get("parent") if k in by else None
    return out

# ---------- build ----------

def build(args):
    msgs = load(args.session); T = tasks_of(msgs)
    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(7)
    cand = []
    for a, m in enumerate(msgs):
        if m["role"] != "assistant" or a < 10: continue
        roots = forest(T, a)
        nodes = list(walk(roots))
        doing = [n for n in nodes if not n["fin"] and not n.get("crossing")]
        fin = [n for n in nodes if n["fin"]]
        if doing and max(n["id"].count(".") for n in doing) >= 1 and len([n for n in fin if n.get("parent")]) >= 3 and any(not r["fin"] for r in roots) and any(r["fin"] for r in roots):
            cand.append(a)
    if not cand:
        for a, m in enumerate(msgs):
            if m["role"] == "assistant" and a > 10:
                nodes = list(walk(forest(T, a)))
                if any(not n["fin"] for n in nodes) and len([n for n in nodes if n["fin"]]) >= 3: cand.append(a)
    cuts = [cand[int(i * (len(cand) - 1) / max(1, args.cuts - 1))] for i in range(args.cuts)] if cand else []
    cuts = sorted(set(cuts))
    n = 0
    for a in cuts:
        roots = forest(T, a)
        for t in walk(roots):
            if t["fin"]: t["_verified"] = bool(facts(msgs, t)[1])
        P = probes(roots, rng)
        for rep in REPS:
            def hist(t, rep=rep):
                if rep == "HR": return t.get("parent") is None
                if rep == "HP": return bool(t["kids"])
                return False
            out = []; SEEN.clear(); render(msgs, 0, a, roots, rep, out, hist)
            ctx = to_openai(sanitize(out))
            nodes = list(walk(roots))
            listing = {"ok": True, "tasks": [{"id": n["id"], "title": n["title"], "status": n["status"] if n["fin"] else "doing"} for n in sorted(nodes, key=lambda n: [int(x) for x in n["id"].split(".")])]}
            recalls = {code(n["key"]): J(record(msgs, n)) for n in nodes if n["fin"]}
            json.dump({"session": os.path.basename(args.session), "cut": a, "rep": rep, "messages": ctx, "probes": P, "listing": listing, "recalls": recalls},
                      open(os.path.join(args.out, f"ctx-{os.path.basename(args.session)[:12]}-{a}-{rep}.json"), "w"))
            n += 1
    print(f"{len(cuts)} cuts x {len(REPS)} reps = {n} contexts in {args.out}")

# ---------- run ----------

def call(key, messages, tries=4):
    import requests
    for k in range(tries):
        try:
            r = requests.post(URL, headers={"Authorization": f"Bearer {key}"}, json={"model": MODEL, "messages": messages, "tools": TOOLS, "max_tokens": 4000}, timeout=300)
            j = r.json()
            if r.status_code == 200: return j
            err = j.get("error")
        except Exception as e:
            err = str(e)
        time.sleep(5 * (k + 1))
    return {"error": err}

def run(args):
    key = json.load(open(os.path.expanduser("~/.pig/agent/auth.json")))["deepseek"]["key"]
    reps = args.reps.split(",") if args.reps else REPS
    jobs = []
    for f in sorted(os.listdir(args.out)):
        if not f.startswith("ctx-"): continue
        c = json.load(open(os.path.join(args.out, f)))
        if c["rep"] not in reps: continue
        for i, p in enumerate(c["probes"]):
            o = os.path.join(args.out, f.replace("ctx-", "ans-").replace(".json", f"-{i}.json"))
            if not os.path.exists(o): jobs.append((c, i, p, o))
    if args.limit: jobs = jobs[: args.limit]
    print(f"{len(jobs)} requests")
    def emulate(c, name, a):
        if name == "tasks" and a.get("action") in ("status", "list"): return J(c["listing"])
        if name == "recall":
            got = [c["recalls"][cd] for x in a.get("codes", []) for cd in re.findall(r"[0-9a-f]{6}", str(x)) if cd in c["recalls"]]
            return "\n".join(got) if got else J({"ok": False, "error": "not_found"})
        return J({"ok": False, "error": "unavailable in this evaluation"})
    def go(job):
        c, i, p, o = job
        msgs = [{"role": "system", "content": SYSTEM}] + c["messages"] + [{"role": "user", "content": p["q"]}]
        steps, usage = [], {}
        for step in range(args.steps):
            j = call(key, msgs)
            for k, v in (j.get("usage") or {}).items():
                if isinstance(v, int): usage[k] = usage.get(k, 0) + v
            steps.append(j)
            if "choices" not in j: break
            m = j["choices"][0]["message"]; tcs = m.get("tool_calls") or []
            # stop once the probe's decisive action happened or the model answered
            names = [(t["function"]["name"], json.loads(t["function"]["arguments"] or "{}")) for t in tcs]
            if not tcs or any(n in ("recall", "bash", "read", "edit") or (n == "tasks" and a.get("action") not in ("status", "list")) for n, a in names) and not (p["kind"] in ("status", "current") and all(n == "recall" for n, _ in names)): break
            msgs.append({"role": "assistant", "content": m.get("content"), "reasoning_content": m.get("reasoning_content") or "", "tool_calls": [{"id": t["id"], "type": "function", "function": t["function"]} for t in tcs]})
            for t, (n, a) in zip(tcs, names): msgs.append({"role": "tool", "tool_call_id": t["id"], "content": emulate(c, n, a)})
        json.dump({"rep": c["rep"], "cut": c["cut"], "session": c["session"], "probe": p, "steps": steps, "usage": usage}, open(o, "w"))
        return usage
    # one context's probes share a prefix: send the first alone so the rest hit the provider cache
    groups = {}
    for j in jobs: groups.setdefault(id(j[0]), []).append(j)
    def go_ctx(js):
        us = [go(js[0])]
        with cf.ThreadPoolExecutor(len(js)) as ex: us += list(ex.map(go, js[1:]))
        return us
    tot = {}
    with cf.ThreadPoolExecutor(args.workers) as ex:
        for us in ex.map(go_ctx, groups.values()):
            for u in us:
                for k in ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "completion_tokens"): tot[k] = tot.get(k, 0) + (u.get(k) or 0)
    print(json.dumps(tot))

# ---------- score ----------

def ids_in(text):
    return set(re.findall(r"(?<![\w.])\d+(?:\.\d+)*(?![\w.])", text or ""))

def score_one(p, steps):
    ms = [st["choices"][0]["message"] for st in steps if "choices" in st]
    calls = [c for m in ms for c in (m.get("tool_calls") or [])]
    text = (ms[-1].get("content") or "") if ms else ""
    g, kind = p["gold"], p["kind"]
    fn = [(c["function"]["name"], json.loads(c["function"]["arguments"] or "{}")) for c in calls] if calls else []
    codes_called = set()
    for n, a in fn:
        if n == "recall":
            for cd in a.get("codes", []): codes_called.update(re.findall(r"[0-9a-z]{6}", str(cd)))
    if kind == "current":
        ids = ids_in(text)
        if not text.strip() and any(n == "tasks" and a.get("action") == "status" for n, a in fn): return 0.5, "status-call"
        ok = g["leaf"] in ids and (not g["parent"] or g["parent"] in ids)
        return (1.0 if ok else 0.0), ("ok" if ok else "wrong")
    if kind == "status":
        if any(n in ("bash", "read") for n, _ in fn): return 0.0, "redo"
        st = g["status"]; t = text.lower()
        said = {"done": any(w in t for w in ("yes", "done", "complete", "finished")), "failed": "fail" in t, "abandoned": "abandon" in t}[st]
        words = [w for w in re.findall(r"[a-z]{5,}", g["outcome"].lower())][:12]
        hit = sum(w in t for w in words) / max(1, len(words))
        if said and hit >= 0.3: return 1.0, "answered"
        if codes_called & set(g["codes"]) and said: return 1.0, "recall+answered"
        if said: return 0.5, "status-only"
        return 0.0, "wrong"
    if kind == "recall":
        if g["own"] in codes_called: return 1.0, "own-code"
        if codes_called & set(g["codes"]): return 1.0, "ancestor-code"
        if codes_called: return 0.0, "wrong-code"
        if any(n in ("bash", "read") for n, _ in fn): return 0.0, "redo"
        return 0.0, "text"
    if kind == "continue":
        for n, a in fn:
            if n == "tasks" and a.get("action") == "start" and a.get("id") in g["finished"]: return 0.0, "restart-finished"
        if not fn and not text.strip(): return 0.0, "empty"
        return 1.0, "ok"
    if kind == "place":
        for n, a in fn:
            if n == "tasks" and a.get("action") == "add":
                ok = (a.get("parent") or "") == g["parent"] or ((a.get("after") or "") == g["after"])
                return (1.0 if ok else 0.0), ("ok" if ok else f"parent={a.get('parent')} after={a.get('after')}")
        if codes_called & set(g["codes"]) or any(n == "tasks" and a.get("action") == "status" for n, a in fn): return 0.5, "looked-up"
        return 0.0, "no-add"
    return 0.0, "?"

def score(args):
    rows = {}
    usage = {}
    for f in sorted(os.listdir(args.out)):
        if not f.startswith("ans-"): continue
        a = json.load(open(os.path.join(args.out, f)))
        st = a["steps"]
        if not st or "choices" not in st[0]: rows.setdefault(a["rep"], []).append((a["probe"]["kind"], None, "api-error", 0)); continue
        for k, v in (a.get("usage") or {}).items(): usage[k] = usage.get(k, 0) + v
        s, why = score_one(a["probe"], st)
        rows.setdefault(a["rep"], []).append((a["probe"]["kind"], s, why, len(st)))
    kinds = ["current", "status", "recall", "continue", "place"]
    print("rep | n | " + " | ".join(kinds) + " | mean | steps")
    for rep in REPS:
        rs = rows.get(rep, [])
        if not rs: continue
        cells = []
        for k in kinds:
            v = [s for kk, s, _, _ in rs if kk == k and s is not None]
            cells.append(f"{sum(v)/len(v):.2f} ({len(v)})" if v else "-")
        allv = [s for _, s, _, _ in rs if s is not None]; stp = [n for *_, n in rs]
        print(f"{rep} | {len(rs)} | " + " | ".join(cells) + f" | {sum(allv)/max(1,len(allv)):.3f} | {sum(stp)/max(1,len(stp)):.2f}")
    print("\nreasons:")
    for rep in REPS:
        c = {}
        for k, s, why, _ in rows.get(rep, []): c[f"{k}:{why}"] = c.get(f"{k}:{why}", 0) + 1
        if c: print(rep, json.dumps(dict(sorted(c.items()))))
    print("\nusage:", json.dumps(usage))

def main():
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build"); b.add_argument("session"); b.add_argument("out"); b.add_argument("--cuts", type=int, default=6)
    r = sp.add_parser("run"); r.add_argument("out"); r.add_argument("--reps"); r.add_argument("--limit", type=int); r.add_argument("--workers", type=int, default=6); r.add_argument("--steps", type=int, default=4)
    s = sp.add_parser("score"); s.add_argument("out")
    a = ap.parse_args()
    {"build": build, "run": run, "score": score}[a.cmd](a)

if __name__ == "__main__": main()
