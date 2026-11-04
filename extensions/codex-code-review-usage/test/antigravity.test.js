'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAntigravity, discoverIDE, requestAntigravityUsage, localRead } = require('../antigravity');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const http = require('node:http');
const { once } = require('node:events');
const { renderAntigravity, installAntigravityView } = require('../antigravity-view');
const summary = { response: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.82, resetTime: '2026-11-04T00:00:00Z' }, { window: 'weekly', remainingFraction: 0.5, resetTime: '2026-11-10T00:00:00Z' }] }] } };
const status = { userStatus: { email: 'must-not-return@example.com', apiKey: 'must-not-return', planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO' } }, cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini example', modelId: 'example', quotaInfo: { remainingFraction: 0.82, resetTime: '2026-11-04T00:00:00Z' } }, { label: 'Unavailable model', quotaInfo: {} }] } } };

test('missing legacy binary does not diagnose an absent runtime; discovery checks both services', async () => {
  await assert.rejects(requestAntigravityUsage({ discover: async () => [], appRoot: 'synthetic-ide', existsSync: () => false }), error => /language server or IDE-owned agy hub/.test(error.message) && !/does not contain/.test(error.message));
});

test('IDE-owned hub discovery uses HTTP and rejects standalone or ambiguous hubs', async () => {
  const hub = { runtime: 'hub', pid: 123, parentPid: 50, ancestors: [50, 10], ideAncestor: true, command: '--hub --hub-port 12345 --csrf_token synthetic-test-token', ports: [12345, 0, 70000] };
  const run = async () => ({ stdout: JSON.stringify([hub, { ...hub, pid: 124, ideAncestor: false }]) });
  assert.deepEqual(await discoverIDE({ platform: 'win32', hostPid: 10, run }), [{ port: 12345, token: 'synthetic-test-token', protocol: 'http:' }]);
  const standalone = async () => ({ stdout: JSON.stringify([{ ...hub, ideAncestor: false }, { ...hub, command: '--hub-port 12345 --csrf_token synthetic-test-token' }]) });
  assert.deepEqual(await discoverIDE({ platform: 'win32', run: standalone }), []);
  const multiple = async () => ({ stdout: JSON.stringify([hub, { ...hub, pid: 456, parentPid: 60, ancestors: [60, 20] }]) });
  await assert.rejects(discoverIDE({ platform: 'win32', hostPid: 99, run: multiple }), /Multiple/);
  assert.equal((await discoverIDE({ platform: 'win32', serverProcessId: 456, run: multiple })).length, 1);
});

test('real HTTP hub reads quota and plan without a legacy binary or proxy agent', async t => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, body: JSON.parse(body), token: request.headers['x-codeium-csrf-token'] });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url.endsWith('/GetUserStatus') ? status : summary));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const value = await requestAntigravityUsage({ appRoot: 'no-legacy-runtime', discover: async () => [{ port: server.address().port, protocol: 'http:', token: 'synthetic-csrf' }] });
  assert.equal(value.plan, 'Google AI Pro');
  assert.equal(value.groups[0].windows[0].remainingPercent, 82);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, { request: {}, forceRefresh: false });
  assert.ok(requests.every(request => request.token === 'synthetic-csrf' && request.path.startsWith('/exa.language_server_pb.LanguageServerService/')));
  assert.ok(!JSON.stringify(value).includes('synthetic-csrf'));
  assert.equal(await localRead({ port: server.address().port, protocol: 'ftp:', token: 'synthetic-csrf' }, 'GetUserStatus'), null);
  await assert.rejects(localRead({ port: server.address().port, token: 'synthetic-csrf' }, 'MutatingMethod'), /Unsupported/);
  assert.equal(requests.length, 2);
});

