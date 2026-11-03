'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAntigravity, discoverDesktop, requestAntigravityUsage } = require('../antigravity');
const { renderAntigravity, installAntigravityView } = require('../antigravity-view');
const summary = { response: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.82, resetTime: '2026-11-04T00:00:00Z' }, { window: 'weekly', remainingFraction: 0.5, resetTime: '2026-11-10T00:00:00Z' }] }] } };
const status = { userStatus: { email: 'must-not-return@example.com', apiKey: 'must-not-return', planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO' } }, cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini example', modelId: 'example', quotaInfo: { remainingFraction: 0.82, resetTime: '2026-11-04T00:00:00Z' } }, { label: 'Unavailable model', quotaInfo: {} }] } } };
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
test('desktop discovery accepts only standalone hub runtime and valid process-owned ports', async () => {
  let script;
  const endpoints = await discoverDesktop({ platform: 'win32', run: async (_, args, options) => {
    script = args.at(-1); assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify([{ command: '--standalone --subclient_type hub --csrf_token synthetic-test-token', ports: [12345, 0, 'bad', 70000] }, { command: '--csrf_token ide-test-token', ports: [22222] }]) };
  } });
  assert.deepEqual(endpoints, [{ port: 12345, token: 'synthetic-test-token' }]);
  assert.ok(script.includes(String.raw`[\\/]antigravity[\\/]resources`));
  await assert.rejects(discoverDesktop({ platform: 'darwin' }), /Windows only/);
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
  await assert.rejects(requestAntigravityUsage({ discover: async () => [] }), /white icon/);
});
test('Antigravity page escapes backend text and shows grouped quota and separate provider navigation', () => {
  const value = normalizeAntigravity(summary, status); value.models[0].name = '<script>bad()</script>';
  const html = renderAntigravity(value, null, Date.now(), 120);
  assert.ok(!html.includes('<script>bad()'));
  assert.match(html, /command:codexUsage.open/);
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
