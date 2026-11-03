'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { listProjectThreads, groupThreads, installCodexProjects } = require('../projects');
function server(pages, requests) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => queueMicrotask(() => child.emit('close'));
  child.stdin = { end() {}, write(line) {
    const request = JSON.parse(line); requests.push(request);
    if (request.id == null) return;
    const result = request.method === 'initialize' ? {} : pages.shift();
    queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, result }) + '\n')));
  } }; return child;
}
test('thread list is paginated and workspace scoped, returning title metadata only', async () => {
  const requests = [];
  const pages = [{ data: [{ id: 'thread-1', name: 'Chat one', cwd: 'F:/project', preview: 'private transcript', turns: ['secret'] }], nextCursor: 'next' }, { data: [{ id: 'thread-2', name: 'Chat two', cwd: 'F:/project' }, { id: '../bad' }], nextCursor: null }];
  const value = await listProjectThreads('fake', ['F:/project'], { spawn: () => server(pages, requests) });
  assert.equal(value.threads.length, 2);
  assert.ok(!JSON.stringify(value).includes('private transcript'));
  assert.ok(!JSON.stringify(value).includes('secret'));
  assert.ok(requests.every(request => ['initialize', 'initialized', 'thread/list'].includes(request.method)));
  const lists = requests.filter(request => request.method === 'thread/list');
  assert.deepEqual(lists[0].params.cwd, ['F:/project']); assert.equal(lists[1].params.cursor, 'next');
});
test('grouping keeps separate folder identities with the same basename', () => {
  const groups = groupThreads([{ id: 'a', name: 'A', cwd: 'F:/one/repo', updatedAt: 1 }, { id: 'b', name: 'B', cwd: 'F:/two/repo', updatedAt: 2 }, { id: 'c', name: 'C', cwd: '', updatedAt: 3 }]);
  assert.equal(groups.length, 3); assert.equal(groups[0].name, 'No project folder');
  assert.equal(groups[1].name, 'repo'); assert.notEqual(groups[1].cwd, groups[2].cwd);
});
test('project tree opens only a listed chat through the official extension URI and defaults to current workspace', async () => {
  const commands = new Map(), opened = [], focused = [], noop = () => ({ dispose() {} }); let provider, selectedFolders;
  const view = { visible: false, onDidChangeVisibility: noop, dispose() {} };
  const vscode = { EventEmitter: class { constructor() { this.event = noop; } fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } }, TreeItemCollapsibleState: { Expanded: 2, None: 0 }, ThemeIcon: class {},
    Uri: { from: value => value }, env: { uriScheme: 'antigravity-ide', asExternalUri: async uri => uri, openExternal: async uri => { opened.push(uri); return true; } },
    window: { createTreeView: (_, options) => { provider = options.treeDataProvider; return view; } },
    workspace: { workspaceFolders: [{ uri: { fsPath: 'F:/project' } }], getConfiguration: () => ({ get: (_, fallback) => fallback }), onDidChangeConfiguration: noop },
    commands: { executeCommand: async name => { focused.push(name); }, registerCommand: (name, fn) => { commands.set(name, fn); return noop(); } } };
  const context = { subscriptions: [] };
  installCodexProjects(vscode, context, { executable: 'fake', list: async (_, folders) => { selectedFolders = folders; return { threads: [{ id: 'thread-1', name: 'Chat one', cwd: 'F:/project' }], truncated: false }; } });
  try {
    await commands.get('codexProjects.open')(); assert.deepEqual(focused, ['codexProjects.chats.focus']);
    assert.deepEqual(selectedFolders, ['F:/project']);
    const group = provider.getChildren()[0]; assert.equal(group.name, 'project');
    const chat = provider.getChildren(group)[0]; assert.equal(provider.getTreeItem(chat).command.command, 'codexProjects.openChat');
    await commands.get('codexProjects.openChat')(chat);
    assert.deepEqual(opened[0], { scheme: 'antigravity-ide', authority: 'openai.chatgpt', path: '/local/thread-1' });
    await commands.get('codexProjects.openChat')({ id: 'unlisted' }); assert.equal(opened.length, 1);
  } finally { context.subscriptions.forEach(item => item.dispose()); }
});
