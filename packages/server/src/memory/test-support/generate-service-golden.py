#!/usr/bin/env python3
"""Pure pinned-source rank/block reference for real service integration scenario."""
import ast,hashlib,json,math,pathlib,subprocess,sys,types
commit='d2e2f96236bbc95512719204126395bd87561302'
hashes={}
def load(path,extra=None):
 raw=subprocess.check_output(['git','-C',sys.argv[1],'show',f'{commit}:{path}']);hashes[path]=hashlib.sha256(raw).hexdigest()
 tree=ast.parse(raw);tree.body=[n for n in tree.body if not isinstance(n,(ast.Import,ast.ImportFrom))]
 ns={'math':math,**(extra or {})};exec(compile(tree,path,'exec'),ns);return types.SimpleNamespace(**ns)
config=load('backend/memory/config.py');ranking=load('backend/memory/ranking.py',{'config':config});block=load('backend/memory/block.py',{'config':config})
def fact(id,text,kind='event',importance=3,turn=5,**extra):
 return dict(id=id,text=text,fact_type=kind,importance=importance,valence=0,participants=['Player','Mira'],reinforcements=0,last_turn=turn,valid_until_turn=None,pinned=False,distance=0,location='Gate',**extra)
promise=fact('promise','Mira promised to return.','promise',4,10);promise['reinforcements']=1
oldstate=fact('oldstate','The gate remains closed.','state',4);oldstate['valid_until_turn']=10
old=[fact(f'old-{i}',f'Earlier event {i+1} occurred.') for i in range(6)]
newstate=fact('newstate','The gate is open.','state',4,10)
new=[fact(f'new-{i}',f'Later event {i+1} occurred.',turn=10) for i in range(7)]
override=fact('override','The city gate stands open.','state',5,0);override.update(pinned=True,location=None,participants=[])
secret=fact('secret','The key is under the stone.','event',4,0);secret.update(location=None,participants=[])
lore=fact('gate-lore','The city gate stands open.','lore',3,11);lore.update(source='lore',pinned=True,participants=[],location=None)
ranked=ranking.rank([promise,oldstate,*old,*new,secret],['Player','Mira','Tomas'],11,'Gate')
cluster={'id':'cluster','summary_text':'Mira returned; the gate opened and the hidden key came to light.','created_turn':10}
expected,used,dropped=block.build_block([override,lore],[newstate],ranked,1000,[cluster])
payload={'commit':commit,'sourceHashes':hashes,'block':expected,'memoryLines':[block._render(f) for f in [override,newstate,*ranked]],'usedIds':used,'droppedIds':dropped}
pathlib.Path(__file__).with_name('service-golden.json').write_text(json.dumps(payload,indent=2)+'\n')
