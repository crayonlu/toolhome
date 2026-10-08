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

- **MCP**：Remote-native 使用 Streamable HTTP；Home-hosted 使用 ToolHome 宿主机上的 stdio；Node-hosted 使用客户端机器上的 stdio，用于只有本机才有的能力，例如本机 Chrome 或本机 Ghidra bridge。`toolhome mcp launch <slug>` 负责运行，任何 MCP 客户端用一行命令即可接入。
- **Hosted CLI**：CLI 必须代表外部平台或 SaaS 控制面，例如 Azure `az`、GitHub `gh`、Tailscale。它支持完整 argv、stdin、timeout、输出限制、allow/deny 规则和 NDJSON 输出。`npm`、`go`、`cargo`、`uv`、`pipx`、`docker`、`cursor` 等安装器或开发工具只是实现细节，不是 Hosted CLI 产品。

服务器放置位置记录在 ToolHome 而不是各 Harness 配置里，因此一台机器的本地服务器只需定义一次，所有客户端共用。Node-hosted 服务器仍以用户自己的权限在该机器上运行，并且在 ToolHome 服务端不可达时不可用。首版明确不包含多租户、Profile、Workspace 或 Project 管理。

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

聚合能力列表在某个上游实时列举失败时改用该 Server 上次成功发现的快照，因此瞬时上游失败不会改变分页期间的目录组成，客户端的续页游标保持有效。这些上游会出现在 `_meta["toolhome/stale-servers"]` 中；实时列举结果始终优先于快照。从未成功列举过该能力、现在又失败的 Server 会出现在 `_meta["toolhome/failed-servers"]` 中；当没有任何上游能提供列表数据时，列表返回协议错误。客户端取消请求时保持上游运行状态。独立入口返回自身上游的错误。

聚合工具名为 `{server_slug}_{encoded_upstream_name}`，上游名称中除 ASCII 字母与数字外的 UTF-8 字节编码为 `-hh`（十六进制），例如 `github.search_code` 映射为 `github_search-5fcode`；超长名称使用稳定哈希缩短。Prompt 名称仍为 `{server_slug}.{upstream_name}`。未知扩展方法在聚合入口使用 `toolhome/{server_slug}/{upstream_method}`；独立入口原样透传。MCP App 若使用原始工具名，ToolHome 会根据 App 资源上下文或全局唯一名称路由；存在同名歧义时应使用独立入口。

当现代 Harness 调用旧式上游时，ToolHome 会把 Tool、Prompt 和 Resource Read 中的 push-style Elicitation、Sampling、Roots 暂停并转换成现代 `input_required` 多轮交互，再恢复同一个上游请求。旧式自定义扩展若在自定义 method 内主动发起私有 server-to-client request，则没有可映射到现代 MRTR 封闭类型集的标准表示；这类扩展应使用 legacy Harness 或升级上游协议。

更多细节见 [架构说明](docs/architecture.md) 和 [协议兼容说明](docs/protocol-compatibility.md)。

## 快速开始

需要 Node.js 24 或更新版本。

```bash
npm install
cp .env.example .env
```

生成两个独立随机值，分别填写 `TOOLHOME_MASTER_KEY` 和首次启动所需的 `TOOLHOME_BOOTSTRAP_CONTROL_KEY`。二者都至少 32 个字符，且不能相同。

```bash
npm run build
set -a
source .env
set +a
npm start
```

打开 `TOOLHOME_PUBLIC_URL`，使用 bootstrap Control API Key 登录 Web 控制台。创建新的 Control Key 后，可以撤销 bootstrap key。

开发模式分别运行：

```bash
npm run dev
npm run dev:web
```

Vite 会把 `/api` 请求代理到 `http://127.0.0.1:3344`。

## Docker

```bash
export TOOLHOME_MASTER_KEY="$(openssl rand -base64 48)"
export TOOLHOME_BOOTSTRAP_CONTROL_KEY="tch_ctl_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
export TOOLHOME_PUBLIC_URL="https://tool.cyncyn.xyz"
export TOOLHOME_ALLOWED_HOSTS="tool.cyncyn.xyz"
docker compose up -d --build
```

