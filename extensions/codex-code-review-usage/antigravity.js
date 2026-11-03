'use strict';
const { execFile } = require('node:child_process');
const https = require('node:https');
const { promisify } = require('node:util');
const run = promisify(execFile);
const SERVICE = '/exa.language_server_pb.LanguageServerService/';
let cached = null;
function fraction(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}
function quota(value) {
  const remaining = fraction(value?.remainingFraction);
  return remaining == null ? null : { remainingPercent: Math.round(remaining * 100), resetsAt: typeof value.resetTime === 'string' ? value.resetTime : null };
}
function normalizeAntigravity(summary, status) {
  const user = status?.userStatus;
  const groups = (Array.isArray(summary?.response?.groups) ? summary.response.groups : []).map((group, index) => ({
    family: (Array.isArray(group.buckets) ? group.buckets : []).some(bucket => String(bucket.bucketId || '').startsWith('gemini-')) ? 'gemini' : (Array.isArray(group.buckets) ? group.buckets : []).some(bucket => String(bucket.bucketId || '').startsWith('3p-')) ? 'third-party' : null,
    name: typeof group.displayName === 'string' ? group.displayName : `Group ${index + 1}`,
    windows: (Array.isArray(group.buckets) ? group.buckets : []).flatMap(bucket => {
      const value = quota(bucket);
      return value ? [{ ...value, label: bucket.window === '5h' ? '5 hour' : bucket.window === 'weekly' ? 'Weekly' : String(bucket.window || 'Usage') }] : [];
    })
  })).filter(group => group.windows.length);
  const models = (Array.isArray(user?.cascadeModelConfigData?.clientModelConfigs) ? user.cascadeModelConfigData.clientModelConfigs : []).filter(model => typeof model.label === 'string').map(model => ({
    name: model.label, id: typeof model.modelId === 'string' ? model.modelId : model.label, quota: quota(model.quotaInfo)
  }));
  const tier = user?.planStatus?.planInfo?.teamsTier;
  const plan = { TEAMS_TIER_PRO: 'Google AI Pro', TEAMS_TIER_ULTRA: 'Google AI Ultra', TEAMS_TIER_FREE: 'Free' }[tier] || (typeof tier === 'string' ? tier : null);
  if (!groups.length && !models.some(model => model.quota)) throw new Error('Antigravity returned no quota data. Confirm the IDE is signed in.');
  return { groups, models, plan, source: 'antigravity-ide-local', tokenUsage: null };
}
async function discoverIDE(options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Antigravity IDE discovery currently supports Windows only.');
  const script = String.raw`Get-CimInstance Win32_Process -Filter "Name = 'language_server_windows_x64.exe'" | Where-Object { $_.ExecutablePath -match '[\\/]Antigravity IDE[\\/]resources[\\/]app[\\/]extensions[\\/]antigravity[\\/]bin[\\/]language_server_windows_x64.exe$' } | ForEach-Object { $p = $_; $ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } | Select-Object -ExpandProperty LocalPort -Unique); [pscustomobject]@{ pid=$p.ProcessId; parentPid=$p.ParentProcessId; command=$p.CommandLine; ports=$ports } } | ConvertTo-Json -Depth 4 -Compress`;
  let stdout;
  try { ({ stdout } = await (options.run || run)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })); }
  catch { throw new Error('Antigravity IDE process discovery failed. Check Windows process access.'); }
  let values;
  try { values = stdout.trim() ? JSON.parse(stdout) : []; } catch { throw new Error('Antigravity IDE discovery returned invalid data.'); }
  const servers = (Array.isArray(values) ? values : [values]).filter(value => /--subclient_type(?:=|\s+)ide\b/.test(value.command || ''));
  const selected = options.serverProcessId ? servers.filter(value => value.pid === options.serverProcessId) : servers.filter(value => value.parentPid === (options.hostPid || process.pid));
  if (options.serverProcessId && !selected.length) throw new Error('Selected Antigravity IDE server is no longer running. Update Server Process Id or set it to 0.');
  if (!selected.length && servers.length > 1) throw new Error('Multiple Antigravity IDE servers found. Set Antigravity Usage: Server Process Id to the intended IDE server.');
  return (selected.length ? selected : servers).flatMap(value => {
    const command = value.command || '';
    if (!/--subclient_type(?:=|\s+)ide\b/.test(command)) return [];
    const token = /--csrf_token(?:=|\s+)["']?([^\s"']+)/.exec(command)?.[1];
    return token ? (Array.isArray(value.ports) ? value.ports : []).filter(port => Number.isInteger(port) && port > 0 && port <= 65535).map(port => ({ port, token })) : [];
  });
}
function localRead(endpoint, method, options = {}) {
  if (!['RetrieveUserQuotaSummary', 'GetUserStatus'].includes(method)) return Promise.reject(new Error('Unsupported Antigravity read method'));
  return new Promise(resolve => {
    if (options.signal?.aborted) return resolve(null);
    const body = JSON.stringify(method === 'RetrieveUserQuotaSummary' ? { request: {}, forceRefresh: false } : {});
    // The IDE uses a self-signed certificate on its process-owned loopback port.
    // This exception is local to this request: no remote host, redirects or global TLS changes.
    const request = https.request({ hostname: '127.0.0.1', port: endpoint.port, path: SERVICE + method, method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': endpoint.token }, signal: options.signal }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) request.destroy(); });
      response.on('error', () => resolve(null));
      response.on('end', () => { try { resolve(response.statusCode === 200 ? JSON.parse(data) : null); } catch { resolve(null); } });
    });
    request.setTimeout(options.requestTimeout || 1200, () => request.destroy());
    request.on('error', () => resolve(null)); request.end(body);
  });
}
async function requestAntigravityUsage(options = {}) {
  const read = options.read || localRead;
  const signal = options.signal || AbortSignal.timeout(15000);
  const candidates = await (options.discover || discoverIDE)(options);
  if (!candidates.length) { cached = null; throw new Error('Open Antigravity IDE, sign in and start its agent panel so the language server is running. The white-icon app is not required.'); }
  if (cached) candidates.sort((a, b) => Number(b.port === cached.port && b.token === cached.token) - Number(a.port === cached.port && a.token === cached.token));
  for (const endpoint of candidates) {
    if (signal.aborted) break;
    const summary = await read(endpoint, 'RetrieveUserQuotaSummary', { ...options, signal });
    const status = summary ? await read(endpoint, 'GetUserStatus', { ...options, signal }) : null;
    if (!summary) continue;
    try { const value = normalizeAntigravity(summary, status); cached = endpoint; return value; } catch {}
  }
  cached = null;
  throw new Error('Antigravity IDE quota service is not ready or unavailable. Open the app and refresh.');
}
module.exports = { requestAntigravityUsage, normalizeAntigravity, discoverIDE };
