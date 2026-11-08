#!/usr/bin/env python3
"""Score routing-live.ts output with the same gold labels and scorer as routing.py."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import routing as R

out = sys.argv[1]
corpus = {it["id"]: it for it in json.load(open(os.path.join(out, "corpus.json")))}
tp = req = fp = exact = n = neg = neg_ok = pins = pv = 0
applied = dropped = rejected = errors = 0
usage = {}
reasons = {}
for f in sorted(os.listdir(out)):
    if not f.startswith("res-"): continue
    r = json.load(open(os.path.join(out, f))); it = corpus[r["id"]]
    for k, v in r.get("usage", {}).items():
        if isinstance(v, (int, float)): usage[k] = usage.get(k, 0) + v
    errors += 1 if r.get("error") else 0
    s = R.score_item(it["gold"], r["B"], it["msg"], it["list"])
    tp += s["tp"]; req += s["req"]; fp += s["fp"]; exact += s["exact"]; n += 1; pins += s["pins"]; pv += s["pins_verbatim"]
    if not [g for g in it["gold"] if not g.get("optional")]: neg += 1; neg_ok += s["fp"] == 0
    applied += len(r["applied"]); dropped += len(r["dropped"]); rejected += len(r["rejected"])
    for d in r["dropped"] + r["rejected"]:
        key = d["reason"][:70]; reasons[key] = reasons.get(key, 0) + 1
print(f"runs {n} | recall {tp/max(1,req):.2f} ({tp}/{req}) | precision {tp/max(1,tp+fp):.2f} | exact {exact/n:.2f} | no-op clean {neg_ok}/{neg} | pins verbatim {pv}/{pins} | errors {errors}")
print(f"store: applied {applied}, refused {dropped}, malformed {rejected}")
for k, v in sorted(reasons.items(), key=lambda x: -x[1])[:10]: print(f"  {v:3d} {k}")
print("usage:", json.dumps(usage))
