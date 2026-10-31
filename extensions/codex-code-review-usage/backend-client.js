'use strict';
const { readBackendJson, BACKEND_ROUTES } = require('./backend-transport');
const { readBackendQuota } = require('./backend-quota');
const { readMonthlyUsage } = require('./monthly-usage');
function normalizeBackendModels(body) {
  if (!Array.isArray(body?.models)) throw new Error('Backend model catalog unavailable');
  const seen = new Set();
  const models = body.models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && model.slug && typeof model.display_name === 'string' && model.display_name)
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : Infinity) - (Number.isFinite(b.priority) ? b.priority : Infinity))
    .filter(model => { if (seen.has(model.slug)) return false; seen.add(model.slug); return true; });
  return models.map((model, index) => ({ id: model.slug, name: model.display_name, isDefault: index === 0 }));
}
async function readBackendModels(token, accountId, options = {}) {
  return normalizeBackendModels(await readBackendJson(token, accountId, BACKEND_ROUTES.models, { ...options, label: 'Backend model catalog' }));
}
async function readBackendSnapshot(credentials, options = {}) {
  const snapshot = { limits: null, models: [], usage: null, quotaError: null, modelsError: null, monthlyError: null };
  const jobs = [
    ['limits', 'quotaError', 'Backend quota', readBackendQuota],
    ['models', 'modelsError', 'Backend model catalog', readBackendModels],
    ['usage', 'monthlyError', 'Monthly usage', readMonthlyUsage]
  ];
  await Promise.all(jobs.map(async ([key, errorKey, label, read]) => {
    try { snapshot[key] = await read(credentials.token, credentials.accountId, options); }
    catch (error) {
      const status = /HTTP (\d+)/.exec(error?.message || '');
      snapshot[errorKey] = status ? `${label} unavailable (HTTP ${status[1]})` : options.signal?.aborted ? `${label} request timed out` : `${label} request failed`;
    }
  }));
  return snapshot;
}
module.exports = { readBackendSnapshot, readBackendModels, normalizeBackendModels };
