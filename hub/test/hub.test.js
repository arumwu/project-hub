'use strict';
// 実行: node --test hub/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseYaml, parseDoc, setScalar } = require('../lib/frontmatter');
const { buildCommand } = require('../lib/launch');
const chatLib = require('../lib/chat');

const HUB = path.join(__dirname, '..');
const TPL = path.join(HUB, '..', 'docs', 'project-hub', 'templates');
// The handoff text starts with "Claude Code". On a case-insensitive Mac this
// could run a real `claude` from a shell; keep PTY fixtures off the user's PATH.
const SHELL_ENV = { PATH: '/usr/bin:/bin', INPUTRC: '/dev/null', BASH_ENV: '/dev/null',
  ENV: '/dev/null', PS1: 'test> ', BASH_SILENCE_DEPRECATION_WARNING: '1' };

test('roles.yaml を読める', () => {
  const r = parseYaml(fs.readFileSync(path.join(TPL, '_hub', 'roles.yaml'), 'utf8'));
  assert.deepStrictEqual(r.models.codex, ['GPT-6.1-Sol']);
  assert.deepStrictEqual(r.roles['文章'].main, ['claude-code', 'Opus 5.5', '中']);
  assert.strictEqual(r.permissions['claude-code'], 'claude --dangerously-skip-permissions');
  assert.strictEqual(r.switch.auto, false);
});

test('台帳の先頭部分を読める', () => {
  const { data, body } = parseDoc(fs.readFileSync(path.join(HUB, 'seed', 'サンプルアプリ', 'PROJECT.md'), 'utf8'));
  assert.strictEqual(data.name, 'サンプルアプリ');
  assert.strictEqual(data.phases[0].role, 'コーディング');
  assert.strictEqual(data.folders['作業用コピー'], '~/Documents/AI-Workspace/Work/サンプルアプリ');
  assert.deepStrictEqual(data.related, ['サンプルサイト', 'サンプル文書']);
  assert.strictEqual(data.issues[0].level, '低');
  assert.match(body, /# メモ/);
});

test('空の値・コメント・URL を正しく扱う', () => {
  const d = parseYaml('a:\nb: []\nc: {}\nd: 値 # コメント\ne: http://x.y/#z\nf: "a # b"');
  assert.strictEqual(d.a, '');
  assert.deepStrictEqual(d.b, []);
  assert.deepStrictEqual(d.c, {});
  assert.strictEqual(d.d, '値');
  assert.strictEqual(d.e, 'http://x.y/#z');
  assert.strictEqual(d.f, 'a # b');
});

test('1行だけ書き換え、コメントを残す', () => {
  const t = '---\nstate: 実行中           # 説明\nquestion:\n---\n本文\n';
  const out = setScalar(setScalar(t, 'state', '完了'), 'question', '改行\nなし $1');
  assert.match(out, /^state: 完了\s+# 説明$/m);
  assert.match(out, /^question: 改行 なし \$1$/m);
  assert.match(out, /本文/);
});

test('起動コマンドは場所と指示を安全に囲む', () => {
  const c = buildCommand({ ai: 'claude', dir: "/a/サンプルアプリ/it's", prompt: 'x; rm -rf ~' });
  assert.strictEqual(c, "cd '/a/サンプルアプリ/it'\\''s' && claude --dangerously-skip-permissions 'x; rm -rf ~'");
  assert.throws(() => buildCommand({ ai: 'evil', dir: '/', prompt: '' }));
});

// ここから: 仮の AI-Workspace を作ってサーバーを動かす
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
const ROOT = path.join(tmp, 'AI-Workspace');
const PORT = 45000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

// seed の見本パスが利用者の環境に存在しても、テスト用台帳だけを隔離する。
// 元のseedは書き換えず、利用者のフォルダやAI設定の有無に依存させない。
function isolateSeedFolders(root) {
  for (const name of fs.readdirSync(path.join(root, 'Product'))) {
    const file = path.join(root, 'Product', name, 'PROJECT.md');
    const text = fs.readFileSync(file, 'utf8');
    let i = 0;
    fs.writeFileSync(file, text.replace(/^(  [^\n:]+:\s*)~\/[^\n]*$/gm,
      (line, label) => label + path.join(root, 'missing-source', name, String(++i))));
  }
}

test('setup.sh で台帳が作られ、2回目は触らない', () => {
  const env = { ...process.env, HUB_ROOT: ROOT, HOME: tmp, HUB_SKIP_NPM: '1' };
  execFileSync('bash', [path.join(HUB, 'setup.sh')], { env });
  for (const n of ['Project Hub', 'サンプルアプリ', 'サンプルサイト', 'サンプル文書']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'Product', n, 'PROJECT.md')), n);
    assert.ok(fs.existsSync(path.join(ROOT, 'Product', n, '.ai', 'rules.md')), n + ' rules');
    assert.ok(fs.existsSync(path.join(ROOT, 'Product', n, 'CLAUDE.md')), n + ' CLAUDE');
  }
  assert.ok(fs.existsSync(path.join(ROOT, '_hub', 'roles.yaml')));
  const f = path.join(ROOT, 'Product', 'サンプルアプリ', 'PROJECT.md');
  fs.appendFileSync(f, '\n手で足した行\n');
  const out = execFileSync('bash', [path.join(HUB, 'setup.sh')], { env }).toString();
  assert.match(out, /そのまま: サンプルアプリ/);
  assert.match(fs.readFileSync(f, 'utf8'), /手で足した行/);
  isolateSeedFolders(ROOT);
});

let server;
test('サーバーを起動', async () => {
  process.env.HUB_ROOT = ROOT;
  process.env.HUB_PORT = String(PORT);
  process.env.HUB_DRY_RUN = '1';
  process.env.HUB_AI_HOME = path.join(tmp, 'ai-home');
  ({ server } = require('../server'));
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
});

const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1', ...headers }, body: JSON.stringify(body) });

test('一覧に4つのプロジェクトと作業が出る', async () => {
  const s = await (await fetch(BASE + '/api/state')).json();
  assert.strictEqual(s.projects.length, 4);
  const h = s.projects.find(p => p.id === 'サンプルアプリ');
  assert.strictEqual(h.tasks[0].state, '返事待ち');
  assert.match(h.tasks[0].question, /プレビュー/);
  assert.strictEqual(s.roles.roles.find(r => r.name === 'コーディング').main.ai, 'codex');
});

