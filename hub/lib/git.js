'use strict';
// Git の出し入れ：作業ごとの作業用コピー（worktree）を作る・本体に取り込む・片付ける
// Git の無いフォルダは、最初に保存を始める（作業用コピーは作らない）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MAX_FILES = 20000;          // これより多いフォルダは自動で保存を始めない
const MAX_BYTES = 1024 ** 3;      // 1GB

function git(dir, args) {
  // 名前が未設定の Mac でも保存できるように、未設定の時だけ仮の名前を使う
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!hasIdentity(dir)) Object.assign(env, { GIT_AUTHOR_NAME: 'Project Hub', GIT_AUTHOR_EMAIL: 'hub@localhost', GIT_COMMITTER_NAME: 'Project Hub', GIT_COMMITTER_EMAIL: 'hub@localhost' });
  return execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(dir, args) { try { return git(dir, args); } catch (e) { return null; } }

function hasIdentity(dir) {
  try { return Boolean(execFileSync('git', ['-C', dir, 'config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (e) { return false; }
}

function available() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

function repoTop(dir) { return fs.existsSync(dir) ? tryGit(dir, ['rev-parse', '--show-toplevel']) : null; }

// 作業用コピーなら、本体のフォルダを返す
function mainOf(dir) {
  const common = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const own = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (!common || !own || common === own) return null;
  return path.dirname(common);
}

function dirty(dir) { return Boolean(tryGit(dir, ['status', '--porcelain'])); }

// ignore の無いプロジェクトでも、新しい秘密設定は自動保存に含めない。
// すでに追跡されているファイルは変更せず、例示用の .env は許容する。
function stageAll(dir) {
  git(dir, ['add', '-A']);
  const added = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '-z'])
    .split('\0').filter(Boolean);
  const secrets = added.filter(f => {
    const name = path.posix.basename(f);
    if (name === '.env.example' || name === '.env.sample') return false;
    return LOCAL_FILES.test(name) || /(^|\/)\.claude\/settings\.local\.json$/.test(f);
  });
  for (let i = 0; i < secrets.length; i += 100) {
    git(dir, ['rm', '--cached', '-q', '--', ...secrets.slice(i, i + 100).map(f => `:(top,literal)${f}`)]);
  }
  try { git(dir, ['diff', '--cached', '--quiet']); return false; }
  catch (e) { if (e.status === 1) return true; throw e; }
}

// 変更があれば保存する
function save(dir, message) {
  if (!dirty(dir)) return false;
  if (!stageAll(dir)) return false;
  git(dir, ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}

// 大きすぎないか数える（途中で上限を超えたら止める）
function tooBig(dir) {
  let files = 0, bytes = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(f)) return true; continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += fs.statSync(f).size; } catch (x) { /* 無視 */ }
      if (files > MAX_FILES || bytes > MAX_BYTES) return true;
    }
    return false;
  };
  return walk(dir);
}

// Git の無いフォルダで保存を始める。できなければ理由を返す
function init(dir) {
  if (tooBig(dir)) return { ok: false, reason: 'ファイルが多すぎるため、Git の保存は始めませんでした' };
  git(dir, ['init', '-q']);
  stageAll(dir);
  git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'Project Hub: 最初の保存']);
  return { ok: true };
}

