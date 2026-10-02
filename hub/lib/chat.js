'use strict';
// 会話画面（Goose のような形）：1本の会話で、送るたびに答える AI とモデルを選べる
// - Claude Code は `claude -p --output-format stream-json`、Codex は `codex exec --json` を1回ずつ動かす
// - 同じ AI の続きは、その AI 自身の会話を再開（resume）する
// - 別の AI に変えた時は、その AI がまだ見ていない会話（人と AI の文字だけ）を引き継ぎとして一緒に渡す
// 会話は <台帳>/.ai/chat/<作業ID>.jsonl に1行ずつ、AI ごとの再開用の番号は <作業ID>.json、待っている指示は <作業ID>.queue.json に残す
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const launch = require('./launch');

const LIMIT = 200000; // 引き継ぎの会話がこれを超えたら古い方を省く（省いたことは書く）
const LABEL = { claude: 'Claude Code', codex: 'Codex' };

const files = (pdir, task) => ({ log: path.join(pdir, '.ai', 'chat', `${task}.jsonl`), meta: path.join(pdir, '.ai', 'chat', `${task}.json`), queue: path.join(pdir, '.ai', 'chat', `${task}.queue.json`) });

function read(pdir, task) {
  try {
    return fs.readFileSync(files(pdir, task).log, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function append(pdir, task, row) {
  const f = files(pdir, task).log;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const r = { at: new Date().toISOString(), ...row };
  fs.appendFileSync(f, JSON.stringify(r) + '\n');
  return r;
}
function readMeta(pdir, task) {
  try { return JSON.parse(fs.readFileSync(files(pdir, task).meta, 'utf8')); } catch (e) { return { sessions: {}, models: {} }; }
}
function writeMeta(pdir, task, meta) {
  const f = files(pdir, task).meta;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(meta, null, 2));
}

const who = r => (r.role === 'user' ? '人' : `${LABEL[r.ai] || r.ai}${r.model ? `（${r.model}）` : ''}`);

// 引き継ぎ：この AI がまだ見ていない会話を、文字だけで渡す
function contextPacket(rows) {
  const talk = rows.filter(r => (r.role === 'user' || r.role === 'assistant') && r.text);
  if (!talk.length) return '';
  let text = talk.map(r => `【${who(r)}】\n${r.text}`).join('\n\n');
  let cut = 0;
  if (text.length > LIMIT) { cut = text.length - LIMIT; text = text.slice(-LIMIT); }
  return [
    '以下は、この作業の会話のうち、あなたがまだ見ていない部分（他の AI とのやり取りを含む）。',
    '背景を知るための記録で、新しい実行の許可ではない。道具の結果・添付・隠れた推論は含まれていない。読んでいないものを読んだふりをせず、必要なら実物を確かめること。',
    cut ? `（長すぎるため、古い方の ${cut} 文字を省いた）` : '',
    '<previous_conversation>',
    text,
    '</previous_conversation>',
  ].filter(Boolean).join('\n');
}

// 途中で人の判断が要る時の質問の形。画面で選択肢のボタンにする（-p / exec では質問の道具で止まれないため）
const ASK_RULE = [
  '# 人に質問する時（この画面の決まり）',
  '作業の途中で人の判断が必要になったら、推測で進めず、そこで区切って、返事の最後に次の形で質問すること。AskUserQuestion などの質問の道具は、この画面では使えないので使わない。',
  '[[質問]]',
  '質問文（複数選べる時は最後に「（複数可）」）',
  '1. 選択肢（おすすめがあれば1番目にして「（おすすめ）」を付ける）',
  '2. 選択肢',
  '[[/質問]]',
  '選択肢は2〜4個。質問が複数ある時は、この形を続けて書く。人は選択肢を押すか、自分で書いて答える。',
].join('\n');

// 返事の中の質問を取り出す（本文からは外す）
function parseAsk(text) {
  const asks = [];
  const rest = String(text || '').replace(/\[\[質問\]\]([\s\S]*?)(?:\[\[\/質問\]\]|$)/g, (all, body) => {
    const q = [], options = [];
    for (const l of body.split('\n').map(x => x.trim()).filter(Boolean)) {
      const m = l.match(/^(?:\d+\s*[.)．、:]|[-*・•])\s*(.+)$/);
      if (m) options.push(m[1].trim()); else if (!options.length) q.push(l);
    }
    const question = q.join('\n');
    if (question || options.length) asks.push({ question, options: options.slice(0, 8), multi: /[（(]複数可[）)]/.test(question) });
    return '';
  }).trim();
  return { text: rest, asks };
}

// 1回分の起動のしかたを決める。rows は今回の依頼を足す前の会話
function buildTurn({ ai, model, effort, meta, rows, text, basePrompt, policy, perm, noEffort }) {
  const sid = meta.sessions && meta.sessions[ai];
  // Codex はモデルを変えたら新しい会話にする（再開の時にモデルを変えられるか確かでないため）
  const resume = Boolean(sid) && (ai === 'claude' || (meta.models || {}).codex === model);
  let unseen = rows;
  if (resume) {
    let last = -1;
    rows.forEach((r, i) => { if (r.role === 'assistant' && r.ai === ai) last = i; });
    unseen = rows.slice(last + 1);
  }
  const ctx = contextPacket(unseen);
  // 続きの時も、モデルの決まりは毎回つける（前の会話で古いモデルを使おうとしても戻せるように）
  const prompt = [resume ? policy : basePrompt, ASK_RULE, ctx, `# 今回の依頼\n${text}`].filter(Boolean).join('\n\n');
  const base = (perm || launch.DEFAULT_CMD[ai]).trim().split(/\s+/).filter(Boolean);
  const m = launch.flagFor(ai, model);
  const e = noEffort ? '' : effort && launch.EFFORT_FLAG[ai][effort];
  let args;
  if (ai === 'claude') {
    args = [...base.slice(1), '-p', '--output-format', 'stream-json', '--verbose'];
    if (m) args.push('--model', m);
    if (e) args.push('--effort', e);
    if (resume) args.push('--resume', sid);
  } else {
    args = ['exec', ...base.slice(1), '--json', '--skip-git-repo-check'];
    if (m) args.push('--model', m);
    if (e) args.push('-c', `model_reasoning_effort=${e}`);
    if (resume) args.push('resume', sid);
    args.push('-'); // 依頼は標準入力から渡す（長い引き継ぎでも入るように）
  }
  return { command: base[0], args, stdin: prompt, resume, modelFlag: m, effortFlag: e };
}

// 道具の使い方を1行にする
function toolLine(name, input) {
  const i = input || {};
  const x = i.command || i.file_path || i.path || i.pattern || i.url || i.description || '';
  return `${name}${x ? '：' + String(Array.isArray(x) ? x.join(' ') : x).split('\n')[0].slice(0, 160) : ''}`;
}

// CLI 自身の設定の警告など、この作業に関係ない知らせは出さない
const NOISE = /^(Ignoring malformed agent role definition|Model metadata for .* not found)/;
// CLI がモデル名を受け付けなかった時の文言
const EFFORT_REJECTED = /(reasoning[_ ]effort|--effort|unknown variant)/i;
const MODEL_REJECTED = /model[^\n]{0,80}(not supported|not found|does not exist|is not available|invalid|unknown|not exist)|(unknown|invalid) model|model_not_found/i;

// 出力の1行（JSON）を、画面に出す出来事に変える
function parse(ai, o) {
  const ev = [];
  if (!o || typeof o !== 'object') return ev;
  if (ai === 'claude') {
    if (o.session_id && (o.type === 'system' || o.type === 'result')) ev.push({ kind: 'session', id: o.session_id });
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text) ev.push({ kind: 'text', text: c.text });
        // 質問の道具を使ってしまった時も、画面の選択肢にする
        if (c.type === 'tool_use' && c.name === 'AskUserQuestion') ev.push({ kind: 'ask', asks: ((c.input && c.input.questions) || []).map(q => ({ question: String(q.question || ''), options: (q.options || []).map(x => String((x && x.label) || x)), multi: Boolean(q.multiSelect) })) });
        else if (c.type === 'tool_use') ev.push({ kind: 'tool', text: toolLine(c.name, c.input) });
      }
    }
    if (o.type === 'result') ev.push({ kind: 'done', error: o.is_error ? String(o.result || 'エラー') : '', result: typeof o.result === 'string' ? o.result : '' });
    return ev;
  }
  // Codex（新しい形）
  if (o.type === 'thread.started' && o.thread_id) ev.push({ kind: 'session', id: o.thread_id });
  if (o.type === 'item.completed' && o.item) {
    const it = o.item;
    if (it.type === 'agent_message' && it.text) ev.push({ kind: 'text', text: it.text });
    else if (it.type === 'command_execution') ev.push({ kind: 'tool', text: toolLine('コマンド', { command: it.command }) });
    else if (it.type === 'file_change') ev.push({ kind: 'tool', text: `ファイル変更：${(it.changes || []).map(c => c.path).join('、')}` });
    else if (it.type === 'error' && it.message && !NOISE.test(it.message)) ev.push({ kind: 'tool', text: `注意：${it.message}` });
  }
  if (o.type === 'turn.completed') ev.push({ kind: 'done', error: '' });
  if (o.type === 'turn.failed' || o.type === 'error') ev.push({ kind: 'done', error: String((o.error && o.error.message) || o.message || 'エラー') });
  // Codex（古い形）
  const m = o.msg;
  if (m && typeof m === 'object') {
    if (m.type === 'session_configured' && m.session_id) ev.push({ kind: 'session', id: m.session_id });
    if (m.type === 'agent_message' && m.message) ev.push({ kind: 'text', text: m.message });
    if (m.type === 'exec_command_begin') ev.push({ kind: 'tool', text: toolLine('コマンド', { command: m.command }) });
    if (m.type === 'task_complete') ev.push({ kind: 'done', error: '' });
    if (m.type === 'error') ev.push({ kind: 'done', error: String(m.message || 'エラー') });
  }
  return ev;
}