test('続きをやる: 作業場所が無ければ台帳のフォルダで起動', async () => {
  const r = await (await post('/api/continue', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.dir, path.join(ROOT, 'Product', 'サンプルアプリ'));
  assert.match(r.command, /^cd '.*サンプルアプリ' && codex --dangerously-bypass-approvals-and-sandbox /);
  assert.match(r.command, /'【モデルの決まり.*作業ID sample-app-01/);
  assert.strictEqual(r.r.file, 'osascript');
});

test('続きをやる: 作業場所があればそこで起動', async () => {
  const wd = path.join(ROOT, 'Work', 'サンプルアプリ', 'sample-app-01');
  fs.mkdirSync(wd, { recursive: true });
  const f = path.join(ROOT, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'sample-app-01.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^workdir:.*$/m, `workdir: ${wd}`));
  const r = await (await post('/api/continue', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'claude' })).json();
  assert.strictEqual(r.dir, wd);
});

test('状態・メモ・返事済み', async () => {
  const k = { project: 'サンプルサイト', task: 'sample-site-01' };
  let t = await (await post('/api/task', { ...k, state: '返事待ち', question: '2本を確認して' })).json();
  assert.strictEqual(t.state, '返事待ち');
  t = await (await post('/api/task', { ...k, memo: 'Discord に依頼した' })).json();
  assert.match(t.memo, /Discord に依頼した/);
  t = await (await post('/api/task', { ...k, question: '', state: '実行中' })).json();
  assert.strictEqual(t.question, '');
  assert.strictEqual(t.state, '実行中');
});

test('作業を足す', async () => {
  const t = await (await post('/api/task/new', { project: 'Project Hub', title: '第2版の設計', owner: 'claude-code', next: 'Discord とつなぐ' })).json();
  assert.match(t.id, /^\d{8}-01$/);
  assert.strictEqual(t.next, 'Discord とつなぐ');
  assert.strictEqual((await post('/api/task/new', { project: 'Project Hub', title: ' ' })).status, 400);
});

test('フォルダを開く: 台帳にある場所だけ', async () => {
  const r = await post('/api/open', { project: 'サンプルアプリ', kind: 'project' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await post('/api/open', { project: 'サンプルアプリ', kind: 'folder', label: '本体' })).status, 404);
});

test('守り: 他サイトからの操作・おかしな名前・外のファイルは拒否', async () => {
  assert.strictEqual((await post('/api/task', { project: 'サンプルサイト', task: 'sample-site-01', state: '完了' }, { 'X-Hub': '' })).status, 403);
  assert.strictEqual((await post('/api/continue', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'claude' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await post('/api/continue', { project: '../..', task: 'x', ai: 'claude' })).status, 400);
  assert.strictEqual((await post('/api/task', { project: 'サンプルアプリ', task: '../../PROJECT', state: 'x' })).status, 400);
  assert.strictEqual((await post('/api/task', { project: 'サンプルアプリ', task: '_template', state: 'x' })).status, 400);
  const trav = await fetch(BASE + '/%2e%2e/server.js');
  assert.notStrictEqual(trav.status, 200);
  assert.doesNotMatch(await trav.text(), /createServer/);
  const code = await new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.strictEqual(code, 403);
});

test('画面が返る', async () => {
  const r = await fetch(BASE + '/');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Project Hub/);
});

test('後片付け', () => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 第2版: 作業画面・設定 ----
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hub2-'));
const ROOT2 = path.join(tmp2, 'AI-Workspace');
const PORT2 = 46000 + Math.floor(Math.random() * 1000);
const BASE2 = `http://127.0.0.1:${PORT2}`;
const post2 = (p, body) => fetch(BASE2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) });
let server2, sessions2;

test('第2版: 準備して起動（実際に AI は動かさず、代わりに bash を使う）', async () => {
  execFileSync('bash', [path.join(HUB, 'setup.sh')], { env: { ...process.env, HUB_ROOT: ROOT2, HOME: tmp2, HUB_SKIP_NPM: '1' } });
  isolateSeedFolders(ROOT2);
  // HUB_DRY_RUN=1 なので本物の claude / codex は起動しない（コマンドの組み立てだけ確かめる）
  delete require.cache[require.resolve('../server')];
  process.env.HUB_ROOT = ROOT2; process.env.HUB_PORT = String(PORT2); process.env.HUB_DRY_RUN = '1';
  process.env.HUB_AI_HOME = path.join(tmp2, 'ai-home');
  ({ server: server2, sessions: sessions2 } = require('../server'));
  await new Promise(r => server2.listen(PORT2, '127.0.0.1', r));
});

test('モデルと思考は役割から決まり、作業ファイルの指定が優先される', async () => {
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.ok(Array.isArray(st.roles.roles) && st.roles.roles.length === 8);
  assert.deepStrictEqual(st.efforts, ['中', '高', '極高', 'MAX', 'Ultra']);
  // サンプルアプリ の作業は role: コーディング → codex GPT-6.1-Sol・高
  let r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.model, 'GPT-6.1-Sol'); assert.strictEqual(r.effort, '高');
  assert.strictEqual(r.command, 'codex');
  assert.ok(r.args.includes('--model') && r.args.includes('gpt-6.1-sol') && r.args.includes('model_reasoning_effort=high'));
  // claude で開くと backup（claude-code Opus 5.5・高）
  r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'claude' })).json();
  assert.strictEqual(r.model, 'Opus 5.5'); assert.strictEqual(r.command, 'claude');
  assert.ok(r.args.includes('--effort') && r.args.includes('high'));
  // 作業ファイルで上書き
  await post2('/api/task', { project: 'サンプルアプリ', task: 'sample-app-01', model: '6luna', effort: 'Ultra' });
  r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.model, '6luna'); assert.strictEqual(r.effort, 'Ultra');
  // 空に戻すと役割どおり
  await post2('/api/task', { project: 'サンプルアプリ', task: 'sample-app-01', model: '', effort: '' });
  r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.model, 'GPT-6.1-Sol');
});

