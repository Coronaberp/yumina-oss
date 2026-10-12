#!/usr/bin/env python3
"""Development-only golden generation. AST whitelist avoids source imports and side effects.
Usage: python generate-parity.py /path/to/StoryHaven
Reads source only via git show COMMIT:path; never reads CFG, environments, providers or DBs.
Requires development pydantic>=2. Writes parity.json adjacent to this file.
"""
import ast, asyncio, hashlib, json, math, pathlib, re, subprocess, sys, types
from typing import Literal
from pydantic import BaseModel, Field, ValidationError, model_validator

COMMIT = 'd2e2f96236bbc95512719204126395bd87561302'
ROOT = sys.argv[1]
SOURCES = {}
def source(path):
    raw = subprocess.check_output(['git', '-C', ROOT, 'show', f'{COMMIT}:{path}'])
    SOURCES[path] = hashlib.sha256(raw).hexdigest()
    return raw.decode()

def load(path, names=None, extra=None):
    tree = ast.parse(source(path))
    tree.body = [n for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom)) and (names is None or getattr(n, 'name', None) in names or isinstance(n, (ast.Assign, ast.AnnAssign)) and any(getattr(t, 'id', None) in names for t in (n.targets if isinstance(n, ast.Assign) else [n.target])))]
    ns = dict(json=json, math=math, re=re, Literal=Literal, BaseModel=BaseModel, Field=Field, ValidationError=ValidationError, model_validator=model_validator, **(extra or {}))
    exec(compile(tree, path, 'exec'), ns)
    return types.SimpleNamespace(**ns)
config = load('backend/memory/config.py')
block = load('backend/memory/block.py', extra={'config': config})
ranking = load('backend/memory/ranking.py', extra={'config': config})
client = load('backend/inference/client.py', ['strip_json_fence'])
extraction = load('backend/memory/extraction.py', ['FactDraft','CharStateDraft','ReconcileDecision','LoreUpdateDecision','SecretRevealDecision','EXTRACT_EXAMPLE','build_extract_prompt','build_reconcile_prompt','build_lore_update_prompt','build_secret_reveal_prompt','_load_array','parse_extract_response','parse_reconcile','parse_lore_updates','parse_secret_reveals','_call_validated','run_extract','run_reconcile','run_lore_update_detection','run_secret_reveal_detection'], {'config':config, 'client':client, 'log':types.SimpleNamespace(warning=lambda *args:None)})
retrieval = load('backend/retrieval.py', ['LORE_CHUNK_THRESHOLD_TOKENS','LORE_RECURSION_MAX_DEPTH','LORE_RECURSION_MAX_ADDED','_estimate_tokens','_split_into_sentences','_split_oversized_sentence','_pack_sentences','chunk_lore_content','_CJK_RE','_key_in_text','_entry_matches'])
clusters = load('backend/memory/clusters.py', ['build_cluster_prompt','build_cluster_assign_prompt','ClusterAssignment','_parse_cluster_assign'], {'config':config,'client':client})

def dump(x):
    if isinstance(x, BaseModel): return x.model_dump()
    if isinstance(x, (list, tuple)): return [dump(y) for y in x]
    return x

def fact(id='a', **kw):
    return dict(id=id,text='Mira arrived.',fact_type='event',participants=['Mira'],importance=3,valence=0,reinforcements=0,last_turn=10,valid_until_turn=None,pinned=False,location='',distance=0.4, **kw)
# kw overrides require a dedicated update to avoid duplicate keyword args.
def f(id='a', **kw):
    d = fact(id); d.update(kw); return d
fixtures = {'commit':COMMIT,'provenance':{'procedure':'AST-selected pure source definitions; original imports never executed','pydantic_version':__import__('pydantic').__version__, 'python_version':sys.version.split()[0]}, 'tokens':[], 'ranking':[], 'rank':[], 'blocks':[], 'chunks':[], 'prompts':[], 'parsers':[], 'clusters':[]}
for text in ['', 'abc', 'abcd', '😀😀😀😀', '中文你好', 'A\U0001f9d1\u200d\U0001f680e\u0301']:
    fixtures['tokens'].append({'text':text,'expected':block.estimate_tokens(text)})
