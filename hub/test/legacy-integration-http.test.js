'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const path=require('node:path'), os=require('node:os'), net=require('node:net'), {execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'), chat=require('../lib/chat');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-legacy-http-'));
let server, base;
test.before(async()=>{
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port;
  await new Promise(r=>probe.close(r));
  process.env.HUB_ROOT=root; process.env.HUB_DRY_RUN='1'; process.env.HUB_AI_HOME=path.join(root,'home'); process.env.HUB_PORT=String(port); process.env.HUB_TRASH=path.join(root,'Trash');
  fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  ({server}=require('../server')); await new Promise(r=>server.listen(port,'127.0.0.1',r)); base='http://127.0.0.1:'+port;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
const post=(route,b)=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(b)});
for (const location of ['recent','older-than-500','rotated']) for (const handedUp of [false,true]) test('旧成功ログの証跡を祖先統合で受領し、旧ログと本体を保持（'+location+'／成果を渡す：'+handedUp+'）',async()=>{
  const project='Project Hub '+location+' '+(handedUp?'offered':'auto');
  const body=path.join(root,'System',project),dir=path.join(root,'Product',project);fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nphases: []\nfolders:\n  本体: ${body}\n---\n`);
  const store=new Store(root),parent=store.createTask(project,{title:'本作業'}),child=store.createTask(project,{title:'固定機能',parent:parent.id,steps:['完成']});store.setStep(project,child.id,0,true);
  const date='2026-10-06T10:09:35Z',sh=(...args)=>execFileSync('git',['-C',body,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost',GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}}).trim();
  sh('init','-q','-b','main');fs.writeFileSync(path.join(body,'base.txt'),'base');sh('add','.');sh('commit','-qm','base');
  sh('checkout','-qb','child');fs.writeFileSync(path.join(body,'result.txt'),'fixture result');sh('add','.');sh('commit','-qm','result');sh('checkout','-q','main');sh('merge','--no-ff','-qm',`取り込み: ${child.id} ${child.title}`,'child');
  const commit=sh('rev-parse','HEAD'),log=path.join(root,'_hub/log.jsonl');
  const oldLine=JSON.stringify({at:'2026-10-06T10:09:35.295Z',action:'merge',project:project,task:child.id,ok:true,conflict:false})+'\n';
  const noise=Array.from({length:600},()=>JSON.stringify({action:'read',project,task:parent.id})).join('\n')+'\n';
  const receiptLog=location==='rotated'?log.replace(/\.jsonl$/,'.old.jsonl'):log;
  fs.rmSync(log.replace(/\.jsonl$/,'.old.jsonl'),{force:true});
  fs.writeFileSync(log,location==='rotated'?noise:oldLine+(location==='recent'?'':noise));
  if(location==='rotated')fs.writeFileSync(receiptLog,oldLine+noise);
  const input={project:project,task:child.id,expectTitle:child.title};
  let r;
  if(handedUp){
    r=await post('/api/task/handup/preview',input);assert.equal(r.status,200);const offer=await r.json();
    assert.deepEqual(offer.blockers,[]);assert.deepEqual(offer.files,[]);assert.equal(offer.hasCode,true);
    r=await post('/api/task/handup',{...input,token:offer.token,selected:[],confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).handedUp,true);
    assert.ok(store.taskFile(project,child.id));assert.equal(chat.read(dir,parent.id).filter(x=>x.handoff).length,0);assert.equal(sh('rev-parse','HEAD'),commit);
  }
  r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);const d=await r.json();
  assert.equal(d.items.length,1);const item=d.items[0];assert.deepEqual(item.blockers,[]);assert.deepEqual(item.files,[]);assert.equal(item.handedUp,handedUp);
  assert.equal(item.integrated.commit,commit);assert.equal(item.integrated.recovered,true);assert.deepEqual(item.integrated.files,['result.txt']);
  r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,selected:[{project,task:child.id,files:[],optional:[]}],confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).complete,true);
  const rows=chat.read(dir,parent.id).filter(x=>x.handoff);assert.equal(rows.length,1);const row=rows[0];assert.ok(row.integrating);assert.match(row.text,/古い取り込み記録を本体の履歴と照合/);assert.match(row.text,/result.txt/);assert.match(row.text,/統合先/);
  assert.match(fs.readFileSync(store.taskFile(project,parent.id),'utf8'),/古い取り込み記録を本体の履歴と照合/);
  assert.equal(store.taskFile(project,child.id),null);assert.equal(fs.readFileSync(path.join(body,'result.txt'),'utf8'),'fixture result');assert.equal(sh('rev-parse','HEAD'),commit);
  assert.ok(fs.readFileSync(receiptLog,'utf8').startsWith(oldLine));assert.equal(fs.readFileSync(receiptLog,'utf8').split(oldLine).length,2);
  r=await post('/api/task/handup/preview',input);assert.equal(r.status,409);assert.match((await r.json()).error,/もう受け取って/);
});