test('役割分担を画面から保存でき、おかしな値は拒否', async () => {
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const rs = JSON.parse(JSON.stringify(st.roles.roles));
  const bun = rs.find(x => x.name === '文章');
  bun.main.model = 'Fable 5.1'; bun.main.effort = 'MAX';
  const saved = await (await post2('/api/roles', { roles: rs })).json();
  assert.strictEqual(saved.roles.find(x => x.name === '文章').main.model, 'Fable 5.1');
  const text = fs.readFileSync(path.join(ROOT2, '_hub', 'roles.yaml'), 'utf8');
  assert.match(text, /文章: \{ main: \[claude-code, Fable 5\.1, MAX\]/);
  assert.match(text, /# 文章は Opus 5\.5/); // コメント行は残る
  assert.match(text, /permissions:/);
  bun.main.model = 'Astra';
  const bad = await post2('/api/roles', { roles: rs });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /Astra/);
});

test('作業画面: 本物の端末を開き、入力と出力が通る', async ctx => {
  if (!sessions2.available()) { console.log('node-pty なし: 省略'); return; }
  ctx.after(() => sessions2.stopAll());
  const s = sessions2.start({ project: 'サンプルアプリ', task: 'pty-test', ai: 'claude', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc', '-i'], cols: 80, rows: 24 });
  // 同じ作業にもう1つ（codex 役）を並べられる
  sessions2.start({ project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc', '-i'], cols: 80, rows: 24 });
  assert.strictEqual(sessions2.list().length, 2);
  const got = [];
  const off = sessions2.watch('サンプルアプリ', 'pty-test', 'claude', ev => got.push(ev));
  assert.ok(sessions2.write('サンプルアプリ', 'pty-test', 'claude', 'echo HELLO-$((1+2))\r'));
  await new Promise(r => setTimeout(r, 800));
  const text = got.filter(e => e.type === 'data').map(e => e.data).join('');
  assert.match(text, /HELLO-3/);
  assert.ok(sessions2.resize('サンプルアプリ', 'pty-test', 'claude', 120, 40));
  // 相手に渡す：codex 側の画面に文字が届く
  const got2 = [];
  const off2 = sessions2.watch('サンプルアプリ', 'pty-test', 'codex', ev => got2.push(ev));
  const hp = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'pty-test.md');
  fs.writeFileSync(hp, '---\nid: pty-test\ntitle: t\nstate: 実行中\n---\n');
  // 相手が作業中（画面が動いている）なら断る
  assert.strictEqual((await post2('/api/term/handoff', { project: 'サンプルアプリ', task: 'pty-test', to: 'codex' })).status, 409);
  sessions2.get('サンプルアプリ', 'pty-test', 'codex').lastOut = 0;
  const ho = await post2('/api/term/handoff', { project: 'サンプルアプリ', task: 'pty-test', to: 'codex' });
  assert.strictEqual(ho.status, 200);
  const hj = await ho.json();
  assert.strictEqual(hj.kind, 'screen'); // bash なので会話の記録は無く、画面の文字で代わりにする
  assert.match(fs.readFileSync(hj.packet, 'utf8'), /HELLO-3/);
  assert.match(fs.readFileSync(hj.packet, 'utf8'), /新しい実行の許可ではない/);
  await new Promise(r => setTimeout(r, 500));
  assert.match(got2.filter(e => e.type === 'data').map(e => e.data).join(''), /Claude Code から交代/);
  // モデル・思考を変える：作業ファイルに残り、動いている AI に /model・/effort が届く
  await post2('/api/cli-models', { claude: {}, codex: { '6terra': '6terra' } });
  const sw = await (await post2('/api/term/switch', { project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', field: 'model', value: '6terra' })).json();
  assert.deepStrictEqual([sw.sent, sw.command, sw.model], [true, '/model 6terra', '6terra']);
  const sw2 = await (await post2('/api/term/switch', { project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', field: 'effort', value: 'MAX' })).json();
  assert.strictEqual(sw2.command, '/effort max');
  await new Promise(r => setTimeout(r, 500));
  const out2 = got2.filter(e => e.type === 'data').map(e => e.data).join('');
  assert.match(out2, /\/model 6terra/);
  assert.match(out2, /\/effort max/);
  assert.match(fs.readFileSync(hp, 'utf8'), /model: 6terra/);
  assert.strictEqual((await post2('/api/term/switch', { project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', field: 'rm', value: 'x' })).status, 400);
  off2();
  off();
  // ストリームで読める
  const ac = new AbortController();
  const r = await fetch(`${BASE2}/api/term/stream?project=${encodeURIComponent('サンプルアプリ')}&task=pty-test&ai=claude`, { signal: ac.signal });
  const reader = r.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /HELLO-3/);
  ac.abort();
  assert.ok(sessions2.stop('サンプルアプリ', 'pty-test', 'claude'));
  assert.ok(sessions2.stop('サンプルアプリ', 'pty-test', 'codex'));
  assert.strictEqual(sessions2.list().length, 0);
  assert.strictEqual((await post2('/api/term/input', { project: 'サンプルアプリ', task: 'pty-test', ai: 'claude', data: 'x' })).status, 404);
  // 相手が動いていなければ、役割どおりに始める（テストでは組み立てだけ）
  const dj = await (await post2('/api/term/handoff', { project: 'サンプルアプリ', task: 'pty-test', to: 'codex' })).json();
  assert.strictEqual(dj.dry, true);
  assert.match(dj.args.join(' '), /から交代です/);
});

test('担当と進み具合：手順・フェーズ・エージェント', async () => {
  const t = await (await post2('/api/task/new', { project: 'サンプルサイト', title: '紹介文の下書き', owner: 'discord:サンプル担当', via: '#サンプル作業', phase: '紹介文', steps: '題材\n下書き\n\n投稿' })).json();
  assert.deepStrictEqual(t.steps.map(x => x.text), ['題材', '下書き', '投稿']);
  assert.deepStrictEqual([t.owner, t.via, t.phase], ['discord:サンプル担当', '#サンプル作業', '紹介文']);
  let r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: 0, done: true })).json();
  assert.strictEqual(r.steps[0].done, true);
  r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, add: 'チェック' })).json();
  assert.strictEqual(r.steps.length, 4);
  for (const i of [1, 2, 3]) r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: i, done: true })).json();
  assert.strictEqual(r.state, '完了'); // 全部付いたら完了
  r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: 3, done: false })).json();
  assert.strictEqual(r.state, '実行中'); // 外したら戻る
  assert.strictEqual((await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: 9, done: true })).status, 400);
  // 次のフェーズへ：今のフェーズを完了に、次を進行中に（コメントは残る）
  const before = (await (await fetch(BASE2 + '/api/state')).json()).projects.find(p => p.id === 'サンプルサイト').phases;
  const cur = before.findIndex(ph => ph.state !== '完了');
  const n = await (await post2('/api/phase/next', { project: 'サンプルサイト' })).json();
  assert.strictEqual(n.phases[cur].state, '完了');
  if (n.phases[cur + 1]) assert.strictEqual(n.phases[cur + 1].state, '進行中');
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.deepStrictEqual(st.roles.agents, ['サンプル担当']);
  // 操作の記録
  const log = await (await fetch(BASE2 + '/api/log?n=5')).json();
  assert.ok(log.some(r => r.action === 'nextphase' && r.project === 'サンプルサイト'));
  assert.ok(log.some(r => r.action === 'newtask'));
  assert.ok(Array.isArray(await (await fetch(BASE2 + '/api/sessions')).json()));
});

