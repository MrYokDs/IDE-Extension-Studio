'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { resolveProxy, resolveWindowsProxy, bypassProxy, createUsageFetch, usageFetchForIDE } = require('../proxy-transport');
const target = new URL('https://chatgpt.com/backend-api/wham/usage');

test('IDE proxy precedes environment; lowercase, HTTPS and HTTP fallback work', () => {
  const env = { https_proxy: 'http://lower:80', HTTPS_PROXY: 'http://upper:80', HTTP_PROXY: 'http://fallback:80' };
  assert.equal(resolveProxy(target, { proxy: 'https://ide:443' }, env).hostname, 'ide');
  assert.equal(resolveProxy(target, {}, env).hostname, 'lower');
  assert.equal(resolveProxy(target, {}, { HTTP_PROXY: env.HTTP_PROXY }).hostname, 'fallback');
  assert.equal(resolveProxy(target, { support: 'off' }, env), null);
  assert.throws(() => resolveProxy(target, { proxy: 'socks5://user:private@host' }, {}), error => !error.message.includes('private'));
});

test('NO_PROXY handles domains, boundaries, wildcard and ports', () => {
  for (const value of ['chatgpt.com', '.chatgpt.com', '*.chatgpt.com', 'chatgpt.com:443', '*']) assert.equal(bypassProxy(target, value), true);
  for (const value of ['gpt.com', 'chatgpt.com:80', 'other.com']) assert.equal(bypassProxy(target, value), false);
  assert.equal(bypassProxy(new URL('https://sub.chatgpt.com'), '.chatgpt.com'), true);
  assert.equal(resolveProxy(target, {}, { HTTPS_PROXY: 'http://proxy', NO_PROXY: 'chatgpt.com' }), null);
});

test('direct fetch retains redirect, headers and cancellation; rejects other origins', async () => {
  const signal = new AbortController().signal;
  const options = { signal, redirect: 'error', headers: { Authorization: 'synthetic' } };
  const fetch = createUsageFetch({ useWindowsProxy: false }, {}, async (url, actual) => { assert.equal(url.href, target.href); assert.equal(actual, options); return 'direct'; });
  assert.equal(await fetch(target, options), 'direct');
  assert.throws(() => fetch('https://other.com/backend-api/usage'), /not allowed/);
});

test('IDE configuration reads proxy auth and noProxy on each refresh', () => {
  let proxy = 'http://first';
  const vscode = { workspace: { getConfiguration: section => {
    assert.ok(['http', 'codexUsage'].includes(section));
    return { get: (key, fallback) => ({ proxy, noProxy: ['chatgpt.com'] }[key] ?? fallback) };
  } } };
  assert.equal(typeof usageFetchForIDE(vscode), 'function');
  proxy = 'http://second';
  assert.equal(typeof usageFetchForIDE(vscode), 'function');
});

test('Windows resolver delegates PAC to OS without exposing credentials or accepting malformed output', async () => {
  let script;
  const signal = new AbortController().signal;
  const run = async (file, args, options) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.equal(options.signal, signal);
    assert.equal(options.timeout, 8000);
    script = args.at(-1);
    return { stdout: 'http://system-proxy:8080/\r\n' };
  };
  assert.equal((await resolveWindowsProxy(target, { platform: 'win32', signal, run })).hostname, 'system-proxy');
  assert.match(script, /GetSystemWebProxy/);
  assert.match(script, /GetProxy/);
  assert.equal(await resolveWindowsProxy(target, { platform: 'win32', run: async () => ({ stdout: 'DIRECT\r\n' }) }), null);
  assert.equal(await resolveWindowsProxy(target, { platform: 'linux', run: () => assert.fail() }), null);
  for (const output of ['', 'socks5://host', 'http://user:private@host']) {
    await assert.rejects(resolveWindowsProxy(target, { platform: 'win32', run: async () => ({ stdout: output }) }), error => /Windows proxy resolution failed/.test(error.message) && !error.message.includes('private'));
  }
});

