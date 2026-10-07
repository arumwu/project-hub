'use strict';
// Japanese remains the default when this module is loaded on its own.
var UI = globalThis.HubI18n || { text: value => value, html: value => value, label: value => value, message: value => value, valueAttribute: () => '', dateLocale: 'ja-JP',
  template: (strings, ...values) => strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '') };

let removePreview=null, removePending=false, removeEpoch=0, removeResult=null;
function drawRemoval(d) {
 const el=$('#remove-sheet');el.innerHTML=UI.template`<div class="remove-box"><h2>「${esc(d.title)}」を削除しますか</h2><h3>ゴミ箱へ移すもの（${d.move.length}）</h3>${d.move.map(x=>`<p>${esc(x.what)}<br><small>${esc(x.path)}</small></p>`).join('')}
 ${d.optional.length?UI.template`<h3>選べば一緒に移すもの</h3>${d.optional.map(x=>`<label class="maintenance-choice"><input type="checkbox" data-remove-option="${esc(x.id)}"><span>${esc(x.path)}<small>${esc(x.why)}</small></span></label>`).join('')}`:''}
 <h3>残すもの</h3>${d.keep.length?d.keep.map(x=>`<p>${esc(x.path)}<br><small>${esc(x.why)}</small></p>`).join(''):UI.html('<p>確認した範囲に共有先はありません。</p>')}
 ${d.blockers.length?UI.template`<h3 class="danger">削除できない理由</h3>${d.blockers.map(x=>`<p class="danger">${esc(x)}</p>`).join('')}`:''}${d.warnings.map(x=>`<p>${esc(x)}</p>`).join('')}
 ${d.typed?UI.template`<label>資料・成果物を含みます。確認のため「${esc(d.title)}」を入力してください<input id="remove-typed" autocomplete="off"></label>`:''}
 <p>あとで［整理と確認］の記録から元に戻せます。</p><p id="remove-status" role="status"></p><div class="acts"><button class="btn plain" data-remove-action="close" type="button">やめる</button><button class="btn danger" id="remove-apply" data-remove-action="apply" type="button" ${d.blockers.length||d.typed?'disabled':''}>ゴミ箱へ移す</button></div></div>`;
}
async function showRemoval(project,task) {
 if(removePending)return;const epoch=++removeEpoch;removePreview=null;removeResult=null;
 if(!$('#remove-sheet'))document.body.insertAdjacentHTML('beforeend',UI.html('<div id="remove-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="削除内容の確認"></div>'));
 $('#remove-sheet').hidden=false;$('#remove-sheet').innerHTML=UI.html('<div class="remove-box"><p>削除できる範囲を確認しています…</p><button class="btn plain" data-remove-action="close" type="button">閉じる</button></div>');
 try {const d=await api('/api/hierarchy/remove/preview',{project,task});if(epoch!==removeEpoch)return;removePreview=d;drawRemoval(d);}catch(e){if(epoch===removeEpoch)$('#remove-sheet').innerHTML=UI.template`<div class="remove-box"><p>${esc(e.message)}</p><button class="btn plain" data-remove-action="close" type="button">閉じる</button></div>`;}
}
function removalResult(r, retry = true) {
 const status=$('#remove-status');
 status.textContent=r.failed.length?(r.moved.length?UI.template`途中で止まりました。移した${r.moved.length}件は元に戻せます。${r.failed.map(x=>x.why).join(' / ')}`:UI.text('移動できませんでした。')+' '+r.failed.map(x=>x.why).join(' / ')):UI.template`${r.moved.length}件をゴミ箱へ移しました。`;
 if(r.moved.length)status.insertAdjacentHTML('beforeend',UI.template` <button class="btn plain sm" data-remove-restore="${esc(r.record)}" type="button">元に戻す</button>`);
 if(retry&&r.failed.length)status.insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-remove-action="refresh" type="button">もう一度削除内容を確認</button>'));
}
async function refreshRemoval() {
 if(removePending||!removePreview)return;
 const target=removePreview, prior=removeResult, epoch=++removeEpoch, status=$('#remove-status');
 const controls=[...$('#remove-sheet').querySelectorAll('button,input')], disabled=controls.map(control=>control.disabled);
 removePending=true;controls.forEach(control=>{control.disabled=true;});
 try {
  const next=await api('/api/hierarchy/remove/preview',{project:target.project,task:target.task});
  if(epoch!==removeEpoch)return;
  if(next.project!==target.project||(next.task||'')!==(target.task||''))throw Error(UI.text('削除する対象が変わりました。もう一度開いてください。'));
  removePreview=next;drawRemoval(next);
  if(prior?.moved.length)removalResult(prior,false);
  $('#remove-status').insertAdjacentHTML('beforeend',UI.html('<span> 削除内容を更新しました。内容を確認してから、もう一度移してください。</span>'));
 }catch(error){
  if(epoch===removeEpoch){
   if(prior)removalResult(prior);
   status.insertAdjacentHTML('beforeend',`<span class="danger"> ${esc(error.message)}</span>`);
  }
 }finally{removePending=false;controls.forEach((control,index)=>{control.disabled=disabled[index];});}
}
async function restoreRemoval(record) {
 if(!confirm(UI.text('ゴミ箱へ移したものを元に戻しますか？同名のファイルは上書きしません。')))return null;
 const r=await api('/api/hierarchy/remove/restore',{record,confirm:true});await load();return r;
}
document.addEventListener('input',e=>{if(e.target.id==='remove-typed')$('#remove-apply').disabled=removePending||removePreview.blockers.length>0||e.target.value!==removePreview.title;});
document.addEventListener('click',async e=>{
 const b=e.target.closest?.('[data-remove-action]');if(!b||removePending)return;
 if(b.dataset.removeAction==='refresh'){await refreshRemoval();return;}
 if(b.dataset.removeAction==='close'){removeEpoch++;$('#remove-sheet').hidden=true;return;}
 if(b.dataset.removeAction!=='apply'||!removePreview||removePreview.blockers.length||b.disabled)return;
 const d=removePreview;removePending=true;b.disabled=true;$('#remove-status').textContent=UI.text('ゴミ箱へ移しています…');
 try {
  const r=await api('/api/hierarchy/remove/apply',{token:d.token,optional:[...document.querySelectorAll('[data-remove-option]:checked')].map(x=>x.dataset.removeOption),typed:$('#remove-typed')?.value,confirm:true});
  removeResult=r;removalResult(r);
  if(r.moved.length){if(view.project===d.project&&(!d.task||view.task===d.task)){const p=proj(d.project);view={kind:'project',project:d.task?d.project:displayParent(p,state.projects)||'Project Hub',task:null};save();}await load();}
 }catch(err){$('#remove-status').textContent=err.message;$('#remove-status').insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-remove-action="refresh" type="button">もう一度削除内容を確認</button>'));}
 finally{removePending=false;/* 古いプレビューで再送しない */}
});
document.addEventListener('click',async e=>{const b=e.target.closest?.('[data-remove-restore]');if(!b||b.disabled)return;b.disabled=true;try{const r=await restoreRemoval(b.dataset.removeRestore);if(r){b.parentElement.textContent=r.skipped.length?UI.template`戻した${r.restored}件。残した理由：${r.skipped.map(x=>x.why).join(' / ')}`:UI.template`${r.restored}件を元に戻しました`;}}catch(err){toast(err.message);}finally{b.disabled=false;}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!removePending&&$('#remove-sheet')){removeEpoch++;$('#remove-sheet').hidden=true;}});
