'use strict';
// Project Hub 第3版の画面
// 左：プロジェクトと作業の木 ／ 右：概要画面 または 作業画面（Claude Code と Codex を並べられる）
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATES = ['未着手', '実行中', '返事待ち', '停止', '上限で停止', '完了'];
const NEEDS = t => t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了');
const CLI = o => /claude|codex/i.test(o || '') || !o;
const aiOf = o => (/codex/i.test(o || '') ? 'codex' : 'claude');
const AI_KEY = { claude: 'claude-code', codex: 'codex' };
const AI_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const OTHER = { claude: 'codex', codex: 'claude' };
// 担当の種類：画面の中の AI（丸）・Discord のエージェント（角）・あなた（黄）
function ownerOf(o) {
  const v = String(o || '').trim();
  if (!v || /claude|codex/i.test(v)) return { kind: aiOf(v), name: AI_LABEL[aiOf(v)], ic: aiOf(v) === 'codex' ? 'X' : 'C' };
  if (/^(人|あなた)$/.test(v)) return { kind: 'you', name: 'あなた', ic: '人' };
  const name = v.replace(/^discord:\s*/i, '');
  return { kind: 'agent', name, ic: name.slice(0, 1), sub: 'Discord' };
}
function chip(p, t) {
  const o = ownerOf(t.owner), running = o.kind === 'claude' || o.kind === 'codex' ? live(p.id, t.id, o.kind) : false;
  const sub = o.kind === 'agent' ? o.sub : (o.kind === 'you' ? '' : specText(t, o.kind));
  return `<span class="chip k-${o.kind}"><span class="ic">${esc(o.ic)}</span>${esc(o.name)}${sub ? `<small>・${esc(sub)}</small>` : ''}${running ? '<span class="blink" title="作業中"></span>' : ''}</span>`;
}
// 進み具合：手順があれば手順の数、なければ状態から
function progressOf(t) {
  if (t.steps.length) return { done: t.steps.filter(x => x.done).length, all: t.steps.length };
  return { done: t.state === '完了' ? 1 : 0, all: 1 };
}
function progressBar(t) {
  const { done, all } = progressOf(t), fin = t.state === '完了';
  const segs = t.steps.length ? t.steps.map(x => `<i class="${x.done ? 'on' : ''}"></i>`).join('') : `<i class="${fin ? 'on' : ''}"></i>`;
  return `<div class="prog ${fin ? 'fin' : ''}"><div class="segs">${segs}</div><span>${t.steps.length ? `${done} / ${all}` : ''}${fin ? '　完了 ✓' : ''}</span></div>`;
}
// フェーズ：今のフェーズ＝最初の未完了。作業は phase で分ける（無ければ今のフェーズに入れる）
function phaseInfo(p) {
  const names = p.phases.map(ph => ph.name);
  const cur = p.phases.findIndex(ph => ph.state !== '完了');
  const curName = cur >= 0 ? names[cur] : '';
  const inPhase = (t, i) => (names.includes(t.phase) ? t.phase === names[i] : i === cur);
  const list = p.phases.map((ph, i) => {
    const ts = p.tasks.filter(t => inPhase(t, i));
    const got = ts.reduce((a, t) => a + progressOf(t).done, 0), all = ts.reduce((a, t) => a + progressOf(t).all, 0);
    const tasksDone = ts.length > 0 && ts.every(t => t.state === '完了');
    return { name: ph.name, role: ph.role, state: ph.state || '未着手', tasks: ts, ratio: ph.state === '完了' ? 1 : all ? got / all : 0, tasksDone };
  });
  return { list, cur, curName, done: list.filter(x => x.state === '完了').length, inPhase };
}
function ring(done, all) {
  const c = 37.7, off = all ? c * (1 - done / all) : c;
  return `<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--idle-bg)" stroke-width="3"/><circle cx="8" cy="8" r="6" fill="none" stroke="${done === all && all ? 'var(--ok)' : 'var(--accent)'}" stroke-width="3" stroke-dasharray="${c}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>`;
}

let state = { projects: [], root: '', roles: { models: {}, roles: [] }, sessions: [], terminal: false, efforts: [] };
let view = { kind: 'project', project: null, task: null }; // project | work | turn | settings
let open = new Set(); // 左の木で開いているプロジェクト
let panes = {}; // ai → { xterm, fit, es, ro }
let rolesDraft = null;
let stateLoadEpoch = 0;
let renderedTreeKey = '', renderedMainKey = '';
try { const v = JSON.parse(localStorage.getItem('hub-view') || 'null'); if (v) view = v; open = new Set(JSON.parse(localStorage.getItem('hub-open') || '[]')); } catch (e) { /* 使えない時はそのまま */ }

async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || '失敗しました'); e.reason = j.reason; e.stage = j.stage; throw e; }
  return j;
}
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { e.hidden = true; }, 3000); }
function save() { try { localStorage.setItem('hub-view', JSON.stringify(view)); localStorage.setItem('hub-open', JSON.stringify([...open])); } catch (e) { /* 無視 */ } }

const proj = id => state.projects.find(p => p.id === id);
const taskOf = (p, id) => p && p.tasks.find(t => t.id === id);
const WAIT_SEC = 20;   // 画面がこの秒数止まっていたら「入力待ち」
const TURN_SEC = 60;   // これ以上待たせていたら「あなたの番」に出す
const sessOf = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && s.ai === ai && s.running);
const aiWaiting = (p, t) => state.sessions.filter(s => s.project === p && s.task === t && s.running && s.quiet >= TURN_SEC);
function statusText(s) {
  if (!s) return '';
  if (s.quiet < WAIT_SEC) return '<span class="pst busy"><i></i>作業中</span>';
  const m = Math.floor(s.quiet / 60);
  return `<span class="pst wait" title="画面が止まっています。返事や指示を待っているかもしれません">入力待ち${m ? `（${m}分）` : ''}</span>`;
}
const live = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && (!ai || s.ai === ai) && s.running)
  || (!ai && (state.chatting || []).find(c => c.project === p && c.task === t));

function specOf(t, ai) {
  const r = state.roles.roles.find(x => x.name === t.role);
  const key = AI_KEY[ai];
  const slot = r ? (r.main.ai === key ? r.main : r.backup.ai === key ? r.backup : null) : null;
  return { model: t.model || (slot && slot.model) || '', effort: state.efforts.includes(t.effort) ? t.effort : (slot && slot.effort) || '' };
}
const specText = (t, ai) => { const s = specOf(t, ai); return [s.model, s.effort].filter(Boolean).join('・'); };

async function load() {
  const epoch = ++stateLoadEpoch;
  const next = await api('/api/state');
  if (epoch !== stateLoadEpoch) return;
  state = next;
  if (!proj(view.project)) view.project = state.projects[0] ? state.projects[0].id : null;
  if (view.kind === 'work' && !taskOf(proj(view.project), view.task)) view.kind = 'project';
  showInTree();
  render();
}
// 今見ている物が左の木で見えるように、上の階層だけ開く（開き直すのは見る物が変わった時だけ。閉じた物は閉じたまま）
let shownKey = '';
function showInTree() {
  const key = [view.kind, view.project, view.task].join('/');
  if (key === shownKey) return;
  shownKey = key;
  let p = proj(view.project);
  if (!p) return;
  if (view.task) for (let t = taskOf(p, view.task), n = 0; t && t.parent && n < 20; n++) { open.add(`t:${p.id}/${t.parent}`); t = taskOf(p, t.parent); }
  for (let n = 0; p && n < 20; n++) { open.add(p.id); p = p.parent ? state.projects.find(x => x.id === p.parent || x.name === p.parent) : null; }
  save();
}

// ---- 左の木 ----
function childrenProjects(parent) {
  return state.projects.filter(p => (p.parent || '') === parent || (parent && proj(parent) && p.parent === proj(parent).name));
}
function taskTree(p, parentId) {
  const kids = p.tasks.filter(t => (t.parent || '') === (parentId || '') || (!parentId && t.parent && !taskOf(p, t.parent)));
  if (!kids.length) return '';
  return kids.map(t => {
    const isLive = live(p.id, t.id);
    const isWait = aiWaiting(p.id, t.id).length > 0;
    const sub = taskTree(p, t.id);
    const tk = `t:${p.id}/${t.id}`, tOpen = open.has(tk);
    return `<button class="node t ${view.kind === 'work' && view.project === p.id && view.task === t.id ? 'sel' : ''}" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" title="${esc(t.title)}">
        <span class="caret" ${sub ? `data-toggle="${esc(tk)}"` : ''}>${sub ? (tOpen ? '▼' : '▶') : ''}</span><span class="sdot ${taskLight(p, t, isLive, isWait).cls}" title="${taskLight(p, t, isLive, isWait).tip}"></span>
        ${t.parent ? '<span class="fork" title="分岐した作業">↳</span>' : ''}<span class="nm">${esc(t.title)}</span>${NEEDS(t) || isWait ? '<span class="q" title="あなたの番">!</span>' : ''}</button>
      ${sub && tOpen ? `<div class="kids">${sub}</div>` : ''}`;
  }).join('');
}
// プロジェクトの丸：灰＝まだ始めていない／赤＝AI が作業中／薄緑＝処理が終わった／紫＝人が完了にした
function projectLight(p) {
  if (p.status === '完了') return { cls: 'pl-fin', tip: '完了' };
  const working = state.sessions.some(s => s.project === p.id && s.running) || (state.chatting || []).some(c => c.project === p.id);
  if (working) return { cls: 'pl-work', tip: 'AI が作業中' };
  if (p.tasks.some(t => t.state && t.state !== '未着手')) return { cls: 'pl-rest', tip: '処理が終わりました（完了にするまで続けられます）' };
  return { cls: 'pl-new', tip: 'まだ始めていません' };
}
// 作業（子）の丸：灰＝まだ／赤＝AI が作業中／黄＝あなたの返事が必要／薄緑＝処理が終わった／紫＝完了
function taskLight(p, t, isLive, isWait) {
  if (isWait) return { cls: 'wait', tip: 'AI が入力を待っています' };
  if (isLive) return { cls: 'pl-work', tip: 'AI が作業中' };
  if (NEEDS(t) || ['返事待ち', '停止', '上限で停止'].includes(t.state)) return { cls: 'wait', tip: 'あなたの返事が必要です' };
  if (t.state === '完了') return { cls: 'pl-fin', tip: '完了' };
  if (!t.state || t.state === '未着手') return { cls: 'pl-new', tip: 'まだ始めていません' };
  return { cls: 'pl-rest', tip: '処理が終わりました' };
}
function projectNode(p, depth) {
  const isOpen = open.has(p.id);
  const subs = state.projects.filter(x => x.parent && (x.parent === p.id || x.parent === p.name));
  const n = p.tasks.filter(t => NEEDS(t) || aiWaiting(p.id, t.id).length).length;
  const forks = subs.length + p.tasks.filter(t => t.parent).length;
  const tasks = p.tasks.filter(t => t.state !== '完了');
  return `<button class="node p ${view.kind === 'project' && view.project === p.id ? 'sel' : ''}" data-go="project" data-p="${esc(p.id)}" type="button">
      <span class="caret" data-toggle="${esc(p.id)}">${tasks.length || subs.length ? (isOpen ? '▼' : '▶') : ''}</span>
      <span class="sdot ${projectLight(p).cls}" title="${projectLight(p).tip}"></span>
      ${p.parent ? '<span class="fork" title="分岐したプロジェクト">↳</span>' : ''}<span class="nm">${esc(p.name)}</span>
      ${forks ? `<span class="fork" title="分岐">⑂${forks}</span>` : ''}${n ? `<span class="q">${n}</span>` : ''}
      ${p.phases.length ? `<span class="phn" title="終わったフェーズ ${phaseInfo(p).done} / ${p.phases.length}">${ring(phaseInfo(p).done, p.phases.length)}</span>` : ''}</button>
    ${isOpen ? `<div class="kids">${taskTree({ ...p, tasks }, '')}${subs.map(s => projectNode(s, depth + 1)).join('')}</div>` : ''}`;
}
// quiet は毎秒増えるので、表示が変わる境目だけ比較する。
const waitingKey = s => s.running ? [s.project, s.task, s.ai, Math.floor((s.quiet || 0) / 60), s.quiet >= TURN_SEC] : [s.project, s.task, s.ai, false];
function treeKey() {
  return JSON.stringify([state.projects, state.sessions.map(s => [s.project, s.task, s.ai, s.running, s.quiet >= TURN_SEC]), state.chatting, view.kind, view.project, view.task, [...open]]);
}
function mainKey() {
  const p = proj(view.project);
  const common = [view.kind, view.project, view.task, state.root, state.terminal, state.roles, state.efforts, state.cliFlags];
  if (view.kind === 'work') {
    const sessions = workMode() === 'term' ? state.sessions.filter(s => s.project === view.project && s.task === view.task).map(s => [s.ai, s.running]) : [];
    return JSON.stringify([...common, p && p.name, p && p.phases, taskOf(p, view.task), sessions]);
  }
  if (view.kind === 'project') return JSON.stringify([...common, p, state.projects.map(x => [x.id, x.name]), state.sessions.filter(s => s.project === view.project).map(waitingKey), state.chatting]);
  if (view.kind === 'turn') return JSON.stringify([...common, state.projects, state.sessions.map(waitingKey), state.chatting]);
  return JSON.stringify([...common, state.projects]);
}
function renderTree() {
  const roots = state.projects.filter(p => !p.parent || !state.projects.some(x => x.id === p.parent || x.name === p.parent));
  $('#list').innerHTML = `<div class="cap">プロジェクト</div><div class="tree">${roots.map(p => projectNode(p, 0)).join('')}</div>
    <button class="newp ${view.kind === 'newproject' ? 'sel' : ''}" data-go="newproject" type="button">＋ 新しいプロジェクト</button>`;
  renderedTreeKey = treeKey();
}

