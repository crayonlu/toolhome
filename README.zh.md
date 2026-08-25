# ToolHome

> **🌐 中文 · [English](README.md)**

ToolHome 是一个单用户、可自托管的 MCP 与 Hosted CLI 控制面。你可以在一个地方管理上游 MCP 能力、Azure `az`、GitHub `gh`、Tailscale 等平台 CLI，以及加密保存的凭据。

它同时暴露两种数据面：

- **MCP**：`POST /mcp` 聚合启用的 Server；`POST /mcp/{server_slug}` 保留单个 Server 的原始名称和扩展语义。
- **Hosted CLI**：`POST /cli/{slug}/exec` 在 ToolHome 宿主机或固定版本的 sibling 容器中执行受 allow-list 限制的 argv，并以 NDJSON 流返回 stdout/stderr/exit；`GET /cli/{slug}/status` 执行声明的状态探针。

ToolHome 不为 Claude Code、Codex、Cursor 或其他 Harness 编写专属适配层。MCP 客户端使用标准 Streamable HTTP 与 Bearer 鉴权；管理面和 Hosted CLI 使用 Control Key。

## AI Agent 快速开始

安装 ToolHome skill，让 AI agent 自动掌握 ToolHome 的部署和操作：

```bash
npx skills add crayonlu/toolhome -g -y
```

安装后 agent 会获得全部 CLI 命令、OAuth 授权流程、Market 安装、排错和部署模式的知识，无需手动编写指令。

## Web 控制台

控制台提供与 CLI 完全对齐的功能：服务器与凭据管理、OAuth 授权、Market 一键安装、调用观测、诊断、事件、配置导入导出，以及中英双语和移动端适配。

<div style="display: flex; flex-wrap: wrap; gap: 8px;">
  <img src="docs/screenshots/zh/dashboard.png" width="49%" alt="Dashboard">
  <img src="docs/screenshots/zh/servers.png" width="49%" alt="Servers">
  <img src="docs/screenshots/zh/calls.png" width="49%" alt="Calls">
  <img src="docs/screenshots/zh/credentials.png" width="49%" alt="Credentials">
  <img src="docs/screenshots/zh/market.png" width="49%" alt="Market">
  <img src="docs/screenshots/zh/settings.png" width="49%" alt="Settings">
</div>

移动端：

<div style="display: flex; gap: 8px;">
  <img src="docs/screenshots/zh/market-mobile.png" width="49%" alt="Market mobile">
  <img src="docs/screenshots/zh/dashboard-mobile.png" width="49%" alt="Dashboard mobile">
</div>

## 项目边界

ToolHome 有两个一等平面：

- **MCP**：Remote-native 使用 Streamable HTTP；Home-hosted 使用 ToolHome 宿主机上的 stdio。
- **Hosted CLI**：CLI 必须代表外部平台或 SaaS 控制面，例如 Azure `az`、GitHub `gh`、Tailscale。它支持完整 argv、stdin、timeout、输出限制、allow/deny 规则和 NDJSON 输出。`npm`、`go`、`cargo`、`uv`、`pipx`、`docker`、`cursor` 等安装器或开发工具只是实现细节，不是 Hosted CLI 产品。

必须运行在 Harness 所在本机、依赖该机器浏览器或桌面状态的 MCP/CLI 仍属于 Harness 本地配置。首版明确不包含多租户、Profile、Workspace 或 Project 管理。

## 协议能力

独立入口以无损代理为目标，聚合入口在保持可路由性的前提下虚拟化冲突名称：

- Tools、Prompts、Resources、Resource Templates、Completion
- Resource subscriptions 与 list-changed 通知
- Sampling、Roots、Elicitation 与 2026 MRTR `input_required`
- 最终 Tasks 扩展：`tasks/get`、`tasks/update`、`tasks/cancel`、任务 ID 虚拟化和 `Mcp-Name` 绑定
- MCP Apps，聚合入口保留 `ui://` URI；独立入口保持原始 App 语义
- Logging、Progress、取消与自定义扩展方法
- 2026-07-28 与 2025-era 自动协商，远程 SSE 可显式作为回退

