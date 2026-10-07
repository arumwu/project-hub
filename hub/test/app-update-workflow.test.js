'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAutomation, safe } = require('../lib/app-update-workflow');
function fixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, '_hub/updates/job/source'); fs.mkdirSync(stage, { recursive: true });
  const calls = [], sha = 'a'.repeat(40), url = 'https://github.com/kieiken/project-hub/pull/123'; let lists = 0;
  const env = { HUB_AUTO_TRANSLATE: '1', HUB_TRANSLATION_FORK: 'fixture/project-hub', HUB_TRANSLATION_BRANCH: 'feat/zh-tw', HUB_STORAGE_GUARD: '/fixture/guard', CODEX_HOME: '/fixture/login', GH_TOKEN: 'private-token', API_KEY: 'private-key' };
  const run = async (file, args, options) => {
    calls.push({ file, args, options }); let stdout = '';
    if (file === env.HUB_STORAGE_GUARD) stdout = 'STATUS=OK';
    else if (file === 'codex') {
      assert.equal(options.env.GH_TOKEN, undefined); assert.equal(options.env.API_KEY, undefined); assert.equal(options.env.CODEX_HOME, env.CODEX_HOME);
      assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ephemeral')); assert.ok(args.includes('workspace-write')); assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
      assert.deepEqual(args.slice(0, 2), ['-a','never']); assert.equal(options.cwd, stage);
      fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ completed: opts.completed !== false, summary: '繁中完成', unresolved: [] }));
    } else if (file === 'git') {
      if (args[0] === 'status') stdout = opts.dirty ? ' M hub/server.js\n' : '';
      else if (args[0] === 'ls-files') stdout = opts.private ? '.env\0' : 'hub/locales/zh-TW.json\0';
      else if (args[0] === 'diff' && args.includes('--name-only')) stdout = opts.private ? '.env\0' : 'hub/public/app.js\0';
      else if (args[0] === 'rev-parse') stdout = sha;
    } else if (file === 'gh') {
      if (args[0] === 'api') stdout = JSON.stringify({ private: false, parent: { full_name: opts.wrongFork ? 'other/project' : 'kieiken/project-hub' } });
      else if (args[1] === 'list') {
        lists++; stdout = JSON.stringify(lists === 1 && !opts.existing ? [] : [{ number: 123, url, baseRefName: opts.wrongBase ? 'dev' : 'main', headRefOid: opts.wrongHead ? 'b'.repeat(40) : sha }]);
      }
    }
    return { stdout, stderr: '', code: 0 };
  };
  return { root, stage, calls, url, auto: createAutomation({ root, env, run }) };
}
test('translation uses bounded Codex settings, removes token env, and stages all public changes exactly', async t => {
  const f = fixture(t); assert.equal((await f.auto.translate(f.stage)).translated, true);
  const add = f.calls.find(x => x.file === 'git' && x.args[0] === 'add');
  assert.deepEqual(add.args, ['add','--','hub/public/app.js','hub/locales/zh-TW.json']);
});
test('incomplete translation and non-public changes cannot be staged or published', async t => {
  for (const opts of [{completed:false}, {private:true}]) {
    const f = fixture(t, opts); await assert.rejects(f.auto.translate(f.stage));
    assert.equal(f.calls.some(x => x.args[0] === 'add' || x.args[0] === 'push'), false);
  }
});
test('validation checks committed public source before installing', async t => {
  const f = fixture(t); assert.equal((await f.auto.validate(f.stage)).verified, true);
  assert.ok(f.calls.some(x => x.args[0] === 'scripts/export-public.js'));
  for (const opts of [{dirty:true}, {private:true}]) { const g = fixture(t, opts); await assert.rejects(g.auto.validate(g.stage)); }
});
test('source outside the isolated update root is rejected before running Codex', async t => {
  const f = fixture(t); await assert.rejects(f.auto.translate(f.root)); assert.equal(f.calls.some(x => x.file === 'codex'), false);
});
test('publisher verifies authorized fork and main PR before pushing; verifies the tested commit after creation', async t => {
  const f = fixture(t); assert.deepEqual(await f.auto.publish(f.stage), {prUrl:f.url});
  assert.ok(f.calls.some(x => x.file === 'git' && x.args[0] === 'push' && x.args[2] === 'HEAD:refs/heads/feat/zh-tw'));
  for (const opts of [{wrongFork:true}, {wrongBase:true,existing:true}]) {
    const g = fixture(t, opts); await assert.rejects(g.auto.publish(g.stage)); assert.equal(g.calls.some(x => x.args[0] === 'push'),false);
  }
  const h = fixture(t, {wrongHead:true}); await assert.rejects(h.auto.publish(h.stage), /readback/);
});
test('public path boundaries reject prefix lookalikes, credentials, user records, and traversal', () => {
  for (const file of ['README.md.secret','hub/.env','hub/node_modules/foo.js','hub/.ai/chat/notes.md','hub/private.key','../hub/app.js']) assert.equal(safe(file),false,file);
  assert.equal(safe('hub/locales/zh-TW.json'),true); assert.equal(safe('docs/project-hub/templates/zh-TW/project/PROJECT.md'),true);
});
