'use strict';
const { randomBytes } = require('node:crypto');

function createUsageDashboard(vscode, { render, refresh, onVisibilityChange = () => {} }) {
  let panel = null;
  let ready = false;
  let disposed = false;
  let listeners = [];
  function update() {
    if (!panel || !ready || disposed) return;
    Promise.resolve(panel.webview.postMessage({ type: 'usage', html: render() })).catch(() => {});
  }
  async function open() {
    if (disposed) return;
    if (panel) panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
    else {
      const current = vscode.window.createWebviewPanel('codexUsage.dashboard', 'Codex Usage', vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true, enableCommandUris: ['codexUsage.refresh']
      });
      panel = current;
      ready = false;
      const nonce = randomBytes(18).toString('hex');
      const script = `<script nonce="${nonce}">
        const bridge = acquireVsCodeApi();
        window.addEventListener('message', event => {
          if (event.data?.type !== 'usage' || typeof event.data.html !== 'string') return;
          const x = window.scrollX, y = window.scrollY;
          const next = new DOMParser().parseFromString(event.data.html, 'text/html');
          document.getElementById('usage-content').innerHTML = next.body.innerHTML;
          requestAnimationFrame(() => window.scrollTo(x, y));
        });
        window.addEventListener('DOMContentLoaded', () => bridge.postMessage({ type: 'ready' }));
      </script>`;
      listeners = [
        current.webview.onDidReceiveMessage(message => {
          if (panel !== current || message?.type !== 'ready') return;
          ready = true;
          update();
        }),
        current.onDidChangeViewState(() => {
          if (panel !== current || disposed) return;
          onVisibilityChange();
          if (current.visible) Promise.resolve(refresh()).catch(() => {});
        }),
        current.onDidDispose(() => {
          if (panel !== current) return;
          panel = null;
          ready = false;
          for (const listener of listeners) listener.dispose();
          listeners = [];
          if (!disposed) onVisibilityChange();
        })
      ];
      current.webview.html = render()
        .replace("style-src 'unsafe-inline'", `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`)
        .replace('</head>', `${script}</head>`)
        .replace('<body>', '<body><main id="usage-content">')
        .replace('</body>', '</main></body>');
      onVisibilityChange();
    }
    await refresh();
  }
  return {
    open, update,
    close: () => panel?.dispose(),
    isVisible: () => Boolean(panel?.visible),
    dispose() { disposed = true; panel?.dispose(); }
  };
}

module.exports = { createUsageDashboard };