生产环境应在 ToolHome 前放置 HTTPS 反向代理。OAuth 回调、URL-based Client ID 和远程 Harness 接入都应使用稳定的 HTTPS `TOOLHOME_PUBLIC_URL`。该值必须是规范 origin，不能包含路径、查询、fragment 或用户名密码。数据保存在 `/data/toolhome.sqlite`，SQLite 使用 WAL 模式。

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
    "Authorization": "Bearer tch_mcp_..."
  }
}
```

只接入 GitHub Server 时使用：

```json
{
  "url": "https://tool.cyncyn.xyz/mcp/github",
  "headers": {
    "Authorization": "Bearer tch_mcp_..."
  }
}
```

Access Key 只能调用 MCP 数据面，不能读取 Server 或 Credential 配置。Control Key 只能调用控制面，不能作为 MCP 身份使用。

ToolHome 的数据面也实现 OAuth 2.1：Harness 可通过 RFC 9728 元数据发现授权服务器，使用 Authorization Code + PKCE 获取只绑定到具体 MCP endpoint 的 access token。

下游 Dynamic Client Registration 返回由主密钥签名的无状态 Client ID，不依赖进程内注册表；使用同一主密钥重启后仍然有效。同时支持 HTTPS URL-based Client Metadata，并限制响应大小、重定向和非公网目标。

## 工具暴露模式

聚合入口 `POST /mcp` 支持两种工具暴露模式。`full` 为默认，直接列出每个启用 Server 的工具；`compact` 需显式启用，只暴露两个工具：

- `search` —— `action: "servers"` 列出可用服务器目录，`action: "find"` 按任务返回排序候选，`action: "describe"` 返回选中工具的完整参数 schema。
- `exec` —— 执行 `search` 返回的某个精确工具，并在真实调用前校验其当前合同。

按入口分别启用，而不是全局开关：

- Host：`TOOLHOME_MCP_TOOL_MODE=compact`。
- 本机 node：`toolhome mcp stdio --tool-mode compact`。

发现只读取入口本地已保存的定义：`search` 不发起上游请求，也不启动子进程；执行只连接被选中的 Server。切换模式后需要重新连接客户端，因为多数客户端会缓存 `tools/list`。独立入口 `/mcp/{server_slug}` 与 `full` 行为保持不变。

**响应预算与兼容边界。** 目录和候选摘要的完整 MCP 结果上限为 8 KiB；完整定义上限为 16 KiB。定义包含参数合同与所需上游说明，超限时返回 `definition_too_large` 和 full/独立入口指引，执行前也遵守该限制。业务结果保留上游内容。带 MCP App 的服务器使用独立入口；要求 Task 的工具和不兼容的 Task 请求会在副作用前给出指引。`definition_changed` 应先 describe，再显式 exec；`may_have_run` 表示此前调用可能已产生副作用，应先核对状态。现代上游的挂起状态由上游管理，当前协议没有通用的挂起调用终止方法。

**检索范围。** 首版采用本地词项排序。纯中文任务通常需要补充英文工具或任务关键词；它未提供原生中文语义检索。固定定义减少初始工具 schema，完整任务成本仍包含发现轮次、完整合同和业务输出，应按实际客户端测量。

**发现速度。** 聚合目录的后续页在 30 秒内复用第一页成功读取的完整目录，按调用者、客户端能力和请求参数隔离。新的遍历仍读取上游；目录或投影变化使复用失效，部分失败仍重试。本机 stdio 入口的普通发现请求读取所属节点的持久化能力镜像，无需启动子进程。本机工具安装变化后运行 `toolhome node status --check` 更新镜像；工具调用仍连接并校验上游实时合同。声明额外能力的客户端保留实时发现。

**本机范围。** Node-hosted Server 仍然只在所属机器上运行，本机 compact 目录只包含放置在该 node 的 Server。启动时本机入口会镜像控制面的工具可见性；若某个 Server 的投影读取失败，它会一直排除在 compact 目录之外（fail closed），直到下次启动或显式刷新。在控制面修改可见性后，本机入口需要重新连接才会生效。

**节点标识。** `toolhome mcp stdio` 会把本地镜像绑定到 `--node` 或 CLI 配置里的 `nodeId`，都没有时退回主机名。请保持该标识稳定：`auth login` 会保留它；若镜像是用别的标识建立的，启动时会直接说明它属于哪个节点标识，而不是只报一个密钥错误。

**回退到 full。** 在 Host 上把 `TOOLHOME_MCP_TOOL_MODE` 设回 `full`（或删除该变量），或去掉 `toolhome mcp stdio --tool-mode`，然后重新连接客户端。无需数据迁移：full 会清除 compact 镜像写入的可见性行，重新暴露全部启用工具。

**定义稳定。** 聚合 `tools/list` 输出规范化后的对象键顺序，数组保持原顺序，因此仅等价 schema 对象的键顺序变化时，序列化字节完全一致。把工具定义放在模型请求前部的客户端可以复用前缀；真实的定义变化仍会改变字节。独立入口保持上游原始键顺序。

**只保留一层发现。** 不要把 ToolHome compact 叠加在已经自带 search/exec 或 Code Mode 的上游之上。二选一：使用 ToolHome `full`/独立入口，或使用上游的完整工具列表。对 Cloudflare API MCP，如需退出 Code Mode，请自行使用其文档给出的 `?codemode=false` URL；ToolHome 不会改写上游 URL 或查询参数，`truncateToolResult` 是另一个独立开关，也不会替你修改。

## 上游鉴权

Remote-native Server 支持：

- Bearer token
- API key header
- 多个自定义 headers
- OAuth 2.1 / OIDC

OAuth/OIDC 使用 MCP TypeScript SDK 的官方认证编排器，覆盖 RFC 9728 发现、Authorization Server/OIDC metadata、PKCE、RFC 9207 issuer 校验、CIMD、DCR、刷新和 RFC 8707 resource indicator。OAuth Credential 与一个 Remote Server 一对一绑定，避免 token 跨 resource 或 issuer 复用。

> 若上游授权服务器声明支持 URL-based Client Metadata 但无法从代理域名抓取（例如 Cloudflare 托管的 MCP），可设置 `TOOLHOME_OAUTH_URL_CLIENT_ID=false` 强制使用 Dynamic Client Registration。

Home-hosted Server 使用 Environment Credential 或 transport 自身的 `env`。

Secret 应放入 Credential，而不是 Remote URL query 或 stdio arguments；后两者属于结构配置，无法可靠判断哪些片段需要脱敏。

## CLI

构建后可以运行 `toolhome`；源码开发时使用 `npm run cli --`。

```bash
export TOOLHOME_URL="https://tool.cyncyn.xyz"
export TOOLHOME_CONTROL_KEY="tch_ctl_<your-control-key>"
# 可选：覆盖默认的 ~/.config/toolhome/config.json 路径
export TOOLHOME_CONFIG="$HOME/.config/toolhome/config.json"
npm run cli -- auth login

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
| `TOOLHOME_HOST`                  | 监听地址                                          | `127.0.0.1`             |
| `TOOLHOME_PORT`                  | 监听端口                                          | `3344`                  |
| `TOOLHOME_PUBLIC_URL`            | 外部可访问的规范 origin，不含 path/query/fragment | `http://127.0.0.1:3344` |
| `TOOLHOME_DATA_DIR`              | SQLite 与运行数据目录                             | `./data`                |
| `TOOLHOME_MASTER_KEY`            | Secret 加密、签名与摘要根密钥，至少 32 字符       | 必填                    |
| `TOOLHOME_BOOTSTRAP_CONTROL_KEY` | 数据库首次启动时写入的 Control Key                | 首次必填                |
| `TOOLHOME_ALLOWED_HOSTS`         | 允许的 Host，逗号分隔                             | Public URL hostname     |
| `TOOLHOME_LOG_LEVEL`             | `debug`、`info`、`warn`、`error`                  | `info`                  |
| `TOOLHOME_WEB_DIR`               | Web 控制台静态文件目录                            | 未启用                  |
| `TOOLHOME_MARKET_DIR`            | Market npm 安装目录                               | `<dataDir>/market`      |
| `TOOLHOME_OAUTH_URL_CLIENT_ID`   | 是否启用 URL-based Client Metadata                | `true`                  |
| `TOOLHOME_MCP_TOOL_MODE`         | 聚合 `/mcp` 工具暴露模式：`full` 或 `compact`     | `full`                  |

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

请备份数据库与 `TOOLHOME_MASTER_KEY`，或保存一份受严格保护的 `--include-secrets` 配置导出。丢失主密钥后，原数据库中的加密 Credential 无法恢复。

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
