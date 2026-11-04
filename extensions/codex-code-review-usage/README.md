# Codex Code Review & Usage 0.6.3

## Proxy connections

Codex quota, monthly usage and model catalog requests read the IDE's `http.proxy` on every refresh. For example, set `"http.proxy": "http://127.0.0.1:7890"` in user settings, then run **Codex Usage: Refresh**. Otherwise the extension uses `https_proxy`, `HTTPS_PROXY`, `http_proxy`, then `HTTP_PROXY` from the extension host environment. Restart the IDE after changing environment variables.

HTTP and HTTPS proxies use CONNECT tunnels with TLS certificate verification enabled. Basic authentication in a proxy URL and `http.proxyAuthorization` are supported; proxy credentials are sent only to the proxy, while account authorization travels inside the encrypted tunnel. Credentials are not saved or logged by the extension. Avoid storing proxy passwords in shared workspace settings.

`http.noProxy` (when nonempty), or `no_proxy`/`NO_PROXY`, bypasses the explicit proxy for matching hosts, domain suffixes, optional ports, or `*`. `http.proxySupport: "off"` disables this extension's explicit proxy routing. Direct requests continue through the host's existing fetch transport. Failed proxy connections do not retry directly. Redirects remain forbidden and requests retain the existing timeout.

PAC/WPAD and OS proxy auto-discovery are not implemented by this adapter; configure an explicit proxy URL. SOCKS and integrated NTLM/Kerberos authentication are unsupported. Corporate TLS interception requires a CA trusted by the Node extension host (for example through `NODE_EXTRA_CA_CERTS` set before launching the IDE); this adapter never disables certificate verification. Antigravity's local loopback service is unchanged. Credential discovery still uses the official Codex app-server and its own network configuration.