下游 2026 请求保持无状态；2025-era 使用与认证 principal 绑定的持久 Session，保留 initialize 能力声明和双向请求语义。最终 Tasks extension 在 SDK 2.0 尚未注册的部分由隔离兼容层补齐，对外仍是官方 `tasks/*` wire contract。

聚合工具名为 `{server_slug}.{upstream_name}`。未知扩展方法在聚合入口使用 `toolhome/{server_slug}/{upstream_method}`；独立入口原样透传。MCP App 若使用原始工具名，ToolHome 会根据 App 资源上下文或全局唯一名称路由；存在同名歧义时应使用独立入口。

当现代 Harness 调用旧式上游时，ToolHome 会把 Tool、Prompt 和 Resource Read 中的 push-style Elicitation、Sampling、Roots 暂停并转换成现代 `input_required` 多轮交互，再恢复同一个上游请求。旧式自定义扩展若在自定义 method 内主动发起私有 server-to-client request，则没有可映射到现代 MRTR 封闭类型集的标准表示；这类扩展应使用 legacy Harness 或升级上游协议。

更多细节见 [架构说明](docs/architecture.md) 和 [协议兼容说明](docs/protocol-compatibility.md)。

## 快速开始

需要 Node.js 24 或更新版本。

```bash
npm install
cp .env.example .env
```

生成两个独立随机值，分别填写 `MCP_HOME_MASTER_KEY` 和首次启动所需的 `MCP_HOME_BOOTSTRAP_CONTROL_KEY`。二者都至少 32 个字符，且不能相同。

```bash
npm run build
set -a
source .env
set +a
npm start
```

打开 `MCP_HOME_PUBLIC_URL`，使用 bootstrap Control API Key 登录 Web 控制台。创建新的 Control Key 后，可以撤销 bootstrap key。

开发模式分别运行：

```bash
npm run dev
npm run dev:web
```

Vite 会把 `/api` 请求代理到 `http://127.0.0.1:3344`。

## Docker

```bash
export MCP_HOME_MASTER_KEY="$(openssl rand -base64 48)"
export MCP_HOME_BOOTSTRAP_CONTROL_KEY="$(openssl rand -base64 48)"
export MCP_HOME_PUBLIC_URL="https://tool.cyncyn.xyz"
export MCP_HOME_ALLOWED_HOSTS="tool.cyncyn.xyz"
docker compose up -d --build
```

生产环境应在 ToolHome 前放置 HTTPS 反向代理。OAuth 回调、URL-based Client ID 和远程 Harness 接入都应使用稳定的 HTTPS `MCP_HOME_PUBLIC_URL`。该值必须是规范 origin，不能包含路径、查询、fragment 或用户名密码。数据保存在 `/data/toolhome.sqlite`，SQLite 使用 WAL 模式。

Market 安装器隐藏在 curated 能力条目之后，可以使用 npm、Go、GitHub Release archive、uvx 或 Docker recipe；产品表面仍然只有 MCP Server 和 Hosted 平台 CLI。Uvx 条目直接执行持久化 ToolHome 工具目录中的已安装二进制，不会在每次刷新时重新解析包。Docker 条目需要 `docker-compose.yml` 中的 Docker socket 挂载。Hosted CLI 的状态目录由条目显式声明为 Docker named volume，ToolHome 不会默认挂载用户本机的认证目录。

## CI/CD

GitHub Actions（`.github/workflows/ci.yml`）在 push 到 main 或打 tag 时自动执行：

1. **test**：服务端 check + test，前端 typecheck + test
2. **docker**：构建 dist -> `docker build` -> 推送 `ghcr.io/crayonlu/toolhome:latest`（tag 额外打 `:v*` 版本标签）
3. **deploy**：SSH 到服务器 `docker compose pull && up -d`

