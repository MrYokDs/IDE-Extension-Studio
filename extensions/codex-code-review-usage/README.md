# Codex Code Review & Usage 0.4.4

Codex Code Review & Usage combines read-only change review with a Codex Usage panel styled after the AntigravityQuota status-bar monitor. The extension identity is `code-review-tools.code-review-usage`; it replaces `local-modpack.codex-review-bridge`.

When no display model is manually selected, the status bar uses the Codex catalog default model. This is the catalog default, not an observation of the model selected in another chat. The ChatGPT/OpenAI logo in the usage popup identifies the provider; this extension is independently developed. Logo asset: Simple Icons v13.0.0, OpenAI icon (CC0); the OpenAI mark belongs to OpenAI.

## Codex usage

All usage amounts and quota windows are read directly from the ChatGPT backend using the same signed-in account. Five-hour/weekly quotas use `/backend-api/wham/usage`; monthly usage uses the separate monthly endpoint described below. The app-server is used only for sign-in/account metadata and the model catalog, not `account/rateLimits/read`. The executable is bundled with the official **Codex ? OpenAI's coding agent** extension (`openai.chatgpt`), which must be installed and signed in. A separate `codex` command on PATH is not needed. Authentication files are never read or stored. If either backend endpoint fails, the other result is preserved; there is no quota fallback to app-server.

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

## Feature settings (0.4.3)

Search Settings for `Codex Code Review & Usage`. Changes apply immediately.

- `codexReview.enabled`: enable/disable review discovery and commands (default true).
- `codexUsage.enabled`: enable/disable usage requests, status bar and dashboard (default true). An already running request may finish; its result is ignored while disabled.
- `codexUsage.refreshIntervalSeconds`: refresh cadence for both dashboard and background (default 120 seconds, minimum effective 30). Set 0 for manual refresh only. Opening the dashboard still refreshes once.
- `codexReview.autoOpen`: automatically open new review batches when review is enabled.

## Backend-only feasibility (investigated 2026-10-31)

A read-only probe of `/backend-api/codex/models?client_version=0.164.0` with existing Codex authorization returned HTTP 200; the visible model IDs matched `model/list`. The catalog exposes ordering/visibility metadata rather than a direct `isDefault` flag. Production still uses app-server for the model catalog and existing sign-in.

[Independent OAuth registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) is documented, but its tokens target the public API. [Model discovery for that flow](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) uses `/v1/models`. A new independent login has not been verified against the internal quota/monthly endpoints or the relevant Edu plan. Removing app-server completely therefore remains unverified; no new login flow or runtime change was shipped in this investigation.
