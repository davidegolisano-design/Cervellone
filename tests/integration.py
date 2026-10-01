"""Live end-to-end checks. Creates temporary rooms; never touches user games."""
import json,re,time,urllib.request,urllib.error,pathlib
cfg=pathlib.Path('dist/config.js').read_text()
URL=re.search(r"API_URL = '([^']+)'",cfg)[1];KEY=re.search(r"API_KEY = '([^']+)'",cfg)[1]
created=[]
def call(action,data,expect_error=False):
 req=urllib.request.Request(URL,data=json.dumps(dict(action=action,data=data)).encode(),headers={'Content-Type':'application/json','apikey':KEY,'Authorization':'Bearer '+KEY})
 try:
  with urllib.request.urlopen(req,timeout=15) as r:result=json.load(r)
 except urllib.error.HTTPError as e:
  result=json.load(e)
  if not expect_error:raise AssertionError(result)
  assert result.get('error'),result
  return result
 if expect_error:raise AssertionError('Expected rejection, got '+str(result)[:200])
 return result
print('Gateway connection',flush=True)
h=call('create',{'title':'Automated verification'});created.append(h['pin'])
host=dict(pin=h['pin'],role='host',secret=h['secret'])
p=call('join',{'pin':h['pin'],'name':'Test Player'})
player=dict(pin=h['pin'],role='player',secret=p['secret'])
view=dict(pin=h['pin'],role='display')
call('join',{'pin':h['pin'],'name':'test player'},True)
call('host',{**view,'command':'start'},True)
call('state',{**view,'role':'host'},True)
s=call('state',view);assert s['questions'] is None and s['question'] is None
qs=[{'question':'Verification 1','options':['A','B','C','D'],'correctIndex':0},{'question':'Verification 2','options':['A','B','C','D'],'correctIndex':1}]
call('host',{**host,'command':'upload','questions':[{**qs[0],'correctIndex':7}]},True)
call('host',{**host,'command':'upload','questions':qs})
call('host',{**host,'command':'settings','duration':90,'autoAdvance':False,'freeSkips':0,'penalty':200,'maxPoints':1300})
s=call('host',{**host,'command':'start'});assert s['phase']=='precount'
call('host',{**host,'command':'start'},True)
print('Rooms, permissions and validation OK',flush=True)
time.sleep(5.2)
s=call('state',view);assert s['phase']=='question',s['phase'];assert 'correctIndex' not in s['question']
ps=call('state',player);assert ps['question'] is None and ps['questions'] is None
s=call('answer',{**player,'idx':s['idx'],'round':s['round'],'choice':0});assert s['mine']['choice']==0
s=call('answer',{**player,'idx':s['idx'],'round':s['round'],'choice':1});assert s['mine']['choice']==0
rejoin=call('join',{'pin':h['pin'],'secret':p['secret'],'name':'Changed'});assert rejoin['secret']==p['secret'] and rejoin['name']=='Test Player'
call('join',{'pin':h['pin'],'name':'Too late'},True)
s=call('host',{**host,'command':'reveal'});score=s['board'][0]['score'];assert 780<=score<=1300
call('host',{**host,'command':'reveal'},True)
s=call('state',player);assert s['mine']['score']==score and s['mine']['result']=='correct'
s=call('state',player);assert s['mine']['score']==score
print('Exactly-once answers, reconnect and scoring OK',flush=True)
s=call('host',{**host,'command':'next'})
time.sleep(5.2)
s=call('state',player);assert s['phase']=='question'
call('answer',{**player,'idx':0,'round':s['round'],'choice':0},True)
s=call('host',{**host,'command':'reveal'})
s=call('state',player);assert s['phase']=='reveal';assert s['mine']['result']=='missed';assert s['mine']['score']==score-200
call('answer',{**player,'idx':s['idx'],'round':s['round'],'choice':1},True)
s=call('host',{**host,'command':'next'});assert s['phase']=='final'
s=call('host',{**host,'command':'reset'});assert s['phase']=='lobby' and s['board'][0]['score']==0
print('Stale-answer rejection, penalties, final and reset OK',flush=True)
pathlib.Path('tests/session.json').write_text(json.dumps(dict(host=host,player=player,created=created)))
print('PASS: live gateway integration',flush=True)
