# ToolHome v0.5.0

ToolHome now manages MCP servers and hosted CLIs as equal planes. Install platform CLIs on the server once, reuse encrypted credentials, and execute allowed commands remotely with streamed output.

- Hosted CLI registry commands, status probes, argv execution, stdin, cancellation, timeouts, and output limits.
- Market contains 26 MCP entries and 9 CLI entries: Azure, GitHub, Tailscale, Lark, Firecrawl, Wrangler, Vercel, Aliyun, and opt-in host shell.
- Shared npm, Go, GitHub Release, uv, and Docker installers; host and Docker execution modes. Go and uv currently have no curated CLI products. Aliyun's release asset targets linux-amd64.
- GitHub CLI supports device-flow login and persistent state. Fresh self-hosted installations can build the pinned image when no preloaded image is available.
- Updated agent skill covers both planes, working CLI examples, authentication, deployment prerequisites, and installer coverage. The npm package includes the skill.
- Web console includes MCP/CLI plane switching and consolidated navigation. Managed deployment transfers images through CI artifacts.

## Upgrade

Requires Node.js 24+ for the management CLI: `npm install -g toolhome@0.5.0`.

Server image: `ghcr.io/crayonlu/toolhome:v0.5.0`. Docker-backed entries require the Docker socket mount and matching group permissions; persist `/data` and declared CLI state volumes.

Environment variables now use `TOOLHOME_*`. API keys use `tch_ctl_` (control) and `tch_mcp_` (MCP access). Update old environment names and key configuration before upgrading. The CLI reads the legacy `~/.config/mcp-home/config.json` if no current config exists.

## Validation

Server typecheck and 160 tests; web typecheck and 31 tests; production builds; skill validation; real Market installation/execution for the hosted CLI plane and Fetch MCP handshake. CI additionally builds and probes the GitHub CLI fallback image.
