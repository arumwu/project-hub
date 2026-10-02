'use strict';
// PROJECT.md や作業ファイルの先頭（--- で囲んだ部分）を読む。
// 台帳で使う形だけに対応した小さな YAML 読み取り:
//   key: 値 / key: [a, b] / key: { k: v } / key: の下に「- 項目」または「子キー: 値」

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitTop(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function splitKey(s) {
  const i = s.indexOf(':');
  if (i < 0) return null;
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    return splitTop(v.slice(1, -1)).map(parseValue);
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const o = {};
    for (const part of splitTop(v.slice(1, -1))) {
      const kv = splitKey(part);
      if (kv) o[kv[0]] = parseValue(kv[1]);
    }
    return o;
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function parseYaml(text) {
  const data = {};
  let key = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      const kv = splitKey(body);
      if (!kv) continue;
      key = kv[0];
      data[key] = kv[1] === '' ? null : parseValue(kv[1]);
      continue;
    }
    if (!key) continue;
    if (body.startsWith('- ') || body === '-') {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(parseValue(body.slice(1)));
    } else {
      const kv = splitKey(body);
      if (!kv) continue;
      if (data[key] === null || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = {};
      data[key][kv[0]] = parseValue(kv[1]);
    }
  }
  for (const k of Object.keys(data)) if (data[k] === null) data[k] = '';
  return data;
}

// 先頭の --- ... --- を分けて読む
function parseDoc(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  return { data: parseYaml(m[1]), body: m[2] };
}

// 先頭部分の「key: 値」1行だけを書き換える（無ければ足す）。コメントは残す
// 1行の値として安全な形にする（# や記号で始まる値は引用符で囲む）
function scalar(value) {
  const clean = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  return /(^|\s)#/.test(clean) || /^[\[{'"&*!|>%@`]/.test(clean) || /:\s/.test(clean) ? `"${clean.replace(/"/g, "'")}"` : clean;
}

function setScalar(text, key, value) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const clean = scalar(value);
  const lines = m[1].split(/\r?\n/);
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':');
  let done = false;
  const out = lines.map(l => {
    if (done || !re.test(l)) return l;
    done = true;
    const comment = (l.match(/\s+#.*$/) || [''])[0];
    return `${key}: ${clean}${comment}`;
  });
  if (!done) out.push(`${key}: ${clean}`);
  return text.replace(m[1], () => out.join('\n'));
}

module.exports = { parseYaml, parseDoc, setScalar, parseValue, scalar };