test('分岐：作業に分岐元を持たせられ、台帳の説明も読める', async () => {
  const t = await (await post2('/api/task/new', { project: 'サンプルアプリ', title: '文言だけ直す', owner: 'codex', parent: 'sample-app-01' })).json();
  assert.strictEqual(t.parent, 'sample-app-01');
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const h = st.projects.find(p => p.id === 'サンプルアプリ');
  assert.ok(h.tasks.some(x => x.parent === 'sample-app-01'));
  assert.strictEqual(typeof h.notes, 'string');
});

test('本体に取り込む：作業用コピーを取り込み、作業を完了にする。AI が動いている間は断る', async () => {
  const gitw = require('../lib/git');
  process.env.HUB_TRASH = path.join(tmp2, 'Trash');
  const main = path.join(tmp2, 'code');
  fs.mkdirSync(main);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', main, 'init', '-q'], { env });
  fs.writeFileSync(path.join(main, 'a.txt'), '1\n');
  execFileSync('git', ['-C', main, 'add', '-A'], { env }); execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'i'], { env });
  const wr = path.join(ROOT2, 'Work', 'サンプルアプリ');
  const r = gitw.prepare({ base: main, workRoot: wr, taskId: 'merge-test' });
  fs.writeFileSync(path.join(r.dir, 'c.txt'), 'done\n');
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'merge-test.md');
  fs.writeFileSync(tf, `---\nid: merge-test\ntitle: 取り込みの確認\nstate: 実行中\nworkdir: ${r.dir}\n---\n`);
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const h = st.projects.find(p => p.id === 'サンプルアプリ');
  assert.ok(h.copies >= 1);
  assert.strictEqual(h.tasks.find(t => t.id === 'merge-test').copy, true);
  // AI が動いている間は取り込まない
  if (sessions2.available()) {
    sessions2.start({ project: 'サンプルアプリ', task: 'merge-test', ai: 'codex', dir: r.dir, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc'], cols: 80, rows: 24 });
    assert.strictEqual((await post2('/api/task/merge', { project: 'サンプルアプリ', task: 'merge-test' })).status, 409);
    sessions2.stop('サンプルアプリ', 'merge-test', 'codex');
  }
  const res = await post2('/api/task/merge', { project: 'サンプルアプリ', task: 'merge-test' });
  const j = await res.json();
  assert.strictEqual(res.status, 200, j.error);
  assert.strictEqual(fs.readFileSync(path.join(main, 'c.txt'), 'utf8'), 'done\n');
  assert.strictEqual(j.task.state, '完了');
  assert.strictEqual(j.task.workdir, '');
  assert.ok(!fs.existsSync(r.dir));
  // 作業用コピーの無い作業は断る
  assert.strictEqual((await post2('/api/task/merge', { project: 'サンプルアプリ', task: 'merge-test' })).status, 400);
});


