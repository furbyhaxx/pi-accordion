#!/usr/bin/env python3
import argparse, concurrent.futures, json, os, pathlib, shutil, subprocess, threading, time

BASE = pathlib.Path('/tmp/accordion-secure-eval')
PROJECT = pathlib.Path('/mnt/Projects/furbyhaxx/pi-accordion/.pi/worktrees/taskfold-tree')
OLD = pathlib.Path('/mnt/Projects/furbyhaxx/pi-accordion/.pi/worktrees/orientation-modes')
FROZEN_NEW = BASE / 'frozen/new'
FROZEN_OLD = BASE / 'frozen/old'
FIXTURES = PROJECT / '.project/analyses/orientation-modes/harness/fixtures'
RESULTS = BASE / 'results2'
PORT = (BASE / 'proxy.port').read_text().strip()
ARMS = ('A', 'K+', 'T', 'TF')
lock = threading.Lock()

def execute(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)

def main_sandbox(repo, config, session, tree):
    cmd = ['bwrap','--unshare-user','--unshare-pid','--share-net',
      '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind','/etc/ssl','/etc/ssl',
      '--ro-bind','/tmp/t2-venv','/venv', '--ro-bind',str(BASE / 'safe-shell'),'/safe-shell',
      '--bind',str(repo),'/work','--bind',str(config),'/config','--bind',str(session),'/session',
      '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/work','--clearenv',
      '--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','PI_CODING_AGENT_DIR','/config',
      '--setenv','ACCORDION_HOME','/config/accordion']
    for src,dst in [('extension','extension'),('core','core'),('conductors','conductors'),('app/src','app/src'),('app/node_modules','app/node_modules')]:
        source = tree / src
        if src == 'app/node_modules' and not source.exists():
            if (tree/'app/package-lock.json').read_bytes() != (PROJECT/'app/package-lock.json').read_bytes(): raise RuntimeError('App dependency locks differ')
            source = PROJECT / src
        cmd.extend(['--ro-bind',str(source),'/opt/accordion/' + dst])
    if tree in (FROZEN_NEW, FROZEN_OLD):
        deps = OLD if tree == FROZEN_OLD else PROJECT
        cmd.extend(['--ro-bind',str(deps/'extension/node_modules'),'/opt/accordion/extension/node_modules'])
    cmd += ['--ro-bind',str(tree / 'package.json'),'/opt/accordion/package.json',
      '/usr/bin/node','/opt/accordion/extension/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      '--no-extensions','--no-skills','--no-mcp','--no-context-files','--tools','bash,tasks,recall,unfold',
      '--provider','deepseek','--model','deepseek-flash','--thinking','off','--session-dir','/session',
      '-e','/opt/accordion/extension/accordion.ts','--mode','json','-p']
    return cmd

def read_metrics(session):
    usage = {'calls':0,'input':0,'cache_read':0,'output':0,'cost':0.,'max_input':0,'tools':{},'rereads':0,'recall':0,'unfold':0,'tool_errors':0}
    reads=set()
    for f in session.glob('*.jsonl'):
        for line in f.read_text().splitlines():
            try: e=json.loads(line)
            except ValueError: continue
            msg=e.get('message') or {}
            if msg.get('role')=='assistant':
                u=msg.get('usage') or {}; usage['calls']+=1
                usage['input']+=u.get('input') or 0; usage['cache_read']+=u.get('cacheRead') or 0; usage['output']+=u.get('output') or 0
                usage['max_input']=max(usage['max_input'], (u.get('input') or 0)+(u.get('cacheRead') or 0)); usage['cost']+=(u.get('cost') or {}).get('total') or 0
                for c in msg.get('content') or []:
                    if c.get('type')!='toolCall': continue
                    n=c.get('name'); usage['tools'][n]=usage['tools'].get(n,0)+1
                    if n in ('recall','unfold'): usage[n]+=1
            elif msg.get('role')=='toolResult' and msg.get('isError'): usage['tool_errors']+=1
    return usage

def sandbox_grade(repo,fixture,run):
    grade=run/'grade'; shutil.copytree(repo,grade,symlinks=True,ignore=shutil.ignore_patterns('.git','.pig','__pycache__','.pytest_cache'))
    tests=grade/'tests'; resolved=tests.resolve()
    if tests.is_symlink() or not resolved.is_relative_to(grade.resolve()): return {'grade_error':'unsafe tests path'}
    tests.mkdir(exist_ok=True)
    target=tests/'test_zz_hidden.py'
    if target.exists() or target.is_symlink(): return {'grade_error':'hidden test target occupied'}
    shutil.copyfile(FIXTURES/fixture/'hidden/test_hidden.py',target)
    cmd=['bwrap','--unshare-all','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
      '--ro-bind','/tmp/t2-venv','/venv','--bind',str(grade),'/work', '--ro-bind',str(FIXTURES/fixture/'repo'),'/baseline', '--ro-bind',str(FIXTURES/fixture/'hidden/constraints.py'),'/constraints.py','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
      '--chdir','/work','--clearenv','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin',
      '--setenv','PYTHONPATH','/venv/lib/python3.13/site-packages','/usr/bin/python3','-m','pytest','-q','-p','no:cacheprovider','-rN']
    try:
        p=execute(cmd,timeout=180)
        check=cmd[:-7]+['/usr/bin/python3','-c','import json,pathlib,runpy; c=runpy.run_path("/constraints.py")["check"](pathlib.Path("/work"),pathlib.Path("/baseline")); print(json.dumps({k:v for k,v in c.items() if v}))']
        violations=execute(check,timeout=60)
        return {'exit':p.returncode,'tail':(p.stdout+p.stderr)[-1500:],'constraints_exit':violations.returncode,'violations':violations.stdout[-2000:]}
    except subprocess.TimeoutExpired: return {'grade_error':'timeout'}

