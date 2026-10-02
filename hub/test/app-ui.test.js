'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function app() {
  const elements = new Map();
  const events = new Map();
  const timers = new Map();
  const timeouts = new Map();
  let nextTimer = 0;
  let stream;
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      dataset: {}, addEventListener() {}, setAttribute() {},
      querySelector() { return null; }, insertAdjacentHTML() {},
    });
    return elements.get(key);
  }
  class EventSource {
    constructor() { stream = this; }
    close() {}
  }
  const document = {
    hidden: false, activeElement: null,
    querySelector: s => s === 'details[open]' ? null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener(name, cb) { events.set(name, cb); },
  };
  const context = vm.createContext({
    document, window: {}, navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}), // 起動時の load() は試験用の状態を上書きしない
    EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; timers.set(id, { cb, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console,
  });
  vm.runInContext(source, context);
  return { context, document, elements, element, events, timers, timeouts, stream: () => stream };
}

const project = (state = '実行中') => ({
  id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '',
  phases: [], tasks: [{ id: 't', title: 'Task', state, owner: 'codex', role: '', model: '', effort: '',
    phase: '', steps: [], skills: [], question: '', next: '', copy: false }],
  folders: [], related: [], issues: [], chats: [],
});
const snapshot = (taskState = '実行中', sessions = []) => ({
  root: '/tmp', projects: [project(taskState)], roles: { models: { codex: [], 'claude-code': [] }, roles: [], permissions: {} },
  sessions, chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
});