test('local usage bypasses IDE proxy agents and sends CSRF only to loopback', async t => {
  let captured;
  t.mock.method(https, 'request', (options, callback) => {
    captured = options;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response);
      response.emit('data', JSON.stringify({ response: {} }));
      response.emit('end');
    });
    return request;
  });
  assert.deepEqual(await localRead({ port: 12345, token: 'synthetic-csrf' }, 'RetrieveUserQuotaSummary'), { response: {} });
  assert.equal(captured.agent, false);
  assert.equal(captured.hostname, '127.0.0.1');
  assert.equal(captured.headers['X-Codeium-Csrf-Token'], 'synthetic-csrf');
  assert.equal(captured.headers['Proxy-Authorization'], undefined);
});
test('Antigravity maps real grouped windows and model quota without exposing identity or inventing token counts', () => {
  const value = normalizeAntigravity(summary, status);
  assert.equal(value.plan, 'Google AI Pro');
  assert.equal(value.groups[0].windows[0].remainingPercent, 82);
  assert.equal(value.groups[0].windows[1].label, 'Weekly');
  assert.equal(value.models[1].quota, null);
  assert.equal(value.tokenUsage, null);
  assert.ok(!JSON.stringify(value).includes('must-not-return'));
  assert.throws(() => normalizeAntigravity({}, {}), /no quota/);
});
test('desktop discovery accepts only IDE runtime and valid process-owned ports', async () => {
  let script;
  const endpoints = await discoverIDE({ platform: 'win32', run: async (_, args, options) => {
    script = args.at(-1); assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify([{ command: '--enable_lsp --subclient_type ide --csrf_token synthetic-test-token', ports: [12345, 0, 'bad', 70000] }, { command: '--csrf_token ide-test-token', ports: [22222] }]) };
  } });
  assert.deepEqual(endpoints, [{ port: 12345, token: 'synthetic-test-token' }]);
  assert.ok(script.includes(String.raw`[\\/]Antigravity IDE[\\/]resources`));
  await assert.rejects(discoverIDE({ platform: 'darwin' }), /Windows only/);
});
test('reader tries process-owned candidates and sanitizes returned data', async () => {
  const methods = [];
  const result = await requestAntigravityUsage({ discover: async () => [{ port: 11111, token: 'synthetic-test-token' }, { port: 12345, token: 'synthetic-test-token' }], read: async (endpoint, method) => {
    methods.push(method);
    return endpoint.port === 11111 ? null : method === 'GetUserStatus' ? status : summary;
  } });
  assert.equal(result.models.length, 2);
  assert.ok(!JSON.stringify(result).includes('synthetic-test-token'));
  assert.ok(methods.every(method => ['RetrieveUserQuotaSummary', 'GetUserStatus'].includes(method)));
  await assert.rejects(requestAntigravityUsage({ discover: async () => [] }), /white-icon/);
});
test('Antigravity page escapes backend text and shows grouped quota and separate provider navigation', () => {
  const value = normalizeAntigravity(summary, status); value.models[0].name = '<script>bad()</script>';
  const html = renderAntigravity(value, null, Date.now(), 120);
  assert.ok(!html.includes('<script>bad()'));
  assert.ok(!html.includes("<nav>"));
  assert.match(html, /width:82%/);
  assert.match(html, /Unavailable model/);
  assert.match(html, /not token counts/);
});
test('Antigravity lifecycle coalesces requests and prevents disabled late responses updating status', async () => {
  const commands = new Map(); let onConfig, finish, calls = 0, enabled = true, textBefore;
  const noop = () => ({ dispose() {} });
  const statusItem = { text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const vscode = { StatusBarAlignment: { Right: 2 }, MarkdownString: class { constructor(value) { this.value = value; } },
    window: { createStatusBarItem: () => statusItem },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : key === 'refreshIntervalSeconds' ? 0 : fallback }), onDidChangeConfiguration: fn => { onConfig = fn; return noop(); } },
    commands: { registerCommand: (key, fn) => { commands.set(key, fn); return noop(); } } };
  const context = { subscriptions: [] };
  installAntigravityView(vscode, context, { read: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  try {
    const manual = commands.get('antigravityUsage.refresh')();
    assert.equal(calls, 1);
    textBefore = statusItem.text;
    enabled = false; onConfig({ affectsConfiguration: () => true });
    assert.equal(statusItem.visible, false);
    finish(normalizeAntigravity(summary, status)); await manual;
    assert.equal(statusItem.text, textBefore);
    await commands.get('antigravityUsage.refresh')();
    assert.equal(calls, 1);
  } finally { context.subscriptions.forEach(item => item.dispose()); }
});


