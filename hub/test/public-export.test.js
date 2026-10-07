'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { excluded, inspect } = require('../../scripts/export-public');
test('both template languages and fictional seeds are inspected by the public exporter', () => {
  for (const file of ['docs/project-hub/templates/project/.ai/README.md','docs/project-hub/templates/zh-TW/project/.ai/README.md','docs/project-hub/templates/zh-TW/_hub/roles.yaml','hub/seed-zh-TW/範例應用程式/.ai/tasks/1.md']) {
    assert.equal(excluded(file), false, file);
    assert.throws(() => inspect([{name:file,content:Buffer.from('-----BEGIN '+'PRIVATE KEY-----')}]), /private key/);
  }
  for (const file of ['hub/seed-zh-TW/範例應用程式/.ai/chat/private.md','docs/project-hub/templates/zh-TW/_hub/state.log','hub/personal/.ai/tasks/private.md','hub/personal/_hub/config.json']) assert.equal(excluded(file), true, file);
});