test('ファイルを渡す：Inbox に保存し、作業ファイルに記録し、動いている AI の入力欄に場所を入れる', async () => {
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'up-test.md');
  fs.writeFileSync(tf, '---\nid: up-test\ntitle: 渡す\nstate: 実行中\n---\n');
  const up = (q, body) => fetch(`${BASE2}/api/task/upload?${new URLSearchParams(q)}`, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/octet-stream' }, body });
  // AI が動いていない時は保存と記録だけ。名前の「../」などは消す
  let j = await (await up({ project: 'サンプルアプリ', task: 'up-test', ai: 'codex', name: '../../evil name.png' }, Buffer.from('PNG'))).json();
  assert.strictEqual(j.typed, false);
  assert.ok(j.path.startsWith(path.join(ROOT2, 'Inbox', 'hub')));
  assert.match(path.basename(j.path), /^\d{6}-evil_name\.png$/);
  assert.strictEqual(fs.readFileSync(j.path, 'utf8'), 'PNG');
  assert.ok(fs.readFileSync(tf, 'utf8').includes(`ファイルを渡した: ${j.path}`));
  if (sessions2.available()) {
    sessions2.start({ project: 'サンプルアプリ', task: 'up-test', ai: 'codex', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc', '-i'], cols: 80, rows: 24 });
    const got = [];
    const off = sessions2.watch('サンプルアプリ', 'up-test', 'codex', ev => got.push(ev));
    j = await (await up({ project: 'サンプルアプリ', task: 'up-test', ai: 'codex', name: 'shot.png' }, Buffer.from('x'))).json();
    assert.strictEqual(j.typed, true);
    await new Promise(r => setTimeout(r, 400));
    assert.ok(got.map(e => e.data || '').join('').includes(path.basename(j.path)));
    off(); sessions2.stop('サンプルアプリ', 'up-test', 'codex');
  }
  // 無い作業・CSRF の印なしは断る
  assert.strictEqual((await up({ project: 'サンプルアプリ', task: 'nai', name: 'a' }, Buffer.from('x'))).status, 400);
  const noHeader = await fetch(`${BASE2}/api/task/upload?project=%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB%E3%82%A2%E3%83%97%E3%83%AA&task=up-test&name=a`, { method: 'POST', body: Buffer.from('x') });
  assert.strictEqual(noHeader.status, 403);
});

test('会話画面：送るたびに AI を選べ、変えた時は見ていない会話を引き継ぐ。同じ AI は続きから', async () => {
  // 本物の代わりの claude / codex（受け取った依頼と引数を、そのまま返事にする）
  const bin = path.join(tmp2, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const js = (code) => `#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const a=process.argv.slice(2).join(' ');${code}});\n`;
  fs.writeFileSync(path.join(bin, 'claude'), js(`const o=x=>console.log(JSON.stringify(x));o({type:'system',subtype:'init',session_id:'S-claude'});o({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'npm test'}},{type:'text',text:'GOT['+i+'] ARGS['+a+']'}]}});o({type:'result',is_error:false,result:'x',session_id:'S-claude'});`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), js(`const o=x=>console.log(JSON.stringify(x));o({type:'thread.started',thread_id:'T-codex'});o({type:'item.completed',item:{type:'command_execution',command:'ls'}});o({type:'item.completed',item:{type:'agent_message',text:'CODEX['+i+'] ARGS['+a+']'}});o({type:'turn.completed'});`), { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'chat-test.md');
  fs.writeFileSync(tf, '---\nid: chat-test\ntitle: 会話\nstate: 実行中\n---\n');
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'chat-test');
  const waitReply = async n => { for (let i = 0; i < 100 && rows().filter(r => r.role === 'assistant').length < n; i++) await new Promise(r => setTimeout(r, 50)); };
  const say = (ai, model, text) => post2('/api/chat/send', { project: 'サンプルアプリ', task: 'chat-test', ai, model, effort: '高', text });
  try {
    assert.strictEqual((await say('claude', 'Opus 5.5', 'はじめまして')).status, 200);
    assert.strictEqual((await say('claude', 'Opus 5.5', '二重')).status, 409); // 返事の途中は送れない
    await waitReply(1);
    let a = rows().filter(r => r.role === 'assistant');
    assert.match(a[0].text, /GOT\[.*はじめまして/s);
    assert.match(a[0].text, /-p --output-format stream-json --verbose --model claude-opus-5-5 --effort high/);
    assert.doesNotMatch(a[0].text, /--resume/);
    assert.ok(rows().some(r => r.role === 'event' && r.text === 'Bash：npm test'));
    // Codex に変える → 前の会話（人の依頼と Claude の返事）を引き継ぐ
    await say('codex', '6sol', 'つづきをお願い');
    await waitReply(2);
    a = rows().filter(r => r.role === 'assistant');
    assert.strictEqual(a[1].ai, 'codex');
    assert.match(a[1].text, /<previous_conversation>[\s\S]*はじめまして[\s\S]*<\/previous_conversation>[\s\S]*つづきをお願い/);
    assert.match(a[1].text, /ARGS\[exec --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check --model gpt-6-sol -c model_reasoning_effort=high -\]/);
    // Claude に戻す → 自分の会話の続き（--resume）。見ていないのは Codex とのやり取りだけ
    await say('claude', 'Opus 5.5', 'まとめて');
    await waitReply(3);
    a = rows().filter(r => r.role === 'assistant');
    assert.match(a[2].text, /--resume S-claude/);
    // モデルの決まりは、最初も続きの時も毎回つく
    for (const x of [a[0], a[1], a[2]]) assert.match(x.text, /【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】.*コーディング＝Codex・GPT-6.1-Sol（gpt-6.1-sol）.*claude-opus-4-6 などの古いモデルは使わない/s);
    assert.match(a[2].text, /つづきをお願い/);
    assert.doesNotMatch(a[2].text.split('<previous_conversation>')[1] || '', /はじめまして/);
    // 見つからないコマンドは日本語で知らせる
    process.env.PATH = '/nonexistent';
    await say('codex', '6sol', 'x');
    await waitReply(4);
    assert.match(rows().filter(r => r.role === 'assistant')[3].error, /見つかりません/);
  } finally { process.env.PATH = oldPath; }
});

test('新しいプロジェクトを始められる（ひな形・フェーズ・本体）', async () => {
  const r = await post2('/api/project/new', { name: '新しいサンプルアプリ', description: 'メモの一覧を見せる: 試作', phases: '計画\n作る\n公開', related: 'サンプルアプリ、Database' });
  const p = await r.json();
  assert.strictEqual(r.status, 200, p.error);
  assert.strictEqual(p.name, '新しいサンプルアプリ');
  assert.strictEqual(p.description, 'メモの一覧を見せる: 試作');
  assert.deepStrictEqual(p.phases.map(x => [x.name, x.state]), [['計画', '進行中'], ['作る', '未着手'], ['公開', '未着手']]);
  assert.deepStrictEqual(p.related, ['サンプルアプリ', 'Database']);
  const dir = path.join(ROOT2, 'Product', '新しいサンプルアプリ');
  for (const f of ['CLAUDE.md', 'AGENTS.md', '.ai/rules.md', '.ai/tasks', '資料', '成果物']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.strictEqual((await post2('/api/project/new', { name: '新しいサンプルアプリ' })).status, 400); // 同じ名前は作らない
  assert.strictEqual((await post2('/api/project/new', { name: '../x' })).status, 400); // 外に作る名前は断る
  assert.ok(!fs.existsSync(path.join(ROOT2, 'x')));
  assert.strictEqual((await post2('/api/project/new', { name: 'a/b' })).status, 200); // 「/」は置き換える
  assert.ok(fs.existsSync(path.join(ROOT2, 'Product', 'a・b', 'PROJECT.md')));
  assert.strictEqual((await post2('/api/project/new', { name: 'y', body: '/nai/folder' })).status, 400);
  // 作ったプロジェクトに作業を足せる
  const t = await (await post2('/api/task/new', { project: '新しいサンプルアプリ', title: '画面を作る', phase: '計画' })).json();
  assert.strictEqual(t.phase, '計画');
});

test('バージョン：package.json と変更の記録の一番上が同じ番号。画面にも出る', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HUB, 'package.json'), 'utf8'));
  const top = fs.readFileSync(path.join(HUB, 'CHANGELOG.md'), 'utf8').match(/^## ([\d.]+)/m)[1];
  assert.strictEqual(top, pkg.version, '更新したら package.json と CHANGELOG.md の両方の番号を上げる');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.deepStrictEqual([st.version, st.latest], [pkg.version, pkg.version]);
  assert.deepStrictEqual(await (await fetch(BASE2 + '/api/version')).json(), { version: pkg.version, latest: pkg.version });
  const log = await (await fetch(BASE2 + '/api/changelog')).json();
  assert.strictEqual(log[0].version, pkg.version);
  assert.ok(log[0].items.length > 0);
  // AI が動いている間は切り替えない
  if (sessions2.available()) {
    sessions2.start({ project: 'サンプルアプリ', task: 'ver-test', ai: 'codex', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc'], cols: 80, rows: 24 });
    assert.strictEqual((await post2('/api/restart', {})).status, 409);
    sessions2.stop('サンプルアプリ', 'ver-test', 'codex');
  }
  assert.strictEqual((await post2('/api/restart', {})).status, 200); // テストでは実際には起動し直さない
});

test('アプリの窓に落とした物：本当の場所で渡す。フォルダ選択。本体はフォルダだけ', async () => {
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'att-test.md');
  fs.writeFileSync(tf, '---\nid: att-test\ntitle: 渡す\nstate: 実行中\n---\n');
  const f = path.join(tmp2, 'メモ 1.txt');
  fs.writeFileSync(f, 'x');
  const j = await (await post2('/api/task/attach', { project: 'サンプルアプリ', task: 'att-test', paths: [f, '/nai/file', 'relative.txt'] })).json();
  assert.deepStrictEqual(j.paths, [f]); // 無い物・相対の場所は渡さない
  assert.ok(fs.readFileSync(tf, 'utf8').includes(`ファイルを渡した: ${f}`));
  assert.strictEqual((await post2('/api/task/attach', { project: 'サンプルアプリ', task: 'att-test', paths: ['/nai'] })).status, 400);
  assert.deepStrictEqual(await (await post2('/api/pick-folder', {})).json(), { path: '' }); // テストでは窓を出さない
  const bad = await post2('/api/project/new', { name: 'ファイルを本体に', body: f });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /フォルダではありません/);
  const ok = await post2('/api/project/new', { name: 'フォルダを本体に', body: tmp2 });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual((await ok.json()).folders, [{ label: '本体', path: tmp2 }]);
});

test('参考フォルダ：作る時に何個でも、作った後にも足せる。関連は一覧から選ぶ。AI への指示に入る', async () => {
  const r1 = path.join(tmp2, 'ref-a'), r2 = path.join(tmp2, 'ref b');
  fs.mkdirSync(r1, { recursive: true }); fs.mkdirSync(r2, { recursive: true });
  const p = await (await post2('/api/project/new', { name: '参考つき', related: ['サンプルアプリ', 'サンプルサイト'], refs: [r1, '/nai/folder'] })).json();
  assert.deepStrictEqual(p.related, ['サンプルアプリ', 'サンプルサイト']);
  assert.deepStrictEqual(p.folders, [{ label: '参考1', path: r1 }]); // 無い場所は入れない
  let j = await (await post2('/api/project/refs', { project: '参考つき', paths: [r1, r2] })).json();
  assert.strictEqual(j.added, 1); // 同じ場所は足さない
  assert.deepStrictEqual(j.folders.map(f => [f.label, f.path]), [['参考1', r1], ['参考2', r2]]);
  assert.strictEqual((await post2('/api/project/refs', { project: '参考つき', paths: ['/nai'] })).status, 400);
  // 空の folders: {} のプロジェクトにも足せる
  j = await (await post2('/api/project/refs', { project: 'サンプルサイト', paths: [r2] })).json();
  assert.deepStrictEqual(j.folders.map(f => f.label), ['参考1']);
  // AI への最初の指示に、参考にしてよい場所が入る
  await post2('/api/task/new', { project: '参考つき', title: 't' });
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const t = st.projects.find(x => x.id === '参考つき').tasks[0];
  const d = await (await post2('/api/term/start', { project: '参考つき', task: t.id, ai: 'claude' })).json();
  const prompt = d.args[d.args.length - 1];
  assert.match(prompt, /参考にしてよい場所（読むだけ。書き換えない）/);
  assert.ok(prompt.includes(r1) && prompt.includes(r2) && prompt.includes(path.join(ROOT2, 'Product', 'サンプルアプリ')));
});

test('モデル名を断られたら1回で止まり、理由と設定を残す', async () => {
  const bin = path.join(tmp2, 'fakebin2');
  fs.mkdirSync(bin, { recursive: true });
  const countFile = path.join(tmp2, 'model-invocations.txt');
  // 本物と同じように、--model があれば断る Codex
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(countFile)},'1\\n');
let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const a=process.argv.slice(2);const o=x=>console.log(JSON.stringify(x));
o({type:'thread.started',thread_id:'T'});
o({type:'item.completed',item:{type:'error',message:'Ignoring malformed agent role definition: failed to deserialize'}});
const m=a.indexOf('--model');
if(m>=0){o({type:'turn.failed',error:{message:'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \\''+a[m+1]+'\\' model is not supported when using Codex with a ChatGPT account."}}'}});process.exit(1);}
o({type:'item.completed',item:{type:'agent_message',text:'OK ARGS['+a.join(' ')+']'}});o({type:'turn.completed'});});
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'model-test.md');
  fs.writeFileSync(tf, '---\nid: model-test\ntitle: m\nstate: 実行中\n---\n');
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'model-test');
  const waitReply = async n => { for (let i = 0; i < 100 && rows().filter(r => r.role === 'assistant').length < n; i++) await new Promise(r => setTimeout(r, 50)); };
  await post2('/api/cli-models', { claude: {}, codex: { 'GPT-6.1-Sol': 'wrong-model-id' } }); // 名前を入れた時だけ渡す
  try {
    await post2('/api/chat/send', { project: 'サンプルアプリ', task: 'model-test', ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'こんにちは' });
    await waitReply(1);
    const a = rows().filter(r => r.role === 'assistant');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].text, '');
    assert.match(a[0].error, /指定したモデル「wrong-model-id」を Codex が受け付けませんでした/);
    assert.match(a[0].error, /AI の更新.*CLI に渡すモデル名/);
    assert.strictEqual(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 1);
    assert.ok(!rows().some(r => /既定のモデルでやり直/.test(r.text || '')));
    assert.ok(!rows().some(r => /Ignoring malformed/.test(r.text || ''))); // 関係ない警告は出さない
    // 拒否された設定を勝手に空へ変えない
    const cm = await (await fetch(BASE2 + '/api/cli-models')).json();
    assert.deepStrictEqual(cm.codex.find(x => x.name === 'GPT-6.1-Sol'), { name: 'GPT-6.1-Sol', flag: 'wrong-model-id', set: true });
    // 設定で直せる（おかしな文字は入れない）
    await post2('/api/cli-models', { claude: {}, codex: { 'GPT-6.1-Sol': 'gpt-6.1-sol' } });
    const cm2 = await (await fetch(BASE2 + '/api/cli-models')).json();
    assert.strictEqual(cm2.codex.find(x => x.name === 'GPT-6.1-Sol').flag, 'gpt-6.1-sol');
    await post2('/api/cli-models', { claude: {}, codex: { 'GPT-6.1-Sol': 'bad name;rm' } });
    const cm3 = await (await fetch(BASE2 + '/api/cli-models')).json();
    assert.strictEqual(cm3.codex.find(x => x.name === 'GPT-6.1-Sol').set, false);
    await post2('/api/cli-models', { claude: {}, codex: {} });
  } finally { process.env.PATH = oldPath; }
});