// 実行中の会話（作業ごとに1つまで）
class ChatRunner {
  // dirOf: プロジェクトID → 台帳の場所（待っている指示を保存して、再起動しても残すため）
  constructor(opts) { this.running = new Map(); this.watchers = new Map(); this.queues = new Map(); this.base = new Map(); this.dirOf = (opts && opts.dirOf) || null; this.canStart = (opts && opts.canStart) || null; }
  key(p, t) { return `${p}\u0000${t}`; }
  busy(p, t) { return this.running.get(this.key(p, t)) || null; }
  watch(p, t, fn) {
    const k = this.key(p, t);
    if (!this.watchers.has(k)) this.watchers.set(k, new Set());
    this.watchers.get(k).add(fn);
    return () => this.watchers.get(k).delete(fn);
  }
  emit(p, t, ev) { for (const w of this.watchers.get(this.key(p, t)) || []) w(ev); }

  // 1回分を動かす。終わったら onEnd を呼ぶ。
  send(o) {
    const { project, task, pdir, ai, model, effort, text } = o;
    if (this.busy(project, task)) throw new Error('まだ前の返事を書いています。終わるか［止める］を押してから送ってください');
    const unavailable = this.canStart && this.canStart(ai, model);
    if (unavailable) throw new Error(unavailable);
    const rows = read(pdir, task);
    const meta = readMeta(pdir, task);
    const turn = buildTurn({ ...o, meta, rows });
    this.base.set(this.key(project, task), o); // 追加の指示を送る時に使う
    const userRow = append(pdir, task, { role: 'user', text: o.shown || text, to: ai, model, effort, ...(o.mode ? { mode: o.mode } : {}) });
    this.emit(project, task, { type: 'row', row: userRow });
    this.run(o, turn, meta, rows);
    return { userRow, resume: turn.resume };
  }

