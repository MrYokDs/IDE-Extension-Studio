'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readMonthlyUsage } = require('./monthly-usage');
const { version } = require('./package.json');

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

function requestCodexUsage(executable, options = {}) {
  const spawnProcess = options.spawn || spawn;
  const timeoutMs = options.timeoutMs || 25000;
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { reject(error); return; }
    let buffer = '';
    let stderr = '';
    let account = null;
    let rateLimits = null;
    let models = [];
    let modelsDone = false;
    let monthly = null;
    let monthlyDone = false;
    let monthlyError = null;
    const monthlyAbort = new AbortController();
    let finished = false;
    let timer;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      monthlyAbort.abort();
      child.stdin.end();
      child.kill();
      resolve(value);
    };
    const fail = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      monthlyAbort.abort();
      child.kill();
      reject(error);
    };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const complete = () => {
      if (finished || !modelsDone || !monthlyDone) return;
      const value = normalizeCodex(rateLimits, account, models);
      if (monthly) value.usage = monthly;
      value.monthlyError = monthlyError;
      finish(value);
    };
    timer = setTimeout(() => {
      if (!rateLimits) return fail(new Error('Codex app-server usage query timed out'));
      monthlyError = monthlyError || 'Monthly usage request timed out';
      modelsDone = monthlyDone = true;
      complete();
    }, timeoutMs);
    child.on('error', fail);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return fail(new Error(message.error.message || 'Codex app-server initialization failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 2) {
          if (message.error) return fail(new Error(message.error.message || 'Codex account status unavailable'));
          account = message.result?.account || null;
          send({ id: 3, method: 'account/rateLimits/read' });
        } else if (message.id === 3) {
          if (message.error) return fail(new Error(message.error.message || 'Codex rate limits unavailable'));
          rateLimits = message.result;
          send({ id: 4, method: 'model/list', params: { limit: 100, includeHidden: false } });
          send({ id: 5, method: 'getAuthStatus', params: { includeToken: true, refreshToken: false } });
        } else if (message.id === 4) {
          const catalog = Array.isArray(message.result?.data) ? message.result.data : [];
          models = catalog.map(model => ({
            id: model.id || model.model,
            name: model.displayName || model.display_name || model.model || model.id,
            isDefault: Boolean(model.isDefault ?? model.is_default)
          })).filter(model => model.id && model.name);
          modelsDone = true;
          complete();
        } else if (message.id === 5) {
          const auth = message.result;
          if (message.error || !['chatgpt', 'chatgptAuthTokens'].includes(auth?.authMethod) || !auth?.authToken) {
            monthlyError = 'Monthly usage sign-in unavailable from this Codex version';
            monthlyDone = true;
            complete();
            continue;
          }
          readMonthlyUsage(auth.authToken, rateLimits.accountId, { fetch: options.fetch, signal: monthlyAbort.signal })
            .then(value => { monthly = value; })
            .catch(error => { monthlyError = /^(Monthly usage|Monthly spending)/.test(error?.message || '') ? error.message : 'Monthly usage request failed'; })
            .finally(() => { monthlyDone = true; complete(); });
        }
      }
    });
    child.on('close', code => { if (!finished) fail(new Error(stderr.trim() || `Codex app-server exited (${code})`)); });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'code_review_usage', title: 'Codex Code Review & Usage', version }, capabilities: { experimentalApi: true } } });
  });
}

module.exports = { resolveBundledCodex, resolveCodexExtensionExecutable, normalizeCodex, requestCodexUsage };