部署需要三个 GitHub Secret：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_KEY`（SSH 私钥）。GHCR 镜像包需设为 Public（首次推送后在 Package Settings 里改）。

## Market

Market 提供 curated 的 MCP Server 和 Hosted 平台 CLI。一键安装会创建加密 Credential，以及对应的 Server 或 CLI record：

```bash
npm run cli -- market list
npm run cli -- market install resend --set RESEND_API_KEY=re_xxx
npm run cli -- market install gh-cli --set GH_TOKEN=ghp_xxx
npm run cli -- market uninstall gh-cli
```

- MCP 条目可以是 remote、npm、uvx 或 Docker 实现。
- Hosted CLI 条目包含 Azure `az`、GitHub `gh`、Tailscale；它们固定平台 artifact 版本，声明 argv allow-list，并声明如何把已保存凭据映射给 CLI。
- CLI 可以使用 bearer token（`GH_TOKEN`）、Env Credential 中选定的变量（Azure service principal），或共享 MCP OAuth 授权流程完成后的 access token。
- Web 控制台的 Market 页提供相同流程；MCP/CLI 是平面 switch，切换后只显示当前平面的条目和记录。

## Harness 接入

先在控制台或 CLI 创建 MCP Access API Key。聚合入口的通用配置等价于：

```json
{
  "url": "https://tool.cyncyn.xyz/mcp",
  "headers": {
    "Authorization": "Bearer mch_mcp_..."
  }
}
```

只接入 GitHub Server 时使用：

```json
{
  "url": "https://tool.cyncyn.xyz/mcp/github",
  "headers": {
    "Authorization": "Bearer mch_mcp_..."
  }
}
```

Access Key 只能调用 MCP 数据面，不能读取 Server 或 Credential 配置。Control Key 只能调用控制面，不能作为 MCP 身份使用。

ToolHome 的数据面也实现 OAuth 2.1：Harness 可通过 RFC 9728 元数据发现授权服务器，使用 Authorization Code + PKCE 获取只绑定到具体 MCP endpoint 的 access token。

下游 Dynamic Client Registration 返回由主密钥签名的无状态 Client ID，不依赖进程内注册表；使用同一主密钥重启后仍然有效。同时支持 HTTPS URL-based Client Metadata，并限制响应大小、重定向和非公网目标。

## 上游鉴权

Remote-native Server 支持：

- Bearer token
- API key header
- 多个自定义 headers
- OAuth 2.1 / OIDC

OAuth/OIDC 使用 MCP TypeScript SDK 的官方认证编排器，覆盖 RFC 9728 发现、Authorization Server/OIDC metadata、PKCE、RFC 9207 issuer 校验、CIMD、DCR、刷新和 RFC 8707 resource indicator。OAuth Credential 与一个 Remote Server 一对一绑定，避免 token 跨 resource 或 issuer 复用。

> 若上游授权服务器声明支持 URL-based Client Metadata 但无法从代理域名抓取（例如 Cloudflare 托管的 MCP），可设置 `MCP_HOME_OAUTH_URL_CLIENT_ID=false` 强制使用 Dynamic Client Registration。

Home-hosted Server 使用 Environment Credential 或 transport 自身的 `env`。

Secret 应放入 Credential，而不是 Remote URL query 或 stdio arguments；后两者属于结构配置，无法可靠判断哪些片段需要脱敏。

## CLI

构建后可以运行 `toolhome`；源码开发时使用 `npm run cli --`。

```bash
npm run cli -- auth login \
  --url https://tool.cyncyn.xyz \
  --control-key "$MCP_HOME_CONTROL_KEY"