for ft in config.FACT_TYPES:
    for age in [0,30,31,100,1000]:
        d = f(f'{ft}-{age}',fact_type=ft,last_turn=10,location=' Dock ',valence=-2,reinforcements=2)
        fixtures['ranking'].append({'fact':d,'turn':10+age,'location':'dock','present':['mira'],'expected':{'active':ranking.is_active(d,'dock'),'retention':ranking.retention(d,10+age,'dock'),'score':ranking.score(d,10+age,'dock',{'mira'}),'passes':ranking.passes_filters(d,{'mira'},10+age,'dock')}})
for d in [f('profile-low',fact_type='profile',importance=1),f('demoted',fact_type='state',demoted=True),f('absent',participants=['Alice']),f('lore',source='lore'),f('pinned',pinned=True),f('expired',fact_type='state',valid_until_turn=12),f('blank-location',location='   '),f('world',fact_type='world',participants=['Alice'])]:
    fixtures['ranking'].append({'fact':d,'turn':50,'location':'dock','present':['mira'],'expected':{'active':ranking.is_active(d,'dock'),'retention':ranking.retention(d,50,'dock'),'score':ranking.score(d,50,'dock',{'mira'}),'passes':ranking.passes_filters(d,{'mira'},50,'dock')}})
for candidates in [[f('a'),f('b'),f('old',last_turn=-1000)], [f('absent',participants=['Alice']),f('present')]]:
    fixtures['rank'].append({'candidates':candidates,'present':['Mira'],'turn':50,'location':'dock','expected':[c['id'] for c in ranking.rank(candidates,['Mira'],50,'dock')]})
block_cases = [([],[],[],100,[]),([f('huge',text='x'*80,importance=5),f('small',text='yes')],[],[f('scored-long',text='x'*90),f('tail',text='yes')],15,[]),([f('p')],[f('a',fact_type='state')],[f('l',source='lore',metadata={'is_open':True,'empty':[],'people':['Mira',None,2],'zero':0},links=[{'label':'Near','name':'Dock'}],link_label='friend'),f('e',valid_until_turn=15)],100,[]),([],[],[f('emoji',text='😀'*20)],20,[]),([],[],[f('a')],100,[{'id':'c','title':'旅','summary_text':'word '*180,'created_turn':10}]),([],[],[],350,[{'id':'c','title':'','summary_text':'😀'*900,'created_turn':10}])]
for p,a,r,b,c in block_cases:
    fixtures['blocks'].append({'pinned':p,'active':a,'ranked':r,'budget':b,'clusters':c,'expected':dump(block.build_block(p,a,r,b,c))})
for content in ['', ' a short entry ', '😀'*1800,'x'*1801,'A sentence. '*300,'First paragraph\n\n'+'Second paragraph! '*180,'word '*1000,'\n\n'+('中'*900)+'\n\n'+('文'*900),'x'*1900+' word '+ 'y'*1900]:
    fixtures['chunks'].append({'content':content,'expected':retrieval.chunk_lore_content(content)})
drafts = [extraction.FactDraft(text='Mira promised to return. 😀',fact_type='promise',participants=['Mira'],importance=4,valence=1),extraction.FactDraft(text='The king fell.',fact_type='event',participants=[],importance=5,valence=-1)]
neighbors = [[{'id':'mf_1','text':'Mira was away.'}],[]]
for cast in [None,[],['Mira','Ryōshū']]:
    args = ['Alice: hello\nMira: 你好😀','Mira','Alice','English',cast]
    fixtures['prompts'].append({'kind':'extract','args':args,'expected':extraction.build_extract_prompt(*args)})
for kind in ['reconcile','lore_update','secret_reveal']:
    fixtures['prompts'].append({'kind':kind,'args':[dump(drafts),neighbors],'expected':getattr(extraction,'build_'+kind+'_prompt')(drafts,neighbors)})
