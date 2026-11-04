import json,collections,math,sys
R=[r for r in json.load(open('results4.json')) if r.get('answers')]
KEEP={'new-task','new-instruction'}; 
def P(a,k):
    v=a.get(k)
    if not v: return None
    if v['type']=='bool': return v['probability']
    if v['type']=='score': return v['score']
    return v['probabilities']
def pres_scores(a):
    s={}
    for k in ['keep_old','keep_goal','new_work','durable_rule','overrule','goal_shift']:
        if P(a,k) is not None: s[k]=P(a,k)
    for k in ['approval_only','status_check','automated','info_only']:
        if P(a,k) is not None: s['not_'+k]=1-P(a,k)
    o=P(a,'old7')
    if o: s['old7:keep']=o.get('new-task',0)+o.get('new-instruction',0); s['old7:keep+lift']=s['old7:keep']+o.get('constraint',0)
    ac=P(a,'act')
    if ac: s['act:K+L']=sum(ac.get(k,0) for k in ['new_task','scope_addition','subject_question','lasting_rule','decision','correction']); s['act:K']=sum(ac.get(k,0) for k in ['new_task','scope_addition','subject_question'])
    f=P(a,'fate')
    if f: s['fate:keep']=f.get('keep_verbatim',0)+f.get('keep_as_rule',0); s['fate:verbatim']=f.get('keep_verbatim',0)
    if P(a,'loss') is not None: s['loss']=P(a,'loss')
    if all(k in s for k in ['new_work','durable_rule','overrule']): s['max(new,rule,overrule)']=max(s['new_work'],s['durable_rule'],s['overrule']); s['max(new,rule)']=max(s['new_work'],s['durable_rule'])
    if 'keep_goal' in s and 'durable_rule' in s: s['max(keep_goal,rule)']=max(s['keep_goal'],s['durable_rule'])
    return s
def auc(pos,neg):
    if not pos or not neg: return float('nan')
    w=sum((p>n)+0.5*(p==n) for p in pos for n in neg); return w/len(pos)/len(neg)
rows=collections.defaultdict(dict)
for r in R: rows[(r['model'],r['variant'])][r['id']]=(r['split'],r['gold'],pres_scores(r['answers']))
out=[]
for (m,v),d in sorted(rows.items()):
    feats=set().union(*[set(x[2]) for x in d.values()])
    for f in sorted(feats):
        res={}
        for sp in ['dev','test']:
            xs=[(g,s[f]) for (spl,g,s) in d.values() if spl==sp and f in s]
            res[sp]=auc([p for g,p in xs if g!='F'],[p for g,p in xs if g=='F'])
        out.append((m.split('/')[-1],v,f,res['dev'],res['test']))
out.sort(key=lambda x:-(x[3]+x[4]))
print(f"{'model':28}{'var':6}{'feature':26}{'devAUC':>7}{'testAUC':>8}")
for o in out[:45]: print(f"{o[0]:28}{o[1]:6}{o[2]:26}{o[3]:7.3f}{o[4]:8.3f}")
print('...baselines')
for o in out:
    if o[2] in ('keep_old','old7:keep+lift') : print(f"{o[0]:28}{o[1]:6}{o[2]:26}{o[3]:7.3f}{o[4]:8.3f}")
