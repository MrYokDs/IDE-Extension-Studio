'use strict';
const { requestAntigravityUsage } = require('./antigravity');
const { createUsageDashboard } = require('./dashboard-panel');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => {
  const parsed = new Date(value);
  return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(parsed) : 'Unavailable';
};
function countdown(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
  let minutes = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 60000));
  if (!minutes) return 'Reset due';
  const parts = [];
  for (const [unit, size] of [['w', 10080], ['d', 1440], ['h', 60], ['m', 1]]) {
    const count = Math.floor(minutes / size); minutes %= size;
    if (count) parts.push(`${count}${unit}`);
  }
  return parts.join(' ');
}
function renderAntigravity(value, error, updated, seconds) {
  const track = percent => `<div class="track"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>`;
  const groups = (value?.groups || []).map(group => `<section><h2>${escape(group.name)}</h2>${group.windows.map(window => `<div class="row"><b>${escape(window.label)}</b><b>${window.remainingPercent}% remaining</b></div>${track(window.remainingPercent)}<p class="muted">Resets ${escape(date(window.resetsAt))}</p>`).join('')}</section>`).join('');
  const models = (value?.models || []).map(model => `<tr><td>${escape(model.name)}</td><td>${model.quota ? model.quota.remainingPercent + '%' : 'Unavailable'}</td><td>${model.quota ? escape(countdown(model.quota.resetsAt)) : 'Unavailable'}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px var(--vscode-font-family);color:var(--vscode-foreground);max-width:820px;margin:auto;padding:24px}section{padding:20px;border:1px solid var(--vscode-panel-border);border-radius:10px;margin:18px 0;background:var(--vscode-sideBar-background)}nav{display:flex;gap:24px;margin-bottom:24px}.row{display:flex;justify-content:space-between;gap:20px}.track{height:7px;background:#e56b6f;margin-top:12px;overflow:hidden;border-radius:5px}.track span{display:block;height:100%;background:#81cf83}.muted{color:var(--vscode-descriptionForeground);font-size:12px}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid var(--vscode-panel-border)}a{color:var(--vscode-textLink-foreground)}</style></head><body><nav><a href="command:codexUsage.open">Codex</a><b>Antigravity</b></nav><h1>Antigravity Usage</h1><p>Plan: <b>${escape(value?.plan || 'Unavailable')}</b></p>${error ? `<p>${escape(error)}</p>` : ''}<p class="muted">Green: Remaining · Red: Used. Models in each group share weekly and five-hour quota.</p>${groups}${models ? `<section><h2>Models</h2><table><tr><th>Model</th><th>Remaining</th><th>Reset</th></tr>${models}</table><p class="muted">Model percentages are returned by the IDE service and may share quota. Group limits above are the account quota windows.</p></section>` : ''}<p class="muted">Token counts and credit balances are not reported here; quota percentages are not token counts.</p><p class="muted">Source: Antigravity IDE local service · Updated: ${escape(date(updated))} · Auto refresh: ${seconds ? seconds + ' seconds' : 'off'} · <a href="command:antigravityUsage.refresh">Refresh now</a></p></body></html>`;
}
function installAntigravityView(vscode, context, options = {}) {
  let value = null, error = null, updated = null, timer, inFlight = null, controller, disposed = false, generation = 0;
  const config = () => vscode.workspace.getConfiguration('antigravityUsage');
  const enabled = () => config().get('enabled', true);
  const interval = () => { const n = Number(config().get('refreshIntervalSeconds', 120)); return Number.isFinite(n) && n > 0 ? Math.max(30, n) : 0; };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Right ?? 2, 89);
  status.command = 'antigravityUsage.open';
  const dashboard = createUsageDashboard(vscode, { title: 'Antigravity Usage', viewType: 'antigravityUsage.dashboard', commandUris: ['codexUsage.open', 'antigravityUsage.refresh'],
    render: () => renderAntigravity(value, error, updated, interval()), refresh: () => refresh(), onVisibilityChange: schedule });
  function update() {
    if (disposed || !enabled()) return;
    const hourly = value?.groups.flatMap(group => group.windows).filter(window => window.label === '5 hour');
    const remaining = hourly?.length ? Math.min(...hourly.map(window => window.remainingPercent)) : null;
    status.text = remaining == null ? '$(pulse) Antigravity Usage' : `${remaining >= 60 ? '🟢' : remaining >= 25 ? '🟡' : '🔴'} Antigravity: ${remaining}%`;
    const cell = text => String(text).replace(/[\\|`*_[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
    const table = ['| Model | Remaining | Reset |', '| :--- | ---: | :--- |', ...(value?.models || []).map(model => `| ${cell(model.name)} | ${model.quota ? model.quota.remainingPercent + '%' : 'Unavailable'} | ${model.quota ? countdown(model.quota.resetsAt) : 'Unavailable'} |`)].join('\n');
    const lines = ['**Antigravity Usage**', value?.plan ? `Plan: ${cell(value.plan)}` : '', error || '', ...(value?.groups || []).flatMap(group => [`**${cell(group.name)}**`, ...group.windows.map(window => `${cell(window.label)}: ${window.remainingPercent}% remaining · reset ${countdown(window.resetsAt)}`)]), table, '[Open Antigravity Usage](command:antigravityUsage.open)'];
    const tooltip = new vscode.MarkdownString(lines.filter(Boolean).join('\n\n'));
    tooltip.isTrusted = { enabledCommands: ['antigravityUsage.open'] }; status.tooltip = tooltip;
  }
  async function refresh() {
    if (disposed || !enabled()) return;
    if (inFlight) return inFlight;
    const current = generation;
    controller = new AbortController();
    inFlight = (async () => {
      try { const fresh = await (options.read || requestAntigravityUsage)({ signal: controller.signal, serverProcessId: Number(config().get('serverProcessId', 0)) || undefined }); if (disposed || !enabled() || current !== generation) return; value = fresh; error = null; updated = Date.now(); }
      catch (failure) { if (disposed || !enabled() || current !== generation) return; value = null; error = failure.message; }
      update(); dashboard.update();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  function schedule() {
    clearTimeout(timer);
    if (disposed || !enabled() || !interval()) return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, interval() * 1000); timer.unref?.();
  }
  const countdownTimer = setInterval(update, 60000); countdownTimer.unref?.();
  context.subscriptions.push(status, dashboard,
    vscode.commands.registerCommand('antigravityUsage.open', () => enabled() ? dashboard.open() : undefined),
    vscode.commands.registerCommand('antigravityUsage.refresh', refresh),
    { dispose() { disposed = true; generation++; clearTimeout(timer); clearInterval(countdownTimer); controller?.abort(); } });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('antigravityUsage')) return;
    generation++; controller?.abort(); clearTimeout(timer);
    if (enabled()) { status.show(); Promise.resolve(inFlight).then(() => refresh()).finally(schedule); }
    else { status.hide(); dashboard.close(); value = null; error = null; }
  }));
  if (enabled()) { status.show(); refresh().finally(schedule); }
}
module.exports = { installAntigravityView, renderAntigravity };