fixtures['prompts'].append({'kind':'cluster','args':[neighbors[0],None],'expected':clusters.build_cluster_prompt(neighbors[0])})
fixtures['prompts'].append({'kind':'cluster','args':[neighbors[0],'A previous arc.'],'expected':clusters.build_cluster_prompt(neighbors[0],'A previous arc.')})
fixtures['prompts'].append({'kind':'cluster_assign','args':[[{'id':'c','title':'','summary_text':'summary'}],neighbors[0]],'expected':clusters.build_cluster_assign_prompt([{'id':'c','title':'','summary_text':'summary'}],neighbors[0])})
base = dict(text='confirmed',fact_type='event',participants=[],importance=3,valence=0)
parse_cases = [('extract',json.dumps({'facts':[dict(base,fact_type=t) for t in config.FACT_TYPES]}),None,None),('extract','```JSON\n'+json.dumps({'facts':[dict(base,importance=' 3.0 ',valence=False)],'char_state':{'doing':'','npcs':[],'ignored':9}})+'\n```',None,None),('extract','{}',None,None),('extract','{"facts": null, "char_state": false}',None,None),('extract','[]',None,None),('extract',json.dumps({'facts':[dict(base,importance=3.1)]}),None,None),('extract',json.dumps({'facts':[dict(base,text='')]}),None,None),('extract',json.dumps({'facts':[dict(base,importance=0,valence=3,participants=[4])]}),None,None),('extract',json.dumps({'facts':[dict(base,text=4)]}),None,None),('extract',json.dumps({'facts':[dict(base,importance='nan')]}),None,None),('extract',json.dumps({'char_state':{'npcs':None}}),None,None),('reconcile','[{"index":"1.0","action":"reinforce","target_id":"mf_1"},{"index":false,"action":"add"}]',2,['mf_1']),('reconcile','[{"index":0,"action":"add"},{"index":0,"action":"add"}]',1,[]),('reconcile','[{"index":0,"action":"reinforce","target_id":"missing"}]',1,[]),('reconcile','[{"index":0,"action":"reinforce"}]',1,[]),('reconcile','[]',1,[]),('lore_updates','[{"index":0,"lore_id":"l","new_content":" "},{"index":0,"lore_id":"l","new_content":"b"}]',1,['l']),('lore_updates','[{"index":1,"lore_id":"l","new_content":"b"}]',1,['l']),('secret_reveals','[{"index":0,"secret_id":""}]',1,['']),('secret_reveals','[{"index":-1,"secret_id":"s"}]',1,['s']),('secret_reveals','{}',1,[])]
parse_cases.extend([('extract',raw,None,None) for raw in ['', 'not json', '{', '{\"facts\":', '{\"facts\": []', '{\"facts\": [],}', '{\"facts\": [1,]}', '{} trailing', '[', '\"unterminated', '{\"facts\": \"bad\\x\"}', '{\"facts\": \"bad\\uZZZZ\"}', '{\"facts\": \"bad\ntext\"}']])
parse_cases.extend([('extract',json.dumps({'facts':[dict(base,importance=value)]}),None,None) for value in [True, '01', '+2.00', '1_0', '３', 0.0, 6.0, None, [], {}]])
parse_cases.extend([('extract',json.dumps({'facts':[item]}),None,None) for item in [None, 3, [], {}, dict(base,fact_type='bad')]])
parse_cases.extend([('reconcile',raw,1,[]) for raw in ['', '[', 'null']])
for kind,raw,count,ids in parse_cases:
    case = {'kind':kind,'raw':raw,'factCount':count,'validIds':ids}
    fn = extraction.parse_extract_response if kind=='extract' else getattr(extraction,'parse_'+kind)
    try: case['expected'] = dump(fn(raw) if kind=='extract' else fn(raw,count,set(ids)))
    except Exception as e: case['error'] = str(e)
    fixtures['parsers'].append(case)
