'use strict';
// Claude Code / Codex の起動コマンドを組み立てる。フォルダを Finder で開く。
const { execFile } = require('child_process');

const DEFAULT_CMD = {
  claude: 'claude --dangerously-skip-permissions',
  codex: 'codex --dangerously-bypass-approvals-and-sandbox',
};

// 画面の呼び名 → CLI に渡す名前
// ※ 実際の CLI が受け付ける名前と違えば、ここを直すだけでよい
const MODEL_FLAG = {
  // Claude Code は本当のモデル名が分かっているので、それを渡す
  claude: { 'Opus 5.5': 'claude-opus-5-5', 'Fable 5.1': 'claude-fable-5-1' },
  // Codex の /model の一覧（v0.157）に合わせた名前。GPT-6 に Terra は無いので 6terra は GPT-5.6-Terra
  codex: { 'GPT-6.1-Sol': 'gpt-6.1-sol', Astra: 'gpt-6-astra', '6sol': 'gpt-6-sol', '6luna': 'gpt-6-luna', '6terra': 'gpt-5.6-terra' },
};
// 設定画面で直した名前（_hub/cli-models.json）。空の文字＝モデルを指定しない（CLI の既定を使う）
let overrides = { claude: {}, codex: {} };
let discovered = { claude: {}, codex: {} };
function setOverrides(o) { overrides = { claude: { ...((o && o.claude) || {}) }, codex: { ...((o && o.codex) || {}) } }; }
function getOverrides() { return overrides; }
function setDiscoveredModels(catalog) {
  discovered = { claude: {}, codex: {} };
  for (const ai of ['claude', 'codex']) {
    for (const row of catalog[ai]?.known || catalog[ai]?.models || []) discovered[ai][row.label] = row.id;
  }
}
// 画面の呼び名 → CLI に渡す名前（無ければ ''）
function flagFor(ai, model) {
  if (!model) return '';
  const o = overrides[ai] || {};
  if (Object.prototype.hasOwnProperty.call(o, model)) return String(o[model] || '');
  return (MODEL_FLAG[ai] || {})[model] || discovered[ai]?.[model] || '';
}
const EFFORT_FLAG = {
  claude: { '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max', 'Ultra': 'ultra' },
  codex: { '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max', 'Ultra': 'ultra' },
};

// 動いている AI に途中で切り替えを伝える時のコマンド（画面の中で打つのと同じ）
// ※ CLI のコマンドが違えば、ここを直すだけでよい
const SWITCH_CMD = {
  claude: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
  codex: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
};

function switchCommand(ai, field, value) {
  const v = field === 'model' ? flagFor(ai, value) : (EFFORT_FLAG[ai] && EFFORT_FLAG[ai][value]);
  const f = SWITCH_CMD[ai] && SWITCH_CMD[ai][field];
  return v && f ? f(v) : '';
}

function sq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function as(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// シェル用の1行（ターミナルの窓を開く時に使う）
function buildCommand({ ai, dir, prompt, cmd, model, effort }) {
  const base = cmd || DEFAULT_CMD[ai];
  if (!base) throw new Error('unknown ai');
  const args = [];
  const m = flagFor(ai, model);
  const e = effort && EFFORT_FLAG[ai]?.[effort];
  if (m) args.push('--model', m);
  if (e) args.push(...(ai === 'claude' ? ['--effort', e] : ['-c', `model_reasoning_effort=${e}`]));
  return `cd ${sq(dir)} && ${base}${args.map(a => ' ' + sq(a)).join('')} ${sq(prompt)}`;
}

// 画面の中の作業画面用：実行ファイルと引数に分ける（シェルを通さない）
function buildArgv({ ai, prompt, cmd, model, effort }) {
  const base = (cmd || DEFAULT_CMD[ai] || '').trim().split(/\s+/).filter(Boolean);
  if (!base.length || !['claude', 'codex'].includes(ai)) throw new Error('unknown ai');
  const args = base.slice(1);
  const m = flagFor(ai, model);
  const e = effort && EFFORT_FLAG[ai][effort];
  if (ai === 'claude') {
    if (m) args.push('--model', m);
    if (e) args.push('--effort', e);
  } else {
    if (m) args.push('--model', m);
    if (e) args.push('-c', `model_reasoning_effort=${e}`);
  }
  if (prompt) args.push(prompt);
  return { command: base[0], args };
}

function run(file, args, dry) {
  if (dry) return Promise.resolve({ dry: true, file, args });
  return new Promise((resolve, reject) => {
    execFile(file, args, err => (err ? reject(err) : resolve({ ok: true })));
  });
}

function openTerminal(command, dry) {
  return run('osascript', [
    '-e', `tell application "Terminal" to do script "${as(command)}"`,
    '-e', 'tell application "Terminal" to activate',
  ], dry);
}

function openFolder(p, dry) { return run('open', [p], dry); }
// ファイルは Finder でその場所を開いて選ぶ。URL は Mac の既定のブラウザで開く
function revealFile(p, dry) { return run('open', ['-R', p], dry); }
function openUrl(u, dry) { return run('open', [u], dry); }

module.exports = { buildCommand, buildArgv, openTerminal, openFolder, revealFile, openUrl, sq, DEFAULT_CMD, MODEL_FLAG, EFFORT_FLAG, SWITCH_CMD, switchCommand, flagFor, setOverrides, getOverrides, setDiscoveredModels };
