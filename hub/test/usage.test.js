'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Usage, readCli, codexWindows, claudeWindows, resetTime } = require('../lib/usage');

const NOW = Date.parse('2026-10-03T00:00:00Z');
const codex = { rateLimits:{ limitId:'codex',primary:{usedPercent:0,windowDurationMins:10080,resetsAt:1791046922},secondary:null,credits:{balance:'SECRET'}} };
const claude = { subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:20,resets_at:'2026-10-03T05:00:00Z'},seven_day:null,model_scoped:[{display_name:'Fable',utilization:33,resets_at:'2026-10-07T13:00:00Z'}]},behaviors:{private:'SECRET'} };

test('Codex uses actual window duration including weekly-only primary and allows zero usage', () => {
  const rows = codexWindows(codex);
  assert.equal(rows[0].label,'週間枠'); assert.equal(rows[0].usedPercent,0);
  assert.equal(rows[0].resetsAt,new Date(1791046922000).toISOString());
  assert.doesNotMatch(JSON.stringify(rows),/SECRET|credits/);
  const byId = { rateLimits:codex.rateLimits,rateLimitsByLimitId:{codex:{primary:{usedPercent:45,windowDurationMins:300},secondary:{usedPercent:71,windowDurationMins:10080}},other:{limitName:'Other',primary:{usedPercent:12,windowDurationMins:60}}} };
  assert.deepEqual(codexWindows(byId).map(r=>r.label),['5時間枠','週間枠','Other・1時間枠']);
});
test('Claude exposes only available subscription windows, including model scope', () => {
  assert.deepEqual(claudeWindows(claude).map(r=>[r.label,r.usedPercent]),[['5時間枠',20],['Fable・週間枠',33]]);
  assert.doesNotMatch(JSON.stringify(claudeWindows(claude)),/SECRET|behaviors/);
  assert.throws(()=>claudeWindows({subscription_type:null,rate_limits_available:false}),/subscription/);
  assert.throws(()=>claudeWindows({subscription_type:'max',rate_limits:null}),/unavailable/);
});
test('Missing, non-finite and malformed fields remain unknown rather than zero or an invented reset', () => {
  assert.equal(resetTime(null),null); assert.equal(resetTime('bad'),null); assert.equal(resetTime(Infinity),null);
  assert.equal(resetTime(1791046922000),null); assert.equal(resetTime('9999-01-01'),null);
  assert.equal(resetTime('2026-10-03T00:00:00+09:00'),'2026-10-02T15:00:00.000Z');
  const rows=codexWindows({rateLimits:{primary:{usedPercent:null,resetsAt:null},secondary:{usedPercent:NaN,resetsAt:'bad'}}});
  assert.ok(rows.every(r=>r.usedPercent===null && r.resetsAt===null));
  assert.equal(rows[0].label,'利用枠'); assert.throws(()=>codexWindows(null),/format/);
});
test('Successful reads are cached, coalesced and manually limited; automatic failures do not retry', async () => {
  let now=NOW, calls=0, unblock;
  const u = new Usage({now:()=>now,find:ai=>ai,read:async ai=>{calls++; if(calls<=2) await new Promise(r=>{const old=unblock;unblock=()=>{old?.();r();};}); return ai==='codex'?codex:claude;}});
  const a=u.status(), b=u.status(true); assert.equal(calls,2); unblock();
  assert.deepEqual(await a,await b); assert.equal((await u.status()).providers.codex.status,'ok'); assert.equal(calls,2);
  await u.status(true); assert.equal(calls,2);
  now+=31000; await u.status(true); assert.equal(calls,4);
  now+=300001; await u.status(); assert.equal(calls,6);
  u.read=async()=>{calls++;throw new Error('SECRET');}; now+=31000;
  const failed=await u.status(true); assert.ok(Object.values(failed.providers).every(p=>p.windows.length===0 && p.status==='unavailable'));
  assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
  const count=calls; now+=3600000; await u.status(); assert.equal(calls,count);
  u.read=async ai=>ai==='codex'?codex:claude; assert.equal((await u.status(true)).providers.claude.status,'ok');
});
test('Missing CLI and dry mode never spawn a CLI', async () => {
  let calls=0;
  for(const opts of [{find:()=>''},{dry:true,find:()=>{throw new Error('must not find');}}]) {
    const u=new Usage({...opts,read:()=>{calls++;}}); const r=await u.status();
    assert.equal(r.providers.codex.status,'unavailable'); assert.equal(r.providers.claude.status,'unavailable');
  }
  assert.equal(calls,0);
});

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-usage-'));
const fake=path.join(dir,'cli.cjs');
fs.writeFileSync(fake,`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const [ai,log,mode]=process.argv.slice(2);
const send=x=>{const s=JSON.stringify(x)+'\\n';process.stdout.write(s.slice(0,7));process.stdout.write(s.slice(7));};
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
  if(mode==='timeout')return;
  if(mode==='oversize'){process.stdout.write('x'.repeat(2100000));return;}
  if(ai==='codex'){
    if(m.id===0)send({id:0,result:{}});
    if(m.id===1)send({id:1,result:{account:{type:mode==='api'?'apiKey':'chatgpt',email:'SECRET'}}});
    if(m.id===2)send({id:2,result:${JSON.stringify(codex)}});
  }else{
    const id=m.request_id;
    if(m.request.subtype==='initialize')send({type:'control_response',response:{request_id:id,subtype:'success',response:{account:{email:'SECRET'}}}});
    if(m.request.subtype==='get_usage')send({type:'control_response',response:{request_id:id,subtype:mode==='unsupported'?'error':'success',error:'SECRET',response:${JSON.stringify(claude)}}});
  }
  process.stderr.write('SECRET\\n');
});
`);
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
function fixture(ai,mode='ok') {
  const log=path.join(dir,`${ai}-${mode}-${Math.random()}.jsonl`), children=[], args=[];
  return {log,children,args,spawn(file,argv,opts){args.push(argv); const p=spawn(process.execPath,[fake,ai,log,mode],opts); children.push(p);return p;}};
}
test('Both real subprocess protocols send only fixed state requests and exit before completion', async () => {
  for(const ai of ['codex','claude']) {
    const f=fixture(ai);
    const r=await readCli(ai,ai,{spawn:f.spawn,timeoutMs:3000});
    const rows=ai==='codex'?codexWindows(r):claudeWindows(r);
    assert.ok(rows.length); assert.doesNotMatch(JSON.stringify(rows),/SECRET/);
    assert.notEqual(f.children[0].exitCode===null && f.children[0].signalCode===null,true);
    const requests=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
    if(ai==='codex') assert.deepEqual(requests.map(x=>x.method),['initialize','initialized','account/read','account/rateLimits/read']);
    else {
      assert.deepEqual(requests.map(x=>x.request.subtype),['initialize','get_usage']);
      assert.equal(requests[1].request.skip_behaviors,true);
      assert.ok(f.args[0].includes('--safe-mode')); assert.ok(f.args[0].includes('{"disableAllHooks":true}'));
      assert.equal(f.args[0][f.args[0].indexOf('--model')+1],'claude-fable-5-1');
    }
    assert.ok(requests.every(x=>x.type!=='user' && !x.method?.includes('turn') && !x.method?.includes('thread')));
  }
});
test('API-only account stops before Codex rate-limit request', async () => {
  const f=fixture('codex','api');
  await assert.rejects(readCli('codex','codex',{spawn:f.spawn,timeoutMs:3000}),/subscription/);
  assert.doesNotMatch(fs.readFileSync(f.log,'utf8'),/rateLimits/);
});
test('Unsupported Claude control returns sanitized error and ends the process', async () => {
  const f=fixture('claude','unsupported');
  await assert.rejects(readCli('claude','claude',{spawn:f.spawn,timeoutMs:3000}),e=>e.usageCode==='unsupported' && !e.message.includes('SECRET'));
});
test('Hanging or oversized CLI output is bounded and process is stopped', async () => {
  for(const mode of ['timeout','oversize']) {
    const f=fixture('codex',mode);
    await assert.rejects(readCli('codex','codex',{spawn:f.spawn,timeoutMs:mode==='timeout'?100:3000}),e=>e.usageCode===(mode==='timeout'?'timeout':'format'));
    assert.ok(f.children[0].signalCode || f.children[0].exitCode!==null);
  }
});
