#!/usr/bin/env python3
"""Fold-timing simulator: replays a Pi session's wire per request under a fold policy and a
breakpoint cache model, and reports cache reads/writes. Read-only; no model calls.

Usage: timing_sim.py <session.jsonl> [--budget N] [--validate]
Tokens are chars/4 scaled by k; S (system + tools) and k are fitted on the requests before the
session's first real fold (real input = S + k * estimate).
"""
import argparse, json, datetime, hashlib

FIN = {"complete": "done", "fail": "failed", "abandon": "abandoned"}

def ts(s): return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def load(path):
    msgs = []
    for line in open(path):
        e = json.loads(line)
        if e.get("type") != "message": continue
        m = e["message"]; c = m.get("content"); parts, calls, blocks = [], [], 0
        if isinstance(c, str): parts.append(c); blocks = 1
        else:
            for p in c or []:
                t = p.get("type")
                if t == "text": parts.append(p.get("text", "")); blocks += 1
                elif t == "thinking": parts.append(p.get("thinking", "")); blocks += 1
                elif t == "toolCall":
                    parts.append("toolCall %s %s" % (p["name"], json.dumps(p.get("arguments"), separators=(",", ":")))); calls.append(p)
                elif t == "image": parts.append("x" * 4000); blocks += 1
            if calls: blocks += 1          # a run of tool_use blocks is one lookback position
        text = "\n".join(parts); u = m.get("usage")
        msgs.append(dict(role=m["role"], text=text, tok=max(1, len(text) // 4), calls=calls, blocks=max(1, blocks),
                         err=m.get("isError", False), call_id=m.get("toolCallId"), t=ts(e["timestamp"]),
                         real=(u["input"] + u.get("cacheRead", 0) + u.get("cacheWrite", 0), u.get("cacheRead", 0), u.get("cacheWrite", 0)) if u and m["role"] == "assistant" else None))
    return msgs

def spans(msgs):
    """Finished task spans as message ranges. A closing call batched with another task's start ends before that message."""
    result_at = {m["call_id"]: i for i, m in enumerate(msgs) if m["role"] == "toolResult"}
    tasks, status = {}, {}
    for i, m in enumerate(msgs):
        starts_here = False
        for c in m["calls"]:
            if c["name"] != "tasks": continue
            a = c.get("arguments") or {}; act, lst, tid = a.get("action"), a.get("list"), a.get("id"); ri = result_at.get(c["id"])
            if ri is None or msgs[ri]["err"] or not tid: continue
            key = "%s/%s" % (lst, tid)
            if act == "start":
                parts = tid.split(".")
                for d in range(1, len(parts) + 1):
                    k = "%s/%s" % (lst, ".".join(parts[:d]))
                    if status.get(k) in (None, "todo"):
                        tasks[k] = dict(key=k, id=".".join(parts[:d]), s=i, e=None, close=None, report=None, title=k); status[k] = "doing"
                starts_here = True
            elif act in FIN and key in tasks and tasks[key]["e"] is None:
                tasks[key].update(e=ri, close=i, report=a.get("report") or {}, status=FIN[act]); status[key] = "fin"
        m["starts"] = starts_here
    done = [t for t in tasks.values() if t["e"] is not None]
    for t in done:
        # Closing call shares its message with a start of a task outside this subtree: that message belongs to the next span.
        if msgs[t["close"]].get("starts") and any(o["s"] == t["close"] and not o["key"].startswith(t["key"] + ".") and o["key"] != t["key"] for o in tasks.values()):
            t["e"] = t["close"] - 1; t["batched"] = True
    done = [t for t in done if t["e"] >= t["s"]]
    done.sort(key=lambda t: (t["s"], -t["e"], t["key"].count(".")))
    roots, stack, crossing = [], [], 0
    for t in done:
        t["kids"] = []
        while stack and stack[-1]["e"] < t["s"]: stack.pop()
        if stack and t["e"] > stack[-1]["e"]: crossing += 1; continue
        (stack[-1]["kids"] if stack else roots).append(t); t["parent"] = stack[-1] if stack else None; stack.append(t)
    return roots, crossing, len(tasks)

def walk(nodes):
    for n in nodes:
        yield n; yield from walk(n["kids"])

def carrier(msgs, t, bracket=False):
    """Record for a non-root, history for a root (SPEC-0002 section 8). Children appear as short entries."""
    rep = t["report"]
    if t["parent"] is None:
        h = dict(history=t["key"], status=t.get("status"), children={k["id"]: dict(title="x" * 40, recall="{#abc123 FOLDED}") for k in t["kids"]})
        if not bracket and rep.get("outcome"):
            h["outcome"] = rep["outcome"]
        return "{#abc123 FOLDED} " + json.dumps(h, separators=(",", ":"))
    inner = set()
    for k in t["kids"]: inner.update(range(k["s"], k["e"] + 1))
    changed, verified = [], []
    for i in range(t["s"], t["e"] + 1):
        if i in inner: continue
        for c in msgs[i]["calls"]:
            a = c.get("arguments") or {}
            if c["name"] in ("edit", "write") and a.get("path") and a["path"] not in changed: changed.append(a["path"])
            if c["name"] == "bash" and len(verified) < 5: verified.append(str(a.get("command", ""))[:120] + " -> ok")
    r = dict(task=t["key"], title="x" * 40, status=t.get("status"))
    if not bracket:
        for f in ("outcome", "decisions", "open"):
            if rep.get(f): r[f] = rep[f]
    if changed: r["changed"] = changed[:20]
    if verified: r["verified"] = verified
    if t["kids"]:
        r["children"] = {k["id"]: dict(title="x" * 40, outcome=k["report"].get("outcome") or "", recall="{#abc123 FOLDED}") for k in t["kids"]}
    return "{#abc123 FOLDED} " + json.dumps(r, separators=(",", ":"), ensure_ascii=False)

def render(msgs, lo, hi, nodes, folded, out, bracket):
    """Wire for messages[lo:hi) as (text, tokens, blocks) with folded spans replaced by their carrier."""
    i = lo
    for t in nodes:
        if t["s"] >= hi: break
        while i < min(t["s"], hi): out.append((msgs[i]["text"], msgs[i]["tok"], msgs[i]["blocks"])); i += 1
        if t["e"] < hi and t["key"] in folded:
            end = t["e"]
            if bracket and not t.get("batched"): end = t["close"] - 1      # keep the closing call and result verbatim
            if end >= t["s"]:
                text = carrier(msgs, t, bracket); out.append((text, max(1, len(text) // 4), 1))
            i = max(i, end + 1)
            while i <= t["e"]: out.append((msgs[i]["text"], msgs[i]["tok"], msgs[i]["blocks"])); i += 1
            continue
        render(msgs, i, min(t["e"] + 1, hi), t["kids"], folded, out, bracket); i = min(t["e"] + 1, hi)
    while i < hi: out.append((msgs[i]["text"], msgs[i]["tok"], msgs[i]["blocks"])); i += 1

def units(roots, a, delay):
    """Outermost finished spans at request a (taskfold.ts: fold units), ready once `delay` messages follow them."""
    out = []
    def rec(nodes):
        for t in nodes:
            if t["s"] >= a: continue
            if t["e"] + delay <= a: out.append(t)
            else: rec(t["kids"])
    rec(roots); return out

def fit(msgs, first_fold):
    """Least squares real = S + k * estimate over requests before the first real fold."""
    xs, ys, cum = [], [], 0
    for i, m in enumerate(msgs):
        if m["real"] and i < first_fold: xs.append(cum); ys.append(m["real"][0])
        cum += m["tok"]
    n = len(xs); mx, my = sum(xs) / n, sum(ys) / n
    k = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return my - k * mx, k

def simulate(msgs, roots, policy, k, S, budget, ttl, lookback, frontier=0, bracket=False, high=0.8, cache="bp"):
    alltasks = list(walk(roots)); folded = set(); entries = {}; prev = []; prev_t = None
    tot = dict(requests=0, input=0, read=0, write=0, folds=0, fold_events=0, peak=0, sys_cold=0, series=[])
    delay = 1 if bracket else 2      # a record never ends the request: one more message must follow the span
    for a, m in enumerate(msgs):
        if m["role"] != "assistant" or a == 0 or not m["real"]: continue
        now = m["t"]; cold = prev_t is None or now - prev_t > ttl
        def wire_of():
            w = []; render(msgs, 0, a, roots, folded, w, bracket); return w
        wire = wire_of(); live = S + k * sum(x[1] for x in wire)
        ready = [t for t in units(roots, a, delay) if t["key"] not in folded]
        pressure = live >= high * budget
        chosen = []
        if policy == "pressure": chosen = ready if pressure else []
        elif policy == "eager": chosen = ready
        elif policy == "lazy":
            chosen = ready if pressure or cold else []
        elif policy == "shipped":  # as lazy, but only a never-sent cache counts as cold
            def near(t): return sum(x["blocks"] for x in msgs[t["s"]:a]) <= 20
            chosen = ready if (pressure or prev_t is None) else [t for t in ready if near(t)]
        if chosen:
            for t in chosen:
                folded.add(t["key"]); tot["folds"] += 1
                for d in walk(t["kids"]): folded.discard(d["key"])
            tot["fold_events"] += 1; wire = wire_of(); live = S + k * sum(x[1] for x in wire)
        # prefix hashes at message ends
        ph = [b""]; h = hashlib.blake2b(digest_size=8)
        for x in wire: h.update(x[0].encode("utf-8", "replace")); h.update(b"\0"); ph.append(h.digest())
        lcp = 0
        while lcp < len(wire) and lcp < len(prev) and wire[lcp][0] == prev[lcp][0]: lcp += 1
        if cache == "lcp":
            hit = 0 if cold else lcp
        else:
            bps = [len(wire)]
            if frontier:      # extra breakpoints just before the start of the innermost (and next outer) open tasks
                open_ = sorted([t for t in alltasks if t["s"] < a <= t["e"] + (0 if not t.get("batched") else 0)], key=lambda t: -t["s"])
                for t in open_[:frontier]:
                    pre = []; render(msgs, 0, t["s"], roots, folded, pre, bracket)
                    if 0 < len(pre) < len(wire) and len(pre) not in bps: bps.append(len(pre))
            hit = 0
            for b in bps:
                n, seen = b, 0
                while n > 0 and seen < lookback:
                    e = entries.get((n, ph[n]))
                    if e is not None and now - e <= ttl: hit = max(hit, n); entries[(n, ph[n])] = now; break
                    seen += wire[n - 1][2]; n -= 1
            for b in bps: entries[(b, ph[b])] = now
        read = k * sum(x[1] for x in wire[:hit]); write = live - S - read
        if cold: write += S; tot["sys_cold"] += 1
        else: read += S
        tot["requests"] += 1; tot["input"] += live; tot["read"] += read; tot["write"] += write; tot["peak"] = max(tot["peak"], live); tot["series"].append(live)
        prev = wire; prev_t = now
    tot["mean"] = tot["input"] / max(1, tot["requests"]); return tot

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("session"); ap.add_argument("--budget", type=int, default=272000); ap.add_argument("--validate", action="store_true")
    ap.add_argument("--first-fold", type=int, default=None, help="message index of the first real fold (fit window); default: first real input drop > 3000")
    args = ap.parse_args()
    msgs = load(args.session); roots, crossing, ntasks = spans(msgs)
    reals = [(i, m["real"]) for i, m in enumerate(msgs) if m["real"]]
    ff = args.first_fold
    if ff is None:
        ff = next((i for (i, r), (_, p) in zip(reals[1:], reals) if p[0] - r[0] > 3000), len(msgs))
    S, k = fit(msgs, ff)
    leaves = [t for t in walk(roots) if not t["kids"]]
    print("messages %d requests %d tasks %d finished %d crossing %d leaves %d | fit S=%.0f k=%.3f (first fold at message %d)" % (len(msgs), len(reals), ntasks, len(list(walk(roots))), crossing, len(leaves), S, k, ff))
    real = dict(input=sum(r[0] for _, r in reals), read=sum(r[1] for _, r in reals), write=sum(r[2] for _, r in reals))
    print("REAL  input %.1fM read %.1fM write %.2fM mean %.0f" % (real["input"] / 1e6, real["read"] / 1e6, real["write"] / 1e6, real["input"] / len(reals)))
    profiles = [("anthropic-1h", 3600, 20, "bp"), ("anthropic-5m", 300, 20, "bp"), ("openai-30m", 1800, 40, "bp"), ("prefix-lcp", 1800, 0, "lcp")]
    weights = {"anthropic-1h": [("sonnet/opus 5.5", .05, 2.0), ("standard", .1, 2.0)], "anthropic-5m": [("sonnet/opus 5.5", .05, 1.25), ("standard", .1, 1.25)],
               "openai-30m": [("gpt-6.1", .05, 1.25), ("standard", .1, 1.25)], "prefix-lcp": [("no write charge", .1, 1.0)]}
    variants = [("none", 0, False), ("pressure", 0, False), ("shipped", 0, False), ("lazy", 0, False), ("eager", 0, False), ("eager", 1, False), ("eager", 2, False), ("eager", 0, True), ("eager", 1, True)]
    if args.validate: profiles, variants = profiles[:1], [("shipped", 0, False), ("pressure", 0, False)]
    for name, ttl, lookback, cache in profiles:
        print("\n== %s (ttl %ds, lookback %s) ==" % (name, ttl, lookback or "n/a"))
        print("policy | frontier bp | bracket | fold events | mean input | peak | read M | write M | " + " | ".join("cost M (%s)" % w[0] for w in weights[name]))
        for policy, frontier, bracket in variants:
            if cache == "lcp" and frontier: continue
            r = simulate(msgs, roots, policy, k, S, args.budget, ttl, lookback, frontier, bracket, cache=cache)
            print("%s | %d | %s | %d | %.0f | %.0f | %.1f | %.2f | " % (policy, frontier, "yes" if bracket else "no", r["fold_events"], r["mean"], r["peak"], r["read"] / 1e6, r["write"] / 1e6)
                  + " | ".join("%.2f" % ((r["read"] * wr + r["write"] * ww) / 1e6) for _, wr, ww in weights[name]))

if __name__ == "__main__": main()
