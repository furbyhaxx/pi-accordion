import importlib.util,pathlib,subprocess,json,time,sys
p=pathlib.Path('/tmp/accordion-secure-eval'); spec=importlib.util.spec_from_file_location('runner',p/'runner.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
arm=sys.argv[1]; d=p/('preflight-'+arm);d.mkdir(exist_ok=True);work=d/'repo';config=d/'config';sessions=d/'session';work.mkdir(exist_ok=True);(config/'accordion/.accordion').mkdir(parents=True,exist_ok=True);sessions.mkdir(exist_ok=True)
port=(p/'mockhold.port').read_text().strip();(config/'models.json').write_text(json.dumps({'providers':{'deepseek':{'baseUrl':'http://127.0.0.1:'+port,'apiKey':'sandbox-only'}}}));(config/'settings.json').write_text(json.dumps({'shellPath':'/safe-shell'}))
common={'autoArm':True,'defaultConductor':'taskfold','doorPort':0,'privacyConsent':{'taskfold':'2026-11-05T08:00:00.000Z'},'modelDefaults':{'deepseek/*':{'budget':'16k','protect':'3k'}}}
if arm in ('A','K+'):
 tree=r.FROZEN_OLD;common['conductorOptions']={'taskfold':{'orientation':{'fold':'off','agentTask':False,'rules':'live','pins':False,'thin':'open' if arm=='K+' else 'off'}}}
else:tree=r.FROZEN_NEW;common['taskfold']={'floor':arm=='TF'}
(config/'accordion/.accordion/config.json').write_text(json.dumps(common))
cmd=r.main_sandbox(work,config,sessions,tree);out=(d/'run.jsonl').open('w');err=(d/'stderr').open('w');child=subprocess.Popen(cmd+['Preflight.'],stdout=out,stderr=err)
try:
 registry=config/'accordion/.accordion/sessions'; entry=None
 for _ in range(60):
  entries=list(registry.glob('*.json'))
  if entries:
   try:
    data=json.loads(entries[0].read_text())
    if data.get('port'):entry=data;break
   except (ValueError,OSError):pass
  if child.poll() is not None:break
  time.sleep(.1)
 if not entry: print(json.dumps({'arm':arm,'error':'no live registry'}));sys.exit(1)
 js='''const WebSocket=require(process.argv[1]);const ws=new WebSocket(`ws://127.0.0.1:${process.argv[2]}/?surface=preflight`);let found={};ws.on("message",b=>{let m=JSON.parse(b);if(m.type==="snapshot") {found.budget=m.state.budget;found.protect=m.state.protectTokens;found.folding=m.state.foldingEnabled;}if(m.type==="conductorState")found.conductor=m.active?.id??null;if(m.type==="hello"&&m.conductor)found.conductor=m.conductor.id;});setTimeout(()=>{console.log(JSON.stringify(found));ws.close()},1200);'''
 x=subprocess.run(['node','-e',js,str(r.PROJECT/'extension/node_modules/ws'),str(entry['port'])],capture_output=True,text=True,timeout=5)
 print(json.dumps({'arm':arm,'websocket':json.loads(x.stdout.strip() or '{}'),'ws_exit':x.returncode}))
finally:
 child.wait(timeout=15);out.close();err.close()
