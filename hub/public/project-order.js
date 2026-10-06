'use strict';
// 画面とサーバーで同じ親の解決・表示順を使う（入力配列は変えない）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectOrder = factory();
})(globalThis, function () {
  function source(item, all) {
    const ref = item.derivedFrom;
    return ref && (all.find(x => x.id === ref) || (all.filter(x => x.name === ref).length === 1 ? all.find(x => x.name === ref) : null));
  }
  function taskTarget(p, t, projects = [p]) {
    if (!t) return null;
    if (t.kind !== 'derived') {
      const task = p.tasks.find(x => x.id === t.parent && x.id !== t.id);
      return task ? { project: p, task } : null;
    }
    const ref = t.derivedFrom || '', slash = ref.indexOf('/');
    const project = projects.find(x => x.id === (slash < 0 ? p.id : ref.slice(0, slash)));
    const task = project?.tasks.find(x => x.id === (slash < 0 ? ref : ref.slice(slash + 1)));
    return task && !(project.id === p.id && task.id === t.id) ? { project, task } : null;
  }
  function taskItems(p) {
    const parent = (t, seen = new Set()) => {
      if (seen.has(t.id)) return '';
      seen.add(t.id);
      const target = taskTarget(p, t);
      return t.kind === 'derived' ? (target ? parent(target.task, seen) : '') : t.parent || '';
    };
    return p.tasks.map(t => ({ ...t, parent: parent(t), sourceParent: t.parent }));
  }
  function finished(t) { return Boolean(t && (t.state === '完了' || t.completionPending || t.steps?.length && t.steps.every(s => s.done))); }
  function ancestorsOf(p, t, projects = [p]) {
    const result = [], seen = new Set([p.id + '\0' + t.id]);
    let next = taskTarget(p, t, projects);
    while (next) {
      const key = next.project.id + '\0' + next.task.id;
      if (seen.has(key)) return []; // 壊れた循環を認可に使わない。
      seen.add(key); result.push(next);
      next = taskTarget(next.project, next.task, projects);
    }
    return result;
  }
  function integrators(p, t, projects = [p]) {
    const all = ancestorsOf(p, t, projects), result = [];
    for (const a of all) {
      result.push(a);
      if (!finished(a.task)) return result;
    }
    return []; // 全祖先が完了している時は従来の取り込みを許す。
  }
  function canIntegrate(a, p, t, projects = [p]) {
    return integrators(p, t, projects).some(x => x.project.id === a.project.id && x.task.id === a.task.id);
  }
  function displayParent(item, all) {
    const resolve = ref => !ref ? null : all.find(x => x.id === ref) || (all.filter(x => x.name === ref).length === 1 ? all.find(x => x.name === ref) : null);
    // 分岐の所属は元と同じ段。循環・孤立参照は最上位へ安全に出す。
    const ownParent = (x, seen = new Set()) => {
      if (seen.has(x.id)) return ''; seen.add(x.id);
      const src = source(x, all);
      return src ? ownParent(src, seen) : resolve(x.parent)?.id || '';
    };
    const first = ownParent(item); let id = first; const seen = new Set([item.id]);
    while (id) { if (seen.has(id)) return ''; seen.add(id); id = ownParent(resolve(id)); }
    return first;
  }
  function ordered(items, saved = []) {
    const rank = new Map(saved.map((id, i) => [id, i]));
    return items.slice().sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : -1) - (rank.has(b.id) ? rank.get(b.id) : -1));
  }
  function siblings(all, parent, groups = {}, pins = []) {
    const pinned = new Set(pins);
    const partition = items => [...items.filter(p => pinned.has(p.id)), ...items.filter(p => !pinned.has(p.id))];
    const saved = Object.hasOwn(groups, parent) ? groups[parent] : [];
    const items = ordered(all.filter(p => displayParent(p, all) === parent), saved);
    if (!Object.hasOwn(groups, parent)) return partition(nearSources(items));
    // 保存済み項目の相対順は動かさず、未配置の分岐だけを元の直後へ。
    const fixed = new Set(saved), result = [], seen = new Set();
    const add = item => {
      if (seen.has(item.id)) return; seen.add(item.id); result.push(item);
      for (const child of items.filter(x => !fixed.has(x.id) && source(x, items)?.id === item.id)) add(child);
    };
    items.filter(x => fixed.has(x.id) || !source(x, items)).forEach(add);
    items.forEach(add); // 循環参照も落とさず表示する。
    return partition(result);
  }
  function nearSources(items) {
    const result = [], seen = new Set();
    const add = item => {
      if (seen.has(item.id)) return; seen.add(item.id); result.push(item);
      for (const child of items.filter(x => source(x, items)?.id === item.id)) add(child);
    };
    items.filter(x => !source(x, items)).forEach(add); items.forEach(add);
    return result;
  }
  function moved(before, from, to, after) {
    if (from === to || !before.includes(from) || !before.includes(to)) return before.slice();
    const result = before.filter(id => id !== from);
    result.splice(result.indexOf(to) + (after ? 1 : 0), 0, from);
    return result;
  }
  return { displayParent, ordered, siblings, moved, source, taskTarget, taskItems, nearSources, finished, ancestorsOf, integrators, canIntegrate };
});
