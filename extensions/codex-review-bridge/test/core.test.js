const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeFile, readBatch } = require('../core');
test('blocks traversal, absolute paths and junctions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-path-'));
  try {
    for (const name of ['../outside', '/outside', 'C:/outside', 'dir\\file', 'a/../b']) assert.throws(() => safeFile(root, name));
    fs.mkdirSync(path.join(root, 'target'));
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => safeFile(root, 'link/file'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('captures modifications, additions, deletions; excludes unchanged and detects tampering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-batch-'));
  const cli = path.resolve(__dirname, '../batch.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(root, 'modified.txt'), 'old');
    fs.writeFileSync(path.join(root, 'deleted.txt'), 'delete');
    fs.writeFileSync(path.join(root, 'same.txt'), 'same');
    run('begin', root, 'test', 'Demo', 'modified.txt', 'added.txt', 'deleted.txt', 'same.txt');
    fs.writeFileSync(path.join(root, 'modified.txt'), 'ใหม่\n');
    fs.writeFileSync(path.join(root, 'added.txt'), 'new');
    fs.unlinkSync(path.join(root, 'deleted.txt'));
    run('publish', root, 'test');
    const relative = '.codex-review/batches/test/manifest.json';
    const batch = readBatch(root, relative);
    assert.equal(batch.files.length, 3);
    assert.equal(batch.files[1].before, null);
    assert.equal(batch.files[2].after, null);
    fs.writeFileSync(path.join(root, batch.files[0].after.snapshot), 'tampered');
    assert.throws(() => readBatch(root, relative), /hash mismatch/);
    assert.throws(() => run('begin', root, 'escape', 'Unsafe', '../outside'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
