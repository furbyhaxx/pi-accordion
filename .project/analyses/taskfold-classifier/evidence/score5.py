import json,collections,statistics
exec(open('score4.py').read().split("def auc")[0].split("R=[r for r")[0])
src=open('score4.py').read(); exec(src[src.index("def P("):src.index("def auc")])
def auc(pos,neg):
    if not pos or not neg: return float('nan')
    return sum((p>n)+0.5*(p==n) for p in pos for n in neg)/len(pos)/len(neg)
GOLD={x['id']:(x['split'],x['gold']) for x in json.load(open('items5.json'))}
R=[r for f in ['r5_old_v2','r5_old_nuk','r5_new','r5_ms_nuk','r5_single','r5_compact'] for r in json.load(open(f+'.json')) if r.get('answers')]
rows=collections.defaultdict(dict); meta=collections.defaultdict(list)
for r in R:
    s=pres_scores(r['answers'])
    if r['answers'].get('keep_v2'): s['keep_v2']=r['answers']['keep_v2']['probability']
    if 'loss' in s: s['loss']=s['loss']/3
    rows[(r['model'].split('/')[-1],r['variant'])][r['id']]=(*GOLD[r['id']],s); meta[(r['model'].split('/')[-1],r['variant'])].append(((r.get('cost') or 0),r['ms']))
out=[]
for key,d in rows.items():
    feats=set().union(*[set(x[2]) for x in d.values()])
    c=meta[key]; cost=sum(x[0] for x in c)/len(c)*1000; ms=statistics.median(x[1] for x in c)
    for f in feats:
        xs={sp:[(g,s[f]) for (spl,g,s) in d.values() if spl==sp and f in s] for sp in ['dev','test','nuk']}
        A={sp:auc([p for g,p in v if g!='F'],[p for g,p in v if g=='F']) for sp,v in xs.items()}
        thr=0
        for t in sorted(set(p for _,p in xs['dev'])):
            if sum(1 for g,p in xs['dev'] if g!='F' and p<t)==0: thr=t
        def ev(v): 
            dr=[g for g,p in v if p<thr]; return (sum(g!='F' for g in dr), sum(g=='F' for g in dr), sum(g=='F' for g,_ in v), sum(g=='K' for g in dr), sum(g=='L' for g in dr))
        out.append(dict(m=key[0],v=key[1],f=f,A=A,thr=thr,dev=ev(xs['dev']),test=ev(xs['test']),nuk=ev(xs['nuk']),cost=cost,ms=ms))
json.dump(out,open('score5.json','w'))
out.sort(key=lambda o:-o['A']['nuk'])
fmt=lambda e:f"{e[0]:>2}({e[3]}K{e[4]}L) {e[1]:>2}/{e[2]}"
print(f"{'model':24}{'var':5}{'feature':24}{'AUCdev':>7}{'test':>6}{'nuk':>6} {'thr':>6} | {'dev harm fold':>16} | {'test':>16} | {'nuk':>16} | $/1k p50")
for o in out[:40]:
    print(f"{o['m']:24}{o['v']:5}{o['f']:24}{o['A']['dev']:7.3f}{o['A']['test']:6.3f}{o['A']['nuk']:6.3f} {o['thr']:6.3f} | {fmt(o['dev']):>16} | {fmt(o['test']):>16} | {fmt(o['nuk']):>16} | {o['cost']:.3f} {o['ms']:.0f}")
