'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trashRootFor, volumeRoot } = require('../lib/trash');
const home = '/Users/example/.Trash';
const stat = file => ({ dev: file === '/Volumes/Data' || file.startsWith('/Volumes/Data/') ? 2 : 1, isDirectory: () => !file.endsWith('.txt') });
const directory = { isDirectory: () => true, isSymbolicLink: () => false };
const options = { platform: 'darwin', homeTrash: home, uid: 501, stat, lstat: () => directory };

test('external-volume deletion chooses that volume Finder Trash, preserving atomic rename', () => {
  assert.equal(volumeRoot('/Volumes/Data/Product/file.txt', stat), '/Volumes/Data');
  assert.equal(trashRootFor('/Volumes/Data/Product/file.txt', home, options), '/Volumes/Data/.Trashes/501');
});
test('internal-volume deletion and explicitly selected trash roots retain their location', () => {
  assert.equal(trashRootFor('/Users/example/Product/file.txt', home, options), home);
  assert.equal(trashRootFor('/Volumes/Data/Product/file.txt', '/Volumes/CustomTrash', options), '/Volumes/CustomTrash');
});
test('native volume Trash containers and user directories cannot be symlink redirects', () => {
  assert.throws(() => trashRootFor('/Volumes/Data/Product/file.txt', home, { ...options, lstat: () => ({ ...directory, isSymbolicLink: () => true }) }));
  assert.throws(() => trashRootFor('/Volumes/Data/Product/file.txt', home, { ...options, lstat: file => file.endsWith('/501') ? { ...directory, isSymbolicLink: () => true } : directory }));
});
test('non-macOS custom directory fixtures preserve existing behaviour', () => {
  assert.equal(trashRootFor('/Volumes/Data/Product/file.txt', home, { ...options, platform: 'linux' }), home);
});
