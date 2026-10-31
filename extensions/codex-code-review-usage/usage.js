'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readCodexCredentials } = require('./codex-auth');
const { readBackendSnapshot } = require('./backend-client');

function resolveBundledCodex(extensionPath, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const existsSync = options.existsSync || fs.existsSync;
  const folderNames = {
    win32: { x64: ['windows-x86_64', 'win32-x64'], arm64: ['windows-aarch64', 'win32-arm64'], ia32: ['windows-i686', 'win32-ia32'] },
    darwin: { x64: ['macos-x86_64', 'darwin-x64'], arm64: ['macos-aarch64', 'darwin-arm64'] },
    linux: { x64: ['linux-x86_64', 'linux-x64'], arm64: ['linux-aarch64', 'linux-arm64'], arm: ['linux-armv7'] }
  };
  const names = folderNames[platform]?.[arch] || [];
  const executableNames = platform === 'win32' ? ['codex.exe', 'codex'] : ['codex'];
  for (const folder of names) {
    for (const name of executableNames) {
      const candidate = path.join(extensionPath, 'bin', folder, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Could not locate Codex's bundled app-server executable. Confirm the official 'openai.chatgpt' extension is installed and supports this platform.");
}

function resolveCodexExtensionExecutable(extensions, options = {}) {
  const extension = extensions.getExtension('openai.chatgpt');
  if (!extension) throw new Error("The official Codex extension (openai.chatgpt) is not installed or enabled.");
  return resolveBundledCodex(extension.extensionPath, options);
}

function normalizeCodex(result, account = null, models = []) {
  const response = result || {};
  const limits = response.rateLimits || response.rate_limits || response;
  const byLimitId = response.rateLimitsByLimitId || response.rate_limits_by_limit_id || limits.rateLimitsByLimitId;
  const entries = byLimitId
    ? Object.entries(byLimitId)
    : limits.primary || limits.secondary ? [[limits.limitId || 'codex', limits]] : [];
  const windows = [];
  for (const [id, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    for (const key of ['primary', 'secondary']) {
      const window = value[key];
      if (!window || !Number.isFinite(Number(window.usedPercent))) continue;
      const usedPercent = Math.max(0, Math.min(100, Number(window.usedPercent)));
      const minutes = Number(window.windowDurationMins || window.window_duration_mins);
      windows.push({
        model: value.normalModelSlug || value.normal_model_slug || value.limitName || value.limit_name || value.limitId || id,
        label: minutes === 300 ? '5 hour' : minutes === 10080 ? 'Weekly' : minutes ? `${minutes} minute` : 'Usage window',
        usedPercent,
        remainingPercent: Math.round(100 - usedPercent),
        resetsAt: window.resetsAt || window.resets_at || null,
        credits: value.credits || null,
        individualLimit: value.individualLimit || value.individual_limit || null
      });
    }
  }
  const unique = [...new Map(windows.map(window => [`${window.model}:${window.label}:${window.usedPercent}:${window.resetsAt}`, window])).values()];
  const credits = limits.credits ?? response.credits ?? response.workspaceCredits ?? response.workspace_credits ?? null;
  const individualLimit = limits.individualLimit || limits.individual_limit || unique.map(window => window.individualLimit).find(Boolean) || null;
  const resetCredits = response.rateLimitResetCredits ?? response.rate_limit_reset_credits ?? limits.rateLimitResetCredits ?? limits.rate_limit_reset_credits ?? null;
  const creditCount = resetCredits && typeof resetCredits === 'object'
    ? resetCredits.availableCount ?? resetCredits.available_count ?? resetCredits.count ?? null
    : resetCredits;
  return {
    windows: unique,
    plan: response.planType || response.plan_type || limits.planType || limits.plan_type || account?.planType || account?.plan_type || account?.plan || null,
    credits,
    usage: response.usage ?? limits.usage ?? (individualLimit ? {
      used: individualLimit.used,
      limit: individualLimit.limit,
      resetsAt: individualLimit.resetsAt || individualLimit.resets_at || null,
      remainingPercent: individualLimit.remainingPercent ?? individualLimit.remaining_percent ?? null
    } : null),
    resetCredits: creditCount != null && Number.isFinite(Number(creditCount)) ? Number(creditCount) : null,
    models,
    account
  };
}

async function requestCodexUsage(executable, options = {}) {
  const timeoutMs = options.timeoutMs || 25000;
  const credentials = await readCodexCredentials(executable, { spawn: options.spawn, timeoutMs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const snapshot = await readBackendSnapshot(credentials, { fetch: options.fetch, signal: controller.signal });
    const value = normalizeCodex(snapshot.limits, null, snapshot.models);
    value.usage = snapshot.usage;
    value.monthlyError = snapshot.monthlyError;
    value.quotaError = snapshot.quotaError;
    value.modelsError = snapshot.modelsError;
    value.quotaSource = snapshot.limits ? 'chatgpt-backend' : null;
    value.modelsSource = snapshot.models.length ? 'chatgpt-backend' : null;
    return value;
  } finally {
    clearTimeout(timer);
    credentials.token = null;
  }
}

module.exports = { resolveBundledCodex, resolveCodexExtensionExecutable, normalizeCodex, requestCodexUsage };
