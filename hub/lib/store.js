'use strict';
// 台帳（Product/<プロジェクト>/PROJECT.md）と作業ファイル（.ai/tasks/<作業ID>.md）の読み書き
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseDoc, parseYaml, setScalar, scalar } = require('./frontmatter');

const SAFE_NAME = /^[^/\\\0]+$/;

function expandHome(p) {
  if (!p || typeof p !== 'string') return '';
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// 本文の「## 見出し」ごとに分ける
function sections(body) {
  const out = {};
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; out[cur] = []; continue; }
    if (cur && line.trim() && !line.trim().startsWith('<!--')) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

// 台帳の本文（先頭の --- の後）から、見出しとコメントを除いたメモ
function projectNotes(body) {
  return body.split(/\r?\n/).filter(l => l.trim() && !/^#\s/.test(l) && !l.trim().startsWith('<!--')).join('\n').trim();
}

// 「## 手順」のチェック欄（- [ ] / - [x]）を読む
const STEP = /^\s*[-*]\s+\[([ xX])\]\s+(\S.*)$/;
function readSteps(body) {
  const out = [];
  let inside = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inside = /^##\s+手順/.test(line); continue; }
    const m = inside && line.match(STEP);
    if (m) out.push({ text: m[2].trim(), done: m[1] !== ' ' });
  }
  return out;
}
const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();

// PROJECT.md の phases の1つの state を書き換える（{ name: X, state: Y } の形と、名前・state が別の行の形）
function setPhaseLine(text, name, state) {
  const lines = text.split('\n');
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flow = new RegExp('^\\s*-\\s*\\{.*\\bname:\\s*' + esc + '\\s*[,}]');
  const block = new RegExp('^(\\s*)-\\s*name:\\s*' + esc + '\\s*$');
  for (let i = 0; i < lines.length; i++) {
    if (flow.test(lines[i])) {
      lines[i] = /\bstate:/.test(lines[i]) ? lines[i].replace(/\bstate:\s*[^,}]*/, `state: ${state} `).replace(/ +([,}])/, ' $1') : lines[i].replace(/\s*\}\s*$/, `, state: ${state} }`);
      return lines.join('\n');
    }
    const b = lines[i].match(block);
    if (b) {
      for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]) && /^\s+\S/.test(lines[j]); j++) {
        if (/^\s*state:/.test(lines[j])) { lines[j] = lines[j].replace(/state:.*$/, `state: ${state}`); return lines.join('\n'); }
      }
      lines.splice(i + 1, 0, `${b[1]}  state: ${state}`);
      return lines.join('\n');
    }
  }
  return text;
}

function pick(secs, word) {
  const k = Object.keys(secs).find(s => s.includes(word));
  return k ? secs[k] : '';
}

class Store {
  constructor(root) {
    this.root = root;
    this.product = path.join(root, 'Product');
  }

  projectDir(id) {
    if (!SAFE_NAME.test(id || '') || id === '.' || id === '..') return null;
    const dir = path.join(this.product, id);
    return fs.existsSync(path.join(dir, 'PROJECT.md')) ? dir : null;
  }

  taskFile(projectId, taskId) {
    const dir = this.projectDir(projectId);
    if (!dir || !SAFE_NAME.test(taskId || '') || taskId.startsWith('_') || taskId.startsWith('.')) return null;
    const f = path.join(dir, '.ai', 'tasks', taskId + '.md');
    return fs.existsSync(f) ? f : null;
  }

  readTask(file) {
    const { data, body } = parseDoc(read(file) || '');
    const secs = sections(body);
    const id = path.basename(file, '.md');
    return {
      id,
      title: data.title || id,
      role: data.role || '',
      owner: data.owner || '',
      state: data.state || '未着手',
      question: data.question || '',
      workdir: data.workdir || '',
      model: data.model || '',
      parent: data.parent || '',
      effort: data.effort || '',
      phase: data.phase || '',
      via: data.via || '',
      steps: readSteps(body),
      skills: Array.isArray(data.skills) ? data.skills.filter(Boolean) : [],
      updated: data.updated || '',
      done: pick(secs, 'やったこと'),
      next: pick(secs, '次にやること'),
      note: pick(secs, '注意'),
      memo: pick(secs, 'メモ'),
    };
  }

