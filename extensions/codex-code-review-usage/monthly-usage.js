'use strict';
const { readBackendJson, BACKEND_ROUTES } = require('./backend-transport');

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

async function readMonthlyUsage(token, accountId, options = {}) {
  const body = await readBackendJson(token, accountId, BACKEND_ROUTES.monthly(accountId), { ...options, label: 'Monthly usage' });
  const usage = normalizeMonthlyUsage(body);
  if (!usage) throw new Error('Monthly spending limit not available for this account');
  return usage;
}

module.exports = { normalizeMonthlyUsage, describeMonthlyUsage, readMonthlyUsage, readBackendJson };
