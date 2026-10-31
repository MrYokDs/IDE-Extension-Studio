# IDE Extension Studio

Home of **Codex Code Review & Usage**, a VS Code-compatible extension developed and tested for Antigravity IDE.

## Features

- Read-only code review using recorded change batches: pinned filename-only tabs, first file selected, single-column diffs.
- Codex five-hour and weekly quotas, monthly credit usage when available, and model catalog display.
- Status-bar popup and a single updating dashboard with green remaining / red used bars.
- Independent Code Review and Usage switches; configurable refresh interval (120 seconds by default, minimum 30 seconds; 0 for manual refresh).

Requires a trusted workspace. Usage requires the official `openai.chatgpt` extension, installed and signed in. No separate API key is required. Usage monitoring reads account data and does not send model inference requests. Monthly usage relies on an internal ChatGPT endpoint and may become unavailable if that endpoint changes. This project is independent of OpenAI.

See [extension documentation](extensions/codex-code-review-usage/README.md) for behavior, settings, authentication handling and limitations.

## Development

Requirements: Node.js 20+ and Python 3. No npm dependencies are required for the extension or tests.

```sh
npm test
python extensions/codex-code-review-usage/package_vsix.py releases/code-review-usage-0.4.4.vsix
```

Install the generated VSIX using **Extensions: Install from VSIX** and reload the IDE. The packager requires a new output filename for each build.

The extension source directory is `extensions/codex-code-review-usage`. The extension identifier is `code-review-tools.code-review-usage`.

## Repository contents

- `extensions/codex-code-review-usage/`: extension source, tests, icon assets and VSIX packager.
- `tools/Build-ExtensionIcon.ps1`: optional Windows icon rebuild helper.

Local archives, development tools, diagnostic captures, account-specific investigation notes, review snapshots and generated builds are deliberately excluded from Git. Automated tests do not replace visual verification in the IDE.