npm run cli -- server list
npm run cli -- server add ./server.json
npm run cli -- credential authorize cloudflare
npm run cli -- access-key create laptop
npm run cli -- endpoint aggregate
npm run cli -- doctor
```

`credential authorize <name>` 按凭据名（或 id）解析，自动在浏览器打开授权链接并保持等待，直到授权成功、失败或超时：

```bash
npm run cli -- credential authorize notion --server notion   # 指定 server（可省略，自动解析）
npm run cli -- credential authorize notion --force            # 清掉旧 client 重新授权
npm run cli -- credential authorize notion --no-open          # 不自动打开浏览器
npm run cli -- credential authorize notion --no-wait          # 只打印链接，不等待
npm run cli -- credential authorize notion --timeout 300      # 等待时长（秒，默认 600）
```

CLI 为每项 Control API 能力提供命令，并保留通用入口：

```bash
npm run cli -- api GET /api/v1/openapi.json
```

默认导出只包含可审阅的脱敏配置，不能用于恢复；Credential payload、静态 HTTP Header 值和 stdio transport env 值都会被隐藏。显式包含 Secret 时，CLI 以 `0600` 权限写文件；导入会在一个 SQLite 事务中重建 Credential、重新映射关联 ID，并在任一步失败时整体回滚。

```bash
npm run cli -- config export backup.json --include-secrets
npm run cli -- config import backup.json
```

备份文件包含明文 Secret，应使用与主密钥同等级别的保护。为避免 Secret 意外进入终端日志，`--include-secrets` 必须同时提供目标文件；CLI 会在写入后强制设置 `0600`。日常审阅可省略 `--include-secrets`。

## 配置

| 环境变量                         | 说明                                              | 默认值                  |
| -------------------------------- | ------------------------------------------------- | ----------------------- |
| `MCP_HOME_HOST`                  | 监听地址                                          | `127.0.0.1`             |
| `MCP_HOME_PORT`                  | 监听端口                                          | `3344`                  |
| `MCP_HOME_PUBLIC_URL`            | 外部可访问的规范 origin，不含 path/query/fragment | `http://127.0.0.1:3344` |
| `MCP_HOME_DATA_DIR`              | SQLite 与运行数据目录                             | `./data`                |
| `MCP_HOME_MASTER_KEY`            | Secret 加密、签名与摘要根密钥，至少 32 字符       | 必填                    |
| `MCP_HOME_BOOTSTRAP_CONTROL_KEY` | 数据库首次启动时写入的 Control Key                | 首次必填                |
| `MCP_HOME_ALLOWED_HOSTS`         | 允许的 Host，逗号分隔                             | Public URL hostname     |
| `MCP_HOME_LOG_LEVEL`             | `debug`、`info`、`warn`、`error`                  | `info`                  |
| `MCP_HOME_WEB_DIR`               | Web 控制台静态文件目录                            | 未启用                  |
| `MCP_HOME_MARKET_DIR`            | Market npm 安装目录                               | `<dataDir>/market`      |
| `MCP_HOME_OAUTH_URL_CLIENT_ID`   | 是否启用 URL-based Client Metadata                | `true`                  |

## 安全模型

- 上游 Secret 使用 AES-256-GCM 加密后写入 SQLite。
- 数据库保存加密的主密钥校验标记；误用不同主密钥时启动会立即失败，避免静默锁死现有 API Key。
- API Key 只保存 HMAC 摘要，完整 Secret 仅创建时返回。
- Control 与 MCP Access Key 使用不同前缀和验证域。
- Web 控制台把 Control Key 换成短期、HttpOnly、SameSite=Strict session cookie。
- 下游 OAuth token 具有精确 endpoint audience；聚合 token 不能调用独立 endpoint，反之亦然。
- OAuth callback 校验 state、PKCE、issuer 与发现状态。
- URL-based client metadata 会拒绝私网和非安全目标，并固定使用已校验的公网解析地址发起 HTTPS 请求，降低 SSRF 与 DNS rebinding 风险。
- 下游 DCR Client ID 使用主密钥签名，可跨进程重启验证且不在数据库保存 Client Secret。
- 诊断事件保留最近约 10,000 条；Home-hosted stderr 进入事件流前会按 transport env 与 Environment Credential 值脱敏。

请备份数据库与 `MCP_HOME_MASTER_KEY`，或保存一份受严格保护的 `--include-secrets` 配置导出。丢失主密钥后，原数据库中的加密 Credential 无法恢复。

## 工程命令

```bash
npm run check
npm run format:check
npm run build
npm run test
npm run test:real
```

`npm run test:real` 优先启动构建后的真实 ToolHome 进程，并连接 Home-hosted stdio 与 Remote-native HTTP fixture。它使用官方 MCP Client 验证聚合/独立入口、modern/legacy Harness、Progress、取消、list-changed、MRTR、Tasks 和鉴权边界；没有构建产物时回退到源码入口，便于本地诊断。

`/healthz` 只表示进程存活；`/readyz` 在运行状态不可用时返回 `503`。

## License

[MIT](LICENSE)
