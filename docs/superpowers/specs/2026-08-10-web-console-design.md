# ToolHome Web Console — 设计方案

**日期**: 2026-08-10
**状态**: 待评审

## 1. 目标

为 ToolHome（自托管 MCP 网关）设计并实现一个 Web 控制台，替代被删除的旧版（`4af9bc7` "drop the web console, keep CLI only"）。设计气质为**现代、克制、高级、无边界**；功能与 CLI **完全对齐、不简化**。

## 2. 设计方向

核心意象：一块安静的毛玻璃仪表盘——内容居中收束（max-width 容器），没有卡片边框、没有硬分割线、没有圆角；间距紧凑、信息饱满，不做空洞的大片留白。层级靠**空间、透明度、毛玻璃景深、elevation** 表达，而非 1px 描边。

参考气质：Linear / Vercel——黑白灰底 + 一个鲜艳强调色 + 全直角 + 几乎无边框。

### 2.1 设计原则（来自 Apple Design skill）

- **Translucent materials**：侧边栏/顶栏用 `backdrop-filter: blur(20px) saturate(180%)` 悬浮毛玻璃层，内容从下方滚过；大表面更厚（更强模糊 + 更深阴影），小控件更轻。
- **无边界感**：不用 `border` 分隔；用留白、轻微 elevation、滚动边缘渐隐（gradient mask）区分区域。
- **Spatial consistency**：面板从哪来回到哪去（右侧抽屉滑入→滑出）；弹层从触发元素缩放展开（`transform-origin` 指向按钮）。
- **Restraint**：纯黑白灰为主，电光蓝仅用于主操作、激活态、链接、焦点；状态色（ok/warn/error）低饱和但可辨认。
- **Type**：系统字体栈；大标题负字距 `-0.02em` + 紧行高，正文 `0` 字距、舒适行高；层级靠字重。
- **Motion**：Motion 库弹簧动画；默认 `damping 1.0`（临界阻尼），仅带惯性的手势用 `0.8`；动画可中断、从当前值继续；响应 `prefers-reduced-motion` 降级为淡入淡出。

### 2.2 设计 Token

深色模式（默认）：

| Token              | 值                                                     |
| ------------------ | ------------------------------------------------------ |
| 背景               | `#0E0E10`                                              |
| 表面               | `#17171A`                                              |
| 毛玻璃             | `rgba(255,255,255,0.05)` + `blur(20px) saturate(180%)` |
| 文字主/次/弱       | `#EDEDEF` / `#A0A0A8` / `#6B6B73`                      |
| **强调色**         | **`#3D7BFF`（电光蓝）**                                |
| 成功 / 警告 / 错误 | `#3FBF7F` / `#D9A03F` / `#D96A5E`（降饱和）            |
| **Radius**         | **`0`（全直角）**                                      |
| **边框**           | **无**                                                 |

浅色模式同比例反转（`#FAFAFA` 底 + 深灰文字），同一套 token 通过 CSS 变量切换。

## 3. 技术栈与架构

- **React 19 + Vite + TypeScript + Tailwind CSS v4**（与前两版技术栈一致）
- **自研设计系统**：视觉层 100% 自写；交互底层用 **Base UI**（`@base-ui/react`，headless 无样式原语：Dialog、Menu、Select、Switch、Tabs、Toast、Tooltip、Field）
- **Motion**（Framer Motion 团队）做弹簧动画
- **TanStack Query**：服务端数据缓存 + events/diagnostics 轮询
- **react-router**：路由
- **i18n**：`zh` / `en` 词典 + 切换器（默认跟随系统）

### 3.1 布局原则

- **居中**：主内容为居中 max-width 容器（`max-w-6xl`），列表/表格/表单共用同一居中列。
- **紧凑密度**：基础 4px 步进，常规间隙 8–16px，区块间距 16–24px；表格行高 ~44px、卡片内边距 16px、侧边栏 200–220px；无大片留白。

### 3.2 移动端（一等公民）

- 底部 Tab 导航（概览/服务器/凭据/更多）+ 顶部毛玻璃栏
- 触控目标 ≥44px；表格 <640px 转卡片流；模态/详情为底部抽屉
- `env(safe-area-inset-*)` 适配；无横向滚动；`prefers-reduced-motion` 降级

### 3.3 目录结构

