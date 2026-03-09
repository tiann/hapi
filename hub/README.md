# zhushen-hub

zs hub 的 HTTP API 与实时更新服务。

## 功能

- 提供 sessions、messages、permissions、machines、files 的 HTTP API。
- 提供 Server-Sent Events（SSE）流，为 web app 推送实时更新。
- 提供供 CLI 连接使用的 Socket.IO 通道。
- 从 `web/dist`（或单二进制内嵌资源）提供 web app 静态资源。
- 使用 SQLite 持久化状态。

## 配置

全部配置项见 `src/configuration.ts`。

### 必填

- `CLI_API_TOKEN`：CLI 与 web 登录共用的基础密钥。客户端会追加 `:<namespace>` 实现隔离。若未设置，首次运行自动生成。

### 可选

- `ZS_LISTEN_HOST`：HTTP 监听地址（默认：`127.0.0.1`）。
- `ZS_LISTEN_PORT`：HTTP 端口（默认：`3006`）。
- `ZS_PUBLIC_URL`：对外 HTTPS URL，同时用于推导 web app 默认 CORS 来源。
- `CORS_ORIGINS`：逗号分隔来源或 `*`。
- `ZS_HOME`：数据目录（默认：`~/.zhushen`）。
- `DB_PATH`：SQLite 数据库路径（默认：`ZS_HOME/zhushen.db`）。
- `ZS_RELAY_API`：Relay API 域名（默认：`relay.hapi.run`）。
- `ZS_RELAY_AUTH`：Relay 认证 key（默认：`zs`）。
- `ZS_RELAY_FORCE_TCP`：强制 TCP relay 模式（`true/1`）。
- `VAPID_SUBJECT`：Web Push 联系邮箱/URL。

## 运行

二进制（单可执行文件）：

```bash
export CLI_API_TOKEN="shared-secret"
export ZS_PUBLIC_URL="https://your-domain.example"

zs hub
```


源码方式：

```bash
bun install
bun run dev:hub
```

## HTTP API

全部端点见 `src/web/routes/`。

### Authentication（`src/web/routes/auth.ts`）

- `POST /api/auth`：获取 JWT token（`CLI_API_TOKEN[:namespace]`）。

### Sessions（`src/web/routes/sessions.ts`）

- `GET /api/sessions`：列出所有会话。
- `GET /api/sessions/:id`：获取会话详情。
- `POST /api/sessions/:id/abort`：中止会话。
- `POST /api/sessions/:id/switch`：切换会话到 remote 模式。
- `POST /api/sessions/:id/resume`：恢复非活跃会话。
- `POST /api/sessions/:id/upload`：上传文件（base64，最大 50MB）。
- `POST /api/sessions/:id/upload/delete`：删除已上传文件。
- `POST /api/sessions/:id/archive`：归档活跃会话。
- `PATCH /api/sessions/:id`：重命名会话。
- `DELETE /api/sessions/:id`：删除非活跃会话。
- `GET /api/sessions/:id/slash-commands`：列出 slash commands。
- `GET /api/sessions/:id/skills`：列出 skills。
- `POST /api/sessions/:id/permission-mode`：设置 permission mode。
- `POST /api/sessions/:id/model`：设置模型偏好。

### Messages（`src/web/routes/messages.ts`）

- `GET /api/sessions/:id/messages`：获取消息（分页）。
- `POST /api/sessions/:id/messages`：发送消息。

### Permissions（`src/web/routes/permissions.ts`）

- `POST /api/sessions/:id/permissions/:requestId/approve`：批准权限。
- `POST /api/sessions/:id/permissions/:requestId/deny`：拒绝权限。

### Machines（`src/web/routes/machines.ts`）

- `GET /api/machines`：列出在线机器。
- `POST /api/machines/:id/spawn`：在指定机器上拉起新会话。
- `POST /api/machines/:id/paths/exists`：检查路径是否存在。

### Git/Files（`src/web/routes/git.ts`）