for c in [[{'id':'a','created_turn':10,'distance':0.5},{'id':'b','created_turn':10,'distance':0.5},{'id':'old','created_turn':0}],[]]:
    fixtures['clusters'].append({'clusters':c,'turn':100,'expected':[v['id'] for v in ranking.rank_clusters(c,100)],'scores':[ranking.score_cluster(v,100) for v in c]})
prompt_helpers = load('backend/prompt.py', ['DIRECTOR_SIGIL','THINK_RE','strip_think','recent_text'])
service = load('backend/memory/service.py', ['_TRUSTED_OOC_RE','is_ooc_transcript_message','exchanges','current_turn','user_turn_ordinals','present_participants','_transcript'], {'DIRECTOR_SIGIL':prompt_helpers.DIRECTOR_SIGIL,'strip_think':prompt_helpers.strip_think})
fixtures['transcripts'] = []
for group in [False,True]:
    msgs=[{'id':'0','role':'system','content':'system'}, {'id':'1','role':'user','content':'(OOC: ordinary untrusted text)'}, {'id':'2','role':'assistant','content':'<think>private</think> reply','char_id':'m'}, {'id':'3','role':'assistant','content':'second reply','char_id':'r'}, {'id':'4','role':'user','content':' (╾━╤デ╦︻ : [OOC] director)'}, {'id':'5','role':'assistant','content':'<think>x</think> (ooc: reply)'}, {'id':'6','role':'user','content':'你好😀','sender_user_id':'u'}, {'id':'7','role':'assistant','content':'<think> hidden\nreason </think>answer'}, {'id':'8','role':'user','content':'incomplete'}]
    batch = service.exchanges(msgs,group)
    fixtures['transcripts'].append({'messages':msgs,'group':group,'pairIndexes':[[msgs.index(u),msgs.index(a)] for u,a in batch], 'ooc':[service.is_ooc_transcript_message(m) for m in msgs], 'turn':service.current_turn(msgs), 'ordinals':service.user_turn_ordinals(msgs), 'recent':prompt_helpers.recent_text(msgs), 'transcript':service._transcript(batch,'Default','Player',{'m':'Mira','r':'Ryōshū'},{'u':'Alice'})})
fixtures['keywordMatches']=[{'key':key,'text':text,'expected':retrieval._key_in_text(key,text.lower())} for key,text in [('Mira','Mirabelle'),('Mira','éMira'),('Mira','Mira'),('猫','小猫咪'),('東京','東京都'),('kael','Kael_2'),('-x','--x '),('x-',' x--'),('','word'),('',''),('a.b','a.b!')]]
fixtures['runs'] = []
async def generate_runs():
    cases=[('extract',['[]','{}']),('extract',['TRANSPORT_ERROR']),('extract',['[]','[]']),('reconcile',['[]','[]']),('reconcile',['[]','[{"index":0,"action":"add"},{"index":1,"action":"reinforce","target_id":"mf_1"}]']),('lore_update_detection',['{}','[]']),('secret_reveal_detection',['{}','[{"index":0,"secret_id":"mf_1"}]'])]
    for kind,responses in cases:
        calls=[]
        async def fake_call(prompt,*args,**kwargs):
            calls.append(prompt)
            response=responses[len(calls)-1]
            if response=='TRANSPORT_ERROR': raise RuntimeError('transport')
            return response
        fn=getattr(extraction,'run_'+kind)
        fn.__globals__['_call']=fake_call
        if kind=='extract': output=await fn('Transcript 😀','Mira','Alice','English','fake')
        else: output=await fn(drafts,neighbors,'fake')
        fixtures['runs'].append({'kind':kind,'responses':responses,'prompts':calls,'expected':dump(output)})
asyncio.run(generate_runs())
fixtures['sourceHashes'] = SOURCES
pathlib.Path(__file__).with_name('parity.json').write_text(json.dumps(fixtures,ensure_ascii=False,indent=2)+'\n')
print(f'Generated {sum(len(v) for v in fixtures.values() if isinstance(v,list))} cases; source hashes {len(SOURCES)}')