```
web/
  src/
    app/                路由、布局、主题、i18n provider
    api/                Control API client（fetch + Bearer Control Key）
    features/
      servers/          server 列表/详情/表单/能力快照/日志
      credentials/      credential CRUD + OAuth 授权流
      access-keys/      访问密钥
      control-keys/     控制密钥
      endpoints/        端点展示
      diagnostics/      doctor 诊断
      events/           事件流
      settings/         配置导出导入/语言/主题/原始 API 控制台
    components/ui/      base 组件（Button/Sheet/Toast/Badge/Input/...）
    i18n/               zh.ts / en.ts + 切换器
  vite.config.ts
```

### 3.2 部署形态

`npm run build:web` 输出静态文件 → 服务端托管 `/`（恢复 `src/app.ts` 静态托管）。Dockerfile 构建前端后 COPY 进镜像，单容器部署。`package.json` 增加 `build:web` / `dev:web` 脚本，`build` 串联 server + web。

## 4. 信息架构（与 CLI 功能全量对齐）

| 页面                  | 覆盖的 CLI 功能                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录                  | `auth login`（Control Key）                                                                                                                           |
| 概览 Dashboard        | `status`（服务器/凭据/密钥计数、整体健康、聚合+各独立端点、一键复制）                                                                                 |
| 服务器 Servers        | `server list/get/add/update/delete` · `enable/disable/refresh/restart/test` · `capability` · `status/logs`；详情页 Tab：概览 / 能力快照 / 日志 / 设置 |
| 凭据 Credentials      | `credential list/get/add/update/delete` · `test/revoke` · `authorize`（OAuth 完整等待流）                                                             |
| 访问密钥 Access Keys  | `access-key create/list/revoke`（创建后一次性明文展示 + 复制）                                                                                        |
| 控制密钥 Control Keys | `control-key create/list/revoke`（设置-高级，二次确认）                                                                                               |
| 端点 Endpoints        | `endpoint aggregate/server`（聚合 + 每服务器 URL，复制按钮）                                                                                          |
| 诊断 Diagnostics      | `doctor`（每服务器状态 + 错误信息 + 重新检查）                                                                                                        |
| 事件 Events           | `events`（级别过滤 + 时间线 + 自动刷新）                                                                                                              |
| 设置 Settings         | `config export/import`（含/不含密钥）· 语言 · 主题 · 原始 API 控制台（`api <method> <path>`）                                                         |

### 4.1 OAuth 授权流（核心体验，镜像 CLI）

`POST /api/v1/credentials/:id/authorize` → 抽屉展示 `authorizationUrl` + 「在浏览器打开」→ 等待态（呼吸指示器 + 剩余超时）→ 每 2s 轮询 `GET /api/v1/credentials/:id` → `ready`：✓ 反馈；超时/失败：明确错误 + 重试。完全对应 CLI 的 `credential authorize <name>`。

## 5. 交互规则

- **反馈即时性**：press 态高亮在 pointer-down 触发；所有操作有连续反馈。
- **确认框惜用**：仅对真破坏性操作（删除服务器、吊销密钥）弹确认。
- **危险操作**：降饱和红 + 与中性操作视觉区分。
- **空态/错误态**：每个列表页有精心设计的空态（icon + 引导动作）；API 错误内联展示，不弹窗打断。
- **可访问性**：键盘导航、焦点环（电光蓝）、`prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` 响应。
- **响应式**：宽屏优先（三栏：侧边栏 + 内容 + 详情抽屉）；窄屏侧边栏抽屉化。

## 6. 实施阶段

1. **脚手架**：`web/` + Vite/React/TS/Tailwind v4；构建管线接入 `package.json` + Dockerfile
2. **设计系统**：token、base 组件库、毛玻璃 AppShell、i18n 框架
3. **认证与框架**：登录页、Control API client、路由、主题切换
4. **核心页面**：Dashboard、Servers（含详情 Tab）、Credentials（含 OAuth 流）、Access Keys
5. **剩余页面**：Endpoints、Diagnostics、Events、Settings（export/import、原始 API 控制台、Control Keys）
6. **打磨**：Motion 统一、空态/错误态、reduced-motion、响应式
7. **测试与上线**：vitest 组件测试、构建进 Docker、部署到 `tool.cyncyn.xyz`

## 7. 范围说明

- 不引入任何带样式的组件库；不复制旧版 web/ 代码（从零写设计系统）。
- 功能面 = CLI 功能面 + 原始 API 控制台兜底，不简化、不新增与 CLI 无关的功能。
- 代码规范：不写任何代码注释（含 JSDoc、行内注释）。
