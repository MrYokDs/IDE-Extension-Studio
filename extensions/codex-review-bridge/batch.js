#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safeFile, hash, text } = require('./core');
const [command, rootArg, id, ...args] = process.argv.slice(2);
try {
  if (!['begin', 'publish'].includes(command) || !rootArg || !/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw Error('Usage: node batch.js begin ROOT ID TITLE FILE... | publish ROOT ID');
  const root = fs.realpathSync(rootArg);
  const base = `.codex-review/batches/${id}`;
  const statePath = `${base}/pending.json`;
  function capture(file, index, side) {
    const target = safeFile(root, file);
    if (!fs.existsSync(target)) return null;
    const bytes = fs.readFileSync(target);
    text(bytes);
    const snapshot = `${base}/snapshots/${index}-${side}.txt`;
    fs.writeFileSync(safeFile(root, snapshot), bytes, { flag: 'wx' });
    return { snapshot, sha256: hash(bytes) };
  }
  if (command === 'begin') {
    const [title, ...files] = args;
    if (!title || !files.length || files.length > 200 || new Set(files).size !== files.length) throw Error('Supply title and 1–200 unique relative text file paths');
    for (const file of files) {
      if (file.startsWith('.codex-review/')) throw Error('Cannot review bridge storage');
      safeFile(root, file);
    }
    if (fs.existsSync(safeFile(root, base))) throw Error('Batch ID already exists');
    fs.mkdirSync(safeFile(root, `${base}/snapshots`), { recursive: true });
    const state = { schema: 1, title, files: files.map((file, i) => ({ path: file, before: capture(file, i, 'before') })) };
    fs.writeFileSync(safeFile(root, statePath), JSON.stringify(state, null, 2), { flag: 'wx' });
    console.log(`Captured before snapshots: ${id}`);
  } else {
    const state = JSON.parse(fs.readFileSync(safeFile(root, statePath), 'utf8'));
    const files = state.files.map((file, i) => ({ ...file, after: capture(file.path, i, 'after') })).filter(file => file.before?.sha256 !== file.after?.sha256 || (file.before === null) !== (file.after === null));
    const manifest = { schema: 1, title: state.title, createdUtc: new Date().toISOString(), files };
    const temporary = safeFile(root, `${base}/manifest.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, safeFile(root, `${base}/manifest.json`));
    console.log(`Published ${files.length} changed files: ${id}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
