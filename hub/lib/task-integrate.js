'use strict';
const { lt } = require("./locale");
// 祖先側の確認→子孫ごとの取り込み→受領→片付け。段階を保存し再開する。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const graph = require('../public/project-order'), git = require('./git');
const { noLinks, exists, snapshot } = require('./remove');
const hash = s => createHash('sha256').update(s).digest('hex');
const key = x => x.project + '\0' + x.task;
const expand = s => s?.startsWith('~/') ? path.join(os.homedir(),s.slice(2)) : s;
class TaskIntegrate {
  constructor({store,transfer,removal,baseOf=p=>p.dir,gitw=git}) {
    Object.assign(this,{store,transfer,removal,baseOf,gitw});this.tokens=new Map();
    this.dir=path.join(store.root,'_hub/task-integrations');
    transfer.beforeCleanup=r=>this.cleanupCopy(r);
  }
  file(project,task){return path.join(this.dir,hash(project+'\0'+task)+'.json');}
  read(project,task){const f=this.file(project,task);noLinks(f);return exists(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;}
  save(r){const f=this.file(r.project,r.task);noLinks(f);fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(f+'.tmp',JSON.stringify(r,null,2));fs.renameSync(f+'.tmp',f);}
  pending(){
    if(!exists(this.dir))return [];noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).flatMap(n=>{
      try{const f=path.join(this.dir,n);noLinks(f);const r=JSON.parse(fs.readFileSync(f,'utf8'));return r.complete?[]:[{project:r.project,task:r.task,id:r.id,items:r.items.map(x=>({project:x.project,task:x.task,title:x.title,state:x.state}))}];}catch{return [];}
    });
  }
  ancestor(project,task){
    const all=this.store.listProjects(),p=all.find(x=>x.id===project),t=p?.tasks.find(x=>x.id===task);
    if(!t)throw Error(lt('統合する親作業が見つかりません'));
    if(this.removal.busy(project,task)||this.removal.locked(project))throw Error(lt('親作業でAI・整理・確認が動いています。この返事が終わってから統合してください'));
    const q=path.join(p.dir,'.ai/chat',task+'.queue.json');noLinks(q);
    if(exists(q)){const rows=JSON.parse(fs.readFileSync(q,'utf8'));if(!Array.isArray(rows)||rows.length)throw Error(lt('親作業に順番待ちがあります'));}
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))throw Error(lt('親の作業場所の記録が不正です'));
    if(copy&&!exists(wd))throw Error(lt('親の作業用コピーが見つかりません。記録を片付けてから統合してください'));
    const target=copy?wd:this.baseOf(p);noLinks(target);
    return {all,p,t,target};
  }
  details(a,p,t,ownId){
    const r=this.transfer.read(p.id,t.id),d=this.removal.describe(p.id,t.id);
    const blockers=d.blockers.filter(x=>!x.startsWith(lt('作業用コピー'))&&!x.startsWith(lt('下の作業や')));
    if(!graph.finished(t)||t.question)blockers.push(lt('子作業の手順・質問が残っています'));
    if(t.mergeExcluded)blockers.push(lt('取り込み対象から外されています'));
    if(t.kind==='derived'&&!require('./work-context').sourceOf(p,t.derivedFrom,a.all))blockers.push(lt('派生元が同じ大きなプロジェクト内にありません'));
    if(r?.complete)blockers.push(lt('受領済みの作業が復元されています。再統合はできません'));
    if(r?.integrating&&r.integrating!==ownId)blockers.push(lt('別の祖先の統合が進行中です'));
    if(r&&!r.handedUp&&!r.integrating&&!r.complete)blockers.push(lt('旧版の引渡しが進行中です。先にその続きを行ってください'));
    const ancestors=graph.ancestorsOf(p,t,a.all),depth=ancestors.findIndex(x=>x.project.id===a.p.id&&x.task.id===a.t.id)+1;
    const route=ancestors.slice(0,depth-1).reverse().map(x=>x.task.title).concat(t.title).join(' › ');
    const descendants=a.all.flatMap(q=>q.tasks.filter(x=>graph.ancestorsOf(q,x,a.all).some(y=>y.project.id===p.id&&y.task.id===t.id)).map(x=>({project:q.id,task:x.id,title:x.title,finished:graph.finished(x)&&!x.question})));
    if(descendants.some(x=>!x.finished))blockers.push(lt('未完了の子孫があります。先に下の作業を済ませてください'));
    let files=[];
    try{files=r?.handedUp?r.files:this.transfer.artifacts(p,t);for(const f of files)if(snapshot(f.path)!==f.fingerprint)throw Error(lt('渡し済みの成果が変わっています。成果を渡し直してください'));}catch(e){blockers.push(e.message);}
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))blockers.push(lt('子の作業場所の記録が不正です'));
    if(copy&&!exists(wd))blockers.push(lt('子の作業用コピーが見つかりません。記録を確認してください'));
    const preview=copy&&exists(wd)?this.gitw.preview({dir:wd,workRoot:this.removal.workRoot(p),target:a.target}):null;
    const source=copy&&exists(wd)?this.gitw.inspect(wd):null;
    if(copy&&!source)blockers.push(lt('子の作業用コピーのGitを確認できません'));
    const integrated=!copy?this.transfer.integration(p,t):null;
    if(!files.length&&!copy&&!integrated?.files?.length)blockers.push(lt('成果ファイルがありません。子の［成果を渡す］でファイルを指定してください'));
    return {project:p.id,task:t.id,title:t.title,taskHash:t.completionHash,route,depth,handedUp:Boolean(r?.handedUp),files,selected:files.map(f=>f.id),copy:copy?wd:null,source,preview,integrated,descendants,blockers:[...new Set(blockers)],move:d.move,optional:d.optional,keep:d.keep};
  }
  preview(project,task,only){
    const a=this.ancestor(project,task),old=this.read(project,task);
    if(old&&!old.complete){
      if(path.resolve(old.target)!==path.resolve(a.target))throw Error(lt('途中の統合先が変わっています。保存された統合先を確認してください'));
      return this.token({project,task,target:old.target,resume:true,id:old.id,items:old.items,ancestorHash:a.t.completionHash});
    }
    let items=a.all.flatMap(p=>p.tasks.filter(t=>graph.canIntegrate({project:a.p,task:a.t},p,t,a.all)&&graph.finished(t)).map(t=>this.details(a,p,t)));
    if(only){
      if(!Array.isArray(only))throw Error(lt('統合対象を確認してください'));
      const keys=new Set(only.map(key));
      for(const x of only){this.transfer.expectTitle(x.project,x.task,x.expectTitle);if(!items.some(i=>key(i)===key(x)))throw Error(lt('この祖先からはその子を統合できません'));}
      // 子を選んだ時は完了した孫も拾い、下から片付ける。
      for(const i of items)if(keys.has(key(i)))for(const d of i.descendants)keys.add(key(d));
      items=items.filter(i=>keys.has(key(i)));
    }
    items.sort((x,y)=>y.depth-x.depth||(x.preview?.files||0)-(y.preview?.files||0)||x.title.localeCompare(y.title));
    for(const i of items){
      if(i.descendants.some(d=>!items.some(x=>key(x)===key(d))))i.blockers.push(lt('子孫を先に統合する必要があります'));
      if(i.descendants.some(d=>items.find(x=>key(x)===key(d))?.blockers.length))i.blockers.push(lt('先に統合する子孫に確認が必要です'));
      i.overlaps=items.filter(j=>key(j)!==key(i)&&(j.preview?.paths||[]).some(f=>i.preview?.paths?.includes(f))).map(j=>j.title);
    }
    return this.token({project,task,target:a.target,ancestorHash:a.t.completionHash,targetSnapshot:this.gitw.inspect(a.target),items});
  }
  token(value){for(const [id,x]of this.tokens)if(Date.now()-x.at>600000)this.tokens.delete(id);const token=randomUUID();this.tokens.set(token,{at:Date.now(),value});return {...value,token};}
  apply({project,task,token,selected,confirm}){
    const x=this.tokens.get(token);
    if(!x||Date.now()-x.at>600000||confirm!==true||x.value.project!==project||x.value.task!==task)throw Error(lt('もう一度統合内容を確認してください'));
    const d=x.value,a=this.ancestor(project,task);let r=this.read(project,task);
    if(r?.complete&&r.id===d.id)return {ok:true,complete:true,duplicate:true};
    if(!d.resume){
      if(r&&!r.complete)throw Error(lt('別の統合が始まりました。続きを確認してください'));
      if(a.t.completionHash!==d.ancestorHash||path.resolve(a.target)!==path.resolve(d.target)||JSON.stringify(this.gitw.inspect(a.target))!==JSON.stringify(d.targetSnapshot))throw Error(lt('確認中に親作業・統合先が変わりました'));
      if(!Array.isArray(selected)||!selected.length||new Set(selected.map(key)).size!==selected.length)throw Error(lt('統合する子作業を選んでください'));
      const items=selected.map(s=>{
        const i=d.items.find(i=>key(i)===key(s));if(!i||i.blockers.length)throw Error(i?.blockers.join(' / ')||lt('統合対象が不正です'));
        const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:a.p,task:a.t},p,t,a.all))throw Error(lt('確認中に子作業・祖先の関係が変わりました'));
        const now=this.details(a,p,t);if(now.blockers.length)throw Error(now.blockers.join(' / '));
        if(JSON.stringify(now.source)!==JSON.stringify(i.source))throw Error(lt('確認中に子の変更が変わりました'));
        const ids=s.files===undefined?i.selected:s.files;
        if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!i.files.some(f=>f.id===id)))throw Error(lt('成果ファイルの選択が不正です'));
        const optional=s.optional||[];if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>!i.optional.some(f=>f.id===id)))throw Error(lt('片付ける専用フォルダが不正です'));
        const files=i.files.filter(f=>ids.includes(f.id));if(!files.length&&!i.copy&&!i.integrated?.files?.length)throw Error(lt('成果ファイルを選んでください'));
        for(const f of files)if(snapshot(f.path)!==f.fingerprint)throw Error(lt('確認中に成果ファイルが変わりました'));
        return {...i,files,optional,branch:i.source?.branch,state:'待ち'};
      });
      // 表示順を変更できても孫→子の制約は崩さない。
      for(let n=0;n<items.length;n++)for(const kid of items[n].descendants)if(!items.slice(0,n).some(i=>key(i)===key(kid)))throw Error(lt('子孫を一緒に選び、孫から先に統合してください'));
      r={id:randomUUID(),project,task,target:a.target,items,at:new Date().toISOString(),complete:false};this.save(r);d.id=r.id;
      for(const i of items){const h=this.transfer.read(i.project,i.task);if(h?.integrating&&h.integrating!==r.id)throw Error(lt('別の祖先が同じ子を統合しています'));this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }else if(!r||r.id!==d.id||r.complete)throw Error(lt('統合記録が変わりました'));
    if(path.resolve(a.target)!==path.resolve(r.target))throw Error(lt('統合先が変わりました'));
    this.active=r;
    try { return this.run(r); }catch(e){r.error=e.message;this.save(r);throw e;}finally{this.active=null;}
  }
  run(r){
    const a=this.ancestor(r.project,r.task);
    // 初回の予約保存が途中で止まった場合も、残りを予約してから処理する。
    for(const i of r.items){
      if(i.state==='片付け済み')continue;
      const h=this.transfer.read(i.project,i.task);
      if(h?.integrating&&h.integrating!==r.id)throw Error(lt('別の祖先が同じ子を統合しています'));
      if(!h?.integrating){if(h?.complete||h?.destination)throw Error(lt('子の受領記録が変わりました'));this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }
    for(const i of r.items){
      if(i.state==='片付け済み')continue;
      const receipt=this.transfer.read(i.project,i.task);
      if(receipt?.integrating!==r.id)throw Error(lt('子の統合予約が変わりました'));
      if(!receipt.receiving&&!receipt.complete){
        const current=this.ancestor(r.project,r.task),p=current.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:current.p,task:current.t},p,t,current.all))throw Error(lt('途中で子作業・祖先の関係が変わりました'));
        const details=this.details(current,p,t,r.id);if(details.blockers.length)throw Error(details.blockers.join(' / '));
        for(const f of i.files)if(snapshot(f.path)!==f.fingerprint)throw Error(lt('成果ファイルが変わりました'));
        if(i.state==='待ち'||i.state==='衝突'){
          if(i.copy){
            const merged=this.gitw.merge({dir:i.copy,workRoot:this.removal.workRoot(p),title:`${i.task} ${i.title}`,target:r.target,cleanup:false});
            if(merged.conflict){
              i.state='衝突';this.save(r);
              this.store.updateTask(r.project,r.task,{state:'返事待ち',question:lt`子作業「${i.title}」を統合する時にぶつかりました。AIを始めて「ブランチ ${i.branch} を統合先 ${r.target} へ取り込み、ぶつかった所を直して保存して」と頼んでから、もう一度［統合…］を押してください`});
              return {ok:false,conflict:true,complete:false,error:merged.error,items:r.items.map(x=>({title:x.title,state:x.state}))};
            }
            if(!merged.ok)throw Error(merged.error);
            i.integrated={dir:r.target,commit:merged.commit,files:merged.files};i.sourceSnapshot=this.gitw.inspect(i.copy);i.sourceHead=i.sourceSnapshot.head;
          }
          i.state='取り込み済み';this.save(r);
        }
      }
      const out=this.transfer.receiveIntegrated({project:i.project,task:i.task,targetProject:r.project,targetTask:r.task,integrating:r.id,files:i.files,integrated:i.integrated,optional:i.optional});
      i.receipt=out.record;i.state='片付け済み';this.save(r);
    }
    r.complete=true;r.error='';this.save(r);
    return {ok:true,complete:true,items:r.items.map(x=>({title:x.title,state:x.state})),parentProject:a.p.id,parent:a.t.id};
  }
  cleanupCopy(receipt){
    const r=this.active?.id===receipt.integrating?this.active:this.read(receipt.targetProject,receipt.targetTask),i=r?.items.find(x=>x.project===receipt.project&&x.task===receipt.task);
    if(!r||r.id!==receipt.integrating||!i)throw Error(lt('統合の片付け記録が見つかりません'));
    if(!i.copy||i.copyTrashed)return;
    if(!exists(i.copy)){
      // 移動後に停止しても、退避先とコミットを照合して登録整理を続ける。
      if(!i.copyTrashPlanned||!exists(i.copyTrashPlanned)||!i.sourceHead||!this.gitw.isAncestor(r.target,i.sourceHead))throw Error(lt('作業用コピーの退避先を確認できません'));
      noLinks(i.copyTrashPlanned);
      this.gitw.finishCleanupCopy({target:r.target,branch:i.branch,sourceHead:i.sourceHead});
      i.copyTrashed=i.copyTrashPlanned;this.save(r);return;
    }
    const out=this.gitw.cleanupCopy({dir:i.copy,workRoot:path.join(this.store.root,'Work',i.project),target:r.target,expectedSnapshot:i.sourceSnapshot,beforeMove:({trashed,branch,sourceHead})=>{i.copyTrashPlanned=trashed;i.branch=branch;i.sourceHead=sourceHead;this.save(r);}});
    i.copyTrashed=out.trashed;this.save(r);
  }
}
module.exports={TaskIntegrate};
