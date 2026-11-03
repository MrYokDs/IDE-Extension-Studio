'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { version } = require('./package.json');
const { resolveCodexExtensionExecutable } = require('./usage');
function listProjectThreads(executable, folders, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = (options.spawn || spawn)(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { return reject(new Error('Codex chat list process could not start')); }
    let buffer = '', finished = false, pages = 0, id = 1;
    const threads = new Map(), cursors = new Set();
    const timer = setTimeout(() => finish(new Error('Codex chat list timed out')), options.timeoutMs || 15000);
    function finish(error) {
      if (finished) return;
      finished = true; clearTimeout(timer); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve({ threads: [...threads.values()], truncated: pages >= 10 });
    }
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const list = cursor => send({ id: ++id, method: 'thread/list', params: { limit: 100, sortKey: 'updated_at', archived: false, useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'appServer', 'exec'], ...(folders?.length ? { cwd: folders } : {}), ...(cursor ? { cursor } : {}) } });
    child.on('error', () => finish(new Error('Codex chat list process unavailable')));
    child.on('close', () => { if (!finished) finish(new Error('Codex chat list process exited early')); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) return finish(new Error('Codex chat list response too large'));
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error) return finish(new Error('Codex chat metadata query failed'));
        if (id === 1) { send({ method: 'initialized' }); list(); continue; }
        pages++;
        for (const thread of (Array.isArray(message.result?.data) ? message.result.data : [])) {
          if (typeof thread.id !== 'string' || !/^[\w-]{1,128}$/.test(thread.id)) continue;
          threads.set(thread.id, { id: thread.id, name: typeof thread.name === 'string' && thread.name.trim() ? thread.name : 'Untitled chat', cwd: typeof thread.cwd === 'string' ? thread.cwd : '', updatedAt: Number(thread.updatedAt) || 0 });
        }
        const cursor = message.result?.nextCursor;
        if (typeof cursor !== 'string' || !cursor || pages >= 10 || cursors.has(cursor)) return finish();
        cursors.add(cursor); list(cursor);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'code_review_projects', title: 'Codex Projects', version } } });
  });
}
function groupThreads(threads) {
  const groups = new Map();
  for (const thread of threads) {
    const key = thread.cwd || '';
    if (!groups.has(key)) groups.set(key, { cwd: key, name: key ? path.win32.basename(key.replace(/\//g, '\\')) || key : 'No project folder', threads: [] });
    groups.get(key).threads.push(thread);
  }
  return [...groups.values()].map(group => ({ ...group, threads: group.threads.sort((a, b) => b.updatedAt - a.updatedAt) })).sort((a, b) => (b.threads[0]?.updatedAt || 0) - (a.threads[0]?.updatedAt || 0));
}
function installCodexProjects(vscode, context, options = {}) {
  const changed = new vscode.EventEmitter();
  let groups = [], view, pending = null, disposed = false, epoch = 0;
  const config = () => vscode.workspace.getConfiguration('codexProjects');
  const provider = { onDidChangeTreeData: changed.event,
    getChildren: item => item ? item.threads : groups,
    getTreeItem: item => {
      const row = new vscode.TreeItem(item.name, item.threads ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      if (item.threads) { row.description = `${item.threads.length} chats`; row.tooltip = item.cwd; row.iconPath = new vscode.ThemeIcon('folder'); }
      else { row.tooltip = item.cwd; row.iconPath = new vscode.ThemeIcon('comment-discussion'); row.command = { command: 'codexProjects.openChat', title: 'Open in Codex', arguments: [item] }; }
      return row;
    }
  };
  async function refresh() {
    if (disposed || !config().get('enabled', true)) return;
    if (pending) return pending;
    const current = epoch;
    const all = config().get('scope', 'workspace') === 'all';
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    if (!all && !folders.length) { groups = []; view.message = 'Open a project folder, or select All projects.'; changed.fire(); return; }
    view.message = 'Loading chat titles…';
    pending = (async () => {
      try {
        const result = await (options.list || listProjectThreads)(options.executable || resolveCodexExtensionExecutable(vscode.extensions), all ? null : folders);
        if (disposed || current !== epoch) return;
        groups = groupThreads(result.threads);
        view.message = `${all ? 'All projects' : 'Current workspace'}${result.truncated ? ' · first 1,000 chats' : ''}${groups.length ? '' : ' · no chats found'}`;
      } catch { if (disposed || current !== epoch) return; groups = []; view.message = 'Unable to list Codex chats. Confirm Codex is installed and signed in, then refresh.'; }
      changed.fire();
    })().finally(() => { pending = null; });
    return pending;
  }
  view = vscode.window.createTreeView('codexProjects.chats', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(changed, view,
    view.onDidChangeVisibility(event => { if (event.visible) refresh(); }),
    vscode.commands.registerCommand('codexProjects.refresh', refresh),
    vscode.commands.registerCommand('codexProjects.chooseScope', async () => {
      const pick = await vscode.window.showQuickPick([{ label: 'Current workspace', scope: 'workspace' }, { label: 'All projects', scope: 'all' }], { title: 'Codex Projects scope' });
      if (pick) await config().update('scope', pick.scope, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('codexProjects.openChat', async item => {
      if (!config().get('enabled', true) || !groups.some(group => group.threads.some(thread => thread.id === item?.id))) return;
      const uri = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: 'openai.chatgpt', path: `/local/${item.id}` });
      if (!await vscode.env.openExternal(await vscode.env.asExternalUri(uri))) vscode.window.showErrorMessage('Could not open this chat in the installed Codex extension.');
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('codexProjects')) return;
      epoch++; groups = []; changed.fire();
      Promise.resolve(pending).then(() => refresh());
    }), { dispose() { disposed = true; epoch++; } });
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { epoch++; groups = []; changed.fire(); Promise.resolve(pending).then(() => refresh()); }));
  if (view.visible) refresh();
}
module.exports = { listProjectThreads, groupThreads, installCodexProjects };