// ---- 全体 ----
function render() {
  if (view.kind !== 'settings') { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  const waiting = state.projects.flatMap(p => p.tasks.filter(t => NEEDS(t) || aiWaiting(p.id, t.id).length).map(t => ({ p, t })));
  $('#turn-n').textContent = waiting.length;
  showVersion(state.version, state.latest);
  $('#turn').setAttribute('aria-pressed', view.kind === 'turn');
  $('#gear').setAttribute('aria-pressed', view.kind === 'settings');
  renderTree();
  if (view.kind !== 'work') closePanes();
  if (view.kind === 'settings') renderSettings();
  else if (view.kind === 'newproject') renderNewProject();
  else if (!state.projects.length) renderEmpty();
  else if (view.kind === 'turn') renderTurn(waiting);
  else if (view.kind === 'work') renderWork();
  else renderOverview(proj(view.project));
  renderedMainKey = mainKey();
}

function renderEmpty() {
  $('#main').innerHTML = `<div class="view"><div class="empty"><h2>台帳が見つかりません</h2>
    <p><code>${esc(state.root)}/Product/</code> に台帳（PROJECT.md）がありません。</p>
    <p>ターミナルで <code>bash setup.sh</code> を実行すると、今の作業の台帳が作られます。</p></div></div>`;
}

function renderTurn(list) {
  $('#main').innerHTML = `<div class="view"><div class="ph"><h2>あなたの番</h2><span class="small">返事待ち・上限で止まっている作業と、AI が入力を待っている作業</span></div>
    ${list.length ? `<div class="card">${list.map(({ p, t }) => taskRow(p, t, true)).join('')}</div>` : '<p class="note">今はありません。</p>'}</div>`;
}

// ---- 新しいプロジェクト ----
let newRefs = [];
function drawRefs() {
  const box = $('#np-reflist'); if (!box) return;
  box.innerHTML = newRefs.length ? newRefs.map((r, i) => `<span class="ref" title="${esc(r)}">${esc(r.split('/').filter(Boolean).pop() || r)}<button type="button" data-rmref="${i}" aria-label="外す">×</button></span>`).join('') : '<span class="small">ここに落とす、または［選ぶ］</span>';
}
function addNewRefs(paths) {
  for (const x of paths) if (x && !newRefs.includes(x)) newRefs.push(x);
  drawRefs();
  const d = $('#np-refs') && $('#np-refs').closest('details'); if (d) d.open = true;
}
function renderNewProject() {
  const opts = state.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  $('#main').innerHTML = `<div class="view"><div class="ph"><h2>新しいプロジェクト</h2></div>
    <div class="card"><form class="newform" id="projform">
      <label>プロジェクト名<input name="name" id="np-name" required maxlength="60" placeholder="例：HD 占いアプリ"></label>
      <label>説明（何を作るか・誰のためか。1〜2行）<textarea name="description" id="np-desc" rows="2" maxlength="400"></textarea></label>
      <label>フェーズ（1行に1つ。順番どおり）<textarea name="phases" id="np-phases" rows="4" maxlength="400">計画\n作る\nチェック\n仕上げ</textarea></label>
      <details class="more"><summary>くわしく（なくてもよい）</summary><div class="newform" style="margin-top:10px">
        <label>本体のフォルダ（もうコードや資料がある時）
          <div class="dropfield" id="np-drop"><input name="body" id="np-body" maxlength="300" placeholder="ここにフォルダを落とす、または［選ぶ］"><button class="btn plain sm" id="np-pick" type="button">選ぶ…</button></div></label>
        <label>親プロジェクト（小分けにする時）<select name="parent" id="np-parent"><option value="">（なし）</option>${opts}</select></label>
        <label>参考にするフォルダ・ファイル（Hub の外。AI は読むだけで書き換えない。何個でも）
          <div class="dropfield refs" id="np-refs"><div class="reflist" id="np-reflist"><span class="small">ここに落とす、または［選ぶ］</span></div><button class="btn plain sm" id="np-refpick" type="button">選ぶ…</button></div></label>
        ${state.projects.length ? `<fieldset class="rels"><legend>関連プロジェクト（Hub の他のプロジェクト。AI がその資料を読んでよい）</legend>${state.projects.map(p => `<label class="chk"><input type="checkbox" name="related" value="${esc(p.name)}"> ${esc(p.name)}</label>`).join('')}</fieldset>` : ''}
      </div></details>
      <p class="small">台帳（PROJECT.md）・AI 用の指示（CLAUDE.md・AGENTS.md）・作業用のフォルダ（資料・作業・成果物・.ai）を <span class="path">${esc(state.root)}/Product/</span> に作ります。</p>
      <div><button class="btn" type="submit">プロジェクトを作る</button></div>
    </form></div></div>`;
  drawRefs();
  if (newRefs.length) $('#np-refs').closest('details').open = true;
}

// ---- 概要画面（プロジェクトの説明と作業の一覧） ----
function taskRow(p, t, showProject) {
  const cur = t.steps.find(x => !x.done);
  const w = aiWaiting(p.id, t.id);
  const sub = t.question ? `<span class="q2">あなたへの質問：${linkify(t.question)}</span>`
    : w.length ? `<span class="q2">${w.map(x => AI_LABEL[x.ai]).join('・')} が入力を待っています（${Math.floor(Math.max(...w.map(x => x.quiet)) / 60)}分）</span>`
    : `<span>${showProject ? esc(p.name) + '・' : ''}${t.state === '完了' ? '完了' : cur ? '次：' + esc(cur.text) : t.next ? '次：' + esc(t.next.split('\n')[0]) : esc(t.state)}</span>`;
  return `<div class="trow ${t.parent ? 'child' : ''} ${t.state === '完了' ? 'fin' : ''}">
    <div class="tt"><b>${esc(t.title)}</b>${sub}</div>
    <div class="tw">${chip(p, t)}${t.via ? `<span class="via">${esc(t.via)}</span>` : ''}</div>
    ${progressBar(t)}
    <button class="btn plain sm" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button">作業画面へ</button>
  </div>`;
}

function phaseRoad(p, info) {
  if (!info.list.length) return '';
  const road = info.list.map((ph, i) => {
    const done = ph.state === '完了' || (i === info.cur && ph.tasksDone);
    return `<div class="step ${done ? 'done' : ''} ${i === info.cur && !done ? 'now' : ''}">
      ${done ? '<span class="stamp">COMPLETE</span>' : ''}
      <span class="no">フェーズ ${i + 1}</span><span class="nm">${esc(ph.name)}</span>
      <div class="pbar"><i style="width:${Math.round((done ? 1 : ph.ratio) * 100)}%"></i></div>
      <span class="st">${esc(ph.state === '完了' ? '完了' : i === info.cur ? '進行中' : '未着手')}・作業 ${ph.tasks.filter(t => t.state === '完了').length} / ${ph.tasks.length}</span></div>`;
  }).join('');
  const c = info.list[info.cur];
  const banner = c && c.tasksDone ? `<div class="banner"><b>COMPLETE</b><span>「${esc(c.name)}」の作業がすべて終わりました。</span><span class="sp"></span>
      <button class="btn" data-act="nextphase" data-p="${esc(p.id)}" type="button">${info.list[info.cur + 1] ? `次のフェーズ「${esc(info.list[info.cur + 1].name)}」へ進む` : 'プロジェクトを完了にする'}</button></div>` : '';
  return `<div class="road">${road}</div>${banner}`;
}

const refsOf = p => p.folders.filter(f => /^参考/.test(f.label));
function renderOverview(p) {
  if (!p) return renderEmpty();
  const info = phaseInfo(p);
  const here = t => !info.list.length || info.cur < 0 || info.inPhase(t, info.cur);
  const active = p.tasks.filter(t => t.state !== '完了' && here(t));
  const others = p.tasks.filter(t => t.state !== '完了' && !here(t));
  const done = p.tasks.filter(t => t.state === '完了');
  const phaseOpts = p.phases.map((ph, i) => `<option ${i === info.cur ? 'selected' : ''}>${esc(ph.name)}</option>`).join('');
  const agentOpts = (state.roles.agents || []).map(a => `<option value="discord:${esc(a)}">${esc(a)}（Discord）</option>`).join('');
  const roleOpts = state.roles.roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  const taskOpts = p.tasks.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
  const description = p.description || p.notes;
  $('#main').innerHTML = `<div class="view">
    <div class="ph"><h2>${esc(p.name)}</h2><span class="pill s-${esc(p.status)}">${esc(p.status)}</span>
      <span class="small">最終更新 ${esc(p.updated || '—')}</span>
      ${p.copies ? `<span class="small" title="Work フォルダに残っている作業用コピー。作業画面の［本体に取り込む］で片付きます">作業用コピー ${p.copies} 件</span>` : ''}<span class="sp"></span>
      <button class="btn plain" data-act="pstatus" data-p="${esc(p.id)}" data-s="${p.status === '完了' ? '進行中' : '完了'}" type="button">${p.status === '完了' ? '完了を取り消す' : 'プロジェクトを完了にする'}</button>
      <button class="btn plain" data-act="files" type="button">ファイルを見る</button></div>
    ${description ? `<p class="desc">${esc(description)}</p>` : ''}
    ${phaseRoad(p, info)}
    <div class="card"><h3 class="sec">${info.curName ? `今のフェーズの作業（${esc(info.curName)}）` : '作業'}</h3>
      <form class="quick" id="quickform">
        <textarea name="text" rows="2" maxlength="4000" required placeholder="やりたいことを書くだけで始められます（例：入退室の画面を作って）"></textarea>
        <button class="btn" type="submit">始める</button>
      </form>
      ${active.length ? active.map(t => taskRow(p, t)).join('') : '<p class="note">進行中の作業はありません。</p>'}
      ${others.length ? `<details class="more"><summary>他のフェーズの作業（${others.length}）</summary>${others.map(t => taskRow(p, t)).join('')}</details>` : ''}
      ${done.length ? `<details class="more"><summary>完了した作業（${done.length}）</summary>${done.map(t => taskRow(p, t)).join('')}</details>` : ''}
      <details class="more"><summary>＋ 細かく決めて作業を足す</summary>
        <form class="newform" id="newform" style="margin-top:10px">
          <label>作業名<input name="title" required maxlength="80" placeholder="例：メモ一覧の文言を直す"></label>
          <label>分岐元（この作業から分かれる時）<select name="parent"><option value="">（なし）</option>${taskOpts}</select></label>
          <label>役割<select name="role"><option value="">（なし）</option>${roleOpts}</select></label>
          ${phaseOpts ? `<label>フェーズ<select name="phase">${phaseOpts}</select></label>` : ''}
          <label>担当<select name="owner"><option value="claude-code">Claude Code</option><option value="codex">Codex</option>${agentOpts}<option value="人">あなた</option></select></label>
          <label>どこで頼んだか（Discord の時。例：#サンプル作業）<input name="via" maxlength="80"></label>
          <label>手順（1行に1つ。3〜5個）<textarea name="steps" rows="4" maxlength="600" placeholder="題材を決める&#10;下書き&#10;チェック&#10;投稿"></textarea></label>
          <div><button class="btn" type="submit">作業を足す</button></div>
        </form></details>
    </div>
    <div class="grid2">
      <div class="card"><h3 class="sec">問題点</h3>${p.issues.length ? `<ul>${p.issues.map(i => `<li>${i.level ? `<span class="pill">${esc(i.level)}</span>` : ''}${esc(i.text || i)}</li>`).join('')}</ul>` : '<p class="note">なし</p>'}</div>
      <div class="card"><h3 class="sec">関連プロジェクト・参考（AI が読むだけ）</h3>${p.related.length || refsOf(p).length ? `<ul>${p.related.map(r => { const q = state.projects.find(x => x.name === r || x.id === r); return `<li>${q ? `<button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(r)}</button>` : esc(r)}</li>`; }).join('')}${refsOf(p).map(f => `<li><span class="ref" title="${esc(f.path)}">${esc(f.path.split('/').filter(Boolean).pop() || f.path)}</span></li>`).join('')}</ul>` : '<p class="note">なし</p>'}
        <p class="small">参考にしたいフォルダは、この画面に落とすと足せます。</p></div>
      ${p.chats.length ? `<div class="card"><h3 class="sec">ブラウザのチャット</h3><ul>${p.chats.map(c => `<li>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title || c.url)}</a>` : esc(c.title || c)}</li>`).join('')}</ul></div>` : ''}
    </div></div>`;
}

// 「ファイルを見る」：場所が1つならすぐ開く。複数なら選ぶ
async function openFiles(btn) {
  const p = proj(view.project); if (!p) return;
  const t = view.kind === 'work' ? taskOf(p, view.task) : null;
  const list = [];
  if (t && t.workdir) list.push({ label: '作業の場所', path: t.workdir, kind: 'workdir' });
  p.folders.forEach(f => list.push({ label: f.label, path: f.path, kind: 'folder' }));
  list.push({ label: '台帳（PROJECT.md・指示ファイル）', path: p.dir, kind: 'project' });
  const go = async it => {
    try { await api('/api/open', { project: p.id, kind: it.kind, label: it.label, task: t && t.id }); toast(`${it.label}を開きました`); }
    catch (e) { toast(`${it.label}：${e.message}`); }
  };
  if (list.length === 1) return go(list[0]);
  const m = $('#menu');
  m.innerHTML = list.map((it, i) => `<button type="button" data-i="${i}">${esc(it.label)}<span>${esc(it.path)}</span></button>`).join('');
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; m.hidden = true; go(list[+b.dataset.i]); };
}

// ---- 作業画面 ----
function renderWork() {
  const p = proj(view.project), t = taskOf(p, view.task);
  if (!p || !t) { view.kind = 'project'; return render(); }
  const running = ['claude', 'codex'].filter(a => live(p.id, t.id, a));
  const main = aiOf(t.owner);
  const shown = running.length ? running : [];
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const mode = workMode();
  const modeSeg = `<div class="seg" role="group" aria-label="画面の切り替え">
      <button class="${mode === 'chat' ? 'on' : ''}" data-act="mode" data-m="chat" type="button" title="1本の会話で、答える AI を選んで話す">会話</button>
      <button class="${mode === 'term' ? 'on' : ''}" data-act="mode" data-m="term" type="button" title="AI の画面をそのまま動かす">ターミナル${running.length ? `（${running.length}）` : ''}</button></div>`;
  const startBtns = mode === 'chat' ? '' : ['claude', 'codex'].filter(a => !running.includes(a)).map(a =>
    `<button class="btn ${a}${a === main || running.length ? '' : ' sub'}" data-act="start" data-ai="${a}" ${k} type="button">${running.length ? '＋ ' : ''}${AI_LABEL[a]}${running.length ? 'も並べる' : 'で始める'}</button>`).join('');
  $('#main').innerHTML = `<div class="work">
    <div class="whead">
      <button class="back" data-go="project" data-p="${esc(p.id)}" type="button">← ${esc(p.name)}</button>
      <h2>${esc(t.title)}</h2><span class="pill s-${esc(t.state)}">${esc(t.state)}</span>
      ${t.role ? `<span class="small">${esc(t.role)}</span>` : ''}
      ${modeSeg}<span class="sp"></span>${startBtns}
      ${t.copy ? `<button class="btn plain" data-act="merge" ${k} type="button" title="この作業の作業用コピーを本体に取り込み、作業用コピーはゴミ箱へ移します">本体に取り込む</button>` : ''}
      <button class="btn plain" data-act="files" type="button">ファイルを見る</button>
    </div>
    ${t.question ? `<div class="wq"><b>あなたへの質問：</b><span>${linkify(t.question)}</span><button class="btn plain sm" data-act="answered" ${k} type="button">返事した</button></div>` : ''}
    ${mode === 'chat' ? chatHtml(p, t) : `<div class="panes ${shown.length === 2 ? 'two' : ''}" id="panes">
      ${shown.length ? shown.map(a => `<section class="pane" data-ai="${a}">
          <div class="phead"><span class="who w-${AI_KEY[a]}">${AI_LABEL[a]}</span><span class="pstat" data-ai="${a}">${statusText(sessOf(p.id, t.id, a))}</span>${specSelect(p, t, a, true)}<span class="sp"></span>
            <button class="btn plain sm" data-act="handoff" data-to="${OTHER[a]}" ${k} type="button" title="上限になった時やモデルを変えたい時に。今までの会話を引き継ぎ資料にまとめて ${AI_LABEL[OTHER[a]]} に渡します（動いていなければ役割どおりのモデルで始めます）">${AI_LABEL[OTHER[a]]}に交代 →</button>
            <button class="btn plain sm" data-act="stop" data-ai="${a}" ${k} type="button">止める</button></div>
          <div class="pbody" id="pane-${a}"></div></section>`).join('')
        : `<div class="pane"><div class="pempty">${ownerOf(t.owner).kind === 'agent'
            ? `この作業は ${esc(ownerOf(t.owner).name)}（Discord）に頼んでいます${t.via ? `（${esc(t.via)}）` : ''}。<br>報告を受けたら、下の「手順」に印を付けてください。全部付くと完了になります。<br>ここで Claude Code や Codex に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'you' ? `この作業は、あなたの担当です。<br>終わったら、下の「手順」に印を付けるか、状態を「完了」にしてください。`
            : state.terminal
            ? `まだ AI は動いていません。<br>上の「${AI_LABEL[main]}で始める」を押すと、ここで作業が始まります。<br>ファイルやスクショは、この画面に落とす（または ⌘V で貼る）と AI に渡せます。<br>${esc(t.next ? '次にやること：' + t.next.split('\n')[0] : '')}`
            : '作業画面の部品が未設定です。［設定］をご覧ください。<br>それまでは、始めると別の窓で開きます。'}</div></div>`}
    </div>`}
    <div class="wfoot">
      <select data-act="state" ${k} aria-label="状態">${STATES.map(s => `<option ${s === t.state ? 'selected' : ''}>${s}</option>`).join('')}</select>
      ${mode === 'term' && CLI(t.owner) && !shown.length ? specSelect(p, t, main) : ''}
      ${p.phases.length ? `<select data-act="phase" ${k} aria-label="フェーズ" title="この作業のフェーズ"><option value="">フェーズ：今のフェーズ</option>${p.phases.map(ph => `<option ${t.phase === ph.name ? 'selected' : ''}>${esc(ph.name)}</option>`).join('')}</select>` : ''}
      <details class="more steps" ${stepsOpen ? 'open' : ''}><summary>手順 ${t.steps.length ? `${progressOf(t).done} / ${t.steps.length}` : '（なし）'}</summary><div class="stepbox">${t.steps.map((x, i) => `<label><input type="checkbox" data-act="step" data-i="${i}" ${k} ${x.done ? 'checked' : ''}> ${esc(x.text)}</label>`).join('')}
        <form class="addstep" data-p="${esc(p.id)}" data-t="${esc(t.id)}"><input name="step" maxlength="120" placeholder="手順を足す（例：下書き）" aria-label="手順を足す"><button class="btn plain sm" type="submit">足す</button></form></div></details>
      <input id="memo" maxlength="300" placeholder="メモ（例：デザイン案Aに決めた）" aria-label="メモ">
      <button class="btn plain sm" data-act="memo" ${k} type="button">メモを残す</button>
      ${t.skills.length ? `<details class="more"><summary>使ったスキル（${t.skills.length}）</summary><ul class="skills">${t.skills.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
    </div></div>`;
  closePanes();
  if (mode === 'chat') openChat(p, t); else shown.forEach(a => attach(p.id, t.id, a));
  if (t.copy) loadPreview(p.id, t.id);
}

// ---- 会話画面（Goose のような形）：1本の会話で、送るたびに答える AI とモデルを選ぶ ----
let chatES = null, chatDraft = {}, chatBusy = null;
function workMode() { try { return localStorage.getItem('hub-mode') === 'term' ? 'term' : 'chat'; } catch (e) { return 'chat'; } }
function setMode(m) { try { localStorage.setItem('hub-mode', m); } catch (e) { /* 無視 */ } render(); }
const EMPTY_CHAT = '<p class="chat-empty">ここで AI と話します。<br>下で答える AI とモデルを選び、依頼を書いて送ってください（⌘ + Enter でも送れます）。<br>途中で AI を変えると、それまでの会話を自動で引き継ぎます。ファイルやスクショは、ここに落とすか ⌘V で貼れます。</p>';
// 選ぶ欄に出すモデル（設定で隠したものは出さない。ただし今選んでいるものは残す）
function shownModels(key, ...keep) {
  const hidden = (state.hiddenModels || {})[key] || [];
  return (state.roles.models[key] || []).filter(m => !hidden.includes(m) || keep.includes(m));
}
function chatHtml(p, t) {
  const pick = chatPick(p, t);
  // 名前が未設定のモデルは、CLI の既定のモデルで動く（設定画面で名前を入れられる）
  const flag = (a, m) => ((state.cliFlags || {})[a] || {})[m];
  const available = (state.roles.models[AI_KEY[pick.ai]] || []).includes(pick.model);
  const old = pick.model && !available ? `<option value="${pick.ai}|${esc(pick.model)}" selected disabled>${esc(AI_LABEL[pick.ai])}・${esc(pick.model)}（利用できません。選び直してください）</option>` : '';
  const opts = old + ['claude', 'codex'].flatMap(a => shownModels(AI_KEY[a], pick.ai === a ? pick.model : '').map(m => `<option value="${a}|${esc(m)}" ${pick.ai === a && pick.model === m ? 'selected' : ''}>${AI_LABEL[a]}・${esc(m)}${flag(a, m) === '' ? '（既定）' : ''}</option>`)).join('');
  return `<div class="chat" data-p="${esc(p.id)}" data-t="${esc(t.id)}">
    <div class="msgs" id="msgs">${EMPTY_CHAT}</div>
    <form class="composer" id="composer">
      <div class="queue" id="chat-queue" hidden></div>
      <textarea id="chat-in" rows="3" maxlength="100000" placeholder="依頼を書く（例：このスクショの崩れを直して）" aria-label="依頼">${esc(chatDraft[t.id] || '')}</textarea>
      <div class="crow">
        <select id="chat-ai" aria-label="答える AI とモデル">${opts}</select>
        <select id="chat-effort" aria-label="思考">${state.efforts.map(e => `<option ${pick.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
        <span class="small" id="chat-state"></span><span class="sp"></span>
        <button class="btn" id="chat-send" type="submit">送る</button>
      </div>
      <div class="crow busyrow" id="chat-busyrow" hidden>
        <span class="small">作業中に送る時は、どうするか選んでください：</span><span class="sp"></span>
        <button class="btn plain" id="chat-stop" type="button" title="今の作業を止めます（待っている指示も取り消します）">止める</button>
        <button class="btn warn" id="chat-redo" type="button" hidden title="今の指示が間違いだった時。今の指示を取り消し、この指示でやり直します">① 取り消してやり直す</button>
        <button class="btn" id="chat-amend" type="button" hidden title="今の指示に足りない所がある時。今の指示は続け、この説明も合わせて行います">② 追加説明（一緒にやる）</button>
        <button class="btn plain" id="chat-q" type="button" hidden title="別の作業を順番待ちにします。今の作業が終わったら自動で始めます（⌘ + Enter）">③ 終わったら次に</button>
      </div>
    </form></div>`;
}
// 最初に選んでおく AI：前回選んだもの → 作業の担当と役割の設定
function chatPick(p, t) {
  try { const v = JSON.parse(localStorage.getItem('hub-chat-' + p.id + '/' + t.id) || 'null'); if (v && v.ai) return v; } catch (e) { /* 無視 */ }
  const ai = aiOf(t.owner), sp = specOf(t, ai);
  return { ai, model: sp.model || (state.roles.models[AI_KEY[ai]] || [])[0], effort: sp.effort || '高' };
}
// 文の中の URL とファイルの場所を押せるようにする（URL＝ブラウザで開く・コピー、場所＝Finder で開く）
const LINK_RE = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%()]+)|`([^`\n]+)`|((?:~\/|\/(?:Users|Volumes|private|tmp|opt|home)\/)[^\s<>"'`()（）「」『』【】\[\]、。，]+)|((?<![\p{L}\p{N}_\/.:@-])(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_@-]+\.[A-Za-z0-9]{1,6})(?![\p{L}\p{N}_\/])/gu;
const urlLink = (u, label) => `<a href="#" class="lk" data-url="${esc(u)}" title="ブラウザで開く">${esc(label || u)}</a><button type="button" class="cp" data-copy="${esc(u)}" title="コピー" aria-label="コピー">⧉</button>`;
const pathLink = (x, label) => `<a href="#" class="lk lp" data-path="${esc(x)}" title="Finder で開く">${esc(label || x)}</a>`;
// URL の終わりの句読点や、対になっていない ) ] は URL に含めない
function trimUrl(u) {
  let x = u.replace(/[.,;:!?'*]+$/, '');
  for (;;) {
    const n = x.length;
    if (x.endsWith(')') && (x.match(/\(/g) || []).length < (x.match(/\)/g) || []).length) x = x.slice(0, -1);
    if (x.endsWith(']') && (x.match(/\[/g) || []).length < (x.match(/\]/g) || []).length) x = x.slice(0, -1);
    x = x.replace(/[.,;:!?'*]+$/, '');
    if (x.length === n) return x;
  }
}
const isPath = x => /^(~\/|\/)/.test(x) || (/\//.test(x) && !/\s{2,}/.test(x) && !/^[\/.]$/.test(x));
function linkify(text) {
  const s = String(text == null ? '' : text);
  let out = '', last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(s))) {
    out += esc(s.slice(last, m.index));
    last = LINK_RE.lastIndex;
    if (m[1] !== undefined) { // [名前](URL または場所)
      const t = m[2].replace(/^<|>$/g, '').replace(/^file:\/\//, '');
      let dec = t; try { dec = decodeURI(t); } catch (e) { /* そのまま */ }
      out += /^https?:\/\//.test(t) ? urlLink(t, m[1]) : isPath(dec) ? pathLink(dec.replace(/#L?\d+(-L?\d+)?$/, ''), m[1]) : esc(m[0]);
    } else if (m[3]) { const u = trimUrl(m[3]); out += urlLink(u) + esc(m[3].slice(u.length)); LINK_RE.lastIndex = last = m.index + m[3].length; }
    else if (m[4] !== undefined) {
      const c = m[4].trim();
      out += /^https?:\/\//.test(c) ? '`' + urlLink(c) + '`' : isPath(c) ? '`' + pathLink(c) + '`' : esc(m[0]);
    }
    else { const raw = m[5] || m[6], x = raw.replace(/[.,;:!?]+$/, ''); out += pathLink(x) + esc(raw.slice(x.length)); }
  }
  return out + esc(s.slice(last));
}
async function copyText(v) {
  try { await navigator.clipboard.writeText(v); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast('コピーしました');
}
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-url],[data-path],[data-copy]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.copy) copyText(el.dataset.copy);
  else if (el.dataset.url) api('/api/open-url', { url: el.dataset.url }).catch(err => toast(err.message));
  else showPath(el.dataset.path);
});
// 場所を押した時：フォルダは中身の一覧を画面に出し、ファイルはそのアプリで開く（Finder が入れない場所でも開けるように）
const IN_APP = /ProjectHubApp/.test(navigator.userAgent);
const fsize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
async function openPath(p, how) {
  try {
    const r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how });
    if (r.byApp) location.href = `hubapp://reveal?dir=${r.dir ? 1 : 0}&open=${r.how === 'open' ? 1 : 0}&path=${encodeURIComponent(r.path)}`;
    toast(`${r.how === 'open' ? '開きました' : 'Finder で開きました'}：${r.path.split('/').pop()}`);
  } catch (err) { toast(err.message); }
}
async function showPath(p) {
  let r;
  try { r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how: 'list' }); }
  catch (err) { toast(err.message); return; }
  if (!r.entries) { if (r.byApp) location.href = `hubapp://reveal?dir=0&open=1&path=${encodeURIComponent(r.path)}`; toast(`開きました：${r.path.split('/').pop()}`); return; }
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  el.innerHTML = `<div class="fs-box"><div class="fs-head"><b>📁 ${esc(r.path.split('/').pop())}</b><span class="small fs-path">${esc(r.path)}</span></div>
    <div class="fs-list">${r.parent ? `<button type="button" class="fs-row" data-fs-dir="${esc(r.parent)}">↩︎ 上のフォルダへ</button>` : ''}
    ${r.entries.length ? r.entries.map(x => `<button type="button" class="fs-row" ${x.dir ? `data-fs-dir="${esc(x.path)}"` : `data-fs-file="${esc(x.path)}"`}><span>${x.dir ? '📁' : '📄'} ${esc(x.name)}</span><span class="small">${x.dir ? '' : fsize(x.size)}</span></button>`).join('') : '<p class="note">空のフォルダです</p>'}</div>
    <div class="acts fs-acts"><button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finder で開く</button><button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn" data-fs-close>閉じる</button></div></div>`;
}
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-fs-dir],[data-fs-file],[data-fs-finder],[data-fs-copy],[data-fs-close],.fsheet');
  if (!t) return;
  const d = t.dataset;
  if (d.fsDir) showPath(d.fsDir);
  else if (d.fsFile) openPath(d.fsFile, 'open');
  else if (d.fsFinder) openPath(d.fsFinder, 'finder');
  else if (d.fsCopy) copyText(d.fsCopy);
  else if (d.fsClose !== undefined || t.classList.contains('fsheet') && e.target === t) $('#fsheet').hidden = true;
});
// コマンドなどの細かい作業を会話に出すか（設定画面で変える。最初は出さない）
const showDetail = () => { try { return localStorage.getItem('hub-detail') === '1'; } catch (e) { return false; } };
const isToolRow = r => r.tool || !/やり直/.test(r.text || ''); // 前の記録には印が無いため、やり直しの知らせ以外は細かい作業とみなす
function msgHtml(r) {
  const time = r.at ? new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  if (r.role === 'event') return isToolRow(r) && !showDetail() ? '' : `<div class="ev">▸ ${esc(r.text)}</div>`;
  if (r.role === 'user') return `<div class="m me"><div class="mh">${r.mode === 'redo' || r.mode === 'interrupt' ? '<span class="tagm int">取り消してやり直し</span>' : r.mode === 'amend' ? '<span class="tagm am">追加説明</span>' : r.mode === 'queued' ? '<span class="tagm">順番待ちの指示</span>' : ''}<span class="small">${time}・${esc(AI_LABEL[r.to] || '')}${r.model ? '・' + esc(r.model) : ''} へ</span></div><div class="mb">${linkify(r.text)}</div></div>`;
  return `<div class="m ai"><div class="mh"><span class="chip k-${esc(r.ai)}"><span class="ic">${r.ai === 'codex' ? 'X' : 'C'}</span>${esc(AI_LABEL[r.ai] || r.ai)}${r.model ? `<small>・${esc(r.model)}${r.effort ? '・' + esc(r.effort) : ''}</small>` : ''}</span><span class="small">${time}</span>${r.error ? '<span class="done bad">⚠ 止まりました</span>' : `<span class="done">✓ 完了${r.ms ? '（' + dur(r.ms) + '）' : ''}</span>`}</div>
    ${r.text ? `<div class="mb">${linkify(r.text)}</div>` : ''}${r.asks && r.asks.length ? askHtml(r.asks) : ''}${r.error ? `<div class="merr">${esc(r.error)}</div>` : ''}</div>`;
}
// AI からの質問：選択肢を押して答える（1問・1つ選ぶ時は押すとすぐ送る。複数の時は選んでから［選んで送る］）
function askHtml(asks) {
  const quick = asks.length === 1 && !asks[0].multi;
  return `<div class="ask">${asks.map((a, i) => `<div class="ask-q" data-i="${i}" data-multi="${a.multi ? 1 : 0}" data-q="${esc(a.question)}">
      <div class="ask-t">❓ ${linkify(a.question || '選んでください')}</div>
      <div class="ask-opts">${a.options.map(o => `<button type="button" class="ask-o" data-ask="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`).join('')}
    <div class="ask-foot"><span class="small">${quick ? '押すと、その答えを送ります。' : '選んでから［選んで送る］を押してください。'}ほかの答えは、下の欄に書いて送れます。</span>${quick ? '' : '<button type="button" class="btn sm ask-send">選んで送る</button>'}</div></div>`;
}
// 答えられるのは最後の返事の質問だけ（前の質問は済んだものとして押せなくする）
function refreshAsks(box) {
  const all = [...box.querySelectorAll('.m')];
  const last = all.filter(m => !m.id).pop();
  box.querySelectorAll('.ask').forEach(a => a.classList.toggle('done', !last || !last.contains(a)));
}
const cleanOpt = o => o.replace(/[（(]おすすめ[）)]/g, '').trim();
// かかった時間：「45秒」「1分20秒」
function dur(ms) { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t}秒` : `${Math.floor(t / 60)}分${t % 60 ? (t % 60) + '秒' : ''}`; }
let busyTimer = null;
function openChat(p, t) {
  const box = $('#msgs');
  const ta = $('#chat-in');
  ta.addEventListener('input', () => { chatDraft[t.id] = ta.value; });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#composer').requestSubmit(); } });
  const keep = () => { const [ai, model] = $('#chat-ai').value.split('|'); try { localStorage.setItem('hub-chat-' + p.id + '/' + t.id, JSON.stringify({ ai, model, effort: $('#chat-effort').value })); } catch (e) { /* 無視 */ } };
  $('#chat-ai').addEventListener('change', keep); $('#chat-effort').addEventListener('change', keep);
  $('#chat-stop').addEventListener('click', () => api('/api/chat/stop', { project: p.id, task: t.id }).catch(e => toast(e.message)));
  // mode: ''（普通）／'interrupt'（① 中断して送る）／'queue'（② 追加：終わったら続けて）
  const sendChat = async mode => {
    const text = ta.value.trim();
    if (!text) { toast('依頼を書いてください'); return; }
    if ($('#chat-ai').selectedOptions?.[0]?.disabled) { toast('利用できないモデルです。新しい候補を選んでください'); return; }
    const [ai, model] = $('#chat-ai').value.split('|');
    keep();
    try {
      const r = await api('/api/chat/send', { project: p.id, task: t.id, ai, model, effort: $('#chat-effort').value, text, mode });
      ta.value = ''; chatDraft[t.id] = '';
      if (r.queued) { toast(`順番待ちにしました。今の作業が終わったら始めます（待っている指示 ${r.queue} 件）`); return; }
      if (mode === 'redo') { chatBusy = null; toast('前の指示を取り消して、新しい指示でやり直しています'); }
      if (mode === 'amend') { chatBusy = null; toast('追加の説明を合わせて、作業を続けています'); }
      if (!chatBusy) setBusy({ ai, model: r.model || model, started: Date.now(), text: '' }); // 知らせを待たずに「作業中」を出す
      if (r.note) toast(r.note);
    } catch (err) { toast(err.message); }
  };
  $('#composer').addEventListener('submit', e => { e.preventDefault(); sendChat(chatBusy ? 'queue' : ''); });
  $('#chat-redo').addEventListener('click', () => sendChat('redo'));
  $('#chat-amend').addEventListener('click', () => sendChat('amend'));
  $('#chat-q').addEventListener('click', () => sendChat('queue'));
  // 質問の選択肢
  box.addEventListener('click', e => {
    const ask = e.target.closest('.ask');
    if (!ask || ask.classList.contains('done')) return;
    const qs = [...ask.querySelectorAll('.ask-q')];
    const opt = e.target.closest('.ask-o');
    if (opt) {
      const q = opt.closest('.ask-q');
      if (qs.length === 1 && q.dataset.multi !== '1') { ta.value = cleanOpt(opt.dataset.ask); ask.classList.add('done'); sendChat(chatBusy ? 'queue' : ''); return; }
      if (q.dataset.multi !== '1') q.querySelectorAll('.ask-o').forEach(b => b.classList.remove('on'));
      opt.classList.toggle('on');
      return;
    }
    if (e.target.closest('.ask-send')) {
      const parts = qs.map(q => { const sel = [...q.querySelectorAll('.ask-o.on')].map(b => cleanOpt(b.dataset.ask)); return sel.length ? (qs.length > 1 ? `${q.dataset.q}：${sel.join('、')}` : sel.join('、')) : ''; }).filter(Boolean);
      if (!parts.length) { toast('選択肢を選んでください'); return; }
      ta.value = parts.join('\n'); ask.classList.add('done'); sendChat(chatBusy ? 'queue' : '');
    }
  });
  // 待っている指示。作業中でない時（再起動の後など）は［▶ 始める］で今すぐ始められる
  let lastQueue = [];
  const drawQueue = q => {
    const el = $('#chat-queue'); if (!el) return;
    lastQueue = q || [];
    el.hidden = !lastQueue.length;
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); // 下に作業中の枠が見えるように
    el.innerHTML = (!chatBusy && lastQueue.length ? '<div class="small qh">待っている指示があります（止まっています）。［▶ 始める］で送れます</div>' : '')
      + lastQueue.map((x, i) => `<div class="qi"><span class="qn">次 ${i + 1}</span><span class="qt" title="${esc(x.text)}">${esc(x.text.split('\n')[0])}</span><span class="small">${esc(AI_LABEL[x.ai])}・${esc(x.model || '')}</span>${!chatBusy && i === 0 ? `<button type="button" class="qgo" data-run="${esc(x.id)}">▶ 始める</button>` : ''}<button type="button" class="qx" data-unq="${esc(x.id)}" aria-label="取り消す">✕</button></div>`).join('');
  };
  $('#chat-queue').addEventListener('click', e => {
    const d = e.target.dataset || {};
    if (d.unq) api('/api/chat/unqueue', { project: p.id, task: t.id, id: d.unq }).then(() => toast('取り消しました')).catch(err => toast(err.message));
    if (d.run) api('/api/chat/send', { project: p.id, task: t.id, fromQueue: d.run }).catch(err => toast(err.message)); // 「作業中」は知らせで出る
  });
  const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const scroll = force => { if (force || atBottom()) box.scrollTop = box.scrollHeight; };
  // 作業中の表示：動く印・かかった時間・今していること。終わったら消して、知らせる
  const setBusy = b => {
    const was = chatBusy;
    chatBusy = b;
    $('#chat-busyrow').hidden = !b; $('#chat-send').hidden = Boolean(b);
    $('#chat-redo').hidden = !b; $('#chat-amend').hidden = !b; $('#chat-q').hidden = !b;
    if (Boolean(was) !== Boolean(b)) drawQueue(lastQueue); // ［▶ 始める］の出し入れ
    let tmp = $('#msg-partial');
    if (!b) {
      clearInterval(busyTimer); busyTimer = null;
      if (tmp) tmp.remove();
      $('#chat-state').innerHTML = '';
      return;
    }
    if (!b.started) b.started = (was && was.started) || Date.now();
    if (!tmp) {
      box.insertAdjacentHTML('beforeend', `<div class="m ai working" id="msg-partial"><div class="mh"><span class="chip k-${esc(b.ai)}"><span class="ic">${b.ai === 'codex' ? 'X' : 'C'}</span>${esc(AI_LABEL[b.ai] || b.ai)}${b.model ? `<small>・${esc(b.model)}</small>` : ''}</span>
        <span class="wk"><i class="spin"></i>作業中<span class="dots"><i>.</i><i>.</i><i>.</i></span> <span class="wk-time"></span></span></div>
        <div class="wk-last"></div><div class="mb" hidden></div></div>`);
      tmp = $('#msg-partial');
    }
    const mb = tmp.querySelector('.mb');
    mb.hidden = !b.text; mb.textContent = b.text || '';
    if (b.last && showDetail()) tmp.querySelector('.wk-last').textContent = '▸ ' + b.last;
    if (!was || was.ai !== b.ai || was.model !== b.model) {
      $('#chat-state').innerHTML = `<span class="wk"><i class="spin"></i>${esc(AI_LABEL[b.ai])}${b.model ? '・' + esc(b.model) : ''} が作業中… <span id="chat-elapsed"></span></span>`;
    }
    const tick = () => {
      if (!chatBusy) return;
      const elapsed = dur(Date.now() - chatBusy.started);
      const w = $('#msg-partial')?.querySelector('.wk-time'); if (w) w.textContent = elapsed;
      const label = $('#chat-elapsed'); if (label) label.textContent = elapsed;
    };
    if (!busyTimer) { tick(); busyTimer = setInterval(tick, 1000); }
    else if (was && was.started !== b.started) tick();
    scroll();
  };
  chatES = new EventSource(`/api/chat/stream?project=${encodeURIComponent(p.id)}&task=${encodeURIComponent(t.id)}`);
  chatES.onmessage = m => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'queue') { drawQueue(ev.queue); return; }
    if (ev.type === 'rows') { setBusy(null); drawQueue(ev.queue); box.innerHTML = ev.rows.length ? ev.rows.map(msgHtml).join('') : EMPTY_CHAT; refreshAsks(box); setBusy(ev.busy); scroll(true); }
    else if (ev.type === 'row') {
      const e = box.querySelector('.chat-empty'); if (e) e.remove();
      const tmp = $('#msg-partial');
      if (tmp) tmp.insertAdjacentHTML('beforebegin', msgHtml(ev.row)); else box.insertAdjacentHTML('beforeend', msgHtml(ev.row));
      refreshAsks(box);
      if (ev.row.role === 'assistant' && ev.row.asks && ev.row.asks.length) toast('AI から質問があります。選んで答えてください');
      if (ev.row.role === 'event' && chatBusy) setBusy({ ...chatBusy, last: ev.row.text });
      if (ev.row.role === 'assistant' && !(ev.row.asks && ev.row.asks.length)) toast(ev.row.error ? `${AI_LABEL[ev.row.ai]} が止まりました。赤い字をご覧ください` : `${AI_LABEL[ev.row.ai]} の返事が届きました（${dur(ev.row.ms || 0)}）`);
      scroll(ev.row.role !== 'event');
    } else if (ev.type === 'busy') { setBusy({ ...(chatBusy || {}), ai: ev.ai, model: ev.model, started: ev.started, text: '' }); refreshTree(); }
    else if (ev.type === 'partial') setBusy({ ...(chatBusy || { ai: ev.ai }), text: ev.text });
    else if (ev.type === 'idle') { setBusy(null); refreshTree(); }
  };
}