test('作業中の指示：① 取り消してやり直す／② 追加説明（一緒にやる）／③ 終わったら次に。［止める］は待っている指示も取り消す', async () => {
  const bin = path.join(tmp2, 'fakebin3');
  fs.mkdirSync(bin, { recursive: true });
  // 0.6秒かかる Claude（受け取った依頼をそのまま返す）
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const o=x=>console.log(JSON.stringify(x));
o({type:'system',subtype:'init',session_id:'S-q'});
setTimeout(()=>{o({type:'assistant',message:{content:[{type:'text',text:'DONE['+(i.split('# 今回の依頼\\n')[1]||i)+']'}]}});o({type:'result',is_error:false,result:'',session_id:'S-q'});},600);});
process.on('SIGTERM',()=>process.exit(143));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'q-test.md');
  fs.writeFileSync(tf, '---\nid: q-test\ntitle: q\nstate: 実行中\n---\n');
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'q-test');
  const done = () => rows().filter(r => r.role === 'assistant');
  const waitN = async n => { for (let i = 0; i < 200 && done().length < n; i++) await new Promise(r => setTimeout(r, 30)); };
  const say = (text, mode) => post2('/api/chat/send', { project: 'サンプルアプリ', task: 'q-test', ai: 'claude', model: 'Opus 5.5', effort: '高', text, mode });
  try {
    await say('一つ目');
    assert.strictEqual((await say('選ばずに送る')).status, 409); // 作業中は選ぶ
    const q = await (await say('二つ目', 'queue')).json();
    assert.deepStrictEqual([q.queued, q.queue], [true, 1]);
    await waitN(2); // 一つ目が終わると、二つ目が自動で始まる
    assert.match(done()[0].text, /DONE\[一つ目/);
    assert.match(done()[1].text, /DONE\[二つ目/);
    assert.strictEqual(rows().find(r => r.role === 'user' && r.text === '二つ目').mode, 'queued');
    // ① 中断して送る
    await say('三つ目');
    await new Promise(r => setTimeout(r, 150));
    const it = await say('四つ目', 'redo');
    assert.strictEqual(it.status, 200);
    await waitN(4);
    assert.strictEqual(done()[2].error, '止めました');
    assert.match(done()[3].text, /前の指示「三つ目」を取り消しました[\s\S]*四つ目/);
    assert.strictEqual(rows().find(r => r.role === 'user' && r.text === '四つ目').mode, 'redo');
    // ② 追加説明（一緒にやる）：元の指示は続け、説明を合わせる
    await say('七つ目');
    await new Promise(r => setTimeout(r, 150));
    await say('色は青で', 'amend');
    await waitN(6);
    assert.match(done()[5].text, /今の指示「七つ目」は取り消さずに続けて[\s\S]*色は青で/);
    assert.strictEqual(rows().find(r => r.role === 'user' && r.text === '色は青で').mode, 'amend');
    // ［止める］は、待っている指示も取り消す
    await say('五つ目');
    await say('六つ目', 'queue');
    await post2('/api/chat/stop', { project: 'サンプルアプリ', task: 'q-test' });
    await waitN(7);
    await new Promise(r => setTimeout(r, 800));
    assert.strictEqual(done().length, 7);
    assert.ok(!rows().some(r => r.text === '六つ目'));
  } finally { process.env.PATH = oldPath; }
});