test('非表示中の定期取得を止め、復帰時に1回更新する', async () => {
  const a = app();
  let calls = 0;
  a.context.api = async () => { calls++; return snapshot(); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  a.document.hidden = true;
  await a.context.pollState();
  await a.context.pollVersion();
  await a.context.pollSessions();
  assert.equal(calls, 0);
  a.document.hidden = false;
  a.events.get('visibilitychange')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('同じ状態は再描画せず、取得中に始めた入力は次回まで保持する', async () => {
  const a = app();
  let resolveFetch;
  let renders = 0;
  a.context.api = () => new Promise(resolve => { resolveFetch = resolve; });
  a.context.render = () => { renders++; vm.runInContext('renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  const same = a.context.pollState();
  resolveFetch(snapshot());
  await same;
  assert.equal(renders, 0);

  const started = a.context.pollState();
  a.document.activeElement = { tagName: 'TEXTAREA', value: 'draft' };
  resolveFetch(snapshot('完了'));
  await started;
  assert.equal(renders, 0);
  assert.equal(a.document.activeElement.value, 'draft');

  a.document.activeElement = null;
  const later = a.context.pollState();
  resolveFetch(snapshot('完了'));
  await later;
  assert.equal(renders, 1);
});

test('重複する定期取得を抑え、明示 load の結果を古い取得で上書きしない', async () => {
  const a = app();
  const pending = [];
  a.context.api = () => new Promise(resolve => pending.push(resolve));
  a.context.render = () => {};
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  const automatic = a.context.pollState();
  await a.context.pollState();
  assert.equal(pending.length, 1);
  const explicit = a.context.load();
  assert.equal(pending.length, 2);
  pending[1](snapshot('完了'));
  await explicit;
  pending[0](snapshot('未着手'));
  await automatic;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].state', a.context), '完了');
});

test('会話の sessions だけ変わっても composer と stream を作り直さない', async () => {
  const a = app();
  let renders = 0;
  a.context.api = async () => snapshot('実行中', [{ project: 'p', task: 't', ai: 'codex', running: true, quiet: 0 }]);
  a.context.render = () => { renders++; };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  await a.context.pollState();
  assert.equal(renders, 0);
});

test('端末 pane の起動と選択中作業の外部変更は描画する', async () => {
  const a = app();
  let next = snapshot();
  let renders = 0;
  a.context.api = async () => next;
  a.context.render = () => { renders++; vm.runInContext('renderedMainKey = mainKey()', a.context); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  a.context.localStorage.getItem = key => key === 'hub-mode' ? 'term' : null;
  vm.runInContext('renderedMainKey = mainKey()', a.context);
  next = snapshot('実行中', [{ project: 'p', task: 't', ai: 'codex', running: true, quiet: 0 }]);
  await a.context.pollState();
  assert.equal(renders, 1);
  next = snapshot('完了', next.sessions);
  await a.context.pollState();
  assert.equal(renders, 2);
});

test('部分応答を連続受信しても作業中タイマーは1本、本文は最新になる', () => {
  const a = app();
  const box = a.element('#msgs');
  const partial = {
    mb: { hidden: true, textContent: '' }, time: { textContent: '' }, last: { textContent: '' },
    querySelector(s) { return s === '.mb' ? this.mb : s === '.wk-time' ? this.time : this.last; },
    remove() { a.elements.delete('#msg-partial'); },
  };
  box.insertAdjacentHTML = () => a.elements.set('#msg-partial', partial);
  const stateEl = a.element('#chat-state');
  Object.defineProperty(stateEl, 'innerHTML', {
    get() { return this.html || ''; },
    set(v) { this.html = v; this.writes = (this.writes || 0) + 1; if (v.includes('chat-elapsed')) a.element('#chat-elapsed'); },
  });
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }', a.context);
  a.context.openChat(project(), project().tasks[0]);
  for (let i = 0; i < 12; i++) a.stream().onmessage({ data: JSON.stringify({ type: 'partial', ai: 'codex', text: `answer ${i}` }) });
  assert.equal(partial.mb.textContent, 'answer 11');
  assert.equal([...a.timers.values()].filter(t => t.ms === 1000).length, 1);
  assert.equal(stateEl.writes, 1);
  a.context.closePanes();
  assert.equal([...a.timers.values()].filter(t => t.ms === 1000).length, 0);
});

test('AI更新カードに現在版・導入方法・2つの操作を表示する', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; aiTools = { codex: {installed:true,version:"0.159.0",method:"standalone",models:[{id:"gpt-6.1-sol",label:"GPT-6.1-Sol"}]}, claude: {installed:true,version:"2.1.284",method:"homebrew-cask",updating:true,modelRefreshAvailable:false,models:[]} }; renderSettings()', a.context);
  assert.match(a.element('#main').innerHTML, /AI の更新/);
  const html = a.element('#ai-tools').innerHTML;
  assert.match(html, /Codex/);
  assert.match(html, /0\.159\.0/);
  assert.match(html, /単独インストール/);
  assert.match(html, /2\.1\.284/);
  assert.match(html, /Homebrew/);
  assert.match(html, /更新を確認して適用/);
  assert.match(html, /モデル一覧を再取得/);
  assert.match(html, /GPT-6\.1-Sol/);
  assert.match(html, /gpt-6\.1-sol/);
  assert.match(html, /処理中…/);
  assert.match(html, /再取得にはまだ対応していません/);
});

test('CLI 更新だけ成功した時はモデル一覧の失敗理由を残す', () => {
  const a = app();
  const message = a.context.aiToolResultText('update', { beforeVersion: '2.1.283', afterVersion: '2.1.284', changed: true, models: { ok: false, error: '一覧の取得方法がありません' } });
  assert.match(message, /2\.1\.283 → 2\.1\.284/);
  assert.match(message, /一覧の取得方法がありません/);
  assert.doesNotMatch(a.context.aiToolResultText('update', { changed: false, beforeVersion: '', afterVersion: '', verified: false, verifyError: '版コマンドが失敗' }), /最新/);
  assert.match(a.context.aiToolResultText('models', { ok: true, added: 0, source: 'claude-cache', unchanged: true, warning: '前回と同じ内容です' }), /前回の内容/);
  assert.match(a.context.aiToolResultText('models', { ok: true, added: 1, source: 'claude-cache', unchanged: false }), /再取得しました（追加 1 件）/);
});

test('別画面で始まった更新の終了を確認し、モデルを読み直して監視を止める', async () => {
  const a = app();
  const fresh = snapshot(); fresh.roles.models.codex = ['GPT-6.1-Sol'];
  let checks = 0, stateReads = 0;
  a.context.api = async route => {
    if (route === '/api/ai-tools') return { tools: { codex: { installed: true }, claude: { installed: true } }, operation: ++checks === 1 ? { ai: 'codex', kind: 'update' } : null };
    if (route === '/api/state') { stateReads++; return fresh; }
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    throw Error(route);
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}', a.context);
  await a.context.loadAiTools();
  const [watchId, watch] = [...a.timeouts.entries()].find(([, t]) => t.ms === 3000) || [];
  assert.ok(watch);
  a.timeouts.delete(watchId);
  watch.cb();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  assert.equal(stateReads, 1);
  assert.equal(vm.runInContext('state.roles.models.codex.includes("GPT-6.1-Sol")', a.context), true);
  assert.equal([...a.timeouts.values()].filter(t => t.ms === 3000).length, 0);
});

test('AI更新後は新しいモデルを取り込み、保存前の役割編集を維持する', async () => {
  const a = app();
  const calls = [];
  const fresh = snapshot();
  fresh.roles.models.codex = ['6sol', 'GPT-6.1-Sol'];
  a.context.api = async (route, body) => {
    calls.push([route, body]);
    if (route === '/api/ai-tools/update') return { ok: true, ai: 'codex', beforeVersion: '0.157.1', afterVersion: '0.159.0', changed: true, models: { ok: true, added: ['GPT-6.1-Sol'] } };
    if (route === '/api/state') return fresh;
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    if (route === '/api/ai-tools') return { tools: { codex: { version: '0.159.0', method: 'standalone', models: [{ id: 'gpt-6.1-sol' }] }, claude: {} } };
    throw Error(route);
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; rolesDraft = [{name:"Coding",main:{ai:"codex",model:"6sol",effort:"高"},backup:{ai:"人",model:"",effort:""}}]; aiTools = {codex:{version:"0.157.1"},claude:{}}', a.context);
  await a.context.runAiTool('codex', 'update');
  assert.equal(calls[0][0], '/api/ai-tools/update');
  assert.equal(calls[0][1].ai, 'codex');
  assert.equal(vm.runInContext('rolesDraft[0].main.model', a.context), '6sol');
  assert.equal(vm.runInContext('state.roles.models.codex.includes("GPT-6.1-Sol")', a.context), true);
  assert.match(a.element('#model-catalog').textContent, /GPT-6\.1-Sol/);
  assert.match(a.element('#ai-tools').innerHTML, /0\.157\.1 → 0\.159\.0/);
});

test('CLI名の再読込中に書き足した下書きを保持する', async () => {
  const a = app();
  const box = a.element('#climodels');
  let current = [{ dataset: { ai: 'codex', name: '6sol' }, value: '元の値' }];
  a.document.querySelectorAll = selector => selector === 'input.cm' ? current : [];
  Object.defineProperty(box, 'innerHTML', {
    get() { return this.html || ''; },
    set(value) { this.html = value; current = [{ dataset: { ai: 'codex', name: '6sol' }, value: 'サーバーの値' }]; },
  });
  let resolveFetch;
  a.context.api = () => new Promise(resolve => { resolveFetch = resolve; });
  const loading = a.context.loadCliModels(true);
  current[0].value = '取得中に入力した値';
  resolveFetch({ claude: [], codex: [{ name: '6sol', flag: 'サーバーの値' }], hints: { claude: [], codex: [] } });
  await loading;
  assert.equal(current[0].value, '取得中に入力した値');
});

test('利用できなくなった既存モデルを明示し、新しい候補へ選び直せる', () => {
  const a = app();
  const fresh = snapshot(); fresh.roles.models.codex = ['GPT-6.1-Sol'];
  fresh.projects[0].tasks[0].model = '旧モデル';
  a.context.localStorage.getItem = key => key.startsWith('hub-chat-') ? JSON.stringify({ ai: 'codex', model: '旧モデル', effort: '高' }) : null;
  vm.runInContext('state = ' + JSON.stringify(fresh), a.context);
  const p = fresh.projects[0], t = p.tasks[0];
  const work = a.context.specSelect(p, t, 'codex', false);
  const chat = a.context.chatHtml(p, t);
  assert.match(work, /旧モデル（現在の指定・利用不可）/);
  assert.match(work, /GPT-6\.1-Sol/);
  assert.match(chat, /旧モデル（利用できません。選び直してください）/);
  assert.match(chat, /GPT-6\.1-Sol/);
});

test('モデルだけの再取得と、段階・理由を含む失敗を表示する', async () => {
  const a = app();
  const calls = [];
  a.context.api = async route => {
    calls.push(route);
    if (route === '/api/ai-tools/models/refresh') return { ok: true, ai: 'codex', added: 1 };
    if (route === '/api/state') return snapshot();
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    if (route === '/api/ai-tools') return { tools: { codex: {}, claude: {} } };
    const error = new Error('更新できません'); error.stage = 'install'; error.reason = 'CLI が実行中'; throw error;
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; aiTools = {codex:{},claude:{}}', a.context);
  await a.context.runAiTool('codex', 'models');
  assert.equal(calls[0], '/api/ai-tools/models/refresh');
  assert.match(a.element('#ai-tools').innerHTML, /追加 1 件/);
  await a.context.runAiTool('claude', 'update');
  assert.match(a.element('#ai-tools').innerHTML, /CLI が実行中/);
  assert.match(a.element('#ai-tools').innerHTML, /段階：install/);
});
