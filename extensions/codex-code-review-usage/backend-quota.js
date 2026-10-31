'use strict';
const { readBackendJson, BACKEND_ROUTES } = require('./backend-transport');

function normalizeBackendQuota(body) {
  const buckets = Object.create(null);
  function add(id, limit, metadata = {}) {
    if (!limit || typeof limit !== 'object') return;
    const bucket = { ...metadata };
    for (const [source, target] of [['primary_window', 'primary'], ['secondary_window', 'secondary']]) {
      const window = limit[source];
      if (!window || typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) continue;
      bucket[target] = { usedPercent: window.used_percent, windowDurationMins: window.limit_window_seconds / 60, resetsAt: window.reset_at ?? null };
    }
    if (bucket.primary || bucket.secondary) buckets[id] = bucket;
  }
  add('codex', body?.rate_limit, { credits: body?.credits ?? null });
  add('code-review', body?.code_review_rate_limit);
  for (const [index, extra] of (Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : []).entries()) {
    add(extra.limit_name || extra.normal_model_slug || `additional-${index}`, extra.rate_limit || extra, { normalModelSlug: extra.normal_model_slug });
  }
  if (!Object.keys(buckets).length) throw new Error('Backend quota response contains no valid windows');
  return { planType: body.plan_type, rateLimitsByLimitId: buckets, credits: body.credits ?? null };
}

async function readBackendQuota(token, accountId, options = {}) {
  try { return normalizeBackendQuota(await readBackendJson(token, accountId, BACKEND_ROUTES.quota, { ...options, label: 'Backend quota' })); }
  catch (error) {
    const status = /HTTP (\d+)/.exec(error?.message || '');
    throw new Error(status ? `Backend quota unavailable (HTTP ${status[1]})` : 'Backend quota request failed');
  }
}
module.exports = { normalizeBackendQuota, readBackendQuota };