// ［本体に取り込む］の横に、変更の量とぶつかりそうかを出す
async function loadPreview(pid, tid) {
  try {
    const r = await api(`/api/task/preview?project=${encodeURIComponent(pid)}&task=${encodeURIComponent(tid)}`);
    const el = document.querySelector('[data-act="merge"]');
    if (!r || !el || view.task !== tid) return;
    const txt = r.files ? `${r.files}ファイル +${r.added} −${r.removed}` : '変更なし';
    el.insertAdjacentHTML('beforebegin', `<span class="pv ${r.conflict ? 'bad' : ''}" title="作業用コピーで変わった量（本体と比べて）">${txt}${r.conflict ? '・本体とぶつかりそう' : ''}</span>`);
  } catch (e) { /* 出せなくても困らない */ }
}

// live=true：動いている AI の見出しに置く。変えるとその AI に切り替えを伝える
function specSelect(p, t, ai, live) {
  const key = AI_KEY[ai], models = state.roles.models[key] || [], s = specOf(t, ai);
  const missing = t.model && !models.includes(t.model);
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"${live ? ` data-ai="${ai}"` : ''}`;
  return `<span class="spec" title="${live ? `変えると ${AI_LABEL[ai]} に切り替えを伝えます` : `次に始める時の ${AI_LABEL[ai]} のモデルと思考（空なら役割の設定）`}">
    <select data-act="model" ${k} aria-label="モデル"><option value="" ${t.model ? '' : 'selected'}>モデル：役割どおり（${esc(s.model || '—')}）</option>${missing ? `<option selected disabled value="${esc(t.model)}">${esc(t.model)}（現在の指定・利用不可）</option>` : ''}${shownModels(key, t.model).map(m => `<option ${t.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <select data-act="effort" ${k} aria-label="思考"><option value="" ${t.effort ? '' : 'selected'}>思考：役割どおり（${esc(s.effort || '—')}）</option>${state.efforts.map(e => `<option ${t.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></span>`;
}

function attach(project, task, ai) {
  const el = document.getElementById('pane-' + ai);
  if (!el) return;
  const xterm = new window.Terminal({ fontSize: 13, fontFamily: 'Menlo, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: { background: '#10131a' } });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  const pane = { xterm, fit, es: null, ro: null };
  panes[ai] = pane;
  const doFit = () => { try { fit.fit(); api('/api/term/resize', { project, task, ai, cols: xterm.cols, rows: xterm.rows }).catch(() => {}); } catch (e) { /* 表示前 */ } };
  pane.ro = new ResizeObserver(doFit); pane.ro.observe(el);
  setTimeout(doFit, 0);
  xterm.onData(d => api('/api/term/input', { project, task, ai, data: d }).catch(() => {}));
  const es = new EventSource(`/api/term/stream?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&ai=${ai}`);
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'data') xterm.write(ev.data);
    if (ev.type === 'exit') { xterm.write(`\r\n\x1b[90m— 終了しました（code ${ev.code}）—\x1b[0m\r\n`); es.close(); setTimeout(() => load().catch(() => {}), 500); }
  };
  pane.es = es;
}
function closePanes() {
  if (chatES) { chatES.close(); chatES = null; }
  clearInterval(busyTimer); busyTimer = null; chatBusy = null;
  for (const ai of Object.keys(panes)) {
    const p = panes[ai];
    if (p.es) p.es.close();
    if (p.ro) p.ro.disconnect();
    try { p.xterm.dispose(); } catch (e) { /* 無視 */ }
  }
  panes = {};
}

async function startAI(p, t, ai) {
  if (!state.terminal) {
    const r = await api('/api/continue', { project: p, task: t, ai });
    toast(`別の窓で起動しました（${r.dir}）`);
    return;
  }
  const r = await api('/api/term/start', { project: p, task: t, ai, cols: 100, rows: 30 });
  toast(`${AI_LABEL[ai]} を起動しました${r.model ? `（${r.model}${r.effort ? '・' + r.effort : ''}）` : ''}${r.note ? '。' + r.note : ''}`);
  await load();
}

// ---- 設定（役割・モデル・思考） ----
let aiTools = null, aiToolsOperation = null, aiToolsError = '', aiToolsLoadingBox = null, aiToolsWatchTimer = null;
const aiToolPending = { claude: false, codex: false };
const aiToolMessage = { claude: '', codex: '' };
const aiToolMethod = method => ({ standalone: '単独インストール', 'homebrew-cask': 'Homebrew', native: '公式インストール', missing: '未導入', unknown: '確認できません' }[method] || method || '不明');
const aiToolErrorText = e => [e.message, e.reason && e.reason !== e.message ? e.reason : '', e.stage ? `段階：${e.stage}` : ''].filter(Boolean).join('。');
function drawAiTools() {
  const box = $('#ai-tools'); if (!box) return;
  if (!aiTools) { box.textContent = aiToolsError || '確認中…'; return; }
  const localBusy = aiToolPending.claude || aiToolPending.codex;
  box.innerHTML = (aiToolsError ? `<p class="ai-tool-result" role="status">${esc(aiToolsError)}</p>` : '') + ['claude', 'codex'].map(ai => {
    const tool = aiTools[ai] || {}, busy = localBusy || tool.updating || Boolean(aiToolsOperation);
    const message = aiToolMessage[ai] || (tool.updating ? '更新中です' : aiToolsOperation ? 'ほかの更新が進行中です' : !tool.installed ? 'この AI は見つかりませんでした' : '');
    const canRefresh = tool.modelRefreshAvailable !== false;
    const count = Array.isArray(tool.models) ? `選べるモデル ${tool.models.length} 件` : '';
    const models = Array.isArray(tool.models) ? tool.models : [];
    return `<div class="ai-tool-row" data-ai="${ai}">
      <div class="ai-tool-head"><b>${esc(AI_LABEL[ai])}</b><span class="small">現在版：${esc(tool.version || '確認できません')}</span><span class="small">導入方法：${esc(aiToolMethod(tool.method))}</span></div>
      <div class="ai-tool-actions"><button class="btn sm" type="button" data-ai-update="${ai}" ${busy || tool.installed === false ? 'disabled' : ''}>${busy ? '処理中…' : '更新を確認して適用'}</button>
        <button class="btn plain sm" type="button" data-ai-model-refresh="${ai}" ${busy || !canRefresh || tool.installed === false ? 'disabled' : ''}>モデル一覧を再取得</button>
        ${count ? `<span class="small">${esc(count)}</span>` : ''}</div>
      ${tool.source ? `<span class="small">モデル候補の取得元：${esc(tool.source)}</span>` : ''}
      ${models.length ? `<details class="more ai-tool-models"><summary>取得したモデル候補</summary><div>${models.map(m => `<span class="ai-model-name">${esc(m.label || m.id)}${m.label && m.label !== m.id ? `<small>${esc(m.id)}</small>` : ''}</span>`).join('')}</div></details>` : ''}
      ${!canRefresh ? '<p class="small">この AI のモデル一覧の再取得にはまだ対応していません。</p>' : ''}
      ${message ? `<p class="ai-tool-result" role="status">${esc(message)}</p>` : ''}
    </div>`;
  }).join('');
}
function scheduleAiToolsWatch() {
  clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null;
  if (view.kind !== 'settings' || document.hidden || !aiToolsOperation) return;
  aiToolsWatchTimer = setTimeout(() => {
    aiToolsWatchTimer = null;
    if (view.kind === 'settings' && !document.hidden) loadAiTools();
  }, 3000);
}
async function loadAiTools() {
  const box = $('#ai-tools'); if (!box || aiToolsLoadingBox === box) return;
  aiToolsLoadingBox = box;
  const wasOperating = Boolean(aiToolsOperation);
  try {
    const r = await api('/api/ai-tools');
    if ($('#ai-tools') !== box) return;
    aiTools = r.tools || {}; aiToolsOperation = r.operation || null; aiToolsError = '';
    if (wasOperating && !aiToolsOperation && !aiToolPending.claude && !aiToolPending.codex) {
      try { await refreshAiToolCatalog(); }
      catch (e) { aiToolsError = `モデル一覧を画面へ反映できませんでした：${aiToolErrorText(e)}`; }
    }
  } catch (e) { if ($('#ai-tools') === box) { aiTools = null; aiToolsError = aiToolErrorText(e); } }
  finally { if (aiToolsLoadingBox === box) aiToolsLoadingBox = null; if ($('#ai-tools') === box) { drawAiTools(); scheduleAiToolsWatch(); } }
}
function refreshRoleModelChoices() {
  if (view.kind !== 'settings') return;
  document.querySelectorAll('select[data-r][data-f="model"]').forEach(el => {
    const slot = rolesDraft?.[+el.dataset.r]?.[el.dataset.k]; if (!slot) return;
    const models = shownModels(slot.ai, slot.model);
    const names = slot.model && !models.includes(slot.model) ? [slot.model, ...models] : models;
    el.innerHTML = names.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    el.value = slot.model;
  });
  const note = $('#model-catalog');
  if (note) note.textContent = `選べるモデル：Claude Code は ${(state.roles.models['claude-code'] || []).join(' / ')}、Codex は ${(state.roles.models.codex || []).join(' / ')}。思考は ${state.efforts.join(' → ')}。`;
}
async function refreshAiToolCatalog() {
  const epoch = ++stateLoadEpoch;
  const next = await api('/api/state');
  if (epoch !== stateLoadEpoch) return;
  state = next;
  refreshRoleModelChoices();
  if (view.kind === 'settings') await loadCliModels(true);
}
function aiToolResultText(action, r) {
  const modelReport = result => {
    if (!result) return 'モデル一覧の状態を確認できませんでした。';
    if (result.ok === false) return `モデル一覧の再取得に失敗しました：${result.error || '理由を確認できません'}。`;
    const unchanged = Boolean(result.unchanged);
    const added = !unchanged && typeof result.added === 'number' ? `（追加 ${result.added} 件）` : '';
    return `${unchanged ? 'モデル一覧は前回の内容を使用しています' : `モデル一覧を再取得しました${added}`}。`
      + (result.source ? `取得元：${result.source}。` : '')
      + (result.warning ? `注意：${result.warning}。` : '');
  };
  if (action === 'models') return modelReport(r);
  const before = r.beforeVersion || '', after = r.afterVersion || '';
  const base = r.verified === false ? `更新操作は終わりましたが、版を確認できませんでした${r.verifyError ? `：${r.verifyError}` : ''}。` : r.changed
    ? before && after ? `更新しました：${before} → ${after}。` : `更新しましたが、版を確認できませんでした。`
    : before || after ? `版は変わりませんでした（${after || before}）。` : '版の変化を確認できませんでした。';
  return base + modelReport(r.models);
}
async function runAiTool(ai, action) {
  if (!['claude', 'codex'].includes(ai) || !['update', 'models'].includes(action) || aiToolPending.claude || aiToolPending.codex || aiToolsOperation || aiTools?.[ai]?.updating || aiTools?.[ai]?.installed === false || (action === 'models' && aiTools?.[ai]?.modelRefreshAvailable === false)) return;
  aiToolPending[ai] = true; aiToolsOperation = { ai, kind: action }; aiToolMessage[ai] = action === 'update' ? '更新を確認しています…' : 'モデル一覧を確認しています…'; drawAiTools();
  try {
    const path = action === 'update' ? '/api/ai-tools/update' : '/api/ai-tools/models/refresh';
    const result = await api(path, { ai });
    aiToolMessage[ai] = aiToolResultText(action, result);
    try { await refreshAiToolCatalog(); }
    catch (e) { aiToolMessage[ai] += `画面のモデル一覧を更新できませんでした：${aiToolErrorText(e)}。`; }
  } catch (e) { aiToolMessage[ai] = `失敗しました：${aiToolErrorText(e)}`; }
  finally { aiToolPending[ai] = false; aiToolsOperation = null; await loadAiTools(); drawAiTools(); }
}
document.addEventListener('click', e => {
  const ai = e.target.dataset.aiUpdate || e.target.dataset.aiModelRefresh;
  if (ai) runAiTool(ai, e.target.dataset.aiUpdate ? 'update' : 'models');
});
function renderSettings() {
  if (!rolesDraft) rolesDraft = JSON.parse(JSON.stringify(state.roles.roles));
  const models = state.roles.models;
  const opt = (list, v) => list.map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const cell = (i, k, s) => `<div class="cfg">
      <select data-r="${i}" data-k="${k}" data-f="ai" aria-label="AI">${['claude-code', 'codex', '人'].map(a => `<option value="${a}" ${s.ai === a ? 'selected' : ''}>${a === 'claude-code' ? 'Claude Code' : a === 'codex' ? 'Codex' : 'あなた'}</option>`).join('')}</select>
      ${s.ai === '人' ? '' : `<select data-r="${i}" data-k="${k}" data-f="model" aria-label="モデル">${opt(shownModels(s.ai, s.model), s.model)}</select>
      <select data-r="${i}" data-k="${k}" data-f="effort" aria-label="思考">${opt(state.efforts, s.effort)}</select>`}</div>`;
  const dirty = JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles);
  $('#main').innerHTML = `<div class="view"><div class="settings">
    <div class="card"><h2>作業画面</h2>
      <p><span class="badge ${state.terminal ? '' : 'off'}"><i></i>${state.terminal ? '画面の中で Claude Code / Codex を動かせます' : '部品（node-pty）が未設定です。ターミナルで setup.sh を実行してください。それまでは別の窓で開きます'}</span></p>
      <p>権限：Claude Code は <code>${esc(state.roles.permissions['claude-code'] || '')}</code>、Codex は <code>${esc(state.roles.permissions.codex || '')}</code></p></div>
    <div class="card"><h2>AI の更新</h2>
      <p>それぞれの AI を確認して更新します。モデル一覧だけを読み直すこともできます。今使っているモデルや役割は自動では変わりません。</p>
      <div id="ai-tools" aria-live="polite">確認中…</div></div>
    <div class="card"><h2>選ぶ欄に出すモデル</h2>
      <p>会話・役割・ターミナルのモデルを選ぶ欄に出すかどうかを決めます。外しても、今そのモデルを使っている所はそのまま動きます。一覧は「AI の更新」で取り直した、今使えるモデルです。</p>
      ${['claude-code', 'codex'].map(k => `<div class="mv"><b>${k === 'codex' ? 'Codex' : 'Claude Code'}</b><div class="mv-list">${(models[k] || []).map(m => `<label class="chk"><input type="checkbox" data-mv-ai="${k}" data-mv="${esc(m)}" ${((state.hiddenModels || {})[k] || []).includes(m) ? '' : 'checked'}> ${esc(m)}</label>`).join('') || '<span class="small">まだありません</span>'}</div></div>`).join('')}
      <div class="acts" style="margin-top:10px"><button class="btn plain" id="models-tidy" type="button">最新のモデルに整理する</button>
        <span class="small">役割で使っている古いモデル名（6sol など）を、同じ系統の一番新しいモデルに置き換え、roles.yaml の一覧も今のものにします。</span></div>
      <div id="tidy-result" class="small"></div></div>
    <div class="card"><h2>Mac のファイルの許可</h2>
      <p>書類・デスクトップ・ダウンロードのフォルダを、Project Hub が読めるか確かめます。「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」に Project Hub が無い時は、［確認をもう一度出す］を押し、Mac の確認で「許可」を選んでください。</p>
      ${/ProjectHubApp/.test(navigator.userAgent) ? `<div class="acts"><a class="btn plain" href="hubapp://access">許可を確かめる</a><a class="btn" href="hubapp://access?reset=1">確認をもう一度出す</a></div>
      <p class="small">それでも出ない時は、確かめた後の画面の［フルディスクアクセスを開く］から、Project Hub をリストに入れてオンにしてください（アプリのメニューからも同じことができます）。</p>`
        : '<p class="small">アプリ（Project Hub.app）で開いた時に使えます。アプリが古い時は、ターミナルで <code>bash hub/app/build-app.sh</code> を実行して作り直してください。</p>'}</div>
    <div class="card"><h2>会話画面</h2>
      <label class="chk"><input type="checkbox" id="set-detail" ${showDetail() ? 'checked' : ''}> コマンドなど、AI の細かい作業も会話に出す</label>
      <p class="small">出さない時も、作業中の印と返事はいつも通り出ます。モデル名を断られた時などの大事な知らせは、いつも出ます。</p></div>
    <div class="card"><h2>役割分担</h2>
      <p>役割ごとに、いつもの担当と上限の時の担当を決めます（AI・モデル・思考）。作業ごとに変えたい時は、作業画面の下で選べます。</p>
      <div class="tbl"><table><tr><th>役割</th><th>いつもの担当</th><th>上限の時</th><th>内容</th></tr>
      ${rolesDraft.map((r, i) => `<tr><td class="now">${esc(r.name)}</td><td>${cell(i, 'main', r.main)}</td><td>${cell(i, 'backup', r.backup)}</td><td class="job">${esc(r.job)}</td></tr>`).join('')}</table></div>
      <div class="acts" style="margin-top:12px"><button class="btn" id="roles-save" type="button" ${dirty ? '' : 'disabled'}>保存する</button>
        <button class="btn plain" id="roles-reset" type="button" ${dirty ? '' : 'disabled'}>元に戻す</button>
        <span class="${dirty ? 'dirty' : 'saved'}">${dirty ? '変更があります（まだ保存していません）' : '保存済み'}</span></div>
      <p class="small"><span id="model-catalog">選べるモデル：Claude Code は ${esc((models['claude-code'] || []).join(' / '))}、Codex は ${esc((models.codex || []).join(' / '))}。思考は ${esc(state.efforts.join(' → '))}。</span>保存先 <span class="path">${esc(state.root)}/_hub/roles.yaml</span></p></div>
    <div class="card"><h2>CLI に渡すモデル名</h2>
      <p>画面のモデルの呼び名を、Claude Code・Codex が受け付ける名前に直します。<b>空にすると、モデルを指定せず CLI の既定のモデルを使います。</b>モデル名が拒否された場合は理由を表示し、設定を勝手に変えません。</p>
      <div id="climodels" class="small">読み込み中…</div></div>
    <div class="card"><h2>バージョン</h2><p>今の版：<b>v${esc(state.version || '')}</b>${state.latest && state.latest !== state.version ? `（新しい版 v${esc(state.latest)} を取り込み済み。上の［新しい版にする］で切り替わります）` : ''}</p>
      <details class="more" id="verd" ${verOpen ? 'open' : ''}><summary>変更の記録</summary><div id="verbox" class="small">読み込み中…</div></details></div>
    <div class="card"><details class="more" id="logd"><summary>最近の操作（記録）</summary><div id="logbox" class="small">読み込み中…</div></details></div>
  </div></div>`;
  drawAiTools(); loadAiTools();
  loadCliModels();
}
// CLI に渡すモデル名：読み込んで表にする・保存する
let cliModelsLoadSeq = 0;
async function loadCliModels(keepDraft = false) {
  const box = $('#climodels'); if (!box) return;
  const seq = ++cliModelsLoadSeq;
  try {
    const r = await api('/api/cli-models');
    if ($('#climodels') !== box || seq !== cliModelsLoadSeq) return;
    const draft = new Map();
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => draft.set(`${el.dataset.ai}/${el.dataset.name}`, el.value));
    const table = ai => `<div class="tbl"><table><tr><th>${AI_LABEL[ai]}</th><th>CLI に渡す名前</th></tr>${r[ai].map(x => `<tr><td class="now">${esc(x.name)}</td><td><input class="cm" data-ai="${ai}" data-name="${esc(x.name)}" value="${esc(x.flag)}" list="hint-${ai}" placeholder="（空＝${AI_LABEL[ai]} の既定のモデル）" maxlength="60"></td></tr>`).join('')}</table></div>
      <datalist id="hint-${ai}">${(r.hints[ai] || []).map(h => `<option value="${esc(h)}">`).join('')}</datalist>`;
    box.innerHTML = `${table('claude')}${table('codex')}
      ${(r.hints.codex || []).length ? `<p class="small">Codex の設定で見つかった名前：${r.hints.codex.map(esc).join('、')}</p>` : ''}
      <div class="acts" style="margin-top:10px"><button class="btn" id="cm-save" type="button">保存する</button></div>`;
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => { const key = `${el.dataset.ai}/${el.dataset.name}`; if (draft.has(key)) el.value = draft.get(key); });
  } catch (e) { box.textContent = '読み込めませんでした'; }
}
document.addEventListener('click', async e => {
  if (e.target.id !== 'cm-save') return;
  const o = { claude: {}, codex: {} };
  document.querySelectorAll('input.cm').forEach(i => { o[i.dataset.ai][i.dataset.name] = i.value.trim(); });
  try { await api('/api/cli-models', o); toast('モデル名を保存しました（次に送る時から使います）'); loadCliModels(); } catch (err) { toast(err.message); }
});
// 版の表示と［新しい版にする］。どの画面にいても、30秒ごとに確かめる
function showVersion(version, latest) {
  $('#ver').textContent = version ? 'v' + version : '';
  const newer = latest && version && latest !== version;
  if ($('#upd').disabled) return; // 切り替え中
  $('#upd').hidden = !newer;
  if (newer) $('#upd').textContent = `新しい版 v${latest} にする`;
}
let versionPolling = false;
async function pollVersion() {
  if (document.hidden || versionPolling) return;
  versionPolling = true;
  try { const v = await api('/api/version'); state.version = v.version; state.latest = v.latest; showVersion(v.version, v.latest); } catch (e) { /* 次に */ }
  finally { versionPolling = false; }
}
setInterval(pollVersion, 30000);
let verOpen = false;
async function loadChangelog() {
  const box = $('#verbox'); if (!box) return;
  try {
    const rows = await api('/api/changelog');
    box.innerHTML = `<ul class="log">${rows.map(r => `<li><b>v${esc(r.version)}</b> <span class="small">${esc(r.date)}</span><ul>${r.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
  } catch (e) { box.textContent = '読み込めませんでした'; }
}
// 新しい版にする：本体を起動し直し、戻ってきたら画面を読み直す
async function restartHub() {
  const b = $('#upd'); b.disabled = true; b.textContent = '切り替えています…';
  try { await api('/api/restart', {}); }
  catch (e) { toast(e.message); b.disabled = false; render(); return; }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const s = await api('/api/state'); if (s.version === s.latest) { location.reload(); return; } } catch (e) { /* まだ */ }
  }
  toast('切り替わりませんでした。アプリを開き直してください');
}
const ACTION = { chatredo: '取り消してやり直した', chatamend: '追加説明を送った', chatqueue: '順番待ちにした', climodels: 'モデル名を直した', refs: '参考を足した', restart: '新しい版にした', chat: '会話で頼んだ', newproject: 'プロジェクトを作った', start: '始めた', stop: '止めた', handoff: '交代した', upload: 'ファイルを渡した', switch: 'モデル・思考を変えた', merge: '本体に取り込んだ', nextphase: '次のフェーズへ', projectdone: 'プロジェクトを完了にした', projectreopen: 'プロジェクトの完了を取り消した', newtask: '作業を足した' };
async function loadLog() {
  const box = $('#logbox'); if (!box) return;
  try {
    const rows = await api('/api/log?n=30');
    box.innerHTML = rows.length ? `<ul class="log">${rows.map(r => `<li><span class="small">${esc(new Date(r.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span> ${esc(r.project || '')}${r.task ? '・' + esc(r.task) : ''}：${esc(ACTION[r.action] || r.action)}${r.ai ? `（${esc(AI_LABEL[r.ai] || r.ai)}）` : ''}${r.action === 'merge' && r.conflict ? '・ぶつかったので中止' : ''}</li>`).join('')}</ul>` : '<p class="note">まだありません。</p>';
  } catch (e) { box.textContent = '読み込めませんでした'; }
}
async function saveRoles() {
  try { state.roles = await api('/api/roles', { roles: rolesDraft }); rolesDraft = null; toast('役割分担を保存しました'); render(); }
  catch (e) { toast(e.message); }
}

// ---- 操作 ----
async function act(el) {
  const a = el.dataset.act, p = el.dataset.p || view.project, t = el.dataset.t;
  try {
    if (a === 'start') await startAI(p, t, el.dataset.ai);
    else if (a === 'stop') { await api('/api/term/stop', { project: p, task: t, ai: el.dataset.ai }); toast('止めました'); await load(); }
    else if (a === 'handoff') {
      el.disabled = true;
      try {
        const r = await api('/api/term/handoff', { project: p, task: t, to: el.dataset.to, cols: 100, rows: 30 });
        toast(`${r.started ? `${AI_LABEL[el.dataset.to]} を始め、` : `${AI_LABEL[el.dataset.to]} に`}引き継ぎ資料を渡しました${r.kind === 'screen' ? '（会話の記録が読めず、画面の文字で代わりにしました）' : ''}`);
      } finally { await load(); }
    }
    else if (a === 'files') await openFiles(el);
    else if (a === 'mode') setMode(el.dataset.m);
    else if (a === 'pstatus') {
      const done = el.dataset.s === '完了';
      if (done && !confirm('このプロジェクトを完了にしますか？（あとで［完了を取り消す］で戻せます）')) return;
      await api('/api/project/status', { project: p, status: el.dataset.s }); toast(done ? 'プロジェクトを完了にしました' : '完了を取り消しました'); await load();
    }
    else if (a === 'nextphase') { await api('/api/phase/next', { project: p }); toast('次のフェーズへ進みました'); await load(); }
    else if (a === 'merge') {
      el.disabled = true;
      try { await api('/api/task/merge', { project: p, task: t }); toast('本体に取り込みました。作業用コピーはゴミ箱へ移しました'); }
      finally { await load(); }
    }
    else if (a === 'memo') {
      const input = $('#memo');
      if (!input || !input.value.trim()) { toast('メモを入れてください'); return; }
      await api('/api/task', { project: p, task: t, memo: input.value }); input.value = ''; toast('メモを残しました'); await load();
    } else if (a === 'answered') { await api('/api/task', { project: p, task: t, question: '', state: '実行中', memo: '人が返事した' }); toast('返事済みにしました'); await load(); }
  } catch (e) { toast(e.message); }
}

document.addEventListener('click', e => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-act="files"]')) $('#menu').hidden = true;
  const tg = e.target.closest('[data-toggle]');
  if (tg) { const id = tg.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); save(); renderTree(); e.stopPropagation(); return; }
  const go = e.target.closest('[data-go]');
  if (go) {
    view = { kind: go.dataset.go, project: go.dataset.p || view.project, task: go.dataset.t || null };
    showInTree(); save(); render(); return;
  }
  if (e.target.id === 'set-detail') { try { localStorage.setItem('hub-detail', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? '細かい作業を出します' : '細かい作業を隠します'); return; }
  if (e.target.id === 'models-tidy') {
    if (rolesDraft && JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles) && !confirm('役割分担の保存していない変更は消えます。整理しますか？')) return;
    api('/api/models/tidy', {}).then(async r => {
      rolesDraft = null; await load();
      const box = $('#tidy-result');
      const msg = r.changes.length ? `整理しました（${r.changes.length} か所）：` + r.changes.map(c => `${c.role}の${c.slot} ${c.from} → ${c.to}`).join('、') : '整理しました。役割はもう最新のモデルを使っています';
      if (box) box.textContent = msg; toast(r.changes.length ? `${r.changes.length} か所を最新のモデルにしました` : '役割はもう最新です');
    }).catch(err => toast(err.message));
    return;
  }
  if (e.target.dataset && e.target.dataset.mv !== undefined) {
    const el = e.target;
    api('/api/models/hidden', { ai: el.dataset.mvAi, model: el.dataset.mv, hidden: !el.checked })
      .then(r => { state.hiddenModels = r.hiddenModels; toast(el.checked ? `${el.dataset.mv} を出します` : `${el.dataset.mv} を隠しました`); })
      .catch(err => { el.checked = !el.checked; toast(err.message); });
    return;
  }
  if (e.target.id === 'roles-save') { saveRoles(); return; }
  if (e.target.id === 'roles-reset') { rolesDraft = null; render(); return; }
  const b = e.target.closest('[data-act]');
  if (b && b.tagName !== 'SELECT') act(b);
});
let stepsOpen = false;
document.addEventListener('toggle', e => {
  if (e.target.classList && e.target.classList.contains('steps')) stepsOpen = e.target.open;
  if (e.target.id === 'logd' && e.target.open) loadLog();
  if (e.target.id === 'verd') { verOpen = e.target.open; if (verOpen) loadChangelog(); }
}, true);
document.addEventListener('change', async e => {
  const s = e.target;
  if (s.dataset.r !== undefined && rolesDraft) {
    const r = rolesDraft[+s.dataset.r][s.dataset.k];
    r[s.dataset.f] = s.value;
    if (s.dataset.f === 'ai') {
      const list = shownModels(s.value);
      r.model = s.value === '人' ? '' : (list.includes(r.model) ? r.model : list[0] || '');
      r.effort = s.value === '人' ? '' : (r.effort || '高');
    }
    render(); return;
  }
  const a = s.dataset.act;
  if (a === 'step') {
    try { const r = await api('/api/task/step', { project: s.dataset.p, task: s.dataset.t, index: +s.dataset.i, done: s.checked }); toast(r.state === '完了' ? '手順がすべて終わりました。完了にしました' : '手順を更新しました'); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (a === 'phase') {
    try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, phase: s.value }); toast('フェーズを変えました'); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (!['state', 'model', 'effort'].includes(a)) return;
  if (s.dataset.ai && a !== 'state') {
    try {
      const r = await api('/api/term/switch', { project: s.dataset.p, task: s.dataset.t, ai: s.dataset.ai, field: a, value: s.value });
      toast(r.sent ? `${AI_LABEL[s.dataset.ai]} に「${r.command}」を送りました` : '保存しました（次に始める時から使います）');
      await load();
    } catch (err) { toast(err.message); }
    return;
  }
  try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, [a]: s.value }); toast(a === 'state' ? `「${s.value}」にしました` : '変えました'); await load(); }
  catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.classList.contains('addstep')) {
    e.preventDefault();
    const f = e.target, v = f.step.value.trim();
    if (!v) return;
    try { await api('/api/task/step', { project: f.dataset.p, task: f.dataset.t, add: v }); stepsOpen = true; toast('手順を足しました'); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'projform') {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const p = await api('/api/project/new', { ...Object.fromEntries(f.entries()), related: f.getAll('related'), refs: newRefs });
      toast(`「${p.name}」を作りました。作業を足して始めましょう`);
      newRefs = [];
      view = { kind: 'project', project: p.id, task: null }; open.add(p.id); save(); await load();
    } catch (err) { toast(err.message); }
    return;
  }
  // すぐ始める：書いた文から作業を作り、会話画面で AI に送る（役割・担当は今のフェーズから）
  if (e.target.id === 'quickform') {
    e.preventDefault();
    const f = e.target, text = f.text.value.trim();
    const p = proj(view.project);
    if (!text || !p || f.dataset.busy) return;
    f.dataset.busy = '1';
    const info = phaseInfo(p);
    const ph = info.list[info.cur];
    const role = ph && state.roles.roles.find(r => r.name === ph.role);
    const ai = role && role.main.ai === 'codex' ? 'codex' : 'claude';
    const line = text.split('\n').find(x => x.trim()) || text;
    const title = line.trim().length > 40 ? line.trim().slice(0, 40) + '…' : line.trim();
    try {
      const t = await api('/api/task/new', { project: p.id, title, owner: ai === 'codex' ? 'codex' : 'claude-code', role: role ? role.name : '', phase: ph ? ph.name : '' });
      await api('/api/task', { project: p.id, task: t.id, state: '実行中' });
      await api('/api/chat/send', { project: p.id, task: t.id, ai, model: '', effort: '', text });
      try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
      toast('作業を作って、AI に頼みました');
      view = { kind: 'work', project: p.id, task: t.id }; save(); await load();
    } catch (err) { toast(err.message); delete f.dataset.busy; }
    return;
  }
  if (e.target.id !== 'newform') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const t = await api('/api/task/new', { project: view.project, title: f.get('title'), owner: f.get('owner'), role: f.get('role'), parent: f.get('parent'), phase: f.get('phase') || '', via: f.get('via') || '', steps: f.get('steps') || '' });
    toast('作業を足しました'); view = { kind: 'work', project: view.project, task: t.id }; save(); await load();
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#menu').hidden = true; if ($('#fsheet')) $('#fsheet').hidden = true; }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest && e.target.closest('#quickform')) { e.preventDefault(); $('#quickform').requestSubmit(); }
});
$('#turn').addEventListener('click', () => { view = { ...view, kind: view.kind === 'turn' ? 'project' : 'turn' }; render(); });
$('#ver').addEventListener('click', () => { view = { ...view, kind: 'settings' }; rolesDraft = null; verOpen = true; render(); loadChangelog(); });
$('#upd').addEventListener('click', restartHub);
// 本体のフォルダ：Mac のフォルダ選択の窓で選ぶ
document.addEventListener('click', async e => {
  if (e.target.dataset && e.target.dataset.rmref !== undefined) { newRefs.splice(+e.target.dataset.rmref, 1); drawRefs(); return; }
  if (e.target.id === 'np-refpick') {
    try { const r = await api('/api/pick-folder', { prompt: '参考にするフォルダを選んでください' }); if (r.path) addNewRefs([r.path]); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id !== 'np-pick') return;
  try { const r = await api('/api/pick-folder', { prompt: '本体のフォルダを選んでください' }); if (r.path) setBodyFolder(r.path); }
  catch (err) { toast(err.message); }
});
function setBodyFolder(p) {
  const i = $('#np-body'); if (!i) return;
  i.value = p;
  const d = i.closest('details'); if (d) d.open = true;
  const n = $('#np-name');
  if (n && !n.value.trim()) n.value = p.split('/').filter(Boolean).pop() || ''; // 名前が空ならフォルダ名を使う
  toast('本体のフォルダを入れました');
}
// アプリの窓に落とした時（本当の場所が分かる）：Mac アプリから呼ばれる
window.hubNativeDrop = async paths => {
  if (!Array.isArray(paths) || !paths.length) return;
  if (view.kind === 'newproject') {
    // 参考の欄に落とした時は参考に。本体の欄（や本体が空の時）は1つ目を本体に、残りは参考に
    if (lastDropZone === 'refs') { addNewRefs(paths); toast(`参考に ${paths.length} 件足しました`); return; }
    const body = $('#np-body');
    if (lastDropZone === 'body' || (body && !body.value.trim())) { setBodyFolder(paths[0]); if (paths.length > 1) addNewRefs(paths.slice(1)); return; }
    addNewRefs(paths); toast(`参考に ${paths.length} 件足しました`); return;
  }
  if (view.kind === 'project' && view.project) {
    try { const r = await api('/api/project/refs', { project: view.project, paths }); toast(r.added ? `参考に ${r.added} 件足しました（AI は読むだけ）` : 'もう入っています'); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (view.kind !== 'work') { toast('ファイルは作業画面に落としてください'); return; }
  const ta = $('#chat-in');
  if (ta) {
    ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + paths.join('\n') + '\n';
    chatDraft[view.task] = ta.value; ta.focus();
    api('/api/task/attach', { project: view.project, task: view.task, paths }).catch(() => {});
    toast('依頼の欄にファイルの場所を入れました。続けて指示を書いて送ってください');
    return;
  }
  const ai = lastDropAi;
  try {
    const r = await api('/api/task/attach', { project: view.project, task: view.task, ai, paths });
    toast(r.typed ? `${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : '作業ファイルに記録しました。AI を始めると読めます');
    if (r.typed && panes[ai]) panes[ai].xterm.focus();
  } catch (err) { toast(err.message); }
};
$('#gear').addEventListener('click', () => { view = { ...view, kind: view.kind === 'settings' ? 'project' : 'settings' }; rolesDraft = null; render(); });

// 左の木だけすぐ読み直す（AI が始めた・終わった時。丸の色を変えるため）
async function refreshTree() {
  const epoch = stateLoadEpoch;
  try { const next = await api('/api/state'); if (epoch !== stateLoadEpoch) return; state = next; if (treeKey() !== renderedTreeKey) renderTree(); }
  catch (e) { /* 次に */ }
}
const editing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
let statePolling = false;
async function pollState() {
  if (document.hidden || statePolling) return;
  statePolling = true;
  const epoch = stateLoadEpoch;
  try {
    const next = await api('/api/state');
    if (epoch !== stateLoadEpoch) return; // 保存後などの明示 load() を古い定期取得で上書きしない
    state = next;
    if (document.hidden) return;
    showVersion(state.version, state.latest);
    const waiting = state.projects.flatMap(p => p.tasks.filter(t => NEEDS(t) || aiWaiting(p.id, t.id).length));
    $('#turn-n').textContent = waiting.length;
    const keepMain = view.kind === 'settings' || view.kind === 'newproject' || editing() || document.querySelector('details[open]');
    if (!keepMain && mainKey() !== renderedMainKey) render();
    else {
      if (treeKey() !== renderedTreeKey) renderTree();
      if (!keepMain) updateStatus();
    }
  } catch (e) { /* 次に */ }
  finally { statePolling = false; }
}
setInterval(pollState, 15000);

// ---- ファイル・スクショを渡す（落とす／⌘V で貼る） ----
// 落とした AI の画面に渡す。画面の外なら、動いている AI が1つの時はそれに、無ければ保存して作業ファイルに記録するだけ
function dropTarget(el) {
  if (el && el.closest && el.closest('.chat')) return '';
  const pane = el && el.closest && el.closest('.pane[data-ai]');
  if (pane) return pane.dataset.ai;
  const run = ['claude', 'codex'].filter(a => document.getElementById('pane-' + a));
  return run.length === 1 ? run[0] : '';
}
async function sendFiles(files, ai) {
  if (view.kind !== 'work' || !files.length) return;
  const ta = $('#chat-in');
  if (ta) ai = ''; // 会話画面では、場所を依頼の欄に入れる
  const got = [];
  for (const f of files) {
    const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const q = new URLSearchParams({ project: view.project, task: view.task, ai, name });
    try {
      const r = await fetch('/api/task/upload?' + q, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || '渡せませんでした');
      got.push(j);
    } catch (e) { toast(`${f.name || 'ファイル'}：${e.message}`); return; }
  }
  if (ta) {
    ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + got.map(x => x.path).join('\n') + '\n';
    chatDraft[view.task] = ta.value; ta.focus();
    toast('依頼の欄にファイルの場所を入れました。続けて指示を書いて送ってください');
    return;
  }
  const typed = got.some(x => x.typed);
  toast(typed ? `${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : `ファイルを保存し、作業ファイルに記録しました（${got.length}件）。AI を始めると読めます`);
  if (typed && panes[ai]) panes[ai].xterm.focus();
}
let dropTimer = null, lastDropAi = '', lastDropZone = '';
function showDrop(ai) {
  document.querySelectorAll('.pane, .chat').forEach(p => p.classList.toggle('dropping', p.dataset.ai ? p.dataset.ai === ai : !ai));
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => document.querySelectorAll('.dropping').forEach(p => p.classList.remove('dropping')), 250);
}
// 窓にファイルを落としても、ファイルが開いて Hub が消えないようにする
document.addEventListener('dragover', e => {
  e.preventDefault();
  if (view.kind === 'work' && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.dataTransfer.dropEffect = 'copy'; lastDropAi = dropTarget(e.target); showDrop(lastDropAi); }
  else if (view.kind === 'newproject' && e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
    const inRefs = e.target.closest && e.target.closest('#np-refs');
    lastDropZone = inRefs ? 'refs' : (e.target.closest && e.target.closest('#np-drop')) ? 'body' : '';
    const z = inRefs ? $('#np-refs') : $('#np-drop');
    if (z) { document.querySelectorAll('.dropfield.dropping').forEach(x => x !== z && x.classList.remove('dropping')); z.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => z.classList.remove('dropping'), 250); }
  } else if (view.kind === 'project' && e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; const v = document.querySelector('.view'); if (v) { v.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => v.classList.remove('dropping'), 250); } }
  else if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
document.addEventListener('drop', e => {
  e.preventDefault();
  // ブラウザで開いている時は、落としたフォルダの場所が分からない
  if (view.kind === 'newproject' || view.kind === 'project') { toast('ブラウザでは場所が分かりません。［選ぶ…］を押すか、アプリの窓で落としてください'); return; }
  if (view.kind !== 'work' || !e.dataTransfer) return;
  sendFiles([...e.dataTransfer.files], dropTarget(e.target));
});
document.addEventListener('paste', e => {
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  if (view.kind !== 'work' || !files.length) return;
  e.preventDefault(); e.stopPropagation();
  sendFiles(files, dropTarget(document.activeElement));
}, true);

// 作業画面では「作業中／入力待ち」を数秒ごとに更新する（画面は作り直さない）
function updateStatus() {
  if (view.kind !== 'work') return;
  document.querySelectorAll('.pstat').forEach(el => { el.innerHTML = statusText(sessOf(view.project, view.task, el.dataset.ai)); });
}
let sessionsPolling = false;
async function pollSessions() {
  if (document.hidden || sessionsPolling || view.kind !== 'work' || !document.querySelector('.pstat')) return;
  sessionsPolling = true;
  const epoch = stateLoadEpoch;
  try { const sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; state.sessions = sessions; if (!document.hidden) updateStatus(); } catch (e) { /* 次に */ }
  finally { sessionsPolling = false; }
}
setInterval(pollSessions, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  else { pollState(); pollSessions(); if (view.kind === 'settings' && aiToolsOperation) loadAiTools(); }
});

load().catch(e => { $('#main').innerHTML = `<div class="view"><p class="note">読み込めませんでした：${esc(e.message)}</p></div>`; });