- `GET /api/sessions/:id/git-status`：Git 状态。
- `GET /api/sessions/:id/git-diff-numstat`：Diff 摘要。
- `GET /api/sessions/:id/git-diff-file`：指定文件 diff。
- `GET /api/sessions/:id/file`：读取文件内容。
- `GET /api/sessions/:id/files`：用 ripgrep 搜索文件。

### Events（`src/web/routes/events.ts`）

- `GET /api/events`：实时更新 SSE 流。
- `POST /api/visibility`：上报客户端可见性状态。

### Push Notifications（`src/web/routes/push.ts`）

- `GET /api/push/vapid-public-key`：获取 VAPID 公钥。
- `POST /api/push/subscribe`：订阅推送通知。
- `DELETE /api/push/subscribe`：取消订阅。

### CLI（`src/web/routes/cli.ts`）

- `POST /cli/sessions`：创建/加载会话。
- `GET /cli/sessions/:id`：按 ID 获取会话。
- `POST /cli/machines`：创建/加载机器。
- `GET /cli/machines/:id`：按 ID 获取机器。

## Socket.IO

事件处理见 `src/socket/handlers/cli.ts`。

Namespace：`/cli`

### 客户端事件（CLI -> hub）

- `message`：向会话发送消息。
- `update-metadata`：更新会话元数据。
- `update-state`：更新 agent 状态。
- `session-alive`：保持会话活跃。
- `session-end`：标记会话结束。
- `machine-alive`：保持机器在线。
- `rpc-register`：注册 RPC handler。
- `rpc-unregister`：注销 RPC handler。

### Terminal 事件（web -> hub）

- `terminal:create`：为会话打开终端。
- `terminal:write`：发送终端输入。
- `terminal:resize`：调整终端尺寸。
- `terminal:close`：关闭终端。

### Hub 事件（hub -> clients）

- `update`：广播会话/消息更新。
- `rpc-request`：传入 RPC 调用。

RPC 路由见 `src/socket/rpcRegistry.ts`。

## 核心逻辑

主会话/消息管理器见 `src/sync/syncEngine.ts`，包括：

- 带版本控制的内存会话缓存。
- 消息分页与查询。
- 权限批准/拒绝。
- 基于 Socket.IO 的 RPC 路由。
- 向 SSE 发布事件。
- Git 操作与文件搜索。
- 活跃度追踪与超时控制。

## 存储

SQLite 持久化见 `src/store/index.ts`，包括：

- 带元数据与 agent 状态的 sessions。
- 支持分页的 messages。
- 带 runner 状态的 machines。
- 从消息中提取的 todo。
- users 表（包含 namespace）。

## 源码结构

- `src/web/`：HTTP 服务与路由。
- `src/socket/`：Socket.IO 初始化与处理。
- `src/socket/handlers/cli/`：模块化 CLI handlers。
- `src/sync/`：核心会话/消息逻辑。
- `src/store/`：SQLite 持久化。
- `src/sse/`：Server-Sent Events。
- `src/config/`：配置加载与生成。
- `src/notifications/`：推送通知。
- `src/visibility/`：客户端可见性追踪。

## 安全模型

访问控制基于：

- `CLI_API_TOKEN` 作为 CLI 与浏览器访问的基础密钥（namespace 由客户端追加）。

传输安全依赖 hub 前置 HTTPS。

## 部署构建

在仓库根目录执行：

```bash
bun run build:hub
bun run build:web
```

hub 构建产物为 `hub/dist/index.js`，web 资源位于 `web/dist`。

## 网络说明

- 若 web app 与 hub 不同源部署，请设置 `CORS_ORIGINS`（或 `ZS_PUBLIC_URL`）以包含静态站点来源。

## 独立托管 Web

Web UI 可与 hub 分离托管（例如 GitHub Pages、Cloudflare Pages）：

1. 在仓库根目录构建并部署 `web/dist`。
2. 设置 `CORS_ORIGINS`（或 `ZS_PUBLIC_URL`）为静态站点来源。
3. 打开静态站点，在登录页点击 Hub 按钮并输入 zs hub 来源。

若将 hub override 留空，则保持默认同源行为（由 hub 直接提供 web 资源）。