test('Windows lookup failure fails closed; cancellation prevents late direct requests', async () => {
  const direct = () => assert.fail('must not send a direct request');
  const fetch = createUsageFetch({}, {}, direct, async () => { throw Error('lookup failed'); });
  await assert.rejects(fetch(target), /lookup failed/);
  const controller = new AbortController();
  const cancelled = createUsageFetch({}, {}, direct, async () => { controller.abort(); return null; });
  await assert.rejects(cancelled(target, { signal: controller.signal }), /aborted/);
});

test('explicit proxy, bypass and disabled system lookup never invoke Windows resolver', async t => {
  const resolver = () => assert.fail('system resolver must not run');
  for (const config of [{ support: 'off' }, { noProxy: 'chatgpt.com' }, { useWindowsProxy: false }]) {
    assert.equal(await createUsageFetch(config, {}, async () => 'direct', resolver)(target), 'direct');
  }
  const proxy = await withProxy(t, (_request, socket) => socket.end('HTTP/1.1 407 Unauthorized\r\nContent-Length: 0\r\n\r\n'));
  await assert.rejects(createUsageFetch({ proxy }, {}, () => assert.fail(), resolver)(target, { signal: AbortSignal.timeout(2000) }), /failed/);
});

test('Windows-selected proxy is used and DIRECT preserves existing fetch options', async t => {
  const proxy = await withProxy(t, (_request, socket) => socket.end('HTTP/1.1 407 Unauthorized\r\nContent-Length: 0\r\n\r\n'));
  let resolved;
  await assert.rejects(createUsageFetch({}, {}, () => assert.fail('no fallback'), async url => { resolved = url.href; return new URL(proxy); })(target, { signal: AbortSignal.timeout(2000) }), /failed/);
  assert.equal(resolved, target.href);
  const options = { redirect: 'error' };
  assert.equal(await createUsageFetch({}, {}, async (_url, actual) => { assert.equal(actual, options); return 'direct'; }, async () => null)(target, options), 'direct');
});

async function withProxy(t, handler) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('real CONNECT sends only proxy credentials and never follows proxy rejection', async t => {
  let seen;
  const proxy = await withProxy(t, (request, socket) => {
    seen = request;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  const authenticated = proxy.replace('http://', 'http://user:p%40ss@');
  const fetch = createUsageFetch({ proxy: authenticated }, {}, () => assert.fail('must not retry direct'));
  await assert.rejects(fetch(target, { headers: { Authorization: 'Bearer synthetic-provider-secret' }, signal: AbortSignal.timeout(2000) }), /proxy connection failed/);
  assert.equal(seen.url, 'chatgpt.com:443');
  assert.equal(seen.headers['proxy-authorization'], `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers['chatgpt-account-id'], undefined);
});

test('real tunnel cancellation closes a stalled proxy connection', { timeout: 4000 }, async t => {
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const proxy = await withProxy(t, (_request, socket) => { socket.resume(); connected(socket); });
  const controller = new AbortController();
  const pending = createUsageFetch({ proxy }, {})(target, { signal: controller.signal });
  const socket = await ready;
  const closed = once(socket, 'end');
  controller.abort();
  await assert.rejects(pending, /aborted/);
  await closed;
});

test('successful CONNECT starts a TLS handshake before sending account headers', { timeout: 4000 }, async t => {
  let bytes = Buffer.alloc(0);
  const proxy = await withProxy(t, (_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', chunk => { bytes = chunk; socket.end(); });
  });
  await assert.rejects(createUsageFetch({ proxy }, {})(target, { headers: { Authorization: 'Bearer synthetic-provider-secret' }, signal: AbortSignal.timeout(2000) }), /failed/);
  assert.equal(bytes[0], 22); // TLS handshake record, never a plaintext authenticated GET.
  assert.equal(bytes.includes(Buffer.from('synthetic-provider-secret')), false);
});
