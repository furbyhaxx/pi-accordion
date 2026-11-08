#!/usr/bin/env python3
"""Offline wire simulator: fold representation x fold timing -> per-request prompt-cache accounting.

Usage: sim.py <session.jsonl> [--budget N] [--json out.json]
Reads a Pi session (active branch), derives task spans from `tasks` calls, rebuilds the outgoing
message list before every assistant response under each strategy and measures the longest common
prefix with the previous request (an always-warm provider prefix cache). Tokens are chars/4.
No model calls; the session file is only read.
"""
import argparse, json, sys

def load(path):
    entries = [json.loads(l) for l in open(path)]
    by_id = {e.get("id"): e for e in entries if e.get("id")}
    leaf = next(e for e in reversed(entries) if e.get("type") == "message")
    chain, e = [], leaf
    while e:
        chain.append(e); e = by_id.get(e.get("parentId"))
    chain.reverse()
    msgs = []
    for e in chain:
        if e.get("type") != "message": continue
        m = e["message"]; role = m["role"]
        if role == "system": role = "user"
        c = m.get("content")
        parts, calls = [], []
        if isinstance(c, str): parts.append(c)
        else:
            for p in c or []:
                t = p.get("type")
                if t == "text": parts.append(p.get("text", ""))
                elif t == "thinking": parts.append(p.get("thinking", ""))
                elif t == "toolCall":
                    parts.append(f"toolCall {p['name']} {json.dumps(p.get('arguments'), separators=(',', ':'))}")
                    calls.append(p)
                elif t == "image": parts.append("x" * 4000)
        msgs.append({"role": role, "text": "\n".join(parts), "calls": calls, "isError": m.get("isError", False),
                     "toolCallId": m.get("toolCallId")})
    for m in msgs: m["tok"] = max(1, len(m["text"]) // 4)
    return msgs

def spans(msgs):
    """Task spans as message-index ranges [s, e] plus report and own facts; parents auto-start."""
    result_at = {m["toolCallId"]: i for i, m in enumerate(msgs) if m["role"] == "toolResult"}
    tasks, status = {}, {}
    for i, m in enumerate(msgs):
        for c in m["calls"]:
            if c["name"] != "tasks": continue
            a = c.get("arguments") or {}
            act, lst, tid = a.get("action"), a.get("list"), a.get("id")
            ri = result_at.get(c["id"])
            if ri is None or msgs[ri]["isError"] or not tid: continue
            key = f"{lst}/{tid}"
            if act == "start":
                parts = tid.split(".")
                for d in range(1, len(parts) + 1):
                    k = f"{lst}/{'.'.join(parts[:d])}"
                    if status.get(k) in (None, "todo"):
                        tasks.setdefault(k, {"key": k, "id": ".".join(parts[:d]), "s": i, "e": None, "report": None})
                        status[k] = "doing"
                    elif status[k] == "blocked": status[k] = "doing"
            elif act == "block": status[key] = "blocked"
            elif act in ("complete", "fail", "abandon") and key in tasks:
                tasks[key].update(e=ri, report=a.get("report"), status={"complete": "done", "fail": "failed", "abandon": "abandoned"}[act])
                status[key] = "fin"
    done = [t for t in tasks.values() if t["e"] is not None]
    # forest by containment; crossing spans are not foldable (historical late children)
    done.sort(key=lambda t: (t["s"], -t["e"]))
    roots, stack, crossing = [], [], 0
    for t in done:
        t["kids"] = []
        while stack and stack[-1]["e"] < t["s"]: stack.pop()
        if stack and t["e"] > stack[-1]["e"]: crossing += 1; t["crossing"] = True; continue
        (stack[-1]["kids"] if stack else roots).append(t); stack.append(t)
    return roots, crossing, len(tasks)

def facts(msgs, s, e, kids):
    inner = set()
    for k in kids: inner.update(range(k["s"], k["e"] + 1))
    changed, verified = [], []
    for i in range(s, e + 1):
        if i in inner: continue
        for c in msgs[i]["calls"]:
            a = c.get("arguments") or {}
            if c["name"] in ("edit", "write") and a.get("path") and a["path"] not in changed: changed.append(a["path"])
            if c["name"] == "bash" and len(verified) < 8: verified.append(str(a.get("command", ""))[:80])
    return changed[:12], verified

def record(msgs, t, compose):
    ch, ve = facts(msgs, t["s"], t["e"], t["kids"])
    r = {"task": t["key"], "status": t.get("status"), "fold": "#" + t["key"][-6:]}
    rep = t["report"] or {}
    for f in ("outcome", "decisions", "open"):
        if rep.get(f): r[f] = rep[f]
    if ch: r["changed"] = ch
    if ve: r["verified"] = ve
    if compose and t["kids"]: r["children"] = [json.loads(record(msgs, k, True)) for k in t["kids"]]
    return json.dumps(r, separators=(",", ":"), ensure_ascii=False)

def count(t):
    n = {"done": 0, "failed": 0, "abandoned": 0}
    for k in walk(t["kids"]): n[k.get("status") or "done"] = n.get(k.get("status") or "done", 0) + 1
    return {k: v for k, v in n.items() if v}

def history(t):
    """1-3 line history: identity, status, subtree counts, short outcome, one recall code."""
    h = {"history": t["key"], "status": t.get("status"), "fold": "#" + t["key"][-6:]}
    if t["kids"]: h["subtasks"] = count(t)
    out = (t["report"] or {}).get("outcome")
    if out: h["outcome"] = out[:160]
    return json.dumps(h, separators=(",", ":"), ensure_ascii=False)

def digest(keys):
    """Pressure-time consolidation of many history entries into one message."""
    return json.dumps({"history": "consolidated", "done": keys}, separators=(",", ":"))

def M(role, text): return (role, text, max(1, len(text) // 4))

def render(msgs, lo, hi, nodes, folded, hist, rep, out, merged=None):
    """Emit messages[lo:hi) with folded spans replaced according to representation `rep`."""
    i = lo
    for t in nodes:
        if t["s"] >= hi: break
        while i < min(t["s"], hi): out.append(M(msgs[i]["role"], msgs[i]["text"])); i += 1
        if merged and t["e"] < hi and t["key"] in merged:
            if t["key"] == merged[0]: out.append(M("assistant", digest(merged)))
            i = t["e"] + 1; continue
        if t["e"] < hi and t["key"] in hist:
            out.append(M("assistant", history(t))); i = t["e"] + 1; continue
        if t["e"] < hi and t["key"] in folded:
            emit_folded(msgs, t, folded, hist, rep, out); i = t["e"] + 1; continue
        render(msgs, i, min(t["e"] + 1, hi), t["kids"], folded, hist, rep, out, merged); i = min(t["e"] + 1, hi)
    while i < hi: out.append(M(msgs[i]["role"], msgs[i]["text"])); i += 1

def emit_folded(msgs, t, folded, hist, rep, out):
    parent_rep = rep
    if rep == "BS": parent_rep = "S" if t["kids"] else "B"   # bracket a leaf, single once a parent folds
    if parent_rep in ("S", "HR", "HP", "HRC"):
        out.append(M("assistant", record(msgs, t, True)))
    elif parent_rep == "T":
        call = json.dumps({"action": "started-and-completed", "id": t["key"]}, separators=(",", ":"))
        out.append(M("assistant", "toolCall tasks " + call)); out.append(M("toolResult", record(msgs, t, True)))
    else:  # B: original start call/result, own-work record, original finish call/result; children as brackets
        s, e = t["s"], t["e"]
        out.append(M(msgs[s]["role"], msgs[s]["text"]))
        if s + 1 < e: out.append(M(msgs[s + 1]["role"], msgs[s + 1]["text"]))
        own = dict(t); own["report"] = None; own["kids"] = t["kids"]
        work = json.loads(record(msgs, own, False)); work.pop("status", None); work.pop("task", None)
        out.append(M("assistant", json.dumps(work, separators=(",", ":"))))
        for k in t["kids"]:
            if k["key"] in hist: out.append(M("assistant", history(k)))
            else: emit_folded(msgs, k, folded, hist, "B" if rep == "B" else "B", out)
        if e - 1 > s + 1: out.append(M(msgs[e - 1]["role"], msgs[e - 1]["text"]))
        out.append(M(msgs[e]["role"], msgs[e]["text"]))

def walk(roots):
    for r in roots:
        yield r; yield from walk(r["kids"])

CUM = {}
def prep(msgs):
    c = [0]
    for m in msgs: c.append(c[-1] + m["tok"])
    CUM[id(msgs)] = c

def simulate(msgs, roots, rep, timing, budget, high=0.8, low=0.6, cache="lcp", lookback=10, tail=0):
    alltasks = list(walk(roots))
    folded, hist, prev, merged = set(), set(), [], []
    base = rep
    tot = dict(input=0, read=0, write=0, rebill=0, requests=0, peak=0, folds=0, histed=0)
    live_series = []
    entries = set()   # (prefix length, prefix hash) of every cache entry written so far (breakpoint models)
    for a, m in enumerate(msgs):
        if m["role"] != "assistant" or a == 0: continue
        cum = CUM[id(msgs)]
        fin = [t for t in alltasks if t["e"] < a and cum[a] - cum[t["e"] + 1] >= tail]  # finished and out of the protected tail
        if rep != "RAW":
            if timing == "eager":
                for t in fin:
                    if t["key"] not in folded: folded.add(t["key"]); tot["folds"] += 1
            if rep in ("HR", "HRC"):
                for t in roots:
                    if t in fin: hist.add(t["key"])
            if rep == "HP":
                for t in fin:
                    if t["kids"]: hist.add(t["key"])
            R = lambda: (lambda w: (render(msgs, 0, a, roots, folded, hist, rep, w, merged), w)[1])([])
            wire = R()
            live = sum(x[2] for x in wire)
            if timing == "lazy" and live > high * budget:
                finroots = sorted([t for t in fin if t["key"] not in folded], key=lambda t: t["e"])
                for t in finroots[:-1] if len(finroots) > 1 else []:
                    folded.add(t["key"]); tot["folds"] += 1
                    wire = R(); live = sum(x[2] for x in wire)
                    if live <= low * budget: break
            if rep == "HRC" and live > high * budget:   # consolidate all history entries once
                old = [t["key"] for t in sorted(roots, key=lambda t: t["e"]) if t["e"] < a]
                if len(old) > len(merged): merged[:] = old; tot["histed"] += 1
                wire = R(); live = sum(x[2] for x in wire)
            if live > high * budget:   # hard pressure: completed roots -> one history message each, oldest first
                for t in sorted([r for r in roots if r["e"] < a and r["key"] in folded and r["key"] not in hist], key=lambda t: t["e"]):
                    hist.add(t["key"]); tot["histed"] += 1
                    wire = R(); live = sum(x[2] for x in wire)
                    if live <= low * budget: break
        else:
            wire = [M(x["role"], x["text"]) for x in msgs[:a]]
        live = sum(x[2] for x in wire)
        lcp = 0
        while lcp < len(wire) and lcp < len(prev) and wire[lcp] == prev[lcp]: lcp += 1
        if cache == "lcp":
            hit = lcp
        else:
            ph = [0]
            for x in wire: ph.append(hash((ph[-1], x)))
            bps = [len(wire)]
            if cache == "stable":   # 4th breakpoint at the start of the innermost open task: the next fold point
                open_ = [t for t in alltasks if t["s"] < a <= t["e"]]
                if open_ and rep != "RAW":
                    t = max(open_, key=lambda t: t["s"]); pre = []
                    render(msgs, 0, t["s"], roots, folded, hist, rep, pre, merged)
                    if 0 < len(pre) < len(wire): bps.append(len(pre))
            if cache == "anchor":
                cands = [n for n, h in entries if n <= lcp and n < len(wire) and ph[n] == h]
                if cands: bps.append(max(cands))
            hit = 0
            for b in bps:
                for n in range(b, max(0, b - lookback) - 1, -1):
                    if n > 0 and (n, ph[n]) in entries: hit = max(hit, n); break
            for b in bps: entries.add((b, ph[b]))
        read = sum(x[2] for x in wire[:hit]); write = live - read
        prev_tail = sum(x[2] for x in prev[lcp:])
        tot["input"] += live; tot["read"] += read; tot["write"] += write
        tot["rebill"] += max(0, sum(x[2] for x in wire[hit:lcp])) + min(sum(x[2] for x in wire[lcp:]), prev_tail)   # previously-sent content that had to be written again
        tot["requests"] += 1; tot["peak"] = max(tot["peak"], live); live_series.append(live)
        prev = wire
    tot["final"] = live_series[-1] if live_series else 0
    tot["mean"] = sum(live_series) // max(1, len(live_series))
    tot["cost"] = round(tot["read"] * 0.1 + tot["write"] * 1.25)   # Anthropic 5m-cache multipliers, in input-token units
    tot["msgs_final"] = len(prev)
    return tot

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("session"); ap.add_argument("--budget", type=int, default=120000)
    ap.add_argument("--cache", default="lcp", help="lcp | bp | anchor | stable | all"); ap.add_argument("--lookback", type=int, default=10); ap.add_argument("--tail", default="0")
    ap.add_argument("--json"); args = ap.parse_args()
    msgs = load(args.session); roots, crossing, ntasks = spans(msgs); prep(msgs)
    print(f"messages {len(msgs)}  tasks {ntasks}  finished roots {len(roots)}  crossing(unfoldable) {crossing}  raw tokens {sum(m['tok'] for m in msgs)}")
    rows = []
    caches = ["lcp", "bp", "stable"] if args.cache == "all" else [args.cache]
    for tail in [int(x) for x in args.tail.split(",")]:
      for cache in caches:
        for rep, timing in [("RAW", "-"), ("S", "lazy"), ("S", "eager"), ("HR", "eager"), ("HRC", "eager")]:
            r = simulate(msgs, roots, rep, timing, args.budget, cache=cache, lookback=args.lookback, tail=tail); r.update(rep=rep, timing=timing, cache=cache, tail=tail); rows.append(r)
    hdr = ["tail", "cache", "rep", "timing", "input", "read", "write", "rebill", "cost", "peak", "mean", "final", "histed"]
    print(" | ".join(hdr))
    for r in rows: print(" | ".join(str(r[h]) for h in hdr))
    if args.json: json.dump(rows, open(args.json, "w"), indent=1)

if __name__ == "__main__": main()
