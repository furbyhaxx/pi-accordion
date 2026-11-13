"""S7 fact-ledger spike. dump.py: task spans as numbered entries; extract.py: rows from a model, kept when the value occurs verbatim in the cited entry; score.py: questions answered from kept rows. Private inputs (spans.json, questions.json) are not committed."""
# --- dump.py
import json,sys
import os
f=os.environ["LEDGER_SESSION"]  # a Pi session JSONL
SPANS={k:tuple(v) for k,v in json.load(open("spans.json")).items()}  # name -> [first line, last line] of a task span
lines=open(f).readlines()
def entries(name):
    a,b=SPANS[name]; out=[]
    for l in lines[a:b+1]:
        try:e=json.loads(l)
        except: continue
        m=e.get("message") or {}
        r=m.get("role")
        if r=="assistant":
            for p in m.get("content",[]):
                if p.get("type")=="text" and p.get("text","").strip(): out.append(("text",p["text"]))
                elif p.get("type")=="toolCall": out.append(("call "+p.get("name",""),json.dumps(p.get("arguments"),ensure_ascii=False)))
        elif r=="toolResult":
            c=m.get("content"); t=c if isinstance(c,str) else "".join(x.get("text","") for x in c if x.get("type")=="text")
            out.append(("result "+m.get("toolName",""),t))
        elif r=="user":
            c=m.get("content"); t=c if isinstance(c,str) else "".join(x.get("text","") for x in c if x.get("type")=="text")
            out.append(("user",t))
    return out
if __name__=="__main__":
    name=sys.argv[1]; clip=int(sys.argv[2])
    for i,(k,t) in enumerate(entries(name),1):
        print(f"--- {i} [{k}] {len(t)} chars"); print(t if len(t)<=clip else t[:clip//2]+"\n[…]\n"+t[-clip//2:])

# --- extract.py
import json,subprocess,sys,re
from dump import entries
MODEL=sys.argv[1]
PROMPT='''Below is the numbered transcript of one finished task of a coding agent. Extract the facts a later step may need to look up: measured values, counts, identifiers (commit hashes, UUIDs, ids), paths and file names, ports, hosts, model names, versions, commands that mattered, errors with their message, and decisions with their reason.

Output one JSON object and nothing else: {"rows":[{"key":"...","value":"...","unit":"...","entry":N}]}
- "key": what the value is, in a few plain words, specific enough to find by search.
- "value": copied character for character from entry N. Never paraphrase or reformat a value.
- "unit": the unit or kind (count, bits, commit, path, port, ...), "" when none.
- "entry": the number of the entry the value is copied from.
- One fact per row. Skip narration, plans and anything without a concrete value. At most 60 rows.

<transcript>
%s
</transcript>'''
for name in sys.argv[2:]:
    es=entries(name)
    body="\n".join(f"--- entry {i} [{k}]\n{t}" for i,(k,t) in enumerate(es,1))
    r=subprocess.run(["pig","-p","--no-session","--no-skills","--no-context-files","--no-tools","-ne","--model",MODEL,PROMPT%body],capture_output=True,text=True,stdin=subprocess.DEVNULL,cwd="/tmp",timeout=900)
    out=r.stdout
    m=re.search(r"\{.*\}",out,re.S)
    try: rows=json.loads(m.group(0))["rows"]
    except Exception as e:
        print(name,"PARSE FAIL",repr(out[:300]),r.stderr[:300]); rows=[]
    ok=[]
    for row in rows:
        n=row.get("entry"); v=str(row.get("value",""))
        if isinstance(n,int) and 1<=n<=len(es) and v and v in es[n-1][1]: ok.append(row)
    json.dump({"rows":rows,"verified":ok,"transcript_chars":len(body)},open(f"rows-{name}.json","w"),indent=1)
    print(name,"rows",len(rows),"verified",len(ok),"transcript chars",len(body),"verified-row chars",sum(len(json.dumps(x)) for x in ok))

# --- score.py
import json
qs=json.load(open("questions.json"))
hit=0; tot={}
for q in qs:
    d=json.load(open(f"rows-{q['task']}.json"))
    def answered(rows):
        for a in q["a"]:
            norm=lambda s:str(s).replace(",","")
            cands=[r for r in rows if norm(a) in norm(r["value"]) and (not q.get("key") or q["key"] in (r["key"]+r["value"]).lower())]
            if not cands: return False
        return True
    v=answered(d["verified"]); u=answered(d["rows"])
    hit+=v
    print("OK  " if v else ("unv " if u else "MISS"), q["task"], "|", q["q"])
print(f"answered from verified rows: {hit}/{len(qs)} = {hit/len(qs):.0%}")
for t in ("k2","k6","g3","btrfs","adapter"):
    d=json.load(open(f"rows-{t}.json")); rc=sum(len(json.dumps(x)) for x in d["verified"])
    print(t,"rows",len(d["rows"]),"verified",len(d["verified"]),"ledger tokens ~",rc//4,"transcript tokens ~",d["transcript_chars"]//4)
