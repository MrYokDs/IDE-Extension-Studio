'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

function bypassProxy(url, entries) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return String(entries || '').split(/[\s,]+/).filter(Boolean).some(entry => {
    if (entry === '*') return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase());
    if (!match || (match[2] && match[2] !== (url.port || '443'))) return false;
    const host = match[1].replace(/^\[|\]$/g, '').replace(/^\*?\./, '');
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}

function resolveProxy(url, config = {}, env = process.env) {
  if (config.support === 'off') return null;
  if (bypassProxy(url, config.noProxy ?? env.no_proxy ?? env.NO_PROXY)) return null;
  const value = config.proxy || env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!value) return null;
  try {
    const proxy = new URL(value);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.hash || proxy.search || proxy.pathname !== '/') throw Error();
    return proxy;
  } catch { throw new Error('Invalid usage proxy: configure an HTTP or HTTPS proxy URL'); }
}

// A fresh agent per request keeps credentials and tunnel lifetime scoped to one read.
function proxyFetch(url, options, proxy, authorization) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false });
    let tunnel, proxySocket, secure, request, settled = false;
    const signal = options.signal;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      request?.destroy();
      secure?.destroy();
      tunnel?.destroy();
      proxySocket?.destroy();
      agent.destroy();
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      // Never expose a proxy URL, password or provider authorization in errors.
      reject(new Error(error?.name === 'AbortError' ? 'Backend request aborted' : 'Usage proxy connection failed'));
    };
    const abort = () => fail({ name: 'AbortError' });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    agent.createConnection = (_options, callback) => {
      const headers = { Host: `${url.hostname}:${url.port || 443}` };
      if (authorization) headers['Proxy-Authorization'] = authorization;
      else if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
      const endpoint = new URL(proxy);
      endpoint.username = '';
      endpoint.password = '';
      tunnel = (proxy.protocol === 'https:' ? https : http).request(endpoint, {
        method: 'CONNECT', path: headers.Host, headers, agent: false
      });
      tunnel.on('error', fail);
      tunnel.on('socket', socket => { proxySocket = socket; if (settled) socket.destroy(); });
      tunnel.on('connect', (response, socket, head) => {
        if (settled || response.statusCode !== 200) { socket.destroy(); return fail(); }
        if (head.length) socket.unshift(head);
        secure = tls.connect({ socket, servername: url.hostname, rejectUnauthorized: true });
        secure.once('error', fail);
        secure.once('secureConnect', () => callback(null, secure));
      });
      tunnel.end();
    };
    try {
      request = https.request(url, { method: 'GET', headers: options.headers, agent }, response => {
        const chunks = [];
        let size = 0;
        response.on('error', fail);
        response.on('aborted', fail);
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) return fail();
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks).toString('utf8');
          cleanup();
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(body) });
        });
      });
      request.on('error', fail);
      request.end();
    } catch (error) { fail(error); }
  });
}

function createUsageFetch(config = {}, env = process.env, directFetch = globalThis.fetch) {
  return (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/')) throw new Error('Backend endpoint not allowed');
    const proxy = resolveProxy(url, config, env);
    return proxy ? proxyFetch(url, options, proxy, config.authorization) : directFetch(url, options);
  };
}

function usageFetchForIDE(vscode) {
  // Read fresh on each refresh. Do not persist settings or credentials.
  const config = vscode.workspace.getConfiguration('http');
  const noProxy = config.get('noProxy');
  return createUsageFetch({
    proxy: config.get('proxy', ''), support: config.get('proxySupport', 'override'),
    authorization: config.get('proxyAuthorization', ''),
    noProxy: Array.isArray(noProxy) && noProxy.length ? noProxy.join(',') : undefined
  });
}

module.exports = { bypassProxy, resolveProxy, createUsageFetch, usageFetchForIDE };