def run_one(fixture,arm,rep):
    rid=f'{fixture}-{arm}-{rep}'; run=BASE/'runs2'/rid
    run.mkdir(parents=True,exist_ok=False); repo=run/'repo'; shutil.copytree(FIXTURES/fixture/'repo',repo,symlinks=True); (repo/'.pig').mkdir(exist_ok=True)
    config=run/'config'; session=run/'session'; config.mkdir(); session.mkdir(); (config/'accordion/.accordion').mkdir(parents=True)
    (config/'settings.json').write_text(json.dumps({'shellPath':'/safe-shell'}))
    (config/'models.json').write_text(json.dumps({'providers':{'deepseek':{'baseUrl':'http://127.0.0.1:'+PORT,'apiKey':'sandbox-only'}}}))
    common={'autoArm':True,'defaultConductor':'taskfold','doorPort':0,'privacyConsent':{'taskfold':'2026-11-05T08:00:00.000Z'},'modelDefaults':{'deepseek/*':{'budget':'16k','protect':'3k'}}}
    if arm in ('A','K+'):
        tree=FROZEN_OLD; common['conductorOptions']={'taskfold':{'orientation':{'fold':'off','agentTask':False,'rules':'live','pins':False,'thin':'open' if arm=='K+' else 'off'}}}
    else:
        tree=FROZEN_NEW; common['taskfold']={'floor':arm in ('TF','TF-inline','TF-ref')}
    if arm in ('TF-inline','TF-ref'):
        common['tasks']={'attachments':{'render':'inline' if arm=='TF-inline' else 'reference'}}
        lines='177-188' if fixture=='ratelimit' else '291-305'
        goal='Implement the rate limiter according to the specification.' if fixture=='ratelimit' else 'Build the monthly invoice export according to the specification.'
        tasksdir=repo/'.pig/tasks'; tasksdir.mkdir()
        (tasksdir/'fixture-plan.json').write_text(json.dumps({'version':2,'slug':'fixture-plan','title':'Fixture implementation','goal':goal,'tasks':[{'title':'Implement the specification','attachments':[{'id':'a1','path':'docs/spec.md','lines':lines,'note':'Relevant specification'}]}]}))
    (config/'accordion/.accordion/config.json').write_text(json.dumps(common))
    execute(['git','init','-q'],cwd=repo,timeout=20)
    paths=[str(p.relative_to(repo)) for p in repo.rglob('*') if p.is_file() and '.git' not in p.parts and '.pig' not in p.parts]
    if paths:
        execute(['git','add','--',*paths],cwd=repo,timeout=20)
        execute(['git','-c','user.email=eval@local','-c','user.name=Eval','commit','-qm','synthetic fixture'],cwd=repo,timeout=20)
    cmd=main_sandbox(repo,config,session,tree); started=time.monotonic(); statuses=[]
    for i,prompt in enumerate(['prompt.txt','prompt2.txt']):
        text=(FIXTURES/fixture/prompt).read_text().strip()
        if i == 0 and arm in ('TF-inline','TF-ref'):
            text += '\nA task list named fixture-plan is already prepared with a relevant specification attachment on task 1. Claim it and start task 1 before implementation; add subtasks if needed.'
        try:
            p=execute(cmd+(['-c'] if i else [])+[text],timeout=900)
            (run/f'phase{i+1}.jsonl').write_text(p.stdout); (run/f'phase{i+1}.stderr').write_text(p.stderr)
            statuses.append(p.returncode)
        except subprocess.TimeoutExpired:
            statuses.append('timeout'); break
    result={'id':rid,'fixture':fixture,'arm':arm,'rep':rep,'statuses':statuses,'wall_s':round(time.monotonic()-started),**read_metrics(session),'grade':sandbox_grade(repo,fixture,run)}
    RESULTS.mkdir(exist_ok=True); (RESULTS/(rid+'.json')).write_text(json.dumps(result,indent=2))
    with lock: print(json.dumps(result, separators=(',',':')),flush=True)
    return result

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--reps',type=int,default=5); ap.add_argument('--jobs',type=int,default=5); ap.add_argument('--arms',default=','.join(ARMS)); ap.add_argument('--fixtures',default='ratelimit,invoices'); args=ap.parse_args()
    jobs=[(f,a,r) for r in range(1,args.reps+1) for f in args.fixtures.split(',') for a in args.arms.split(',')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures=[pool.submit(run_one,*job) for job in jobs]
        for f in futures:
            try: f.result()
            except Exception as exc: print(json.dumps({'runner_error':str(exc)}),flush=True)

if __name__=='__main__': main()
