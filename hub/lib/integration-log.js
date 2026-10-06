'use strict';
const fs = require('node:fs');

// 一覧表示の件数制限とは分け、保持中のログから最新の成功記録を探す。
// 現行ログを読めない場合は、より古い記録を最新とみなさない。
function lastMerge(file, project, task) {
  for (const source of [file, file.replace(/\.jsonl$/, '.old.jsonl')]) {
    let lines;
    try { lines = fs.readFileSync(source, 'utf8').trim().split('\n'); }
    catch (e) { if (e.code === 'ENOENT') continue; return null; }
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row?.action === 'merge' && row.ok && row.project === project && row.task === task) return row;
    }
  }
  return null;
}
module.exports = { lastMerge };
