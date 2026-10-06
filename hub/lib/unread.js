'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 一覧が空でもアクセス権限エラーの可能性がある。不存在を確認できた通知だけ消す。
function removeMissing(items, product, stat = fs.statSync) {
  let changed = false;
  for (const key of items) {
    const parts = key.split('\u0000'), [project, task] = parts;
    const safe = value => value && value !== '.' && value !== '..' && !/[\/\\\\\u0000]/.test(value);
    let missing = parts.length !== 2 || !safe(project) || !safe(task);
    if (!missing) {
      try {
        stat(path.join(product, project, 'PROJECT.md'));
        stat(path.join(product, project, '.ai', 'tasks', task + '.md'));
      } catch (e) {
        missing = e.code === 'ENOENT' || e.code === 'ENOTDIR';
      }
    }
    if (missing) { items.delete(key); changed = true; }
  }
  return changed;
}
module.exports = { removeMissing };
