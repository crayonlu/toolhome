# Protocol compatibility

ToolHome 的原则是：独立入口无损，聚合入口只做可逆路由变换。

| Capability                     | Individual endpoint          | Aggregate endpoint                              |
| ------------------------------ | ---------------------------- | ----------------------------------------------- |
| Tools                          | 原名、实时 list、call        | `{slug}.{name}`，实时 list/call                 |
| Prompts                        | 原名、实时 list/get          | `{slug}.{name}`                                 |
| Resources                      | 原 URI、template、read       | 可逆虚拟 URI/template                           |
| Completion                     | 原样                         | 反向映射 prompt/template reference              |
| Subscriptions                  | subscribe/unsubscribe/listen | 按虚拟 URI 分组到 upstream                      |
| List changed                   | 转发                         | 刷新 snapshot 后发布聚合通知                    |
| Progress / cancellation        | 转发并绑定 signal            | 转发并绑定 signal                               |
| Sampling / Roots / Elicitation | 按下游能力桥接               | 按下游能力 profile 路由                         |
| MRTR `input_required`          | 签名 requestState            | requestState 额外绑定 upstream server           |
| Tasks extension                | 原 task ID                   | 可逆虚拟 task ID                                |
| MCP Apps                       | 原 `ui://` 和 tool 名        | 虚拟 `ui://`；原名调用按 App 上下文或唯一性路由 |
| Logging                        | setLevel 与相关通知          | setLevel fan-out；相关通知转发                  |
| Unknown extension              | method 原样                  | `toolhome/{slug}/{method}`                      |

## 版本策略

ToolHome 使用 MCP TypeScript SDK 2.0.0，同时服务 2026-07-28 modern 协议和 2025-era legacy 协议。每个 upstream Server 可以选择 `auto`、`modern` 或 `legacy`。

`auto` 不会用 2026 body 直接污染旧 Server：SDK 先执行 discovery probe，并在需要时使用独立的 stdio probe 进程或干净的 legacy initialize 路径。

## ClientCapabilities isolation

2026-07-28 把 ClientCapabilities 放到每个请求的 `_meta` envelope。ToolHome 从当前请求 context 读取它，并使用能力 JSON fingerprint 选择 upstream connection。2025-era 使用 stateful Streamable HTTP Session 保留 initialize 中声明的 capabilities；Session ID 与认证 principal 绑定，不能跨 Access Key 或 OAuth client 复用。

这保证：

- 没声明 Sampling 的 Harness 不会共享一条声明了 Sampling 的 upstream connection。
- MCP Apps catalog 可以根据 UI extension capability 动态返回。
- Roots、Elicitation 和自定义 extension 的行为与当前 Harness 对齐。

## 跨协议时代交互

现代协议移除了 server-to-client JSON-RPC request，改用 `input_required` 多轮返回；旧式上游仍可能在一个 Tool、Prompt 或 Resource Read 执行过程中主动请求 Elicitation、Sampling 或 Roots。ToolHome 对这三个允许 MRTR 的方法维护一个有界、可取消的 suspended round：

1. 保持原来的旧式上游请求和连接槽，不重新执行副作用。
2. 收集一个或多个 push request，返回现代 `input_required`。
3. 用签名 request state 绑定 method、upstream 和下游 client。
4. Harness 回传 bare `inputResponses` 后恢复原请求，支持多轮重复。
5. 达到 `maxTotalTimeoutMs`、取消或重启时，终止上游请求并释放连接。

现代协议只允许 `tools/call`、`prompts/get`、`resources/read` 返回 `input_required`，且 InputRequest 类型集是封闭的。因此，旧式自定义 method 内的私有 server-to-client request 无法被无损转换成现代 MRTR；独立入口可以在 legacy-to-legacy 链路上原样代理，但不能突破现代协议本身的方向限制。

## Tasks

最终 Tasks extension ID 为 `io.modelcontextprotocol/tasks`。它没有 `tasks/list`；控制面只有 `tasks/get`、`tasks/update`、`tasks/cancel`。Task 使用扁平字段 `taskId`、`status`、`statusMessage?`、`createdAt`、`lastUpdatedAt`、`ttlMs`、`pollIntervalMs?`。聚合 tool call 返回 task 时，ToolHome 把 task ID 编码为带 slug 的虚拟 ID，后续控制请求由虚拟 ID 确定 upstream。

Task control request 必须携带 `Mcp-Name` header，值与 request body 的 `taskId` 一致。非安全 ASCII 值使用 MCP 的 base64 header encoding。

TypeScript SDK 2.0.0 尚未把最终 Tasks extension 注册进 2026 core method registry。ToolHome 在 HTTP 边界把这三个已验证请求映射为内部 extension method，使 SDK fallback 能处理它们；对 Harness 和 upstream 暴露的 method、header 与 body 均保持官方 wire contract。

Task status notification 是可选优化；轮询 task method 是兼容基线。当前官方 SDK 对 extension notification filter 的高阶支持仍有限，因此 ToolHome 不把 task notification 作为正确性前提。

## MCP Apps

普通资源使用 `toolhome://`，App 资源使用 `ui://toolhome/...`，因此 Host 仍能识别 MCP Apps。Tool metadata 的 `ui.resourceUri` 和旧 `ui/resourceUri` 都会改写。

App 内代码可能以原始名称调用 tool。聚合入口按以下顺序路由：

1. 从 App request metadata 的虚拟 resource URI 取得 slug。
2. 若无上下文，查找全局唯一的原始 tool 名。
3. 存在同名冲突时拒绝歧义调用，并要求使用独立 endpoint。

对依赖私有 Host 行为或存在同名工具的 App，应直接配置 `/mcp/{slug}`。

## 自定义扩展

独立 endpoint 的 fallback request/notification handler 原样发送未知 method 和 params。聚合 endpoint 需要 method 自带 server namespace，否则无法在多个 upstream 之间做确定路由。

扩展 capability 也会命名空间化；Tasks 与 UI 是聚合感知扩展，保留标准 extension ID 并合并 settings。
