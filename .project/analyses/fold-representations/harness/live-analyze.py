#!/usr/bin/env python3
"""Analyze a live.py run: python3 live-analyze.py <out-dir> -> prints a JSON summary."""
import glob, json, os, re, sys

out = sys.argv[1]
allreqs = [json.load(open(f)) for f in sorted(glob.glob(f"{out}/requests/req-*.json"))]
allusage = {int(re.search(r"(\d+)", os.path.basename(f)).group(1)): json.load(open(f)) for f in sorted(glob.glob(f"{out}/requests/usage-*.json"))}
# The agent's conversation is the one whose system prompt carries the tools; extractor/classifier calls are separate.
agent = [i for i, r in enumerate(allreqs) if r.get("tools")]
reqs = [allreqs[i] for i in agent]
usages = {n + 1: allusage.get(i + 1, {}) for n, i in enumerate(agent)}
canon = lambda m: json.dumps({k: v for k, v in m.items() if k != "reasoning_content"}, sort_keys=True)
msgs = lambda r: [canon(m) for m in r["messages"]]

rows = []
for i, r in enumerate(reqs):
    ms = r["messages"]; u = usages.get(i + 1, {})
    prev = msgs(reqs[i - 1]) if i else []
    cur = msgs(r)
    k = 0
    while k < min(len(prev), len(cur)) and prev[k] == cur[k]: k += 1
    folded = [m for m in ms if m["role"] == "assistant" and isinstance(m.get("content"), str) and "FOLDED}" in m["content"]]
    rows.append({"req": agent[i] + 1, "msgs": len(ms), "sharedPrefix": k, "prevMsgs": len(prev), "extends": (k == len(prev)) if i else None, "foldedCarriers": len(folded), "carrierCodes": [m["content"][2:8] for m in folded], "hit": u.get("prompt_cache_hit_tokens"), "miss": u.get("prompt_cache_miss_tokens")})

results = []
for r in reqs[-1:]:
    for m in r["messages"]:
        if m["role"] == "tool" and isinstance(m.get("content"), str) and m["content"].startswith("{"):
            try: results.append(json.loads(m["content"]))
            except ValueError: pass
carrier_roles = {m["role"] for r in reqs for m in r["messages"] if isinstance(m.get("content"), str) and re.match(r"^\{#[0-9a-z]{6} FOLDED\} \{", m["content"])}
nonjson = [m["content"][:80] for r in reqs[-1:] for m in r["messages"] if m["role"] == "tool" and not (m.get("content") or "").startswith(("{", "["))]
broken = [x["req"] for x in rows if x["extends"] is False]
tot = {k: sum(x[k] or 0 for x in rows) for k in ("hit", "miss")}
lists = glob.glob(f"{out}/work/.pig/tasks/*.json")
lst = json.load(open(lists[0])) if lists else {}
summary = {"requests": len(reqs), "prefixBreaks": broken, "foldCarrierRoles": sorted(carrier_roles), "nonJsonToolResults": nonjson[:5], "cacheHit": tot["hit"], "cacheMiss": tot["miss"], "hitRatio": round(tot["hit"] / max(1, tot["hit"] + tot["miss"]), 3), "listVersion": lst.get("version"), "listGoals": [g.get("text") for g in lst.get("goals", [])], "listPins": [p.get("text") for p in lst.get("pins", [])], "taskStatuses": {t["id"]: t["status"] for t in lst.get("tasks", [])}}
json.dump({"summary": summary, "rows": rows}, open(f"{out}/analysis.json", "w"), indent=1)
print(json.dumps(summary, indent=1)); print(json.dumps(rows))