test('プロジェクトを完了にする・戻す（おかしな状態は拒否）', async () => {
  const f = path.join(ROOT2, 'Product', 'サンプルアプリ', 'PROJECT.md');
  const status = () => parseDoc(fs.readFileSync(f, 'utf8')).data.status;
  assert.strictEqual((await post2('/api/project/status', { project: 'サンプルアプリ', status: '完了' })).status, 200);
  assert.strictEqual(status(), '完了');
  assert.strictEqual((await post2('/api/project/status', { project: 'サンプルアプリ', status: '進行中' })).status, 200);
  assert.strictEqual(status(), '進行中');
  assert.strictEqual((await post2('/api/project/status', { project: 'サンプルアプリ', status: 'x' })).status, 400);
});

test('文の中の場所は Finder で、URL はブラウザで開く（ホームの外・おかしな URL は断る）', async () => {
  const j = async (p, b) => { const r = await post2(p, b); return { status: r.status, body: await r.json() }; };
  const a = await j('/api/reveal', { project: 'サンプルアプリ', path: 'PROJECT.md' });
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(a.body.r.args, ['-R', path.join(ROOT2, 'Product', 'サンプルアプリ', 'PROJECT.md')]);
  assert.strictEqual((await j('/api/reveal', { project: 'サンプルアプリ', path: '/etc/hosts' })).status, 404);
  assert.strictEqual((await j('/api/reveal', { project: 'サンプルアプリ', path: 'nothing/here.txt' })).status, 404);
  // フォルダは中身を返す（Finder を使わない）。ファイルはそのアプリで開く
  const l = await j('/api/reveal', { project: 'サンプルアプリ', path: '.ai', how: 'list' });
  assert.strictEqual(l.status, 200);
  assert.ok(l.body.entries.some(x => x.name === 'tasks' && x.dir));
  assert.strictEqual(l.body.parent, path.join(ROOT2, 'Product', 'サンプルアプリ'));
  const o = await j('/api/reveal', { project: 'サンプルアプリ', path: 'PROJECT.md', how: 'open' });
  assert.deepStrictEqual(o.body.r.args, [path.join(ROOT2, 'Product', 'サンプルアプリ', 'PROJECT.md')]);
  const inApp = await j('/api/reveal', { project: 'サンプルアプリ', path: 'PROJECT.md', how: 'open', app: true });
  assert.strictEqual(inApp.body.byApp, true); assert.strictEqual(inApp.body.how, 'open');
  const u = await j('/api/open-url', { url: 'http://127.0.0.1:8796/a?b=1' });
  assert.deepStrictEqual(u.body.r.args, ['http://127.0.0.1:8796/a?b=1']);
  assert.strictEqual((await j('/api/open-url', { url: 'javascript:alert(1)' })).status, 400);
});

