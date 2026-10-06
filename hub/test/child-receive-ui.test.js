'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture() {
 const elements=new Map(),events={},calls=[];
 const el=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',hidden:false,textContent:'',value:'',dataset:{},addEventListener(){},setAttribute(){},querySelectorAll:()=>[],insertAdjacentHTML(){}});return elements.get(s);};
 const document={querySelector:el,querySelectorAll:()=>[],body:{insertAdjacentHTML(){},classList:{contains:()=>false}},addEventListener:(n,f)=>(events[n]||=[]).push(f)};
 const ctx=vm.createContext({document,window:{},navigator:{userAgent:''},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),setInterval(){},setTimeout(){},clearInterval(){},clearTimeout(){},requestAnimationFrame(){},console,URLSearchParams,ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order')});
 const run=s=>vm.runInContext(s,ctx);
 run(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));
 run(fs.readFileSync(path.join(__dirname,'../public/task-transfer.js'),'utf8'));
 ctx.stubApi=async(route,body)=>{calls.push({route,body});if(ctx.failure){const e=Error(ctx.failure);e.status=ctx.status;throw e;}if(route.endsWith('/preview'))return{token:'fixture',title:'小作業',target:'本作業',files:[{id:'report',bytes:1}],blockers:[],guidance:''};return{parentProject:'p',parent:'parent'};};
 run(`api=stubApi;save=()=>{};load=async()=>{};render=()=>{};toast=()=>{};state={version:'4.63.2',latest:'4.63.3',projects:[{id:'p',name:'見本',tasks:[{id:'parent',title:'本作業',steps:[]},{id:'kid',title:'小作業',parent:'parent',state:'完了',steps:[]}]}],sessions:[],chatting:[]};view={kind:'work',project:'p',task:'parent'};`);
 return{ctx,run,el,calls,click:async action=>{for(const f of events.click||[])await f({target:{dataset:{},closest:s=>s==='[data-transfer-action]'?{dataset:{transferAction:action},disabled:false}:null}});}};
}
test('古い稼働版では帯とカードの受領を無効にし正式な版切替案内を表示する',async()=>{
 const f=fixture();f.run(`state.version='4.59.0'`);
 for(const html of [f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childTitle:'小作業',text:'結果'})`)]){assert.match(html,/disabled/);assert.match(html,/新しい版 v4\.63\.3 にする/);assert.match(html,/AI と順番待ちが終わってから/);}
 await f.run('showTaskTransfer("p","kid")');assert.equal(f.calls.length,0);assert.match(f.el('#transfer-sheet').innerHTML,/新しい版/);
 // 数字で比較し、窓口追加版から有効。
 f.run(`state.version='4.61.0'`);assert.doesNotMatch(f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),/disabled/);
});
test('古い結果名と現在の子が違えば別の子を指さない。旧本文・新childTitle・別プロジェクトを照合',()=>{
 const f=fixture();
 for(const row of [`{childTitle:'昔の子',text:'結果'}`,`{text:'（子作業「昔の子」の結果）\\n本文'}`]){
  const html=f.run(`msgHtml({role:'user',from:'subtask',child:'kid',...${row}})`);assert.doesNotMatch(html,/data-act="absorb"/);assert.match(html,/同じ番号の別の作業/);
 }
 const html=f.run(`msgHtml({role:'user',from:'subtask',child:'kid',text:'（子作業「小作業」の結果）\\n本文'})`);assert.match(html,/data-expect-title="小作業"/);
 f.run(`state.projects.push({id:'q',name:'別',tasks:[{id:'kid',title:'別の子',kind:'derived',derivedFrom:'p/parent'}]})`);
 assert.match(f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childProject:'q',childTitle:'別の子',text:'結果'})`),/data-p="q"/);
 assert.match(f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childTitle:'小作業',handoff:'receipt',text:'受領'})`),/もう受け取って/);
});
test('previewと適用の404 not foundは版切替案内へ、業務エラーと通信失敗はその理由を保持',async()=>{
 const f=fixture();f.ctx.failure='not found';f.ctx.status=404;await f.run('showTaskTransfer("p","kid",[],"小作業")');assert.match(f.el('#transfer-sheet').innerHTML,/新しい版/);assert.match(f.el('#transfer-sheet').innerHTML,/窓口を確認できません/);assert.doesNotMatch(f.el('#transfer-sheet').innerHTML,/not found|まだ v/);
 f.ctx.failure='片付け済み';f.ctx.status=409;await f.run('showTaskTransfer("p","kid")');assert.match(f.el('#transfer-sheet').innerHTML,/片付け済み/);assert.doesNotMatch(f.el('#transfer-sheet').innerHTML,/新しい版/);
 f.ctx.failure='network failure';f.ctx.status=undefined;await f.run('showTaskTransfer("p","kid")');assert.match(f.el('#transfer-sheet').innerHTML,/network failure/);
 f.ctx.failure=null;await f.run('showTaskTransfer("p","kid",[],"小作業")');assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
 await f.click('refresh');assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
 f.ctx.failure='not found';f.ctx.status=404;await f.click('apply');assert.match(f.el('#transfer-status').textContent,/新しい版/);assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
});