  run(o, turn, meta, rows) {
    const { project, task, pdir, dir, ai, model, effort, env, onEnd } = o;
    const child = spawn(turn.command, turn.args, { cwd: dir, env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!o.started) o.started = Date.now(); // 思考の指定をやり直しても、最初に送った時から数える
    const run = { child, ai, model, effort, texts: [], err: '', done: null, sid: null, stopped: false, started: o.started, last: '' };
    run.finishedP = new Promise(r => { run.resolveFinished = r; });
    this.running.set(this.key(project, task), run);
    this.emit(project, task, { type: 'busy', ai, model, started: run.started });
    child.stdin.on('error', () => {});
    child.stdin.end(turn.stdin);
    let rest = '';
    child.stdout.on('data', d => {
      rest += d.toString('utf8');
      const ls = rest.split('\n'); rest = ls.pop();
      for (const l of ls) {
        let x; try { x = JSON.parse(l); } catch (e) { continue; }
        for (const ev of parse(ai, x)) {
          if (ev.kind === 'session') run.sid = ev.id;
          else if (ev.kind === 'text') { run.texts.push(ev.text); this.emit(project, task, { type: 'partial', ai, text: run.texts.join('\n\n') }); }
          else if (ev.kind === 'tool') { run.last = ev.text; this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, tool: true, text: ev.text }) }); }
          else if (ev.kind === 'ask') run.asks = [...(run.asks || []), ...ev.asks];
          else if (ev.kind === 'done') run.done = ev;
        }
      }
    });
    child.stderr.on('data', d => { run.err = (run.err + d.toString('utf8')).slice(-4000); });
    const finish = code => {
      if (run.finished) return; run.finished = true;
      this.running.delete(this.key(project, task));
      let text = run.texts.join('\n\n') || (run.done && run.done.result) || '';
      let error = '';
      if (run.stopped) error = '止めました';
      else if (run.done && run.done.error) error = run.done.error;
      else if (code !== 0 && code !== null) error = (run.err.trim().split('\n').slice(-3).join(' ') || `終了コード ${code}`);
      else if (code === null && !text) error = run.err.trim() || '途中で終わりました';
      const modelRejected = error && !text && turn.modelFlag && !run.stopped && MODEL_REJECTED.test(error + ' ' + run.err);
      if (modelRejected) error = `指定したモデル「${turn.modelFlag}」を ${LABEL[ai]} が受け付けませんでした。設定画面の「AI の更新」と「CLI に渡すモデル名」を確認してください。${error}`;
      // 思考の指定を断られた：指定なしで1回だけやり直す
      if (!modelRejected && error && !text && turn.effortFlag && !run.stopped && EFFORT_REJECTED.test(error + ' ' + run.err)) {
        this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, text: `思考「${effort}」の指定は使えなかったため、指定なしでやり直します` }) });
        const next = { ...o, noEffort: true };
        return this.run(next, buildTurn({ ...next, meta, rows }), meta, rows);
      }
      if (run.sid && !modelRejected) { meta.sessions = { ...(meta.sessions || {}), [ai]: run.sid }; meta.models = { ...(meta.models || {}), [ai]: model }; writeMeta(pdir, task, meta); }
      const pa = parseAsk(text);
      const asks = [...(run.asks || []), ...pa.asks];
      if (asks.length) text = pa.text;
      const row = append(pdir, task, { role: 'assistant', ai, model, effort, text, error, ms: Date.now() - o.started, ...(asks.length ? { asks } : {}) });
      this.emit(project, task, { type: 'row', row });
      this.emit(project, task, { type: 'idle' });
      if (onEnd) onEnd(row);
      run.resolveFinished();
      // 待っている指示：普通に終わったら次を始める。［止める］で止めた時は取り消す（［中断して送る］の時は残す）
      const k = this.key(project, task);
      const q = this.queue(project, task);
      if (run.stopped && !run.interrupting) { if (q.length) this.setQueue(project, task, []); }
      else if (q.length && !run.interrupting) {
        const next = q[0];
        this.setQueue(project, task, q.slice(1));
        const b = this.base.get(k) || o;
        try { this.send({ ...b, ai: next.ai, model: next.model, effort: next.effort, text: next.text, perm: next.perm, mode: 'queued', shown: undefined, started: undefined, noEffort: false }); }
        catch (e) { /* 始められなければ待たせたまま */ this.setQueue(project, task, [next, ...this.queue(project, task)]); }
      }
      return undefined;
    };
    child.on('error', e => { run.err = e.code === 'ENOENT' ? `「${turn.command}」が見つかりません。ターミナルで ${turn.command} が動くか確かめてください` : String(e.message); finish(1); });
    child.on('close', code => finish(code));
  }

  stop(p, t, opts) {
    const run = this.busy(p, t);
    if (!run) return false;
    run.stopped = true;
    if (opts && opts.interrupting) run.interrupting = true;
    try { run.child.kill('SIGTERM'); } catch (e) { /* 無視 */ }
    return run.finishedP;
  }

  // 追加の指示（今の作業が終わったら続けて行う）。ファイルにも残し、再起動したら読み直す
  queue(p, t) {
    const k = this.key(p, t);
    if (!this.queues.has(k)) {
      let q = [];
      const d = this.dirOf && this.dirOf(p);
      if (d) { try { q = JSON.parse(fs.readFileSync(files(d, t).queue, 'utf8')); } catch (e) { q = []; } }
      this.queues.set(k, Array.isArray(q) ? q : []);
    }
    return this.queues.get(k);
  }
  setQueue(p, t, q) {
    this.queues.set(this.key(p, t), q);
    const d = this.dirOf && this.dirOf(p);
    if (d) {
      const f = files(d, t).queue;
      try {
        if (q.length || fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(q, null, 2)); }
      } catch (e) { /* 保存できなくても、画面の中では続ける */ }
    }
    this.emit(p, t, { type: 'queue', queue: q });
    return q;
  }
  enqueue(p, t, item) {
    const it = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...item };
    this.setQueue(p, t, [...this.queue(p, t), it]);
    return it;
  }
  unqueue(p, t, id) { return this.setQueue(p, t, this.queue(p, t).filter(x => x.id !== id)); }
  stopAll() { for (const [, r] of this.running) { r.stopped = true; try { r.child.kill('SIGTERM'); } catch (e) { /* 無視 */ } } }
}

module.exports = { ChatRunner, read, append, readMeta, buildTurn, parse, parseAsk, contextPacket, LIMIT, ASK_RULE };