test('生きているかは、ファイルを読まずにすぐ答える', async () => {
  const r = await (await fetch(BASE2 + '/api/ping')).json();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.pid, process.pid);
});

test('本体が台帳を読めるか答える。止める時は、外からの操作を断る', async () => {
  const a = await (await fetch(BASE2 + '/api/access')).json();
  assert.strictEqual(a.ok, true);
  const r = await fetch(BASE2 + '/api/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403); // X-Hub が無い
  assert.strictEqual((await post2('/api/quit', { reason: 'test' })).status, 200); // 試しの時は止まらない
});

test('AI の質問を選択肢にする（決まった形・質問の道具のどちらでも）', () => {
  const r = chatLib.parseAsk('料金案を2つ作りました。\n\n[[質問]]\nどちらで進めますか？\n1. 月額を下げる（おすすめ）\n2. 初期費用を下げる\n[[/質問]]\n[[質問]]\n入れる機能は？（複数可）\n- 予約\n- 来所受付\n[[/質問]]');
  assert.strictEqual(r.text, '料金案を2つ作りました。');
  assert.deepStrictEqual(r.asks, [
    { question: 'どちらで進めますか？', options: ['月額を下げる（おすすめ）', '初期費用を下げる'], multi: false },
    { question: '入れる機能は？（複数可）', options: ['予約', '来所受付'], multi: true },
  ]);
  assert.deepStrictEqual(chatLib.parseAsk('質問なしの返事').asks, []);
  assert.strictEqual(chatLib.parseAsk('[[質問]]\nA と B どちら？\n1. A\n2. B').asks[0].options.length, 2); // 閉じ忘れ
  const ev = chatLib.parse('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: '色は？', multiSelect: false, options: [{ label: '赤' }, { label: '青' }] }] } }] } });
  assert.deepStrictEqual(ev, [{ kind: 'ask', asks: [{ question: '色は？', options: ['赤', '青'], multi: false }] }]);
  const turn = chatLib.buildTurn({ ai: 'claude', model: '', meta: {}, rows: [], text: 'やって', basePrompt: 'B' });
  assert.match(turn.stdin, /\[\[質問\]\]/);
});

test('モデルを最新に整理：今の一覧だけ出し、役割の古い名前を同じ系統の一番新しいモデルにする', () => {
  const rolesLib = require('../lib/roles');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tidy-'));
  const f = path.join(d, 'roles.yaml');
  fs.copyFileSync(path.join(TPL, '_hub', 'roles.yaml'), f);
  // 古い設定を持つ利用者の移行を確かめる。配布ひな形の既定値に依存しない。
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8')
    .replace('main: [codex, GPT-6.1-Sol, 高]', 'main: [codex, 6sol, 高]')
    .replace('main: [codex, GPT-6.1-Sol, 中]', 'main: [codex, Astra, 中]')
    .replaceAll('backup: [codex, GPT-6.1-Sol, 高]', 'backup: [codex, 6terra, 高]'));
  try {
    assert.strictEqual(rolesLib.tidy(f).ok, false); // 一覧を取り直す前は断る
    rolesLib.setModelCatalog({
      claude: { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-fable-5-1', label: 'Fable 5.1' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
      codex: { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' }, { id: 'gpt-6.1-astra', label: 'GPT-6.1-Astra' }] },
    });
    const before = rolesLib.read(f).data;
    assert.deepStrictEqual(before.models.codex.slice(0, 4), ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-6.1-Astra']);
    assert.strictEqual(before.roles.find(r => r.name === '調査').backup.model, 'GPT-5.6-Terra'); // 6terra は同じモデルなので今の名前で見せる
    const r = rolesLib.tidy(f);
    assert.ok(r.changes.some(c => c.role === 'コーディング' && c.from === '6sol' && c.to === 'GPT-6.1-Sol'));
    assert.ok(r.changes.some(c => c.from === 'Astra' && c.to === 'GPT-6.1-Astra'));
    const after = rolesLib.read(f).data;
    assert.deepStrictEqual(after.models.codex, ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-6.1-Astra']);
    assert.match(fs.readFileSync(f, 'utf8'), /codex:\s+\[GPT-6\.1-Sol, GPT-5\.6-Sol, GPT-5\.6-Terra, GPT-6\.1-Astra\]/);
    assert.deepStrictEqual(rolesLib.tidy(f).changes, []); // 2回目は何も変えない
  } finally { rolesLib.setModelCatalog({}); fs.rmSync(d, { recursive: true, force: true }); }
});

test('選ぶ欄に出すモデルを、設定で隠せる・戻せる', async () => {
  const j = async b => (await post2('/api/models/hidden', b)).json();
  assert.deepStrictEqual((await j({ ai: 'codex', model: '6luna', hidden: true })).hiddenModels.codex, ['6luna']);
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.deepStrictEqual(st.hiddenModels.codex, ['6luna']);
  assert.deepStrictEqual((await j({ ai: 'codex', model: '6luna', hidden: false })).hiddenModels.codex, []);
  assert.strictEqual((await post2('/api/models/hidden', { ai: 'x', model: 'a' })).status, 400);
});

test('待っている指示はファイルに残り、再起動しても消えない', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-q-'));
  try {
    const a = new chatLib.ChatRunner({ dirOf: id => (id === 'P' ? d : '') });
    const it = a.enqueue('P', 'T', { ai: 'claude', model: 'Opus 5.5', effort: '高', text: 'あとで' });
    a.enqueue('P', 'T', { ai: 'codex', model: '6sol', effort: '中', text: 'その次' });
    const b = new chatLib.ChatRunner({ dirOf: id => (id === 'P' ? d : '') }); // 起動し直した
    assert.deepStrictEqual(b.queue('P', 'T').map(x => x.text), ['あとで', 'その次']);
    b.unqueue('P', 'T', it.id);
    const c = new chatLib.ChatRunner({ dirOf: id => (id === 'P' ? d : '') });
    assert.deepStrictEqual(c.queue('P', 'T').map(x => x.text), ['その次']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('第2版: 後片付け', () => {
  sessions2.stopAll();
  server2.close();
  fs.rmSync(tmp2, { recursive: true, force: true });
});
