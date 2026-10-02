'use strict';
// Project Hub 第2版：台帳の一覧、画面の中の作業画面、役割・モデル・思考の設定
// 使い方: node server.js  →  http://127.0.0.1:4545
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store, expandHome } = require('./lib/store');
const launch = require('./lib/launch');
const roles = require('./lib/roles');
const { Sessions } = require('./lib/sessions');
const gitw = require('./lib/git');
const transcript = require('./lib/transcript');
const chat = require('./lib/chat');
const { AiTools } = require('./lib/ai-tools');

const PORT = Number(process.env.HUB_PORT || 4545);
const ROOT = expandHome(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'AI-Workspace'));
const DRY = process.env.HUB_DRY_RUN === '1'; // テスト用：実際には起動しない
const PUBLIC = path.join(__dirname, 'public');
const ROLES_FILE = path.join(ROOT, '_hub', 'roles.yaml');
const store = new Store(ROOT);
const sessions = new Sessions();
const chats = new chat.ChatRunner({ dirOf: id => { const p = store.readProject(id); return p ? p.dir : ''; },
  canStart: (ai, model) => aiTools.isOperating() ? 'AI の更新・モデル再取得が進行中です' : modelError(ai, model) });
const aiTools = new AiTools({ root: ROOT, dry: DRY, busy: () => sessions.list().filter(x => x.running).length + chats.running.size });
function applyModelCatalog() {
  const catalog = aiTools.catalog();
  launch.setDiscoveredModels(catalog);
  roles.setModelCatalog(catalog);
}
applyModelCatalog();

// 版：起動した時の番号と、ファイル上の番号（更新を取り込むと変わる）
const PKG = path.join(__dirname, 'package.json');
const readVersion = () => { try { return JSON.parse(fs.readFileSync(PKG, 'utf8')).version || ''; } catch (e) { return ''; } };
const VERSION = readVersion();
function changelog(n) {
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    const m = head.match(/^([\d.]+)\s*（?([^）]*)）?/);
    out.push({ version: m ? m[1] : head.trim(), date: m ? m[2] : '', items: rest.filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, '').trim()) });
    if (out.length >= n) break;
  }
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// このパソコンの画面からの操作だけ受け付ける
function allowed(req) {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return false;
  return req.headers['x-hub'] === '1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// 操作の記録（_hub/log.jsonl に1行ずつ）。1MB を超えたら log.old.jsonl に回す
const LOG_FILE = path.join(ROOT, '_hub', 'log.jsonl');
function record(action, b, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.jsonl$/, '.old.jsonl'));
    const row = { at: new Date().toISOString(), action, project: b.project, task: b.task, ai: b.ai || b.to, ...(extra || {}) };
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  } catch (e) { /* 記録できなくても操作は続ける */ }
}
function readLog(n) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}

