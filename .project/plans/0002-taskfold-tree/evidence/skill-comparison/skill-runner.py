#!/usr/bin/env python3
import argparse, json, pathlib, shutil, subprocess
BASE=pathlib.Path('/tmp/accordion-secure-eval')
SOURCE=BASE/'frozen/new/extension'
CASES={
 'plan':('transcript','Create .pig/tasks/transcript.json as an Accordion task list: implement transcript branches and filtering, each independently verified, then final tests. The goal is a working transcript view. Write and validate the file.'),
 'scratch':('invoices','Create .pig/tasks/invoices.json as an Accordion task list to build invoice totals and tax calculation, with separate independently verifiable tasks and final regression tests. The goal is correct invoice totals. Write and validate the file.'),
 'repair':('repair','Repair .pig/tasks/repair.json into a valid Accordion task list. Preserve its intended work, supply a goal consistent with the title, and validate the file.'),
}

def run(case, arm, port):
 slug,prompt=CASES[case];root=BASE/(__import__('os').environ.get('SKILL_RUNS','skill-runs'))/case/arm;root.mkdir(parents=True,exist_ok=False);work=root/'work';config=root/'config';session=root/'session';work.mkdir();config.mkdir();session.mkdir()
 (config/'settings.json').write_text(json.dumps({'shellPath':'/skill-shell'}));(config/'models.json').write_text(json.dumps({'providers':{'deepseek':{'baseUrl':'http://127.0.0.1:'+port,'apiKey':'sandbox-only'}}}))
 ref=work/'reference';ref.mkdir();shutil.copyfile(SOURCE/'skills/accordion-task-lists/references/tasks.schema.json',ref/'tasks.schema.json')
 if case=='repair':
  dest=work/'.pig/tasks';dest.mkdir(parents=True);(dest/'repair.json').write_text(json.dumps({'version':2,'slug':'repair','title':'Repair authorization checks','tasks':[{'id':'2','title':'Check permissions','acceptanceCriteria':['Permission checks reject unauthorised access']}]}))
 if arm=='with-skill':
  ext=work/'extension';ext.mkdir();shutil.copyfile(SOURCE/'taskSchema.ts',ext/'taskSchema.ts');shutil.copytree(SOURCE/'skills/accordion-task-lists',ext/'skills/accordion-task-lists')
 cmd=['bwrap','--unshare-user','--unshare-pid','--share-net','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
  '--ro-bind',str(BASE/'skill-shell'),'/skill-shell','--ro-bind',str(pathlib.Path('/mnt/Projects/furbyhaxx/pi-accordion/.pi/worktrees/taskfold-tree/extension/node_modules')),'/opt/pi/node_modules',
  '--tmpfs','/opt/pi/node_modules/.cache','--bind',str(work),'/work','--bind',str(config),'/config','--bind',str(session),'/session','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
  '--chdir','/work','--clearenv','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','PI_CODING_AGENT_DIR','/config',
  '/usr/bin/node','/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js','--no-extensions','--no-skills','--no-mcp','--no-session','--no-context-files',
  '--tools','read,write,bash','--provider','deepseek','--model','deepseek-flash','--thinking','off','--mode','json']
 if arm=='with-skill':cmd+=['--skill','/work/extension/skills/accordion-task-lists']
 result=subprocess.run(cmd+['-p',prompt],capture_output=True,text=True,timeout=180);(root/'run.jsonl').write_text(result.stdout);(root/'stderr').write_text(result.stderr)
 events=[]
 for line in result.stdout.splitlines():
  try: events.append(json.loads(line))
  except ValueError: pass
 assistant=[e.get('message',{}) for e in events if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant']
 cost=sum((m.get('usage',{}).get('cost',{}) or {}).get('total',0) for m in assistant)
 used_skill=any('accordion-task-lists/SKILL.md' in json.dumps(part) for m in assistant for part in m.get('content',[]) if part.get('type')=='toolCall')
 target=work/'.pig/tasks'/(slug+'.json');inside=target.exists() and not target.is_symlink() and target.resolve().is_relative_to(work.resolve())
 if not inside:return {'case':case,'arm':arm,'agent_exit':result.returncode,'valid':False,'reason':'missing or unsafe target'}
 check=subprocess.run(['node',str(SOURCE/'skills/accordion-task-lists/scripts/validate.mjs'),str(target)],capture_output=True,text=True,timeout=30)
 try:
  data=json.loads(target.read_text()); leaves=[]
  def walk(nodes):
   for node in nodes:
    if not isinstance(node,dict): continue
    if node.get('subtasks'): walk(node['subtasks'])
    else: leaves.append(node)
  walk(data.get('tasks',[])); criteria=bool(leaves) and all(1<=len(x.get('acceptanceCriteria',[]))<=3 for x in leaves)
 except (ValueError,TypeError,AttributeError): criteria=False
 return {'case':case,'arm':arm,'agent_exit':result.returncode,'valid':check.returncode==0,'leaf_criteria':criteria,'used_skill':used_skill,'cost':cost,'validator':(check.stdout+check.stderr).strip()[:300]}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--port',required=True);args=parser.parse_args()
 for case in CASES:
  for arm in ('baseline','with-skill'): print(json.dumps(run(case,arm,args.port)),flush=True)
if __name__=='__main__':main()
