'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const { safeFile, readBatch, hash, text } = require('./core');
const { resolveCodexExtensionExecutable, requestCodexUsage } = require('./usage');
const { primaryWindow } = require('./status-quota');
const { describeMonthlyUsage } = require('./monthly-usage');
const { installCodexProjects } = require('./projects');
const { installAntigravityView } = require('./antigravity-view');
const { createUsageDashboard } = require('./dashboard-panel');
function activate(context) {
  installAntigravityView(vscode, context);
  installCodexProjects(vscode, context);
  const changed = new vscode.EventEmitter();
  const output = vscode.window.createOutputChannel('Codex Code Review & Usage');
  const usageOutput = vscode.window.createOutputChannel('Codex Usage');
  const snapshots = new Map();
  let batches = [];
  let timer;
  let usageTimer;
  let usageRefreshPromise = null;
  let lastUsageRefreshAt = null;
  let disposed = false;
  const reviewEnabled = () => vscode.workspace.getConfiguration('codexReview').get('enabled', true);
  const usageEnabled = () => vscode.workspace.getConfiguration('codexUsage').get('enabled', true);
  const refreshSeconds = () => {
    const value = Number(vscode.workspace.getConfiguration('codexUsage').get('refreshIntervalSeconds', 120));
    return Number.isFinite(value) && value > 0 ? Math.max(30, value) : 0;
  };
  let codexUsage = null;
  let codexError = null;
  let displayModel = context.workspaceState.get('codexUsage.displayModel', '');
  const dashboard = createUsageDashboard(vscode, {
    commandUris: ['codexUsage.refresh', 'antigravityUsage.open'], render: renderUsageDashboard, refresh: () => refreshUsage(false), onVisibilityChange: scheduleUsageRefresh
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Right ?? 2, 90);
  status.text = '$(pulse) Codex: loading';
  status.command = 'codexUsage.open';
  if (usageEnabled()) status.show();
  const seen = new Set(context.workspaceState.get('codexReview.seen', []));
  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren: item => !reviewEnabled() ? [] : item ? item.files.map(file => ({ batch: item, file })) : batches,
    getTreeItem: item => {
      if (!item.file) {
        const row = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.Expanded);
        row.description = `${item.files.length} files`;
        row.tooltip = item.relative;
        return row;
      }
      const row = new vscode.TreeItem(item.file.path);
      row.description = item.file.before === null ? 'Added' : item.file.after === null ? 'Deleted' : 'Modified';
      row.command = { command: 'codexReview.openFile', title: 'Open diff', arguments: [item] };
      return row;
    }
  };
  const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const displayPlan = value => ({
    edu: 'ChatGPT Education (Edu)',
    education: 'ChatGPT Education (Edu)',
    edu_plus: 'ChatGPT Education Plus (Edu Plus)',
    edu_pro: 'ChatGPT Education Pro (Edu Pro)'
  }[value] || value || 'Not provided');
  const quotaTrack = value => {
    const remaining = Number(Math.max(0, Math.min(100, Number(value))).toFixed(4));
    return `<div class="track" role="progressbar" aria-label="Quota remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"><span class="remaining" style="width:${remaining}%"></span></div>`;
  };
  const resetText = value => {
    if (!value) return 'Not provided';
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
  };
  const resetCountdown = value => {
    if (value == null) return 'Unavailable';
    const numeric = Number(value);
    const timestamp = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'Unavailable';
    let minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60000));
    if (!minutes) return 'Reset due';
    const parts = [];
    for (const [unit, size] of [['w', 10080], ['d', 1440], ['h', 60], ['m', 1]]) {
      const amount = Math.floor(minutes / size);
      minutes %= size;
      if (amount) parts.push(`${amount}${unit}`);
    }
    return parts.join(' ');
  };
  const markdownCell = value => String(value).replace(/[\\|`*_[\]<>]/g, character => `\\${character}`).replace(/[\r\n]+/g, ' ');
  function updateUsageStatus() {
    if (disposed || !usageEnabled()) return;
    const defaultModel = codexUsage?.models?.find(model => model.isDefault)?.name;
    const codexWindows = codexUsage?.windows?.filter(window => window.model === 'codex');
    const hourly = primaryWindow(codexWindows?.length ? codexWindows : codexUsage?.windows);
    if (hourly) {
      const remaining = hourly.remainingPercent;
      status.text = `${remaining >= 60 ? '🟢' : remaining >= 25 ? '🟡' : '🔴'} ${displayModel || defaultModel || 'Codex'}: ${remaining}%${hourly.label === 'Weekly' ? ' (Weekly)' : ''}`;
      status.color = undefined;
    } else if (codexError) { status.text = '$(warning) Codex unavailable'; status.color = undefined; }
    else { status.text = '$(pulse) Codex Usage'; status.color = undefined; }
    const shared = codexUsage?.windows?.find(window => window.label === '5 hour') || hourly;
    const resetIndent = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
    const modelLines = (codexUsage?.models || []).map(model => `| ${markdownCell(model.name)} | ${shared ? `${shared.remainingPercent}%` : 'Unavailable'} | ${resetIndent}${shared ? resetCountdown(shared.resetsAt) : 'Unavailable'} |`);
    const modelTable = modelLines.length ? [`| Model | Remaining | ${resetIndent}Reset |`, '| :--- | ---: | :--- |', ...modelLines].join('\n') : null;
    const windowTable = codexUsage?.windows?.length ? [`| Limit | Remaining | ${resetIndent}Reset |`, '| :--- | ---: | :--- |', ...codexUsage.windows.map(window => `| ${markdownCell(window.label)} | ${window.remainingPercent}% | ${resetIndent}${resetCountdown(window.resetsAt)} |`)].join('\n') : null;
    const creditsBalance = codexUsage?.credits?.balance ?? codexUsage?.windows?.map(window => window.credits?.balance).find(value => value != null) ?? null;
    const logo = vscode.Uri.joinPath(context.extensionUri, 'media', 'chatgpt.svg');
    const monthlySummary = describeMonthlyUsage(codexUsage?.usage);
    const lines = [`<table><tr><td><img src="${escapeHtml(logo.toString())}" width="18" height="18" alt="ChatGPT"></td><td><strong>Codex Usage</strong></td></tr></table>`, codexUsage?.plan ? `Plan: **${displayPlan(codexUsage.plan)}**` : null,
      monthlySummary ? `Monthly usage limit: **${monthlySummary.text}** · ${monthlySummary.remainingPercent}% remaining` : 'Monthly usage: **unavailable**',
      creditsBalance != null ? `Workspace credits balance: **${creditsBalance}**` : null,
      modelTable ? '**Available models** · shared Codex quota' : null, modelTable, windowTable,
      codexUsage?.modelsError ? `Models: ${codexUsage.modelsError}` : null,
      codexError ? `Status: ${codexError}` : null,
      displayModel ? `Display model: **${displayModel}** (manually selected; chat selection is not synchronized)` : null,
      '[Choose display model](command:codexUsage.selectDisplayModel)', '[Open Codex Usage](command:codexUsage.open)'].filter(Boolean);
    if (typeof vscode.MarkdownString === 'function') {
      const tooltip = new vscode.MarkdownString(lines.join('\n\n'));
      tooltip.supportHtml = true;
      tooltip.isTrusted = { enabledCommands: ['codexUsage.open', 'codexUsage.selectDisplayModel'] };
      status.tooltip = tooltip;
    } else status.tooltip = lines.join('\n');
  }
  async function refreshUsage(notify = false) {
    if (disposed || !usageEnabled()) return;
    if (!usageRefreshPromise) {
      usageRefreshPromise = (async () => {
        try {
          const executable = resolveCodexExtensionExecutable(vscode.extensions);
          const fresh = await requestCodexUsage(executable);
          if (disposed || !usageEnabled()) return;
          codexUsage = fresh;
          lastUsageRefreshAt = Date.now();
          codexError = codexUsage.windows.length ? null : (fresh.quotaError || 'Codex did not return any quota buckets for this account.');
        } catch (error) {
          if (disposed || !usageEnabled()) return;
          codexUsage = null;
          codexError = error?.message || String(error);
          usageOutput.appendLine(codexError);
        }
        updateUsageStatus();
        dashboard.update();
      })().finally(() => { usageRefreshPromise = null; });
    }
    await usageRefreshPromise;
    if (disposed) return;
    if (notify) await vscode.window.showInformationMessage(codexUsage ? 'Codex usage refreshed.' : `Codex usage unavailable: ${codexError}`);
  }
  function scheduleUsageRefresh() {
    clearTimeout(usageTimer);
    if (disposed || !usageEnabled()) return;
    const interval = refreshSeconds();
    if (!interval) return;
    usageTimer = setTimeout(async () => {
      await refreshUsage(false);
      scheduleUsageRefresh();
    }, interval * 1000);
    usageTimer?.unref?.();
  }
  function renderUsageDashboard() {
    const monthlySummary = describeMonthlyUsage(codexUsage?.usage);
    const monthlyRemaining = monthlySummary ? Number(codexUsage.usage.limit) === 0 ? 0 : 100 - Number(codexUsage.usage.used) / Number(codexUsage.usage.limit) * 100 : null;
    const monthly = monthlySummary
      ? `<div class="quota-row"><div class="row-head"><strong>Monthly usage limit</strong><b>${monthlySummary.remainingPercent}% remaining</b></div><div class="muted">${escapeHtml(monthlySummary.text)}</div>${quotaTrack(monthlyRemaining)}</div>`
      : `<p class="muted">Monthly usage unavailable. ${escapeHtml(codexUsage?.monthlyError || '')}</p>`;
    const rows = codexUsage?.windows?.map(window => {
      const remaining = Math.max(0, Math.min(100, window.remainingPercent));
      return `<div class="quota-row"><div class="row-head"><strong>${escapeHtml(window.label)}</strong><b>${remaining}% left</b></div>${quotaTrack(remaining)}<div class="muted">${100 - remaining}% used · resets ${escapeHtml(resetText(window.resetsAt))}</div></div>`;
    }).join('') || '';
    const modelQuota = codexUsage?.windows?.find(window => window.label === '5 hour') || codexUsage?.windows?.[0];
    const modelRows = (codexUsage?.models || []).map(model => `<div class="model-row"><span>${escapeHtml(model.name)}${model.isDefault ? ' <span class="muted">(Codex default)</span>' : ''}</span><b>${modelQuota ? `${modelQuota.remainingPercent}% · resets ${escapeHtml(resetText(modelQuota.resetsAt))}` : 'Quota unavailable'}</b></div>`).join('');
    const message = codexError || 'Codex has not returned quota buckets for this account.';
    const credits = codexUsage?.credits?.balance ?? codexUsage?.windows?.map(window => window.credits?.balance).find(value => value != null) ?? null;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:820px;margin:auto}h1{font-size:26px;margin:0 0 18px}.card{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:18px;margin:16px 0;background:var(--vscode-sideBar-background)}.plan{margin:12px 0 18px}.quota-row{padding:14px 0;border-bottom:1px solid var(--vscode-panel-border)}.quota-row:last-child{border-bottom:1px solid var(--vscode-panel-border)}.row-head{display:flex;justify-content:space-between;gap:20px;margin-bottom:9px}.track{height:7px;border-radius:8px;background:#e56b6f;margin:0 0 10px;overflow:hidden}.track span{display:block;height:100%;border-radius:0;background:#81cf83}.track span.remaining{background:#81cf83}.muted{color:var(--vscode-descriptionForeground);font-size:12px;margin-top:5px}.credits{padding-top:14px}.model-row{display:flex;justify-content:space-between;gap:20px;padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}.notice{color:var(--vscode-errorForeground)}</style></head><body><h1>Codex Usage</h1><div class="card"><p class="plan"><b>Plan:</b> ${escapeHtml(displayPlan(codexUsage?.plan))}</p><p class="muted">Green: Remaining · Red: Used</p>${monthly}${rows || `<p class="notice">${escapeHtml(message)}</p>`}${credits != null ? `<div class="credits"><p><b>Workspace credits balance:</b> ${escapeHtml(credits)}</p></div>` : ''}</div>${!modelRows && codexUsage?.modelsError ? `<p class="notice">${escapeHtml(codexUsage.modelsError)}</p>` : ''}${modelRows ? `<h2>Available models</h2><div class="card">${modelRows}<p class="muted">These models share the same Codex quota; the percentage is not measured separately per model. “Codex default” is not necessarily the model selected in the current chat.</p></div>` : ''}<p class="muted">Updated: ${escapeHtml(resetText(lastUsageRefreshAt))} · Auto refresh: ${refreshSeconds() ? `${refreshSeconds()} seconds` : 'off'}. <a href="command:codexUsage.refresh">Refresh now</a></p></body></html>`;
  }
  async function openFile(item, preserveFocus = false) {
    if (!reviewEnabled()) return;
    try {
      const { batch, file } = item;
      // Revalidate on each click, including snapshot hashes and junction boundaries.
      const fresh = readBatch(batch.root, batch.relative);
      const current = fresh.files.find(f => f.path === file.path);
      if (!current) throw Error('File no longer belongs to batch');
      const uris = [];
      for (const side of ['before', 'after']) {
        const uri = vscode.Uri.from({ scheme: 'codex-review', path: `/${encodeURIComponent(batch.root)}/${encodeURIComponent(batch.relative)}/${side}/${file.path}` });
        const snapshot = current[side];
        snapshots.set(uri.toString(), snapshot === null ? '' : text(fs.readFileSync(safeFile(batch.root, snapshot.snapshot))));
        uris.push(uri);
      }
      const live = safeFile(batch.root, file.path);
      const liveBytes = fs.existsSync(live) ? fs.readFileSync(live) : null;
      const matches = current.after === null ? liveBytes === null : liveBytes !== null && hash(liveBytes) === current.after.sha256;
      if (!matches) output.appendLine(`${file.path}: working file changed since batch; showing recorded snapshots.`);
      await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], file.path.split('/').pop(), { preview: false, preserveFocus, override: 'default' });
    } catch (error) { output.appendLine(String(error)); vscode.window.showErrorMessage(`Codex Review: ${error.message}`); }
  }
  async function openBatch(batch) {
    // A deletion remains inspectable in the tree, but is not a surviving file tab.
    const files = batch.files.filter(file => file.after !== null);
    for (const file of files) await openFile({ batch, file }, true);
    // preserveFocus preserves keyboard focus, not the active tab. Select first explicitly.
    if (files.length) await openFile({ batch, file: files[0] }, false);
  }
  async function refresh(auto = false) {
    if (!vscode.workspace.isTrusted || !reviewEnabled()) return;
    const next = [];
    const manifests = await vscode.workspace.findFiles('.codex-review/batches/*/manifest.json', '**/node_modules/**', 200);
    for (const uri of manifests) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || uri.scheme !== 'file') continue;
      const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      try { next.push({ ...readBatch(folder.uri.fsPath, relative), root: folder.uri.fsPath, relative }); }
      catch (error) { output.appendLine(`${relative}: ${error.message}`); }
    }
    if (disposed || !reviewEnabled()) return;
    next.sort((a, b) => String(b.createdUtc || '').localeCompare(String(a.createdUtc || '')) || b.relative.localeCompare(a.relative));
    batches = next;
    changed.fire();
    const fresh = batches.filter(b => !seen.has(`${b.root}/${b.relative}`));
    for (const b of fresh) seen.add(`${b.root}/${b.relative}`);
    await context.workspaceState.update('codexReview.seen', [...seen].slice(-1000));
    if (auto && fresh.length && vscode.workspace.getConfiguration('codexReview').get('autoOpen', true)) await openBatch(fresh[0]);
  }
  let watcher;
  let watcherListeners = [];
  function configureReview() {
    clearTimeout(timer);
    watcherListeners.forEach(listener => listener.dispose());
    watcherListeners = [];
    watcher?.dispose();
    watcher = null;
    if (reviewEnabled()) {
      watcher = vscode.workspace.createFileSystemWatcher('**/.codex-review/batches/*/manifest.json');
      watcherListeners = [watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule)];
      refresh(true).catch(e => output.appendLine(String(e)));
    } else { batches = []; snapshots.clear(); changed.fire(); }
  }
  const countdownTimer = setInterval(updateUsageStatus, 60000);
  countdownTimer?.unref?.();
  function schedule() { clearTimeout(timer); timer = setTimeout(() => refresh(true).catch(e => output.appendLine(String(e))), 250); }
  context.subscriptions.push(output, usageOutput, status, changed, dashboard,
    vscode.window.registerTreeDataProvider('codexReview.changes', provider),
    vscode.workspace.registerTextDocumentContentProvider('codex-review', { provideTextDocumentContent: uri => snapshots.get(uri.toString()) || '' }),
    vscode.commands.registerCommand('codexReview.openFile', openFile),
    vscode.commands.registerCommand('codexReview.refresh', () => refresh(false)),
    vscode.commands.registerCommand('codexReview.openLatest', async () => { await refresh(false); if (batches[0]) await openBatch(batches[0]); }),
    vscode.commands.registerCommand('codexUsage.open', () => usageEnabled() ? dashboard.open() : undefined),
    vscode.commands.registerCommand('codexUsage.refresh', () => refreshUsage(true)),
    vscode.commands.registerCommand('codexUsage.selectDisplayModel', async () => {
      if (!usageEnabled()) return;
      const items = [{ label: 'Use Codex default', description: 'Automatically use the default model from the Codex catalog', modelName: '' }, ...(codexUsage?.models || []).map(model => ({ label: model.name, description: 'Display label only; does not change the chat model', modelName: model.name }))];
      const picked = await vscode.window.showQuickPick(items, { title: 'Choose the model name shown in the status bar', placeHolder: 'Choose the same model as your chat; this label is not synchronized automatically' });
      if (!picked) return;
      displayModel = picked.modelName;
      await context.workspaceState.update('codexUsage.displayModel', displayModel);
      updateUsageStatus();
    }),
    { dispose: () => { disposed = true; watcherListeners.forEach(listener => listener.dispose()); watcher?.dispose(); clearTimeout(timer); clearTimeout(usageTimer); clearInterval(countdownTimer); } });
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codexReview.enabled')) configureReview();
      if (event.affectsConfiguration('codexUsage.enabled')) {
        clearTimeout(usageTimer);
        if (usageEnabled()) { status.show(); refreshUsage(false).finally(scheduleUsageRefresh); }
        else { status.hide(); dashboard.close(); codexUsage = null; codexError = null; }
      }
      if (event.affectsConfiguration('codexUsage.refreshIntervalSeconds')) {
        scheduleUsageRefresh();
        dashboard.update();
      }
    }));
  }
  configureReview();
  refreshUsage(false).finally(scheduleUsageRefresh);
}
module.exports = { activate };
