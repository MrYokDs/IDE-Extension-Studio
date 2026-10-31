'use strict';

function amount(value) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeMonthlyUsage(body) {
  const unit = body?.balance_unit ?? 'credit';
  const effective = body?.effective_monthly_limit;
  if (!effective || effective.limit_mode === 'unlimited_platform_max' || !['credit', 'usd'].includes(unit)) return null;
  const used = amount(body.current_month_usage);
  const limit = effective.limit_amount?.unit === unit ? amount(effective.limit_amount.amount) : unit === 'credit' ? amount(effective.limit) : null;
  if (used == null || limit == null) return null;
  return { used, limit, balanceUnit: unit, remainingPercent: limit === 0 ? 0 : Math.max(0, Math.min(100, 100 - used / limit * 100)), source: 'desktop-monthly-usage' };
}

function describeMonthlyUsage(usage) {
  const used = amount(usage?.used);
  const limit = amount(usage?.limit);
  if (used == null || limit == null) return null;
  const usd = usage.balanceUnit === 'usd';
  const format = new Intl.NumberFormat('en-US', usd ? { style: 'currency', currency: 'USD' } : { maximumFractionDigits: 0 });
  return {
    text: `${format.format(used)} of ${format.format(limit)}${usd ? ' used' : ' credits used'}`,
    remainingPercent: Math.round(limit === 0 ? 0 : Math.max(0, Math.min(100, 100 - used / limit * 100)))
  };
}

async function readBackendJson(token, accountId, pathname, options = {}) {
  if (typeof token !== 'string' || !token || typeof accountId !== 'string' || !accountId) throw new Error('Backend usage requires an authenticated workspace');
  let tokenAccount = null;
  try {
    tokenAccount = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch {}
  if (tokenAccount && tokenAccount !== accountId) throw new Error('Backend usage account routing differs from Codex');
  const url = new URL(`https://chatgpt.com${pathname}`);
  const fetchUsage = options.fetch || globalThis.fetch;
  if (typeof fetchUsage !== 'function') throw new Error('Monthly usage network transport unavailable');
  const response = await fetchUsage(url, {
    method: 'GET', redirect: 'error', signal: options.signal || AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-ID': accountId, Accept: 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' }
  });
  if (!response.ok) throw new Error(`Monthly usage unavailable (HTTP ${response.status})`);
  return response.json();
}

async function readMonthlyUsage(token, accountId, options = {}) {
  const body = await readBackendJson(token, accountId, `/backend-api/accounts/${encodeURIComponent(accountId)}/spend-controls/current-user/monthly-usage?supports_usage_limit_modes=true`, options);
  const usage = normalizeMonthlyUsage(body);
  if (!usage) throw new Error('Monthly spending limit not available for this account');
  return usage;
}

module.exports = { normalizeMonthlyUsage, describeMonthlyUsage, readMonthlyUsage, readBackendJson };
