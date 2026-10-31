'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { normalizeMonthlyUsage, describeMonthlyUsage, readMonthlyUsage } = require('../monthly-usage');
const { requestCodexUsage } = require('../usage');
const observed = { balance_unit: 'credit', current_month_usage: 14.934312582015991, effective_monthly_limit: { limit: 10000, limit_mode: 'amount_credits', enforcement_mode: 'HARD_CAP' } };

test('desktop monthly response displays the same rounded 15 of 10,000 as the app', () => {
  const monthly = normalizeMonthlyUsage(observed);
  assert.equal(monthly.used, observed.current_month_usage);
  assert.equal(monthly.limit, 10000);
  assert.deepEqual(describeMonthlyUsage(monthly), { text: '15 of 10,000 credits used', remainingPercent: 100 });
});

test('missing amounts never turn into zero, and USD amounts are not labeled credits', () => {
  for (const missing of [null, undefined, '', false, NaN, Infinity, -1]) {
    assert.equal(normalizeMonthlyUsage({ ...observed, current_month_usage: missing }), null);
    assert.equal(describeMonthlyUsage({ used: missing, limit: 10000 }), null);
  }
  assert.equal(normalizeMonthlyUsage({ ...observed, effective_monthly_limit: { limit: 10000, limit_mode: 'unlimited_platform_max' } }), null);
  const usd = normalizeMonthlyUsage({ balance_unit: 'usd', current_month_usage: 1.5, effective_monthly_limit: { limit_amount: { amount: '10', unit: 'usd' } } });
  assert.equal(describeMonthlyUsage(usd).text, '$1.50 of $10.00 used');
  assert.equal(describeMonthlyUsage({ used: 2, limit: 0 }).remainingPercent, 0);
});

test('monthly read uses only the fixed provider origin, forbids redirects and never returns credentials', async () => {
  const secret = 'synthetic-test-token';
  let call;
  const value = await readMonthlyUsage(secret, 'workspace-test', { fetch: async (url, options) => {
    call = { url, options };
    return { ok: true, json: async () => observed };
  } });
  assert.equal(call.url.origin, 'https://chatgpt.com');
  assert.equal(call.url.pathname, '/backend-api/accounts/workspace-test/spend-controls/current-user/monthly-usage');
  assert.equal(call.url.searchParams.get('supports_usage_limit_modes'), 'true');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(JSON.stringify(value).includes('workspace-test'), false);
});

test('monthly read rejects a mismatched account before sending the authenticated request', async () => {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'another-workspace' } })).toString('base64url');
  let fetched = false;
  await assert.rejects(readMonthlyUsage(`test.${claims}.signature`, 'workspace-test', { fetch: async () => { fetched = true; } }), /routing differs/);
  assert.equal(fetched, false);
});

function appServer(responses, requests) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {}, write(line) {
    const request = JSON.parse(line);
    requests.push(request);
    if (request.id == null) return;
    const response = responses[request.method];
    if (response) queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, ...response }) + '\n')));
  } };
  child.kill = () => queueMicrotask(() => child.emit('close', 0));
  return child;
}
const responses = {
  initialize: { result: {} },
  'account/read': { result: { account: { type: 'chatgpt', planType: 'edu' } } },
  'account/rateLimits/read': { result: { accountId: 'workspace-test', rateLimits: { primary: { usedPercent: 31, windowDurationMins: 300 }, individualLimit: null, credits: { hasCredits: true, balance: null } } } },
  'model/list': { result: { data: [{ id: 'test-model', displayName: 'Test model', isDefault: true }] } },
  getAuthStatus: { result: { authMethod: 'chatgpt', authToken: 'synthetic-test-token' } }
};

test('quota reader merges desktop monthly data even when rateLimits.individualLimit is null', async () => {
  const requests = [];
  const result = await requestCodexUsage('fake-codex', { spawn: () => appServer(responses, requests), fetch: async () => ({ ok: true, json: async () => observed }) });
  assert.equal(describeMonthlyUsage(result.usage).text, '15 of 10,000 credits used');
  assert.equal(result.windows[0].remainingPercent, 69);
  assert.equal(result.models[0].name, 'Test model');
  assert.equal(result.monthlyError, null);
  assert.equal(JSON.stringify(result).includes('synthetic-test-token'), false);
  assert.ok(requests.some(request => request.method === 'getAuthStatus' && request.params.includeToken === true));
});

test('monthly HTTP failure preserves normal quota data and reports only a sanitized error', async () => {
  const result = await requestCodexUsage('fake-codex', { spawn: () => appServer(responses, []), fetch: async () => ({ ok: false, status: 403, json: async () => { throw Error('must not read error body'); } }) });
  assert.equal(result.windows[0].remainingPercent, 69);
  assert.equal(result.monthlyError, 'Monthly usage unavailable (HTTP 403)');
  assert.equal(result.usage, null);
});

test('an unsupported auth method preserves quota data without making a monthly request', async () => {
  let fetched = false;
  const result = await requestCodexUsage('fake-codex', { spawn: () => appServer({ ...responses, getAuthStatus: { error: { code: -32601 } } }, []), fetch: async () => { fetched = true; } });
  assert.equal(result.windows[0].remainingPercent, 69);
  assert.equal(fetched, false);
  assert.match(result.monthlyError, /sign-in unavailable/);
});

test('a stuck monthly request times out without discarding quota data', async () => {
  const result = await requestCodexUsage('fake-codex', { timeoutMs: 30, spawn: () => appServer(responses, []), fetch: () => new Promise(() => {}) });
  assert.equal(result.windows[0].remainingPercent, 69);
  assert.match(result.monthlyError, /timed out/);
});
