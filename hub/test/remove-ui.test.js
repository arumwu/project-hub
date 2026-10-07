'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove');
const uiLocale=require('./ui-locale-fixture');
const source=fs.readFileSync(path.join(__dirname,'../public/remove.js'),'utf8');
function fixture(t, failAt=1) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-remove-ui-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
 for(const name of ['Alpha','Beta'])write(path.join(root,'Product',name,'PROJECT.md'),`---\nname: ${name}\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n`);
 const task=path.join(root,'Product/Alpha/.ai/tasks/work.md'),chat=path.join(root,'Product/Alpha/.ai/chat/work.jsonl'),other=path.join(root,'Product/Beta/PROJECT.md');
 write(task,'---\nid: work\ntitle: 作業の原名\nowner: 人\nstate: 未着手\n---\n## 手順\n- [ ] 作業\n');write(chat,'original chat\n');
 const before={task:fs.readFileSync(task),chat:fs.readFileSync(chat),other:fs.readFileSync(other)};
 const store=new Store(root);let moves=0, failing=true;
 const removal=new Removal({store,trash:path.join(root,'trash'),rename:(from,to)=>{if(failing&&++moves===failAt)throw Object.assign(Error('fixture move failure'),{code:'EIO'});fs.renameSync(from,to);}});
 const elements=new Map(),handlers=[],calls=[];
 function element(key) {
  if(!elements.has(key))elements.set(key,{textContent:'',innerHTML:'',value:'',disabled:false,hidden:false,dataset:{},insertAdjacentHTML(where,html){this.innerHTML+=html;},querySelectorAll(){return [element('#remove-apply'),element('#remove-typed')];}});
  return elements.get(key);
 }
 const sheet=element('#remove-sheet');let html='';
 Object.defineProperty(sheet,'innerHTML',{get:()=>html,set:value=>{html=value;for(const key of ['#remove-status','#remove-apply','#remove-typed'])elements.delete(key);const button=value.match(/<button[^>]*id="remove-apply"[^>]*>/);if(button)element('#remove-apply').disabled=/\bdisabled\b/.test(button[0]);}});
 const api=async(route,body)=>{calls.push({route,body:JSON.parse(JSON.stringify(body))});if(route.endsWith('/preview'))return removal.preview(body.project,body.task);if(route.endsWith('/apply'))return removal.apply(body);if(route.endsWith('/restore'))return removal.restore(body.record,body.confirm);throw Error('unexpected API '+route);};
 const context=vm.createContext({HubI18n:uiLocale('zh-TW'),$:element,esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),api,
  document:{body:{insertAdjacentHTML(){}},addEventListener(name,cb){if(name==='click')handlers.push(cb);},querySelectorAll:()=>[]},
  view:{kind:'project',project:'Beta',task:null},proj:id=>store.readProject(id),displayParent:()=>'',state:{projects:[]},load:async()=>{},save(){},toast(){},confirm:()=>true});
 vm.runInContext(source,context);
 async function click(action){const button=action==='apply'?element('#remove-apply'):{disabled:false};button.dataset={removeAction:action};for(const handler of handlers)await handler({target:{closest:selector=>selector==='[data-remove-action]'?button:null}});}
 return{root,store,removal,context,calls,element,task,chat,other,before,click,setFixed(){failing=false;},run:code=>vm.runInContext(code,context)};
}
test('A zero-move failure requires a fresh same-target preview before retrying and never changes another project',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');const first=f.run('removePreview.token');assert.equal(f.element('#remove-apply').disabled,false,f.element('#remove-sheet').innerHTML);
 await f.click('apply');assert.equal(f.element('#remove-apply').disabled,true);assert.match(f.element('#remove-status').textContent,/無法移動/);assert.doesNotMatch(f.element('#remove-status').textContent,/0項可以還原/);
 assert.match(f.element('#remove-status').innerHTML,/data-remove-action="refresh"/);assert.doesNotMatch(f.element('#remove-status').innerHTML,/data-remove-restore/);
 assert.equal(f.removal.tokens.has(first),false);assert.deepEqual(fs.readFileSync(f.task),f.before.task);assert.deepEqual(fs.readFileSync(f.chat),f.before.chat);
 await f.click('apply');assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).length,1);
 f.setFixed();await f.click('refresh');const next=f.run('removePreview.token');assert.notEqual(next,first);assert.equal(f.element('#remove-apply').disabled,false);
 assert.deepEqual(f.calls.at(-1),{route:'/api/hierarchy/remove/preview',body:{project:'Alpha',task:'work'}});
 await f.click('apply');assert.equal(fs.existsSync(f.task),false);assert.equal(fs.existsSync(f.chat),false);assert.deepEqual(fs.readFileSync(f.other),f.before.other);
 assert.equal(f.context.view.project,'Beta');assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).at(-1).body.token,next);
});
test('A partial failure retains the real journal restore record even if refreshed task preview no longer exists',async t=>{
 const f=fixture(t,2);await f.context.showRemoval('Alpha','work');await f.click('apply');
 const result=f.run('removeResult');assert.equal(result.moved.length,1);assert.equal(fs.existsSync(f.task),false);assert.deepEqual(fs.readFileSync(f.chat),f.before.chat);
 assert.match(f.element('#remove-status').innerHTML,new RegExp('data-remove-restore="'+result.record+'"'));
 await f.click('refresh');assert.match(f.element('#remove-status').innerHTML,new RegExp('data-remove-restore="'+result.record+'"'));assert.match(f.element('#remove-status').innerHTML,/作業不存在|沒有作業|作業がありません/);
 assert.equal(f.element('#remove-apply').disabled,true);assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).length,1);
 f.setFixed();await f.context.restoreRemoval(result.record);assert.deepEqual(fs.readFileSync(f.task),f.before.task);assert.deepEqual(fs.readFileSync(f.chat),f.before.chat);assert.deepEqual(fs.readFileSync(f.other),f.before.other);
});
test('Refreshing confirmation rejects a different target without enabling an old consumed token',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');await f.click('apply');
 const token=f.run('removePreview.token');f.context.api=async()=>({...f.removal.preview('Beta'),task:''});
 await f.click('refresh');assert.equal(f.run('removePreview.token'),token);assert.equal(f.element('#remove-apply').disabled,true);assert.match(f.element('#remove-status').innerHTML,/刪除目標已變更/);
 assert.deepEqual(fs.readFileSync(f.task),f.before.task);assert.deepEqual(fs.readFileSync(f.other),f.before.other);
});

test('Maintenance history does not call a zero-move journal restored or offer a meaningless restore',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');await f.click('apply');
 const removed=f.removal.history();assert.equal(removed.length,1);assert.equal(removed[0].count,0);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/maintenance.js'),'utf8'),f.context);
 f.context.historyFixture={token:'preview',candidates:[],excluded:[],history:[],scripts:[],removed};
 f.run('maintenanceProject="Alpha";maintenanceData=historyFixture;drawMaintenance()');
 const html=f.element('#maintenance-body').innerHTML;assert.match(html,/沒有移動任何項目/);assert.doesNotMatch(html,/已還原|data-maint-action="unremove"/);
});