test('IDE discovery selects the current host and refuses to mix unrelated IDE processes', async () => {
  const values = [1, 2].map(pid => ({ pid, parentPid: pid * 10, command: '--subclient_type ide --csrf_token synthetic-test-token', ports: [20000 + pid] }));
  const run = async () => ({ stdout: JSON.stringify(values) });
  assert.equal((await discoverIDE({ platform: 'win32', hostPid: 20, run }))[0].port, 20002);
  await assert.rejects(discoverIDE({ platform: 'win32', hostPid: 99, run }), /Multiple/);
  assert.equal((await discoverIDE({ platform: 'win32', serverProcessId: 1, run }))[0].port, 20001);
  await assert.rejects(discoverIDE({ platform: 'win32', serverProcessId: 99, run }), /no longer running/);
});


test('status windows prefer five-hour quota unless the matching weekly quota is exhausted', () => {
  const { primaryWindow, antigravitySelection } = require('../status-quota');
  const hourly = { label: '5 hour', remainingPercent: 82 };
  assert.equal(primaryWindow([hourly, { label: 'Weekly', remainingPercent: 5 }]), hourly);
  assert.equal(primaryWindow([hourly, { label: 'Weekly', remainingPercent: 0 }]).label, 'Weekly');
  const value = { models: [{ id: 'gemini-first', name: 'Gemini first', quota: { remainingPercent: 80 } }, { id: 'claude-second', name: 'Claude second', quota: { remainingPercent: 70 } }], groups: [
    { family: 'gemini', windows: [{ label: 'Weekly', remainingPercent: 0 }] },
    { family: 'third-party', windows: [{ label: 'Weekly', remainingPercent: 90 }] }
  ] };
  assert.equal(antigravitySelection(value, '').model.id, 'gemini-first');
  assert.equal(antigravitySelection(value, '').window.label, 'Weekly');
  assert.equal(antigravitySelection(value, 'claude-second').window.remainingPercent, 70);
  assert.equal(antigravitySelection(value, 'removed-model').model.id, 'gemini-first');
});

test('Antigravity display model picker updates the status label and saves the selected ID', async () => {
  const commands = new Map(), saved = [];
  const noop = () => ({ dispose() {} });
  const statusItem = { show() {}, dispose() {} };
  const value = normalizeAntigravity(summary, status);
  const vscode = { MarkdownString: class { constructor(value) { this.value = value; } }, window: { createStatusBarItem: () => statusItem, showQuickPick: async () => ({ modelId: value.models[1].id }) }, workspace: {
    getConfiguration: () => ({ get: (key, fallback) => key === 'refreshIntervalSeconds' ? 0 : fallback }), onDidChangeConfiguration: noop
  }, commands: { registerCommand: (name, fn) => { commands.set(name, fn); return noop(); } } };
  const context = { subscriptions: [], workspaceState: { get: (_, fallback) => fallback, update: async (...args) => saved.push(args) } };
  installAntigravityView(vscode, context, { read: async () => value });
  try {
    await commands.get('antigravityUsage.refresh')();
    assert.match(statusItem.text, /Gemini example: 82%/);
    await commands.get('antigravityUsage.selectDisplayModel')();
    assert.match(statusItem.text, /Unavailable model/);
    assert.equal(saved[0][1], value.models[1].id);
  } finally { context.subscriptions.forEach(item => item.dispose()); }
});
