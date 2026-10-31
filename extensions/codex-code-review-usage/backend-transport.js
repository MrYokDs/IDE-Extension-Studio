'use strict';
const BACKEND_ROUTES = Object.freeze({
  quota: '/backend-api/wham/usage',
  // Verified catalog compatibility version, independent of the extension version.
  models: '/backend-api/codex/models?client_version=0.164.0',
  monthly: accountId => `/backend-api/accounts/${encodeURIComponent(accountId)}/spend-controls/current-user/monthly-usage?supports_usage_limit_modes=true`
});

async function readBackendJson(token, accountId, pathname, options = {}) {
  if (typeof token !== 'string' || !token || typeof accountId !== 'string' || !accountId) throw new Error('Backend usage requires an authenticated workspace');
  let tokenAccount = null;
  try {
    tokenAccount = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch {}
  if (tokenAccount && tokenAccount !== accountId) throw new Error('Backend usage account routing differs from Codex');
  const url = new URL(pathname, 'https://chatgpt.com');
  if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/')) throw new Error('Backend endpoint not allowed');
  const fetchUsage = options.fetch || globalThis.fetch;
  const label = options.label || 'Backend usage';
  if (typeof fetchUsage !== 'function') throw new Error(`${label} network transport unavailable`);
  const signal = options.signal || AbortSignal.timeout(12000);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new Error('Backend request aborted'));
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetchUsage(url, {
        method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-ID': accountId, Accept: 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' }
      });
      if (!response.ok) throw new Error(`${label} unavailable (HTTP ${response.status})`);
      return response.json();
    })()]);
  } finally { signal.removeEventListener('abort', abortListener); }
}

module.exports = { readBackendJson, BACKEND_ROUTES };