// 受け取ったファイルの置き場：AI-Workspace/Inbox/hub/<日付>/<時刻>-<名前>（場所に空白が入らないように）
const MAX_UPLOAD = 50 * 1024 * 1024;
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function saveUpload(name, data) {
  const d = new Date(), z = x => String(x).padStart(2, '0');
  const day = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
  const time = `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  const safe = path.basename(String(name || 'file')).replace(/[\x00-\x1f\x7f/\\:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const dir = path.join(ROOT, 'Inbox', 'hub', day);
  fs.mkdirSync(dir, { recursive: true });
  let f = path.join(dir, `${time}-${safe}`), i = 1;
  while (fs.existsSync(f)) f = path.join(dir, `${time}-${i++}-${safe}`);
  fs.writeFileSync(f, data);
  return f;
}

// CLI に渡すモデル名（設定画面で直せる）。空の文字＝モデルを指定しない（CLI の既定）
const CLI_MODELS = path.join(ROOT, '_hub', 'cli-models.json');
function loadCliModels() {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(CLI_MODELS, 'utf8')); } catch (e) { o = {}; }
  // 4.5.1 までに「断られたので渡さない」と自動で覚えた空の名前は、推測した名前へのものなので消す（1回だけ）
  if (o && !o.v && Object.keys(o).length) {
    for (const ai of ['claude', 'codex']) for (const [k, v] of Object.entries(o[ai] || {})) if (v === '') delete o[ai][k];
    o.v = 2;
    try { fs.writeFileSync(CLI_MODELS, JSON.stringify(o, null, 2)); } catch (e) { /* 書けなくても続ける */ }
  }
  launch.setOverrides(o);
}
function saveCliModels(o) { fs.mkdirSync(path.dirname(CLI_MODELS), { recursive: true }); fs.writeFileSync(CLI_MODELS, JSON.stringify({ ...o, v: 2 }, null, 2)); loadCliModels(); }
loadCliModels();
// 候補：CLI 自身の設定から、実際に使えそうなモデル名を集める
function cliModelHints() {
  const home = process.env.HUB_AI_HOME || os.homedir();
  const catalog = aiTools.catalog();
  const out = { claude: new Set(catalog.claude.models.map(x => x.id)), codex: new Set(catalog.codex.models.map(x => x.id)) };
  try { const m = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m); if (m) out.codex.add(m[1]); } catch (e) { /* 無い */ }
  try { const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); if (j.model) out.claude.add(j.model); } catch (e) { /* 無い */ }
  return { claude: [...out.claude], codex: [...out.codex] };
}

function rolesData() { return roles.read(ROLES_FILE).data; }
// 選ぶ欄に出さないモデル（設定画面で選ぶ）。_hub/model-view.json
const MODEL_VIEW = path.join(ROOT, '_hub', 'model-view.json');
function hiddenModels() {
  try { const h = JSON.parse(fs.readFileSync(MODEL_VIEW, 'utf8')).hidden || {}; return { 'claude-code': [].concat(h['claude-code'] || []).map(String), codex: [].concat(h.codex || []).map(String) }; }
  catch (e) { return { 'claude-code': [], codex: [] }; }
}

function permCmd(ai) {
  const p = rolesData().permissions || {};
  const v = ai === 'claude' ? p['claude-code'] : p.codex;
  return typeof v === 'string' && /^(claude|codex)\b/.test(v) ? v : launch.DEFAULT_CMD[ai];
}

// 作業の役割 → いつもの担当（AI・モデル・思考）。作業ファイルに指定があればそちら
function pickSpec(task, ai) {
  const data = rolesData();
  const r = data.roles.find(x => x.name === task.role);
  const slot = r ? (r.main.ai === (ai === 'claude' ? 'claude-code' : 'codex') ? r.main : r.backup.ai === (ai === 'claude' ? 'claude-code' : 'codex') ? r.backup : null) : null;
  // 作業に指定があれば、候補から消えていても別のモデルへ置き換えない。
  const model = task.model || (slot && slot.model) || '';
  const effort = roles.EFFORTS.includes(task.effort) ? task.effort : (slot && slot.effort) || '';
  return { model, effort };
}

function modelError(ai, model) {
  if (!model) return '';
  if (aiTools.staleModel(ai, model)) return `モデル「${model}」は現在の候補から外れています。新しいモデルを選んでください`;
  if (Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, model)) return '';
  return launch.flagFor(ai, model) ? '' : `モデル「${model}」の CLI 名が分かりません。設定で直してください`;
}

// 作業する場所：作業ファイルの workdir → なければ用意する（Git なら作業用コピー、無ければ保存を始めて本体）
const workRoot = p => path.join(ROOT, 'Work', p.id);
function baseOf(p) {
  const body = p.folders.find(f => f.label === '本体');
  const d = body && expandHome(body.path);
  return d && fs.existsSync(d) ? d : p.dir;
}
function workDir(p, t) {
  const wd = expandHome(t.workdir);
  if (wd && fs.existsSync(wd)) return { dir: wd };
  const base = baseOf(p);
  if (DRY) return { dir: base };
  try {
    const r = gitw.prepare({ base, workRoot: workRoot(p), taskId: t.id, direct: base === p.dir });
    if (r.worktree) store.updateTask(p.id, t.id, { workdir: r.dir });
    return r;
  } catch (e) {
    return { dir: base, note: `作業用コピーを作れなかったため、本体で作業します（${String(e.message || e).split('\n')[0]}）` };
  }
}
const inWork = (p, t) => { const wd = expandHome(t.workdir); const rel = wd && path.relative(workRoot(p), wd); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };

// 人が決めた役割とモデル（roles.yaml）。AI が他のファイル（エージェントの設定など）の古い指定に従わないよう、毎回伝える
function modelPolicy() {
  const d = rolesData();
  const label = s => (s.ai === 'claude-code' ? 'Claude Code' : 'Codex');
  const slot = s => { if (!s || s.ai === '人' || !s.model) return ''; const f = launch.flagFor(s.ai === 'claude-code' ? 'claude' : 'codex', s.model); return `${label(s)}・${s.model}${f ? `（${f}）` : ''}`; };
  const list = d.roles.map(r => slot(r.main) ? `${r.name}＝${slot(r.main)}` : '').filter(Boolean).join('、');
  return `【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】${list}。claude-opus-4-6 などの古いモデルは使わない。エージェント（紬・律など）に頼む時も、この決まりのモデルを指定すること。`;
}

function taskPrompt(p, t, file, dir) {
  const rel = dir && path.relative(workRoot(p), dir);
  const copy = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `今いるフォルダ（${dir}）はこの作業専用の作業用コピー。ここだけで作業し、本体には触らないこと（取り込みは人が Hub で行う）。` : '';
  const refs = p.folders.filter(f => /^参考/.test(f.label)).map(f => expandHome(f.path));
  let projects;
  const rels = p.related.map(r => {
    const byId = store.readProject(r);
    if (byId) return byId.dir;
    projects ||= store.listProjects();
    return projects.find(x => x.name === r)?.dir;
  }).filter(Boolean);
  const look = refs.length || rels.length ? `参考にしてよい場所（読むだけ。書き換えない）: ${[...refs, ...rels].join(' / ')}。` : '';
  return modelPolicy() + copy + look + `作業ID ${t.id}（${t.title}）の続きをしてください。まず次の3つを読むこと: ${path.join(p.dir, '.ai', 'rules.md')} / ${path.join(p.dir, 'PROJECT.md')} / ${file}。区切りごとに作業ファイルを更新し、「## 手順」の終わった所を [x] にすること（手順が無ければ3〜5個書く）。`;
}