const real = p => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
// ブランチ名に使えない文字だけ置き換える（日本語はそのまま）
const branchName = s => 'hub/' + (String(s).replace(/[\s~^:?*[\\\x00-\x1f\x7f]+|\.\.|@\{/g, '-').replace(/^[-.]+|[-.]+$|\.lock$/g, '') || 'task');

// 作業を始める前の準備。作業する場所と、何をしたかを返す
//   base: 本体のフォルダ / workRoot: AI-Workspace/Work/<プロジェクト>
function prepare({ base, workRoot, taskId, direct }) {
  if (!available()) return { dir: base, note: 'Git が無いため、本体で作業します' };
  let top = repoTop(base);
  // 台帳のフォルダが別の Git の中にある時は、台帳だけの保存を始める
  if (top && direct && real(top) !== real(base)) top = null;
  if (!top) {
    const r = init(base);
    if (!r.ok) return { dir: base, note: r.reason };
    git(base, ['config', 'hub.mode', 'direct']);
    return { dir: base, note: 'Git の保存を始めました（本体で作業します）', inited: true };
  }
  // 元々 Git の無かったフォルダ・台帳のフォルダは、本体で作業する（始める前に保存だけする）
  if (direct || tryGit(top, ['config', 'hub.mode']) === 'direct') {
    save(top, '作業前の保存');
    return { dir: base, note: '作業前に保存しました' };
  }
  // まだ一度も保存していない Git なら、まず保存する
  if (!tryGit(top, ['rev-parse', '--verify', 'HEAD'])) { stageAll(top); git(top, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'Project Hub: 最初の保存']); }
  const wt = path.join(workRoot, taskId);
  const rel = path.relative(top, base);
  if (fs.existsSync(wt)) return { dir: path.join(wt, rel), worktree: wt };
  fs.mkdirSync(workRoot, { recursive: true });
  const branch = branchName(taskId);
  const exists = tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  git(top, exists ? ['worktree', 'add', '-q', wt, branch] : ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD']);
  const copied = copyLocalFiles(top, wt);
  return { dir: path.join(wt, rel), worktree: wt, created: true, branch, copied, note: `この作業専用の作業用コピーを作りました${copied.length ? `（${copied.join('・')} も写しました）` : ''}` };
}

// Git に入っていない手元の設定（.env など）を作業用コピーにも写す。無いと AI のテストが動かないため
const LOCAL_FILES = /^(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc)$/;
function copyLocalFiles(top, wt) {
  const copied = [];
  const cands = [];
  try { for (const n of fs.readdirSync(top)) if (LOCAL_FILES.test(n)) cands.push(n); } catch (e) { return copied; }
  for (const f of ['.claude/settings.local.json']) if (fs.existsSync(path.join(top, f))) cands.push(f);
  for (const rel of cands) {
    const src = path.join(top, rel), dst = path.join(wt, rel);
    try {
      if (!fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
      if (tryGit(top, ['ls-files', '--error-unmatch', rel]) !== null) continue; // Git に入っている物は写さない
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    } catch (e) { /* 写せない物は飛ばす */ }
  }
  return copied;
}

// 取り込む前の見通し：変わったファイルの数・行数、本体とぶつかりそうか（本体は触らない）
function preview({ dir, workRoot }) {
  const wt = repoTop(dir);
  const main = wt && mainOf(wt);
  if (!wt || !main) return null;
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const mainHead = tryGit(main, ['rev-parse', 'HEAD']);
  const base = mainHead && tryGit(wt, ['merge-base', mainHead, 'HEAD']);
  if (!base) return null;
  const stat = tryGit(wt, ['diff', '--shortstat', base]) || '';
  const num = re => Number((stat.match(re) || [0, 0])[1]);
  const untracked = (tryGit(wt, ['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean).length;
  const files = num(/(\d+) files? changed/) + untracked;
  let conflict = false;
  // 保存済みの変更どうしで試しに合わせてみる（git 2.38 以上。使えなければ判定しない）
  if (tryGit(wt, ['rev-parse', 'HEAD']) !== base) {
    try { git(main, ['merge-tree', '--write-tree', '--name-only', '--no-messages', mainHead, tryGit(wt, ['rev-parse', 'HEAD'])]); }
    catch (e) { conflict = e.status === 1; }
  }
  return { files, added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/), conflict, mainDirty: dirty(main) };
}

// ゴミ箱へ移す（完全には消さない）
function toTrash(dir, trash) {
  const bin = trash || process.env.HUB_TRASH || path.join(os.homedir(), '.Trash');
  fs.mkdirSync(bin, { recursive: true });
  let dest = path.join(bin, path.basename(dir));
  if (fs.existsSync(dest)) dest += ' ' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(dir, dest);
  return dest;
}

// 作業用コピーを本体に取り込み、片付ける。ぶつかったら何も変えずに conflict を返す
function merge({ dir, workRoot, title }) {
  const wt = repoTop(dir);
  if (!wt) return { ok: false, error: '作業用コピーが見つかりません' };
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Work フォルダの作業用コピーではありません' };
  const main = mainOf(wt);
  if (!main) return { ok: false, error: 'Git の作業用コピーではありません' };
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  save(wt, `${title}（作業の保存）`);
  save(main, '取り込み前の保存');
  try {
    git(main, ['merge', '--no-ff', '--no-edit', '-m', `取り込み: ${title}`, branch]);
  } catch (e) {
    tryGit(main, ['merge', '--abort']);
    return { ok: false, conflict: true, error: '本体とぶつかったため、取り込みませんでした' };
  }
  const trashed = toTrash(wt);
  tryGit(main, ['worktree', 'prune']);
  tryGit(main, ['branch', '-d', branch]);
  return { ok: true, main, trashed };
}

// Work/<プロジェクト>/ に残っている作業用コピーの数
function countCopies(workRoot) {
  try { return fs.readdirSync(workRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).length; } catch (e) { return 0; }
}

module.exports = { available, repoTop, mainOf, save, init, prepare, merge, preview, toTrash, countCopies, dirty, copyLocalFiles };
