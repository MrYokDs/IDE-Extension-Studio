'use strict';
const { spawn } = require('node:child_process');
const { version } = require('./package.json');
function readCodexCredentials(executable, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = (options.spawn || spawn)(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { reject(new Error('Codex sign-in process could not start')); return; }
    let buffer = '', finished = false;
    const timer = setTimeout(() => finish(new Error('Codex sign-in query timed out')), options.timeoutMs || 25000);
    const finish = (error, credentials) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(credentials);
    };
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Codex sign-in process unavailable')));
    child.on('close', () => { if (!finished) finish(new Error('Codex sign-in process exited before authentication')); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('Codex sign-in initialization failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'getAuthStatus', params: { includeToken: true, refreshToken: false } });
        } else if (message.id === 2) {
          const auth = message.result;
          if (message.error || !['chatgpt', 'chatgptAuthTokens'].includes(auth?.authMethod) || !auth?.authToken) return finish(new Error('Backend usage sign-in unavailable from this Codex version'));
          let accountId = auth.accountId;
          try { accountId ||= JSON.parse(Buffer.from(auth.authToken.split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth']?.chatgpt_account_id; } catch {}
          if (typeof accountId !== 'string' || !accountId) return finish(new Error('Codex signed-in workspace routing unavailable'));
          finish(null, { token: auth.authToken, accountId });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'code_review_usage', title: 'Codex Code Review & Usage', version }, capabilities: { experimentalApi: true } } });
  });
}
module.exports = { readCodexCredentials };
