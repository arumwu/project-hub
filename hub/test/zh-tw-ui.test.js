'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');
const source = name => fs.readFileSync(path.join(publicDir, name), 'utf8');
const kana = /[\u3041-\u3096\u30a1-\u30fa]/u;
function locale(language) {
  const context = vm.createContext({ HUB_LOCALE: language ? { locale: language } : undefined });
  vm.runInContext(source('locale.js'), context);
  return context.HubI18n;
}
function app() {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false,
      addEventListener() {}, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { contains() { return false; }, toggle() {} } });
    return elements.get(key);
  };
  const document = { documentElement: {}, hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ HUB_LOCALE: { locale: 'zh-TW' }, document, window: {}, navigator: { userAgent: '' },
    localStorage: { getItem() { return null; }, setItem() {} }, fetch: () => new Promise(() => {}),
    EventSource: class { close() {} }, URLSearchParams, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    requestAnimationFrame: fn => fn(), console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order') });
  vm.runInContext(source('locale.js'), context);
  vm.runInContext(source('app.js'), context);
  const snapshot = {
    root: '/資料/プロジェクト', projects: [{ id: 'p', name: 'プロジェクトの原名', status: '進行中', parent: '',
      description: 'そのまま残す説明', updated: '', phases: [], folders: [], related: [], issues: [], chats: [],
      tasks: [{ id: 't', title: 'ユーザーの作業名', state: '返事待ち', owner: 'codex', role: 'コーディング', model: 'GPT-6.1-Sol',
        effort: '極高', phase: '', steps: [], skills: [], question: 'どちらにしますか？', next: '', copy: false }] }],
    roles: { models: { codex: ['GPT-6.1-Sol'], 'claude-code': ['Opus 5.5'] }, roles: [
      { name: 'コーディング', job: 'プログラムを書く', main: { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' }, backup: { ai: '人' } }
    ], permissions: {}, agents: [] }, sessions: [], chatting: [], terminal: true, efforts: ['中', '高', '極高'], cliFlags: {}, version: '1', latest: '1'
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot) + '; view = {kind:"work",project:"p",task:"t"}', context);
  return { context, element, snapshot, run: code => vm.runInContext(code, context) };
}

test('Japanese is the default; Traditional Chinese catalog covers UI and contains no untranslated prose', () => {
  const ja = locale(), zh = locale('zh-TW');
  assert.equal(ja.locale, 'ja'); assert.equal(ja.text('あなたの番'), 'あなたの番');
  assert.equal(zh.text('あなたの番'), '輪到您'); assert.equal(zh.dateLocale, 'zh-TW');
  assert.ok(Object.keys(zh.messages).length >= 950);
  for (const [original, translated] of Object.entries(zh.messages)) {
    // The example is a real relative path: filenames retain their original spelling.
    if (original === '資料/調査.txt&#10;body:src/app.js') continue;
    assert.ok(!kana.test(translated), 'untranslated catalog prose: ' + original);
  }
});

test('Every explicitly marked UI string literal resolves to Traditional Chinese', () => {
  const zh = locale('zh-TW');
  let checked = 0;
  for (const name of fs.readdirSync(publicDir).filter(name => name.endsWith('.js') && name !== 'locale.js')) {
    const text = source(name);
    const literal = /UI\.(text|html)\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\)/g;
    for (const match of text.matchAll(literal)) {
      const value = vm.runInNewContext(match[2]);
      const translated = zh[match[1]](value);
      assert.ok(!kana.test(translated), name + ': missing UI translation: ' + value);
      checked++;
    }
  }
  assert.ok(checked > 400);
});

test('Template interpolation and machine attributes stay opaque while UI text and accessible labels translate', () => {
  const zh = locale('zh-TW'), original = '作業中 &lt;ユーザー原文&gt;';
  const html = zh.template`<button data-state="進行中" value="完了" class="s-返事待ち" title="作業中">あなたへの質問：${original}</button>`;
  assert.match(html, /title="作業中"/); // Same spelling in both languages.
  assert.match(html, />給您的問題：作業中 &lt;ユーザー原文&gt;<\/button>/);
  assert.match(html, /data-state="進行中" value="完了" class="s-返事待ち"/);
  const dynamic = zh.template`<p>子作業「${'まだ続ける'}」の成果と統合内容を確認します</p>`;
  assert.match(dynamic, /まだ続ける/);
  assert.doesNotMatch(dynamic, /繼續作業/);
  assert.equal(zh.label('まだ続ける'), 'まだ続ける'); // A custom role or folder name is user content.
  assert.equal(zh.valueAttribute('返事待ち'), ' value="返事待ち"');
  assert.equal(zh.valueAttribute('"<&'), ' value="&quot;&lt;&amp;"');
  assert.equal(locale().valueAttribute('返事待ち'), '');
});

test('Work, project and settings views localize labels without changing saved state, roles, effort or user content', () => {
  const a = app(), before = a.run('JSON.stringify(state)');
  a.run('renderWork()');
  const work = a.element('#main').innerHTML;
  assert.match(work, /給您的問題/); assert.match(work, /等待回覆/); assert.match(work, /程式設計/);
  assert.match(work, /value="返事待ち"[^>]*>等待回覆<\/option>/);
  assert.match(work, /value="極高"[^>]*>極高<\/option>/);
  assert.match(work, /ユーザーの作業名/); assert.match(work, /どちらにしますか？/);
  assert.match(work, /s-返事待ち/);
  a.run('renderOverview(proj("p"))');
  assert.match(a.element('#main').innerHTML, /プロジェクトの原名/);
  assert.match(a.element('#main').innerHTML, /そのまま残す説明/);
  assert.match(a.element('#main').innerHTML, /新增作業/);
  assert.match(a.element('#main').innerHTML, /value="コーディング">程式設計<\/option>/);
  a.run('renderSettings()');
  assert.match(a.element('#main').innerHTML, /角色分工/);
  assert.match(a.element('#main').innerHTML, /撰寫程式/);
  assert.match(a.element('#main').innerHTML, /value="人"[^>]*>您<\/option>/);
  assert.equal(a.run('JSON.stringify(state)'), before);
  const ai = a.run('msgHtml({role:"assistant",ai:"codex",text:"まだ続ける <script>原文</script>",at:"2026-10-07T00:00:00Z"})');
  assert.match(ai, /まだ続ける/); assert.match(ai, /&lt;script&gt;原文&lt;\/script&gt;/);
  assert.doesNotMatch(ai, /<script>/);
});

test('Initial markup loads locale synchronously and marks only its own UI for translation', () => {
  const index = source('index.html');
  assert.ok(index.indexOf('src="locale-config.js"') < index.indexOf('src="locale.js"'));
  assert.ok(index.indexOf('src="locale.js"') < index.indexOf('src="mobile.js"'));
  assert.ok(index.indexOf('src="locale.js"') < index.indexOf('src="app.js"'));
  assert.match(index, /id="turn"[^>]*data-ui/);
  assert.match(index, /id="usage-title"[^>]*data-ui/);
  assert.doesNotMatch(source('locale.js'), /MutationObserver|prototype\.(?:innerHTML|textContent)/);
});

test('CSS drag hints follow the document language and retain Japanese defaults', () => {
  const css = source('app.css');
  for (const selector of ['pane', 'chat', 'view']) assert.match(css, new RegExp('html\\[lang="zh-TW"\\] \\.' + selector + '\\.dropping::after\\{content:"[^"\\u3041-\\u3096\\u30a1-\\u30fa]+"\\}'));
  assert.match(css, /content:"ここに落とすと渡します"/);
});
