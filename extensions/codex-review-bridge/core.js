'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LIMIT = 2 * 1024 * 1024;
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe relative path');
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  let cursor = target;
  while (cursor !== base) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Symlink/junction is not permitted');
    const parent = path.dirname(cursor);
    if (parent === cursor) throw Error('Path escapes workspace');
    cursor = parent;
  }
  return target;
}
function text(bytes) {
  if (bytes.length > LIMIT || bytes.includes(0)) throw Error('Only text files up to 2 MiB are supported');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function readBatch(root, relative) {
  const filename = safeFile(root, relative);
  const metadata = fs.readFileSync(filename);
  if (metadata.length > LIMIT) throw Error('Batch manifest too large');
  const batch = JSON.parse(metadata.toString('utf8'));
  if (batch.schema !== 1 || typeof batch.title !== 'string' || !Array.isArray(batch.files) || batch.files.length > 200) throw Error('Invalid batch manifest');
  const seen = new Set();
  for (const file of batch.files) {
    safeFile(root, file.path);
    if (seen.has(file.path)) throw Error('Duplicate file');
    seen.add(file.path);
    for (const side of ['before', 'after']) {
      if (file[side] === null) continue;
      if (!file[side] || typeof file[side].sha256 !== 'string') throw Error('Invalid snapshot');
      // Snapshots must stay beside the manifest, not point at arbitrary workspace files.
      const prefix = relative.slice(0, relative.lastIndexOf('/') + 1);
      if (!file[side].snapshot.startsWith(prefix + 'snapshots/')) throw Error('Snapshot outside batch');
      const bytes = fs.readFileSync(safeFile(root, file[side].snapshot));
      if (hash(bytes) !== file[side].sha256) throw Error('Snapshot hash mismatch');
      text(bytes);
    }
    if (file.before === null && file.after === null) throw Error('Empty change');
  }
  return batch;
}
module.exports = { safeFile, hash, text, readBatch, LIMIT };