  readProject(id) {
    const dir = this.projectDir(id);
    if (!dir) return null;
    const { data, body } = parseDoc(read(path.join(dir, 'PROJECT.md')) || '');
    const tdir = path.join(dir, '.ai', 'tasks');
    let tasks = [];
    try {
      tasks = fs.readdirSync(tdir)
        .filter(f => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
        .map(f => this.readTask(path.join(tdir, f)))
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    } catch { /* 作業ファイルなし */ }
    const folders = data.folders && typeof data.folders === 'object' && !Array.isArray(data.folders) ? data.folders : {};
    return {
      id,
      dir,
      name: data.name || id,
      status: data.status || '未着手',
      parent: data.parent || '',
      description: data.description || '',
      notes: projectNotes(body),
      updated: data.updated || '',
      phases: Array.isArray(data.phases) ? data.phases : [],
      folders: Object.entries(folders).filter(([, v]) => v).map(([label, p]) => ({ label, path: p })),
      related: Array.isArray(data.related) ? data.related.filter(Boolean) : [],
      issues: Array.isArray(data.issues) ? data.issues.filter(i => i && (i.text || typeof i === 'string')) : [],
      chats: Array.isArray(data.chats) ? data.chats.filter(Boolean) : [],
      tasks,
    };
  }

  // 新しいプロジェクト：ひな形（CLAUDE.md・AGENTS.md・.ai/ など）を写し、台帳を書く
  createProject({ name, description, body, phases, parent, related, refs }, templateDir) {
    const nm = oneLine(name).replace(/[\/\\\0]/g, '・').slice(0, 60);
    if (!nm || nm === '.' || nm === '..' || nm.startsWith('.') || nm.startsWith('_')) return { error: 'プロジェクト名を入れてください' };
    const dir = path.join(this.product, nm);
    if (fs.existsSync(dir)) return { error: `「${nm}」はもうあります` };
    fs.mkdirSync(dir, { recursive: true });
    if (templateDir && fs.existsSync(templateDir)) {
      fs.cpSync(templateDir, dir, { recursive: true, filter: src => path.basename(src) !== '.gitkeep' && path.basename(src) !== 'PROJECT.md' });
    }
    for (const d of ['資料', '作業', '成果物', '.ai/tasks', '.ai/memory', '.ai/work']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const list = (Array.isArray(phases) ? phases : String(phases || '').split(/\r?\n/)).map(oneLine).filter(Boolean).slice(0, 12);
    const rel = (Array.isArray(related) ? related : String(related || '').split(/[,、\n]/)).map(oneLine).filter(Boolean);
    const q = v => scalar(v);
    const text = [
      '---',
      `name: ${q(nm)}`,
      'status: 進行中',
      `updated: ${now().slice(0, 10)}`,
      `description: ${q(description)}`,
      `parent: ${q(parent)}`,
      'phases:',
      ...(list.length ? list : ['計画', '作る', 'チェック', '仕上げ']).map((ph, i) => `  - { name: ${ph.replace(/[,{}]/g, '・')}, state: ${i === 0 ? '進行中' : '未着手'} }`),
      'folders:',
      ...(oneLine(body) ? [`  本体: ${q(oneLine(body))}`] : []),
      ...(Array.isArray(refs) ? refs : []).map(oneLine).filter(Boolean).slice(0, 30).map((r, i) => `  参考${i + 1}: ${q(r)}`),
      `related: [${rel.map(x => x.replace(/[,\[\]]/g, '・')).join(', ')}]`,
      'chats: []',
      'issues: []',
      '---',
      '',
      '# メモ',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), text);
    return { project: this.readProject(nm) };
  }

  // 参考フォルダ・ファイルを足す（PROJECT.md の folders に「参考N」として書く。同じ場所は足さない）
  addRefs(id, paths) {
    const p = this.readProject(id);
    if (!p) return null;
    const file = path.join(p.dir, 'PROJECT.md');
    const lines = read(file).split('\n');
    const end = lines.indexOf('---', 1);
    let i = lines.findIndex((l, k) => k > 0 && k < end && /^folders:/.test(l));
    if (i < 0) { lines.splice(end, 0, 'folders:'); i = end; }
    else if (/^folders:\s*\{\s*\}/.test(lines[i])) lines[i] = 'folders:';
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j]) && lines[j] !== '---') j++;
    const have = new Set(p.folders.map(f => expandHome(f.path)));
    const used = new Set(p.folders.map(f => f.label));
    // 中身の無い「資料:」などの行は残してよい。番号は空いている所から
    let n = 1;
    const add = [];
    for (const x of paths) {
      if (have.has(x)) continue;
      while (used.has(`参考${n}`)) n++;
      used.add(`参考${n}`); have.add(x);
      add.push(`  参考${n}: ${scalar(x)}`);
    }
    lines.splice(j, 0, ...add);
    fs.writeFileSync(file, lines.join('\n'));
    return { project: this.readProject(id), added: add.length };
  }

  listProjects() {
    let names = [];
    try { names = fs.readdirSync(this.product); } catch { return []; }
    return names.filter(n => !n.startsWith('.') && !n.startsWith('_'))
      .map(n => this.readProject(n)).filter(Boolean)
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  roles() {
    const text = read(path.join(this.root, '_hub', 'roles.yaml'));
    return text ? parseYaml(text) : {};
  }

  // 状態・質問を書き換え、メモを1行足す
  updateTask(projectId, taskId, { state, question, memo, owner, role, model, effort, parent, workdir, phase, via }) {
    const file = this.taskFile(projectId, taskId);
    if (!file) return null;
    let text = read(file);
    if (state !== undefined) text = setScalar(text, 'state', state);
    if (question !== undefined) text = setScalar(text, 'question', question);
    if (owner !== undefined) text = setScalar(text, 'owner', owner);
    if (role !== undefined) text = setScalar(text, 'role', role);
    if (model !== undefined) text = setScalar(text, 'model', model);
    if (effort !== undefined) text = setScalar(text, 'effort', effort);
    if (parent !== undefined) text = setScalar(text, 'parent', parent);
    if (workdir !== undefined) text = setScalar(text, 'workdir', workdir);
    if (phase !== undefined) text = setScalar(text, 'phase', phase);
    if (via !== undefined) text = setScalar(text, 'via', via);
    text = setScalar(text, 'updated', now());
    if (memo && String(memo).trim()) {
      const line = `- ${now()} ${String(memo).replace(/[\r\n]+/g, ' ').trim()}`;
      text = /^## メモ\s*$/m.test(text)
        ? text.replace(/^## メモ\s*$/m, m => `${m}\n${line}`)
        : text.replace(/\s*$/, `\n\n## メモ\n${line}\n`);
    }
    fs.writeFileSync(file, text);
    return this.readTask(file);
  }

  // 手順に印を付ける・外す。全部付いたら完了、外したら実行中に戻す
  setStep(projectId, taskId, index, done) {
    const file = this.taskFile(projectId, taskId);
    if (!file) return null;
    const lines = read(file).split('\n');
    let inside = false, n = -1, hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { inside = /^##\s+手順/.test(lines[i]); continue; }
      if (inside && STEP.test(lines[i]) && ++n === index) { lines[i] = lines[i].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]'); hit = true; break; }
    }
    if (!hit) return null;
    let text = setScalar(lines.join('\n'), 'updated', now());
    const steps = readSteps(parseDoc(text).body);
    const cur = parseDoc(text).data.state;
    if (steps.length && steps.every(x => x.done)) text = setScalar(text, 'state', '完了');
    else if (cur === '完了') text = setScalar(text, 'state', '実行中');
    fs.writeFileSync(file, text);
    return this.readTask(file);
  }

  // 手順を1つ足す（「## 手順」が無ければ本文の先頭に作る）
  addStep(projectId, taskId, textIn) {
    const file = this.taskFile(projectId, taskId);
    const item = oneLine(textIn).slice(0, 120);
    if (!file || !item) return null;
    const lines = read(file).split('\n');
    const h = lines.findIndex(l => /^##\s+手順/.test(l));
    if (h >= 0) {
      let end = h + 1;
      for (let i = h + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (STEP.test(lines[i])) end = i + 1;
      // 中身の無い「- [ ] 」は置き換える
      const blank = lines.findIndex((l, i) => i > h && i <= end && /^\s*[-*]\s+\[ \]\s*$/.test(l));
      if (blank >= 0) lines[blank] = `- [ ] ${item}`; else lines.splice(end, 0, `- [ ] ${item}`);
    } else {
      const close = lines.indexOf('---', 1);
      lines.splice(close + 1, 0, '## 手順', `- [ ] ${item}`, '');
    }
    let text = setScalar(lines.join('\n'), 'updated', now());
    if (parseDoc(text).data.state === '完了') text = setScalar(text, 'state', '実行中');
    fs.writeFileSync(file, text);
    return this.readTask(file);
  }

  // プロジェクトの状態（人が［プロジェクトを完了にする］を押した時など）
  setProjectStatus(projectId, status) {
    const p = this.readProject(projectId);
    if (!p) return null;
    const file = path.join(p.dir, 'PROJECT.md');
    fs.writeFileSync(file, setScalar(read(file), 'status', status));
    return this.readProject(projectId);
  }

  // 今のフェーズ（最初の未完了）を完了にして、次を進行中にする
  nextPhase(projectId) {
    const p = this.readProject(projectId);
    if (!p) return null;
    const i = p.phases.findIndex(ph => ph && ph.state !== '完了');
    if (i < 0) return p;
    const file = path.join(p.dir, 'PROJECT.md');
    let text = setPhaseLine(read(file), p.phases[i].name, '完了');
    if (p.phases[i + 1]) text = setPhaseLine(text, p.phases[i + 1].name, '進行中');
    else text = setScalar(text, 'status', '完了');
    fs.writeFileSync(file, text);
    return this.readProject(projectId);
  }

  // 新しい作業ファイルを作る
  createTask(projectId, { title, owner, next, role, parent, phase, via, steps }) {
    const dir = this.projectDir(projectId);
    if (!dir || !title || !String(title).trim()) return null;
    const tdir = path.join(dir, '.ai', 'tasks');
    fs.mkdirSync(tdir, { recursive: true });
    const day = now().slice(0, 10).replace(/-/g, '');
    let n = 1, id;
    do { id = `${day}-${String(n).padStart(2, '0')}`; n++; } while (fs.existsSync(path.join(tdir, id + '.md')));
    const one = scalar;
    const list = (Array.isArray(steps) ? steps : String(steps || '').split(/\r?\n/)).map(oneLine).filter(Boolean).slice(0, 12);
    const text = `---\nid: ${id}\ntitle: ${one(title)}\nrole: ${one(role)}\nparent: ${one(parent)}\nphase: ${one(phase)}\nowner: ${one(owner)}\nvia: ${one(via)}\nstate: 未着手\nworkdir:\nmodel:\neffort:\nquestion:\nskills: []\nupdated: ${now()}\n---\n## 手順\n${list.map(x => `- [ ] ${x}`).join('\n')}\n\n## やったこと\n\n## 次にやること\n${one(next)}\n\n## 注意\n`;
    fs.writeFileSync(path.join(tdir, id + '.md'), text);
    return this.readTask(path.join(tdir, id + '.md'));
  }
}

function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = { Store, expandHome, readSteps, setPhaseLine };
