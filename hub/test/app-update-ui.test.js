'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const uiLocale = require('./ui-locale-fixture');
const source = fs.readFileSync(path.join(__dirname, '../public/app-update.js'), 'utf8');
const snapshot = { enabled: false, sourceVersion: '4.68.2', latestVersion: '4.68.3', lastCheck: '2026-10-07T00:00:00Z', nextCheck: '2026-10-08T00:00:00Z', phase: 'idle', pending: false, error: '', supported: true, autoTranslate: true, publishEnabled: true };
function fixture(locale = 'ja') {
  const elements = new Map(), handlers = new Map(), calls = [], timers = [];
  const element = key => { if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', disabled: false }); return elements.get(key); };
  const context = vm.createContext({ HubI18n: uiLocale(locale), $: element, esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])),
    api: async (route, body) => { calls.push({ route, body }); return { ...snapshot }; },
    view: { kind: 'settings' }, document: { hidden: false, addEventListener(name, fn) { handlers.set(name, fn); } },
    setInterval(fn) { timers.push(fn); }, location: { reload() { throw Error('must not reload'); } } });
  vm.runInContext(source, context);
  return { context, calls, timers, handlers, element, elements, run: code => vm.runInContext(code, context) };
}
test('App update card is bilingual and distinguishes daily checking, translation, test, install and PR state', () => {
  for (const [locale, expected] of [['ja', 'Project Hub を自動で更新する'], ['zh-TW', '自動更新 Project Hub']]) {
    const f = fixture(locale), data = { ...snapshot, enabled: true, pending: true, phase: 'deferred', prUrl: 'https://github.com/kieiken/project-hub/pull/5' };
    const html = f.context.appUpdateHtml(data);
    assert.ok(html.includes(expected)); assert.match(html, /4\.68\.2/); assert.match(html, /4\.68\.3/);
    assert.match(html, /kieiken\/project-hub/); assert.match(html, /data-url="https:\/\/github.com\/kieiken\/project-hub\/pull\/5"/);
    if (locale === 'zh-TW') { assert.match(html, /每天檢查一次/); assert.match(html, /等待作業結束/); assert.match(html, /繁體中文/); assert.match(html, /測試通過/); assert.match(html, /查看翻譯 PR/); assert.doesNotMatch(html, /[ぁ-んァ-ヶ]/); }
  }
  const f = fixture('zh-TW');
  for (const phase of ['translating', 'testing', 'building', 'verifying', 'publishing']) {
    const html = f.context.appUpdateHtml({ ...snapshot, phase });
    assert.match(html, /id="app-update-check"[^>]*disabled/);
  }
  const html = f.context.appUpdateHtml({ ...snapshot, error: '<script>error</script>', publishError: '<b>publish failed</b>' });
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;b&gt;/); assert.doesNotMatch(html, /<script>|<b>publish failed/);
});
test('Toggle saves one explicit boolean, prevents duplicate writes and restores the previous setting on failure', async () => {
  const f = fixture(); await f.context.loadAppUpdate(); f.calls.length = 0;
  let release; f.context.api = (route, body) => { f.calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return new Promise(resolve => { release = resolve; }); };
  const pending = f.context.changeAppUpdate(true); await f.context.changeAppUpdate(false);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], { route: '/api/app-update', body: { enabled: true } });
  release({ ...snapshot, enabled: true }); await pending;
  assert.match(f.element('#app-update-box').innerHTML, /id="app-auto-update"[^>]*checked/);
  f.context.api = async () => { throw Error('save failed'); }; await f.context.changeAppUpdate(false);
  assert.match(f.element('#app-update-box').innerHTML, /id="app-auto-update"[^>]*checked/);
  assert.equal(f.element('#app-update-status').textContent, 'save failed');
});
test('Manual checking displays returned status and status polling never triggers another upstream check or reload', async () => {
  const f = fixture('zh-TW'); await f.context.loadAppUpdate(); f.calls.length = 0;
  f.context.api = async (route, body) => { f.calls.push({ route, body }); return { ...snapshot, phase: route.endsWith('/check') ? 'checking' : 'deferred', pending: true }; };
  await f.context.checkAppUpdate(); await f.context.checkAppUpdate();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].route, '/api/app-update/check');
  assert.equal(f.element('#app-update-status').textContent, '已顯示更新狀態');
  f.timers[0](); await new Promise(setImmediate);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].route, '/api/app-update'); assert.equal(f.calls[1].body, undefined);
  assert.match(f.element('#app-update-box').innerHTML, /等待作業結束/);
  f.context.document.hidden = true; f.timers[0](); assert.equal(f.calls.length, 2);
  f.context.document.hidden = false; f.context.view.kind = 'work'; f.timers[0](); assert.equal(f.calls.length, 2);
});
test('Unavailable update adapters disable mutation while stale status responses cannot replace a newer settings card', async () => {
  const f = fixture(); f.context.api = async () => ({ ...snapshot, supported: false }); await f.context.loadAppUpdate();
  assert.match(f.element('#app-update-box').innerHTML, /id="app-auto-update"[^>]*disabled/);
  assert.match(f.element('#app-update-box').innerHTML, /id="app-update-check"[^>]*disabled/);
  let writes = 0; f.context.api = async () => { writes++; return snapshot; };
  await f.context.changeAppUpdate(true); await f.context.checkAppUpdate(); assert.equal(writes, 0);
  let release; f.context.api = () => new Promise(resolve => { release = resolve; });
  const old = f.context.loadAppUpdate(), current = { innerHTML: 'new settings', textContent: '' }; f.elements.set('#app-update-box', current);
  release(snapshot); await old; assert.equal(current.innerHTML, 'new settings');
});
test('App update settings and module loading are distinct from AI CLI update controls', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(app, /id="app-update-box"/); assert.match(app, /loadAppUpdate/); assert.match(index, /src="app-update.js"/);
  assert.match(app, /id="ai-tools"/); assert.doesNotMatch(source, /location\.reload|window\.open|\/api\/ai-tools/);
});

test('A cached daily check displays stored status without claiming a new check started', async () => {
  const f=fixture('zh-TW'); await f.context.loadAppUpdate();
  f.context.api=async()=>({...snapshot,phase:'idle'}); await f.context.checkAppUpdate();
  assert.equal(f.element('#app-update-status').textContent,'已顯示更新狀態');
  assert.doesNotMatch(f.element('#app-update-status').textContent,/已開始/);
  assert.equal(f.run('appUpdateData.lastCheck'),snapshot.lastCheck);
});
