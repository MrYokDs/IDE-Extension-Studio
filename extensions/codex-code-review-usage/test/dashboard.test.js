'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createUsageDashboard } = require('../dashboard-panel');

function event() {
  const callbacks = new Set();
  return { subscribe: callback => { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; }, fire: value => { for (const callback of [...callbacks]) callback(value); } };
}
function panelHost() {
  const panels = [];
  return { panels, vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: (...args) => {
    const message = event(), changed = event(), closed = event();
    const panel = { args, visible: true, viewColumn: 1, reveals: 0, htmlWrites: 0, messages: [],
      webview: { onDidReceiveMessage: message.subscribe, postMessage: async value => { panel.messages.push(value); return true; } },
      onDidChangeViewState: changed.subscribe, onDidDispose: closed.subscribe,
      reveal() { panel.reveals++; panel.visible = true; }, dispose() { closed.fire(); },
      ready: () => message.fire({ type: 'ready' }), setVisible: value => { panel.visible = value; changed.fire({ webviewPanel: panel }); }
    };
    Object.defineProperty(panel.webview, 'html', { set: value => { panel.html = value; panel.htmlWrites++; } });
    panels.push(panel);
    return panel;
  } } } };
}
const document = value => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body><h1>${value}</h1></body></html>`;

test('dashboard opens one panel for rapid repeated clicks and reveals it on later clicks', async () => {
  const host = panelHost();
  let finishRefresh;
  const refresh = new Promise(resolve => { finishRefresh = resolve; });
  const dashboard = createUsageDashboard(host.vscode, { render: () => document('cached'), refresh: () => refresh });
  const opens = [dashboard.open(), dashboard.open(), dashboard.open()];
  assert.equal(host.panels.length, 1);
  assert.equal(host.panels[0].reveals, 2);
  finishRefresh();
  await Promise.all(opens);
  await dashboard.open();
  assert.equal(host.panels.length, 1);
  assert.equal(host.panels[0].reveals, 3);
  dashboard.dispose();
});

test('dashboard pushes the latest snapshot after ready and updates without reloading or focusing it', async () => {
  const host = panelHost();
  let snapshot = '55%';
  const dashboard = createUsageDashboard(host.vscode, { render: () => document(snapshot), refresh: async () => {} });
  await dashboard.open();
  const panel = host.panels[0];
  snapshot = '38%';
  dashboard.update();
  panel.ready();
  assert.match(panel.messages.at(-1).html, /38%/);
  snapshot = '36%';
  dashboard.update();
  assert.match(panel.messages.at(-1).html, /36%/);
  assert.equal(panel.htmlWrites, 1);
  assert.equal(panel.reveals, 0);
  assert.match(panel.html, /script-src 'nonce-[a-f0-9]+'/);
  assert.match(panel.html, /window.scrollTo\(x, y\)/);
  assert.deepEqual(panel.args[3].enableCommandUris, ['codexUsage.refresh']);
  dashboard.dispose();
});

test('closing and reopening creates a new usable panel and disposal prevents further opens', async () => {
  const host = panelHost();
  let visibilityChanges = 0;
  const dashboard = createUsageDashboard(host.vscode, { render: () => document('latest'), refresh: async () => {}, onVisibilityChange: () => visibilityChanges++ });
  await dashboard.open();
  host.panels[0].dispose();
  assert.equal(dashboard.isVisible(), false);
  dashboard.update();
  await dashboard.open();
  assert.equal(host.panels.length, 2);
  host.panels[1].ready();
  assert.match(host.panels[1].messages.at(-1).html, /latest/);
  assert.equal(visibilityChanges, 3);
  dashboard.dispose();
  await dashboard.open();
  assert.equal(host.panels.length, 2);
});

test('extension polling updates dashboard and status from one read and coalesces overlapping requests', async () => {
  const commands = new Map(), timers = new Map(), pending = [], rendered = [];
  let requestCount = 0, timerId = 0, visible = false, configChanged, scans = 0;
  const settings = { codexReview: { enabled: true }, codexUsage: { enabled: true, refreshIntervalSeconds: 120 } };
  const status = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const noop = () => ({ dispose() {} });
  const context = { subscriptions: [], extensionUri: {}, workspaceState: { get: (_, fallback) => fallback, update: async () => {} } };
  const mock = {
    EventEmitter: class { constructor() { this.event = noop; } fire() {} dispose() {} },
    Uri: { joinPath: () => ({ toString: () => 'file:///logo.svg' }) },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), createStatusBarItem: () => status, registerTreeDataProvider: noop, showInformationMessage: async () => {} },
    workspace: { isTrusted: true, findFiles: async () => { scans++; return []; }, onDidChangeConfiguration: callback => { configChanged = callback; return noop(); }, getConfiguration: section => ({ get: (name, fallback) => settings[section]?.[name] ?? fallback }), registerTextDocumentContentProvider: noop, createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} }) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return noop(); } }
  };
  const setTimer = (callback, delay) => { const timer = { id: ++timerId, delay, callback, unref() {} }; timers.set(timer.id, timer); return timer; };
  const sandbox = { module: { exports: {} }, console,
    setTimeout: setTimer, clearTimeout: timer => timers.delete(timer?.id), setInterval: () => ({ unref() {} }), clearInterval() {},
    require: name => {
      if (name === './antigravity-view') return { installAntigravityView() {} };
      if (name === 'vscode') return mock;
      if (name === './core') return require('../core');
      if (name === './monthly-usage') return require('../monthly-usage');
      if (name === './usage') return { resolveCodexExtensionExecutable: () => 'fake-codex', requestCodexUsage: () => { requestCount++; return new Promise(resolve => pending.push(resolve)); } };
      if (name === './dashboard-panel') return { createUsageDashboard: (_, options) => ({
        open: async () => { visible = true; options.onVisibilityChange(); await options.refresh(); },
        close: () => { visible = false; }, update: () => rendered.push(options.render()), isVisible: () => visible, dispose() { visible = false; }
      }) };
      return require(name);
    }
  };
  const usage = (remaining, used) => ({ plan: 'edu', windows: [{ label: '5 hour', model: 'codex', remainingPercent: remaining }], models: [], usage: { used, limit: 10000 } });
  try {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../extension.js'), 'utf8'), sandbox);
    sandbox.module.exports.activate(context);
    const opens = [commands.get('codexUsage.open')(), commands.get('codexUsage.open')()];
    assert.equal(requestCount, 1);
    pending.shift()(usage(55, 15));
    await Promise.all(opens);
    assert.match(status.text, /55%/);
    assert.match(status.tooltip, /Plan: \*\*ChatGPT Education \(Edu\)\*\*/);
    assert.match(rendered.at(-1), /55% left/);
    assert.match(rendered.at(-1), /Plan:<\/b> ChatGPT Education \(Edu\)/);
    assert.match(rendered.at(-1), /class="remaining" style="width:55%"/);
    assert.match(rendered.at(-1), /class="remaining" style="width:99\.85%"/);
    assert.match(rendered.at(-1), /\.track\{[^}]*background:#e56b6f/);
    assert.match(rendered.at(-1), /\.track span\.remaining\{background:#81cf83/);
    assert.match(rendered.at(-1), /15 of 10,000 credits used/);
    const timer = [...timers.values()].find(timer => timer.delay === 120000);
    assert.ok(timer, 'visible dashboard must honor the configured 120 seconds');
    timers.delete(timer.id);
    const tick = timer.callback();
    const manual = commands.get('codexUsage.refresh')();
    assert.equal(requestCount, 2);
    pending.shift()(usage(38, 16));
    await Promise.all([tick, manual]);
    assert.match(status.text, /38%/);
    assert.match(rendered.at(-1), /38% left/);
    assert.match(rendered.at(-1), /class="remaining" style="width:38%"/);
    assert.match(rendered.at(-1), /16 of 10,000 credits used/);
    const change = (section, key, value) => {
      settings[section][key] = value;
      configChanged({ affectsConfiguration: name => name === `${section}.${key}` });
    };
    change('codexUsage', 'refreshIntervalSeconds', 45);
    assert.ok([...timers.values()].some(timer => timer.delay === 45000));
    change('codexUsage', 'refreshIntervalSeconds', 5);
    assert.ok([...timers.values()].some(timer => timer.delay === 30000));
    change('codexUsage', 'refreshIntervalSeconds', 0);
    assert.equal(timers.size, 0);
    change('codexUsage', 'enabled', false);
    assert.equal(status.visible, false);
    await commands.get('codexUsage.open')();
    await commands.get('codexUsage.refresh')();
    assert.equal(requestCount, 2);
    assert.equal(visible, false);
    change('codexReview', 'enabled', false);
    const previousScans = scans;
    await commands.get('codexReview.refresh')();
    await commands.get('codexReview.openLatest')();
    assert.equal(scans, previousScans);
    change('codexUsage', 'enabled', true);
    assert.equal(status.visible, true);
    assert.equal(requestCount, 3);
    pending.shift()(usage(37, 17));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(status.text, /37%/);
    assert.equal(timers.size, 0);
    change('codexReview', 'enabled', true);
    assert.equal(scans, previousScans + 1);

  } finally {
    for (const disposable of context.subscriptions) disposable.dispose();
  }
  assert.equal(timers.size, 0);
});