async function api(req, res, url) {
  // Mac の許可が無くて中を読めない時の知らせ（Finder が違う場所で開くのを防ぐ）
  const denied = x => { try { fs.readdirSync(fs.statSync(x).isDirectory() ? x : path.dirname(x)); return ''; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code) ? 'Mac の許可が無くて開けません。設定画面の「Mac のファイルの許可」で［確認をもう一度出す］を押し、「許可」を選んでください' : ''; } };
  // 本体が台帳のフォルダ（書類フォルダの中）を読めるか。Mac の許可が本体に効いているかをアプリが確かめる
  if (req.method === 'GET' && url.pathname === '/api/access') {
    try { fs.readdirSync(ROOT); return send(res, 200, { ok: true, root: ROOT }); }
    catch (e) { return send(res, 200, { ok: false, root: ROOT, code: e.code || '' }); }
  }
  // 一覧
  // 生きているかだけ答える（ファイルを読まないので、台帳が大きくても・iCloud が遅くてもすぐ返る）
  if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, pid: process.pid });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const t0 = Date.now();
    res.on('finish', () => { const ms = Date.now() - t0; if (ms > 2000) console.log(`[遅い] 一覧を作るのに ${ms}ms かかりました（台帳のファイルの読み込みが遅い可能性）`); });
    const roleData = rolesData();
    return send(res, 200, {
      root: ROOT, roles: roleData, version: VERSION, latest: readVersion(),
      cliFlags: Object.fromEntries(['claude', 'codex'].map(ai => [ai, Object.fromEntries((roleData.models[ai === 'claude' ? 'claude-code' : 'codex'] || []).map(m => [m, launch.flagFor(ai, m)]))])),
      projects: store.listProjects().map(p => ({ ...p, copies: gitw.countCopies(workRoot(p)), tasks: p.tasks.map(t => ({ ...t, copy: inWork(p, t) })) })),
      sessions: sessions.list(), terminal: sessions.available(),
      chatting: [...chats.running.entries()].map(([k, r]) => { const [project, task] = k.split('\u0000'); return { project, task, ai: r.ai, model: r.model }; }),
      efforts: roles.EFFORTS, hiddenModels: hiddenModels(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/ai-tools') {
    const status = await aiTools.status();
    applyModelCatalog();
    return send(res, 200, status);
  }

  // 会話画面：今までの会話と、書いている途中の返事を流す
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task');
    const p = store.readProject(project);
    if (!p || !store.taskFile(project, task)) return send(res, 404, { error: '作業が見つかりません' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const run = chats.busy(project, task);
    emit({ type: 'rows', rows: chat.read(p.dir, task), busy: run ? { ai: run.ai, model: run.model, text: run.texts.join('\n\n'), started: run.started, last: run.last } : null, queue: chats.queue(project, task) });
    const off = chats.watch(project, task, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/api/cli-models') {
    const m = rolesData().models;
    const rows = ai => (m[ai === 'claude' ? 'claude-code' : 'codex'] || []).map(name => ({ name, flag: launch.flagFor(ai, name), set: Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, name) }));
    return send(res, 200, { claude: rows('claude'), codex: rows('codex'), hints: cliModelHints() });
  }
  if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: VERSION, latest: readVersion() });
  if (req.method === 'GET' && url.pathname === '/api/changelog') return send(res, 200, changelog(12));
  if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, sessions.list());
  if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, readLog(Math.min(200, Number(url.searchParams.get('n')) || 50)));
  // 取り込む前の見通し（変更の量・ぶつかりそうか）
  if (req.method === 'GET' && url.pathname === '/api/task/preview') {
    const p = store.readProject(url.searchParams.get('project'));
    const file = p && store.taskFile(p.id, url.searchParams.get('task'));
    if (!file) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 200, null);
    let r = null;
    try { r = gitw.preview({ dir: expandHome(t.workdir), workRoot: workRoot(p) }); } catch (e) { r = null; }
    return send(res, 200, r);
  }

  // 作業画面の出力を流す（Server-Sent Events）
  if (req.method === 'GET' && url.pathname === '/api/term/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task'), ai = url.searchParams.get('ai');
    const s = sessions.get(project, task, ai);
    if (!s) return send(res, 404, { error: '作業画面がありません' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    emit({ type: 'data', data: s.buf, replay: true });
    if (s.exited) emit({ type: 'exit', code: s.code });
    const off = sessions.watch(project, task, ai, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method' });

  // ファイル・スクショを受け取る（本文はファイルそのもの）。Inbox に置き、作業ファイルに記録し、動いている AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/upload') {
    const q = k => url.searchParams.get(k) || '';
    const p = store.readProject(q('project'));
    const file = p && store.taskFile(p.id, q('task'));
    if (!file) { req.resume(); return send(res, 400, { error: '作業が見つかりません' }); }
    let data;
    try { data = await readRaw(req, MAX_UPLOAD); } catch (e) { return send(res, 413, { error: 'ファイルが大きすぎます（50MB まで）' }); }
    const saved = saveUpload(q('name'), data);
    store.updateTask(p.id, q('task'), { memo: `ファイルを渡した: ${saved}` });
    const ai = ['claude', 'codex'].includes(q('ai')) ? q('ai') : '';
    const typed = ai ? sessions.write(p.id, q('task'), ai, (/\s/.test(saved) ? `"${saved}"` : saved) + ' ') : false;
    record('upload', { project: p.id, task: q('task'), ai }, { file: saved, bytes: data.length });
    return send(res, 200, { ok: true, path: saved, typed });
  }

  const b = await readBody(req);
  if (url.pathname === '/api/ai-tools/update' || url.pathname === '/api/ai-tools/models/refresh') {
    try {
      const result = url.pathname.endsWith('/update') ? await aiTools.update(b.ai) : await aiTools.refresh(b.ai);
      applyModelCatalog();
      record(url.pathname.endsWith('/update') ? 'aiupdate' : 'aimodels', { ai: b.ai }, { added: result.models?.added ?? result.added ?? 0 });
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 502, { error: e.reason || e.message || 'CLI の操作に失敗しました', stage: e.stage || 'operation', reason: e.reason || e.message || '' });
    }
  }
  if (aiTools.isOperating() && ['/api/term/start', '/api/term/handoff', '/api/continue', '/api/chat/send'].includes(url.pathname)) {
    return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です。終わってから始めてください' });
  }

  // 作業画面を開く（画面の中）
  if (url.pathname === '/api/term/start') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !['claude', 'codex'].includes(b.ai)) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    const { model, effort } = pickSpec(t, b.ai);
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const cur = sessions.get(b.project, b.task, b.ai);
    const { dir, note } = cur && !cur.exited ? { dir: cur.dir } : workDir(p, t);
    const argv = launch.buildArgv({ ai: b.ai, prompt: taskPrompt(p, t, file, dir), cmd: permCmd(b.ai), model, effort });
    if (DRY) return send(res, 200, { ok: true, dry: true, dir, model, effort, ...argv });
    try {
      const s = sessions.start({ project: b.project, task: b.task, ai: b.ai, dir, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows });
      record('start', b, { model, effort, dir });
      return send(res, 200, { ok: true, dir, note, model, effort, running: !s.exited });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }
  // 交代する：前の AI の会話を「引き継ぎ資料」にまとめ、相手の AI に読ませて続けさせる
  // 相手が動いていなければ、役割どおりのモデル・思考で始める。相手が作業中なら断る（勝手に割り込まない）
  if (url.pathname === '/api/term/handoff') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !['claude', 'codex'].includes(b.to)) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    const from = b.to === 'claude' ? 'codex' : 'claude';
    const LABEL = { claude: 'Claude Code', codex: 'Codex' };
    const tgt = sessions.get(b.project, b.task, b.to);
    const tgtLive = tgt && !tgt.exited;
    if (!tgtLive) {
      const invalidModel = modelError(b.to, pickSpec(t, b.to).model);
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    if (tgtLive && Date.now() - tgt.lastOut < 20000) return send(res, 409, { error: `${LABEL[b.to]} が作業中です。止まってから（入力待ちになってから）交代してください` });
    const src = sessions.get(b.project, b.task, from);
    const { dir } = tgtLive ? { dir: tgt.dir } : workDir(p, t);
    const convo = transcript.collect({ ai: from, dir: (src && src.dir) || dir, since: src ? src.started : Date.now() - 3 * 86400000, buf: src && src.buf });
    const board = path.join(p.dir, '.ai', 'board.md');
    const note = b.note ? String(b.note).replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
    const hdir = path.join(p.dir, '.ai', 'handoff');
    fs.mkdirSync(hdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const packetFile = path.join(hdir, `${t.id}-${stamp}-${from}.md`);
    fs.writeFileSync(packetFile, transcript.packet({ fromLabel: LABEL[from], toLabel: LABEL[b.to], taskFile: file, board, convo, extra: note }));
    const msg = `${LABEL[from]} から交代です。引き継ぎ資料 ${packetFile} を読み、${file} と ${board} も確かめてから、あなたの役割で続けてください。`;
    let started = false, spec = null;
    if (tgtLive) {
      sessions.type(b.project, b.task, b.to, msg);
    } else {
      spec = pickSpec(t, b.to);
      const argv = launch.buildArgv({ ai: b.to, prompt: msg + ' ' + taskPrompt(p, t, file, dir), cmd: permCmd(b.to), model: spec.model, effort: spec.effort });
      if (DRY) return send(res, 200, { ok: true, dry: true, packet: packetFile, kind: convo.kind, ...argv });
      try { sessions.start({ project: b.project, task: b.task, ai: b.to, dir, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows }); started = true; }
      catch (e) { return send(res, 500, { error: String(e.message || e), packet: packetFile }); }
    }
    store.updateTask(p.id, t.id, { owner: b.to === 'claude' ? 'claude-code' : 'codex', memo: `${LABEL[from]} から ${LABEL[b.to]} へ交代（引き継ぎ資料: ${packetFile}）` });
    record('handoff', b, { packet: packetFile, kind: convo.kind, started });
    return send(res, 200, { ok: true, packet: packetFile, kind: convo.kind, started, ...(spec || {}) });
  }
  // 動いている AI のモデル・思考を変える：作業ファイルに残し、その AI に /model・/effort を打つ
  if (url.pathname === '/api/term/switch') {
    if (!['claude', 'codex'].includes(b.ai) || !['model', 'effort'].includes(b.field)) return send(res, 400, { error: '指定が正しくありません' });
    if (b.field === 'model') {
      const invalidModel = modelError(b.ai, String(b.value || ''));
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    const t = store.updateTask(b.project, b.task, { [b.field]: typeof b.value === 'string' ? b.value : '' });
    if (!t) return send(res, 400, { error: '作業が見つかりません' });
    const spec = pickSpec(t, b.ai);
    const cmd = launch.switchCommand(b.ai, b.field, spec[b.field]);
    const sent = Boolean(cmd) && sessions.type(b.project, b.task, b.ai, cmd);
    record('switch', b, { [b.field]: spec[b.field], sent });
    return send(res, 200, { ok: true, sent, command: cmd, ...spec });
  }
  if (url.pathname === '/api/term/input') {
    return send(res, sessions.write(b.project, b.task, b.ai, String(b.data || '')) ? 200 : 404, { ok: true });
  }
  if (url.pathname === '/api/term/resize') {
    return send(res, sessions.resize(b.project, b.task, b.ai, b.cols, b.rows) ? 200 : 404, { ok: true });
  }
  if (url.pathname === '/api/term/stop') {
    record('stop', b);
    return send(res, 200, { ok: sessions.stop(b.project, b.task, b.ai) });
  }

  // 別の窓で開く（作業画面の部品が無い時の代わり）
  if (url.pathname === '/api/continue') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !['claude', 'codex'].includes(b.ai)) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    const spec = pickSpec(t, b.ai);
    const invalidModel = modelError(b.ai, spec.model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const { dir } = workDir(p, t);
    const command = launch.buildCommand({ ai: b.ai, dir, prompt: taskPrompt(p, t, file, dir), cmd: permCmd(b.ai), ...spec });
    const r = await launch.openTerminal(command, DRY);
    return send(res, 200, { ok: true, dir, ...(DRY ? { command, r } : {}) });
  }

  // フォルダを Finder で開く（台帳に書かれた場所だけ）
  if (url.pathname === '/api/open') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: 'プロジェクトが見つかりません' });
    let target = null;
    if (b.kind === 'project') target = p.dir;
    else if (b.kind === 'folder') target = (p.folders.find(f => f.label === b.label) || {}).path;
    else if (b.kind === 'workdir') { const f = store.taskFile(b.project, b.task); target = f && store.readTask(f).workdir; }
    target = expandHome(target || '');
    if (!target || !fs.existsSync(target)) return send(res, 404, { error: 'その場所が見つかりません', path: target });
    if (denied(target)) return send(res, 403, { error: denied(target), path: target });
    const r = await launch.openFolder(target, DRY);
    return send(res, 200, { ok: true, path: target, ...(DRY ? { r } : {}) });
  }

  // 文の中のファイル・フォルダを Finder で開く（作業の場所からの相対でもよい。ホームの中だけ）
  if (url.pathname === '/api/reveal') {
    const raw = String(b.path || '').trim();
    if (!raw) return send(res, 400, { error: '場所がありません' });
    const p = store.readProject(b.project);
    const f = p && b.task ? store.taskFile(b.project, b.task) : null;
    const t = f ? store.readTask(f) : null;
    const bases = [t && expandHome(t.workdir), p && baseOf(p), p && p.dir, ROOT].filter(Boolean);
    const list = raw.startsWith('~') || path.isAbsolute(raw) ? [expandHome(raw)] : bases.map(d => path.join(d, raw));
    const home = [os.homedir(), ROOT].map(d => path.resolve(d));
    const target = list.map(x => path.resolve(x)).find(x => home.some(h => x === h || x.startsWith(h + path.sep)) && fs.existsSync(x));
    if (!target) return send(res, 404, { error: `見つかりません：${raw}` });
    if (denied(target)) return send(res, 403, { error: denied(target) });
    const isDir = fs.statSync(target).isDirectory();
    // how: list＝フォルダの中身を返す（Finder を使わずに画面で見る）／open＝ファイルをそのアプリで開く／finder（前から）＝Finder で見せる
    const how = ['list', 'open'].includes(b.how) ? b.how : 'finder';
    if (how === 'list' && isDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).slice(0, 500)
          .map(d => { const full = path.join(target, d.name); let st = null; try { st = fs.statSync(full); } catch (e) { /* 読めない物 */ } return { name: d.name, path: full, dir: st ? st.isDirectory() : d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }; })
          .sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name, 'ja') : x.dir ? -1 : 1));
      } catch (e) { return send(res, 403, { error: denied(target) || String(e.message) }); }
      const up = path.dirname(target);
      return send(res, 200, { ok: true, path: target, dir: true, entries, parent: home.some(h => up === h || up.startsWith(h + path.sep)) ? up : '' });
    }
    record('reveal', { project: b.project, task: b.task }, { path: target, dir: isDir, how, app: Boolean(b.app) });
    const act = how === 'list' ? 'open' : how; // ファイルに list が来たら開く
    // アプリの中では、アプリ自身が開く（許可がアプリに付いているため）。ブラウザの時は本体が open で開く
    if (b.app) return send(res, 200, { ok: true, path: target, dir: isDir, byApp: true, how: act });
    const r = act === 'open' || isDir ? await launch.openFolder(target, DRY) : await launch.revealFile(target, DRY);
    return send(res, 200, { ok: true, path: target, dir: isDir, how: act, ...(DRY ? { r } : {}) });
  }
  // URL を既定のブラウザで開く（http・https だけ）
  if (url.pathname === '/api/open-url') {
    const u = String(b.url || '');
    if (!/^https?:\/\/[^\s]+$/.test(u)) return send(res, 400, { error: '開けない URL です' });
    const r = await launch.openUrl(u, DRY);
    return send(res, 200, { ok: true, ...(DRY ? { r } : {}) });
  }

  // 作業の状態・質問・メモ・モデル・思考
  if (url.pathname === '/api/task') {
    const str = k => (typeof b[k] === 'string' ? b[k] : undefined);
    const t = store.updateTask(b.project, b.task, {
      state: str('state'), question: str('question'), owner: str('owner'), role: str('role'),
      model: str('model'), effort: str('effort'), parent: str('parent'), phase: str('phase'), via: str('via'), memo: b.memo,
    });
    return t ? send(res, 200, t) : send(res, 400, { error: '作業が見つかりません' });
  }
  // 手順に印を付ける・外す
  if (url.pathname === '/api/task/step') {
    const t = typeof b.add === 'string' ? store.addStep(b.project, b.task, b.add) : store.setStep(b.project, b.task, Number(b.index), Boolean(b.done));
    return t ? send(res, 200, t) : send(res, 400, { error: 'その手順が見つかりません' });
  }
  // プロジェクトを完了にする・戻す（人がはっきり押した時だけ）
  if (url.pathname === '/api/project/status') {
    if (!['完了', '進行中'].includes(b.status)) return send(res, 400, { error: '形式が違います' });
    const p = store.setProjectStatus(b.project, b.status);
    if (p) record(b.status === '完了' ? 'projectdone' : 'projectreopen', { project: b.project });
    return p ? send(res, 200, { ok: true, status: p.status }) : send(res, 400, { error: 'プロジェクトが見つかりません' });
  }
  // 次のフェーズへ進む（今のフェーズを完了に）
  if (url.pathname === '/api/phase/next') {
    const p = store.nextPhase(b.project);
    if (p) record('nextphase', b);
    return p ? send(res, 200, { ok: true, phases: p.phases }) : send(res, 400, { error: 'プロジェクトが見つかりません' });
  }
  // 作業用コピーを本体に取り込んで片付ける
  if (url.pathname === '/api/task/merge') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 400, { error: 'この作業には作業用コピーがありません' });
    if (['claude', 'codex'].some(a => { const s = sessions.get(b.project, b.task, a); return s && !s.exited; })) return send(res, 409, { error: '先に AI を止めてください（作業中に取り込むと、途中の変更が混ざります）' });
    let r;
    try { r = gitw.merge({ dir: expandHome(t.workdir), workRoot: workRoot(p), title: `${t.id} ${t.title}` }); }
    catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    record('merge', b, { ok: Boolean(r.ok), conflict: Boolean(r.conflict) });
    if (r.conflict) {
      store.updateTask(p.id, t.id, { state: '返事待ち', question: '本体に取り込む時にぶつかりました。AI を始めて「本体の最新を取り込み、ぶつかった所を直して」と頼んでから、もう一度［本体に取り込む］を押してください' });
      return send(res, 409, { error: r.error, conflict: true });
    }
    if (!r.ok) return send(res, 400, { error: r.error });
    for (const a of ['claude', 'codex']) sessions.stop(b.project, b.task, a);
    const done = store.updateTask(p.id, t.id, { workdir: '', state: '完了', question: '', memo: `本体に取り込み、作業用コピーをゴミ箱へ移しました（${r.main}）` });
    return send(res, 200, { ok: true, main: r.main, trashed: r.trashed, task: done });
  }
  // 会話画面：送る・止める
  if (url.pathname === '/api/chat/send') {
    // 待っている指示を今すぐ始める（再起動の後など、作業中でない時）
    const fromQueue = b.fromQueue ? chats.queue(b.project, b.task).find(x => x.id === String(b.fromQueue)) : null;
    if (b.fromQueue && !fromQueue) return send(res, 404, { error: 'その指示はもう待っていません' });
    if (fromQueue) Object.assign(b, { ai: fromQueue.ai, model: fromQueue.model, effort: fromQueue.effort, text: fromQueue.text, mode: '' });
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!p || !file || !['claude', 'codex'].includes(b.ai)) return send(res, 400, { error: '作業が見つかりません' });
    if (!text) return send(res, 400, { error: '依頼を書いてください' });
    const t = store.readTask(file);
    const busy = chats.busy(p.id, b.task);
    // redo: 取り消してやり直す ／ amend: 追加説明（一緒にやる）／ queue: 終わったら次に（interrupt は前の呼び名）
    const want = b.mode === 'interrupt' ? 'redo' : b.mode;
    const mode = busy ? (['redo', 'amend', 'queue'].includes(want) ? want : '') : '';
    if (busy && !mode) return send(res, 409, { error: 'まだ作業中です。［取り消してやり直す］［追加説明（一緒にやる）］［終わったら次に］から選んでください' });
    const spec = pickSpec(t, b.ai);
    const model = b.model || spec.model;
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const { dir, note } = workDir(p, t);
    const effort = roles.EFFORTS.includes(b.effort) ? b.effort : spec.effort;
    const basePrompt = taskPrompt(p, t, file, dir) + ' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。';
    // 追加：今の作業が終わったら続けて行う
    if (mode === 'queue') {
      const it = chats.enqueue(p.id, t.id, { ai: b.ai, model, effort, text, perm: permCmd(b.ai) });
      record('chatqueue', { project: p.id, task: t.id, ai: b.ai }, { model });
      return send(res, 200, { ok: true, queued: true, id: it.id, queue: chats.queue(p.id, t.id).length });
    }
    // 取り消し・追加説明：今の作業を区切って（終わるのを待って）から、元の指示と合わせて伝え直す
    let sendText = text;
    if (mode === 'redo' || mode === 'amend') {
      const last = chat.read(p.dir, t.id).filter(r => r.role === 'user').pop();
      const prev = last ? String(last.text).replace(/\s+/g, ' ').slice(0, 400) : '';
      await chats.stop(p.id, t.id, { interrupting: true });
      record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: b.ai });
      sendText = mode === 'redo'
        ? `（人が前の指示「${prev}」を取り消しました。途中で変えたファイルがあれば、必要に応じて元に戻してから、この新しい指示だけを行ってください）\n${text}`
        : `（人が追加の説明を送りました。今の指示「${prev}」は取り消さずに続けてください。途中までの作業を活かし、この追加説明も合わせて行ってください）\n${text}`;
    }
    try {
      // 答えを送ったら、AI からの質問は済んだことにする
      if (t.question || t.state === '返事待ち') store.updateTask(p.id, t.id, { question: '', state: '実行中' });
      // AI が質問して終わったら「あなたの番」にする（左の丸が黄色になる）
      const onEnd = row => { if (row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || '選んでください' }); };
      const r = chats.send({ project: p.id, task: t.id, pdir: p.dir, dir, ai: b.ai, model, effort, text: sendText, shown: text, mode: mode || (fromQueue ? 'queued' : undefined), basePrompt, policy: modelPolicy(), perm: permCmd(b.ai), onEnd });
      if (fromQueue) chats.unqueue(p.id, t.id, fromQueue.id);
      record('chat', { project: p.id, task: t.id, ai: b.ai }, { model, effort, resume: r.resume });
      return send(res, 200, { ok: true, model, effort, note, resume: r.resume });
    } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
  }
  if (url.pathname === '/api/chat/unqueue') {
    return send(res, 200, { ok: true, queue: chats.unqueue(b.project, b.task, String(b.id || '')) });
  }
  if (url.pathname === '/api/chat/stop') {
    const ok = Boolean(chats.stop(b.project, b.task));
    if (ok) record('chatstop', b);
    return send(res, 200, { ok });
  }

  // 新しい版にする：本体を起動し直す（動いている AI があれば断る。止まってしまうため）
  // 本体を止める（アプリが、許可のある自分から起動し直すため）。AI が動いている間は断る
  if (url.pathname === '/api/quit') {
    if (aiTools.isOperating()) return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です' });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: `動いている AI が ${busy} つあります` });
    record('quit', {}, { reason: String(b.reason || '') });
    send(res, 200, { ok: true });
    if (!DRY) setTimeout(shutdown, 200);
    return undefined;
  }
  if (url.pathname === '/api/restart') {
    if (aiTools.isOperating()) return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です' });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: `動いている AI が ${busy} つあります。止めてから（または返事が終わってから）押してください` });
    record('restart', {}, { from: VERSION, to: readVersion() });
    send(res, 200, { ok: true, from: VERSION, to: readVersion() });
    if (DRY) return undefined;
    setTimeout(() => {
      server.close();
      const { spawn } = require('child_process');
      // 同じ設定で新しい本体を起動してから、この本体は終わる（新しい方は待ち受けが空くまで少し待つ）
      const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, env: { ...process.env, HUB_RESTART_WAIT: '1' }, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
      process.exit(0);
    }, 200);
    return undefined;
  }

  // CLI に渡すモデル名を保存する
  if (url.pathname === '/api/cli-models') {
    const clean = x => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length < 40 && /^[\w.:\-/\[\]]*$/.test(v.trim())).map(([k, v]) => [k, v.trim()])) : {});
    saveCliModels({ claude: clean(b.claude), codex: clean(b.codex) });
    record('climodels', {});
    return send(res, 200, { ok: true, overrides: launch.getOverrides() });
  }

  // Mac のフォルダ選択の窓を出して、選んだ場所を返す
  if (url.pathname === '/api/pick-folder') {
    if (DRY) return send(res, 200, { path: '' });
    const { execFile } = require('child_process');
    execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(b.prompt || 'フォルダを選んでください').replace(/["\\]/g, '')}")`], (err, out) => {
      if (err) return send(res, 200, { path: '' }); // 取り消した時
      return send(res, 200, { path: String(out).trim().replace(/\/$/, '') });
    });
    return undefined;
  }
  // アプリの窓に落としたファイル（場所が分かる物）を渡す：作業ファイルに記録し、AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/attach') {
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x)).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 20);
    if (!file) return send(res, 400, { error: '作業が見つかりません' });
    if (!paths.length) return send(res, 400, { error: 'ファイルが見つかりません' });
    store.updateTask(p.id, b.task, { memo: `ファイルを渡した: ${paths.join(' , ')}` });
    const ai = ['claude', 'codex'].includes(b.ai) ? b.ai : '';
    const typed = ai ? sessions.write(p.id, b.task, ai, paths.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ') + ' ') : false;
    record('upload', { project: p.id, task: b.task, ai }, { file: paths.join(' , ') });
    return send(res, 200, { ok: true, paths, typed });
  }

  // 参考フォルダ・ファイルを足す（作った後のプロジェクトにも）
  if (url.pathname === '/api/project/refs') {
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 30);
    if (!paths.length) return send(res, 400, { error: 'フォルダが見つかりません' });
    const r = store.addRefs(b.project, paths);
    if (!r) return send(res, 400, { error: 'プロジェクトが見つかりません' });
    record('refs', { project: b.project }, { paths: paths.join(' , ') });
    return send(res, 200, { ok: true, added: r.added, folders: r.project.folders });
  }

  // 新しいプロジェクトを始める
  if (url.pathname === '/api/project/new') {
    const body = expandHome(b.body || '');
    if (body && !fs.existsSync(body)) return send(res, 400, { error: `本体のフォルダが見つかりません: ${body}` });
    if (body && !fs.statSync(body).isDirectory()) return send(res, 400, { error: `フォルダではありません（ファイルです）: ${body}` });
    const refs = (Array.isArray(b.refs) ? b.refs : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x));
    const r = store.createProject({ ...b, body, refs }, path.join(__dirname, '..', 'docs', 'project-hub', 'templates', 'project'));
    if (r.error) return send(res, 400, { error: r.error });
    record('newproject', { project: r.project.id });
    return send(res, 200, r.project);
  }
  if (url.pathname === '/api/task/new') {
    const t = store.createTask(b.project, b);
    if (t) record('newtask', { project: b.project, task: t.id }, { title: t.title });
    return t ? send(res, 200, t) : send(res, 400, { error: '作業名を入れてください' });
  }

  // 選ぶ欄にモデルを出す・出さない
  if (url.pathname === '/api/models/hidden') {
    if (!['claude-code', 'codex'].includes(b.ai) || typeof b.model !== 'string' || !b.model) return send(res, 400, { error: '形式が違います' });
    const h = hiddenModels();
    h[b.ai] = b.hidden ? [...new Set([...h[b.ai], b.model])] : h[b.ai].filter(m => m !== b.model);
    fs.mkdirSync(path.dirname(MODEL_VIEW), { recursive: true });
    fs.writeFileSync(MODEL_VIEW, JSON.stringify({ hidden: h }, null, 2));
    return send(res, 200, { ok: true, hiddenModels: h });
  }
  // 最新のモデルに整理：役割の古いモデル名を、同じ系統の一番新しいモデルに。roles.yaml の一覧も今のものに
  if (url.pathname === '/api/models/tidy') {
    const r = roles.tidy(ROLES_FILE);
    if (!r.ok) return send(res, 400, { error: r.error });
    record('modeltidy', {}, { changes: r.changes.length });
    return send(res, 200, { ok: true, changes: r.changes, roles: rolesData() });
  }
  // 役割分担の保存
  if (url.pathname === '/api/roles') {
    if (!Array.isArray(b.roles)) return send(res, 400, { error: '形式が違います' });
    const r = roles.write(ROLES_FILE, b.roles);
    return r.ok ? send(res, 200, r.data) : send(res, 400, { error: r.errors.join(' / ') });
  }

  return send(res, 404, { error: 'not found' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

function shutdown() { sessions.stopAll(); chats.stopAll(); server.close(); process.exit(0); }

if (require.main === module) {
  // 新しい版に切り替える時は、前の本体が待ち受けを空けるまで少し待つ
  let tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && process.env.HUB_RESTART_WAIT && tries++ < 50) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 200);
    console.error(e.code === 'EADDRINUSE' ? `ポート ${PORT} は使われています（もう起動しているかもしれません）` : e);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Project Hub ${VERSION}`);
    console.log(`Project Hub: http://127.0.0.1:${PORT}  （台帳の場所: ${ROOT}）`);
    console.log(sessions.available() ? '作業画面: 使えます' : '作業画面: 部品（node-pty）が未設定。setup.sh を実行してください');
    console.log('止める時は、この窓で Control + C');
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, PORT, sessions };