References: [VS Code network configuration](https://code.visualstudio.com/docs/setup/network), [Node HTTPS agent](https://github.com/nodejs/node/blob/main/doc/api/https.md).

Codex Code Review & Usage combines read-only change review with a Codex Usage panel styled after the AntigravityQuota status-bar monitor. The extension identity is `code-review-tools.code-review-usage`; it replaces `local-modpack.codex-review-bridge`.

When no display model is manually selected, the status bar uses the Codex catalog default model. This is the catalog default, not an observation of the model selected in another chat. The ChatGPT/OpenAI logo in the usage popup identifies the provider; this extension is independently developed. Logo asset: Simple Icons v13.0.0, OpenAI icon (CC0); the OpenAI mark belongs to OpenAI.

## Codex usage

All usage amounts and quota windows are read directly from the ChatGPT backend using the same signed-in account. Five-hour/weekly quotas use `/backend-api/wham/usage`; monthly usage uses the separate monthly endpoint described below. For Usage, the app-server is used only for `getAuthStatus` sign-in, then closed before backend reads. Account/read, model/list and account/rateLimits/read are not called. The executable is bundled with the official **Codex ? OpenAI's coding agent** extension (`openai.chatgpt`), which must be installed and signed in. A separate `codex` command on PATH is not needed. Authentication files are never read or stored. If either backend endpoint fails, the other result is preserved; there is no quota fallback to app-server.

Monthly usage uses the same read-only workspace monthly-usage endpoint found in the Codex desktop app. The extension obtains the existing account's authorization through the app-server `getAuthStatus` method, holds it only in memory, and sends it only to the fixed ChatGPT backend origin with redirects disabled. Account identity is checked before the request. Monthly amounts use the desktop's rounding and number grouping, for example **15 of 10,000 credits used**. This is an internal desktop endpoint rather than a documented stable third-party API; if it becomes unavailable, quota windows continue working and monthly usage shows unavailable. Tokens are never written to extension state, output logs, or the dashboard.

Education plan codes are expanded in both popup and dashboard: `edu` appears as **ChatGPT Education (Edu)**. Dashboard bars show **green = remaining** and **red = used**, with the same proportions for monthly, five-hour and weekly quotas. Monthly bar proportions retain the actual fractional usage even when the displayed percentage rounds to 100%. Education plan reference: https://learn.chatgpt.com/docs/enterprise/education-plans

The right-side status-bar item shows the five-hour remaining percentage with a green/yellow/red dot. Hover to see the available model catalog with the shared account quota and reset time; click to open or return to the single full dashboard tab. The dashboard and status bar receive the same snapshot. Automatic refresh uses the configured interval in both visible and background modes, defaulting to 120 seconds. Change `codexUsage.refreshIntervalSeconds` or set it to `0` to disable polling. Opening the dashboard, returning to it, or clicking **Refresh now** also refreshes data. Repeated clicks share any request already in progress. Updates preserve the dashboard's scroll position and do not move editor focus.

Codex does not expose the model selected in another extension's active chat through this integration, so the dashboard distinguishes the Codex default from the active chat selection. These are polled snapshots rather than server-pushed real-time updates.

Codex reports quota buckets such as `codex`; these are not always model-specific. The extension shows the labels and values returned by Codex and does not infer per-model limits. Token activity totals and full conversation histories are not shown in this quota dashboard.

## Change review

- Opens each surviving changed file in a separate pinned tab, selects the first file, and uses a single-column diff.
- Keeps deleted files in the change list without opening a tab for them.
- Shows recorded snapshots if the working file changed after the batch was created.
- Has no Accept/Reject, CodeLens, or hunk controls.

Requires a trusted workspace. Review snapshots are local under `.codex-review/batches`.

Auto-open is triggered by a published review batch, not every file save or arbitrary edits by another extension. The editing agent/tool must capture before snapshots before editing, then publish after finishing:

```sh
node extensions/codex-code-review-usage/batch.js begin . unique-id "Change title" path/to/file.js
# edit and validate the listed files
node extensions/codex-code-review-usage/batch.js publish . unique-id
```

The helper is also included as `batch.js` in the installed extension. Set both `codexReview.enabled` and `codexReview.autoOpen` to true. Use **Codex Review: Open Latest Batch** to reopen a batch already seen. Existing edits without before snapshots cannot be reconstructed by this helper.

## Feature settings (0.4.3)

Search Settings for `Codex Code Review & Usage`. Changes apply immediately.

- `codexReview.enabled`: enable/disable review discovery and commands (default true).
- `codexUsage.enabled`: enable/disable usage requests, status bar and dashboard (default true). An already running request may finish; its result is ignored while disabled.
- `codexUsage.refreshIntervalSeconds`: refresh cadence for both dashboard and background (default 120 seconds, minimum effective 30). Set 0 for manual refresh only. Opening the dashboard still refreshes once.
- `codexReview.autoOpen`: automatically open new review batches when review is enabled.

## Backend-only feasibility (investigated 2026-10-31)

A read-only probe of `/backend-api/codex/models?client_version=0.164.0` with existing Codex authorization returned HTTP 200; the visible model IDs matched `model/list`. The catalog exposes ordering/visibility metadata rather than a direct `isDefault` flag. Version 0.4.6 reads the model catalog directly. The default is derived from the first visible model in ascending priority order; it is not a server-provided isDefault field or an observation of the active chat.

[Independent OAuth registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) is documented, but its tokens target the public API. [Model discovery for that flow](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) uses `/v1/models`. A new independent login has not been verified against the internal quota/monthly endpoints or the relevant Edu plan. Removing app-server completely therefore remains unverified; no new login flow or runtime change was shipped in this investigation.

The independent OAuth trial was blocked before authorization by the workspace policy (`3p_delegated_access_policy_denied`). No independent access token was obtained, so internal quota/monthly compatibility remains untested. Keep existing Codex sign-in integration for this workspace unless its administrator enables the separate app authorization; model discovery now uses the backend with the existing authorization.

## Data boundary (0.4.6)

`codex-auth.js` obtains credentials in memory through the installed Codex sign-in, and closes its child process before returning. `backend-client.js` coordinates independent quota, monthly and model reads. `backend-transport.js` owns endpoint paths, origin restrictions, authentication headers, redirects, cancellation and HTTP transport; schema mapping stays in focused modules. An endpoint failure does not discard other successful results. No credentials are returned to UI state. Models use the verified catalog compatibility parameter `client_version=0.164.0`, maintained centrally with endpoint routing. Independent OAuth remains disabled; no organization policy changes are required.

## Required extension

Only `openai.chatgpt` is required for existing Codex sign-in. antigravityQuota is not a dependency and its API/data is not used. An older separately installed copy is not automatically uninstalled; disable it if you want to avoid duplicate quota items.

## Antigravity IDE (0.6.0)

On Windows, **Antigravity IDE** must be running, signed in, and have its language server initialized (open the agent panel if needed). The separate white-icon Antigravity desktop app is not required and is not used as fallback. No antigravityQuota dependency is needed.

The extension discovers only the IDE-installed language_server_windows_x64.exe with subclient_type=ide and its process-owned loopback listeners. It prefers the server parented by the current extension host; when multiple unrelated IDE servers make automatic selection ambiguous, it reports an error instead of mixing accounts. `antigravityUsage.serverProcessId` can select the intended server explicitly; this ID must be updated if the process restarts. Keep 0 for automatic selection.

Read-only RetrieveUserQuotaSummary (forceRefresh=false) and GetUserStatus supply group weekly/five-hour quotas and model snapshots. Runtime CSRF is in memory only; no credential files or browser cookies are read. Local HTTPS retains a request-scoped self-signed certificate exception for 127.0.0.1 only. Source is labeled Antigravity IDE local service. Missing token totals/credit balances are not inferred from percentages.

The separate dashboard/status item and antigravityUsage.enabled / refreshIntervalSeconds settings are unchanged. Codex and code review work independently. Current source detection supports Windows only; the internal service may change between IDE releases.

## Status display (0.6.0)

Open each dashboard from its bottom status-bar item; dashboard headers no longer contain provider navigation. Codex window headings use Five hour/Weekly labels without the redundant codex bucket prefix. Antigravity displays the first model by default; Choose Display Model in its popup/command palette stores a manual display choice per workspace, without changing the active chat model. Each status item normally displays five-hour remaining quota. If the corresponding weekly remaining percentage is zero, it displays 0% (Weekly) instead. Antigravity uses the selected model's matching quota family, so an exhausted Gemini pool does not mask an available Claude/GPT pool.

## Codex Projects (0.6.0)

Open **Codex Projects** in the Activity Bar for a separate Projects & Chats tree. The default scope is Current workspace; use the filter button or Codex Projects: Choose Scope to show All projects. Refresh reads up to 1,000 non-archived chat titles and recorded working folders through app-server thread/list with useStateDbOnly=true. No turns/transcripts are requested and chat metadata is not saved in the repository. Only opening/refreshing the view performs a list request, not Usage polling.

Folders group by their recorded cwd, which can differ from custom project labels/membership in the desktop app; worktrees or migrated paths can appear separately. Clicking a chat routes through the installed official extension URI handler (/local/thread-id). This is an internal IDE integration verified against installed Codex 26.1021.22027 and can change in later versions; live UI navigation remains a visual verification step. The original Codex Chats list is not patched or replaced.

Settings: codexProjects.enabled (true) and codexProjects.scope (workspace/all). Selecting another project does not open its files or switch IDE workspaces automatically. Displaying a title list and navigating to an existing chat does not send a new model turn.

Open the project list with Ctrl+Shift+P → Codex Projects: Open. After installing an update, run Developer: Reload Window if the command or activity-bar icon is missing. This is a separate view from the official Codex Chats panel.
