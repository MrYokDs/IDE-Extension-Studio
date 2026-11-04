# Changelog

## 0.6.3 — 2026-11-04

- Added request-scoped HTTP/HTTPS CONNECT proxy support for Codex quota, monthly usage and models. Reads IDE proxy settings and proxy environment variables; supports Basic authentication, bypass rules and cancellation. Keeps TLS verification and fixed-origin/no-redirect behavior; no direct fallback on proxy failure.
- Preserved before snapshots in `.codex-review/batches/proxy-20261104-01` and `proxy-tests-20261104-01`; review behavior unchanged.
- Validation: `npm.cmd test` passed all 39 tests, including seven proxy tests with real loopback CONNECT rejection, proxy-only credentials, cancellation and TLS handshake coverage. `git diff --check` passed. Real IDE, corporate proxy, authenticated HTTPS proxy and trusted corporate CA verification remain pending; automated tests are not real IDE verification.
- Relationship inspection scope: extension.js → usage.js → backend-client.js → backend-transport.js, plus monthly usage, quota and model readers; new proxy-transport.js is injected at extension refresh. No unrelated projects or account data inspected.
- Graphify inspection/update unavailable: no configured Graphify tool, command, graph artifacts or `tools/update_graph.py` in this checkout. No graph-based verification claimed.
- The prescribed `.tools/g/Scripts/python.exe` and Python command are absent. Built `releases/code-review-usage-0.6.3-proxy.vsix` using PowerShell/.NET ZIP, reusing the Python packager's manifest and content types with the same source/asset whitelist. Reopened the archive and verified all 23 entries, source bytes, XML and version 0.6.3. VSIX remains a local ignored build artifact.
