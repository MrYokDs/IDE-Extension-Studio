const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
test('activation discovers published batches and requests an immutable native diff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-editor-'));
  const cli = path.resolve(__dirname, '../batch.js');
  const commands = new Map();
  const calls = [];
  let contentProvider;
  let rows;
  const noop = () => ({ dispose() {} });
  try {
    fs.writeFileSync(path.join(root, 'deleted.txt'), 'deleted old file');
    execFileSync(process.execPath, [cli, 'begin', root, 'demo', 'Test batch', 'deleted.txt', 'demo.txt', 'second.txt', 'third.txt']);
    fs.unlinkSync(path.join(root, 'deleted.txt'));
    fs.writeFileSync(path.join(root, 'demo.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'second.txt'), 'second');
    fs.writeFileSync(path.join(root, 'third.txt'), 'third');
    execFileSync(process.execPath, [cli, 'publish', root, 'demo']);
    const mock = {
      EventEmitter: class { constructor() { this.event = noop; } fire() {} dispose() {} },
      TreeItem: class { constructor(label) { this.label = label; } },
      TreeItemCollapsibleState: { Expanded: 2 },
      Uri: { from: parts => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }), joinPath: (_, ...parts) => ({ toString: () => `file:///${parts.join('/')}` }) },
      window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), createStatusBarItem: () => ({ show() {}, dispose() {} }), registerTreeDataProvider: (id, p) => { if (id === 'codexReview.changes') rows = p; return noop(); }, showInformationMessage: async () => {}, showQuickPick: async () => undefined, showInputBox: async () => undefined, createWebviewPanel: () => ({ webview: {}, dispose() {} }), showErrorMessage: message => { throw Error(message); } },
      workspace: {
        isTrusted: true, findFiles: async () => [{ scheme: 'file' }],
        getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
        asRelativePath: () => '.codex-review/batches/demo/manifest.json',
        getConfiguration: () => ({ get: () => true }),
        registerTextDocumentContentProvider: (_, p) => { contentProvider = p; return noop(); },
        createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} })
      },
      commands: { registerCommand: (name, fn) => { commands.set(name, fn); return noop(); }, executeCommand: async (...args) => calls.push(args) }
    };
    const sandbox = { require: name => name === './projects' ? { installCodexProjects() {} } : name === './antigravity-view' ? { installAntigravityView() {} } : name === './status-quota' ? require('../status-quota') : name === 'vscode' ? mock : name === './core' ? require('../core') : name === './usage' ? require('../usage') : name === './monthly-usage' ? require('../monthly-usage') : name === './dashboard-panel' ? require('../dashboard-panel') : require(name), module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval, console };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../extension.js'), 'utf8'), sandbox);
    sandbox.module.exports.activate({ subscriptions: [], workspaceState: { get: () => ['already-seen'], update: async () => {} } });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls[0][0], 'vscode.diff');
    assert.equal(contentProvider.provideTextDocumentContent(calls[0][1]), '');
    assert.equal(contentProvider.provideTextDocumentContent(calls[0][2]), 'hello');
    assert.equal(rows.getChildren()[0].files.length, 4);
    assert.equal(new Set(calls.map(call => call[2].toString())).size, 3);
    assert.ok(calls.every(call => !call[3].startsWith('deleted.txt')));
    assert.ok(calls.every(call => call[4].preview === false));
    assert.ok(calls.every(call => call[4].override === 'default'));
    assert.equal(calls.at(-1)[3], 'demo.txt');
    assert.deepEqual([...new Set(calls.map(call => call[3]))], ['demo.txt','second.txt','third.txt']);
    assert.equal(calls.at(-1)[4].preserveFocus, false);
    fs.writeFileSync(path.join(root, 'demo.txt'), 'user followup');
    await commands.get('codexReview.openLatest')();
    assert.equal(calls.at(-1)[3], 'demo.txt');
    assert.equal(fs.readFileSync(path.join(root, 'demo.txt'), 'utf8'), 'user followup');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
