# HAPI Hub 契约基线（Bun 实现）

> 目的：作为 Go 重构的唯一真源（Single Source of Truth）。此文档基于现有 Bun Hub 源码整理，任何字段或行为变更都必须先在此基线变更，再进入 Go 实现。

## 1. HTTP API（Web）

### 1.1 公共与认证

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/health` | 健康检查 | `{ status: 'ok', protocolVersion: number }` | - |
| POST | `/api/auth` | Telegram/AccessToken 登录 | `{ token, user }` | 400/401/503 `{ error }` |
| POST | `/api/bind` | 绑定 Telegram 与 AccessToken | `{ token, user }` | 400/401/409/503 `{ error }` |

### 1.2 Sessions

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/api/sessions` | 会话列表 | `{ sessions: SessionSummary[] }` | 503 `{ error }` |
| GET | `/api/sessions/:id` | 会话详情 | `{ session: Session }` | 403/404/503 `{ error }` |
| POST | `/api/sessions/:id/resume` | 恢复会话 | `{ type:'success', sessionId }` | 403/404/503 `{ error, code }` |
| POST | `/api/sessions/:id/abort` | 中止会话 | `{ ok: true }` | 403/404/409/503 `{ error }` |
| POST | `/api/sessions/:id/archive` | 归档会话 | `{ ok: true }` | 403/404/409/503 `{ error }` |
| POST | `/api/sessions/:id/switch` | 切换为远程模式 | `{ ok: true }` | 403/404/409/503 `{ error }` |
| PATCH | `/api/sessions/:id` | 重命名 | `{ ok: true }` | 400/403/404/409/500 `{ error }` |
| DELETE | `/api/sessions/:id` | 删除 | `{ ok: true }` | 403/404/409/500 `{ error }` |
| POST | `/api/sessions/:id/permission-mode` | 设置权限模式 | `{ ok: true }` | 400/403/404/409/503 `{ error }` |
| POST | `/api/sessions/:id/model` | 设置模型模式 | `{ ok: true }` | 400/403/404/409/503 `{ error }` |
| GET | `/api/sessions/:id/slash-commands` | 获取 Slash 命令 | `{ success: true, commands: ... }` | 403/404/503 `{ error }` |
| GET | `/api/sessions/:id/skills` | 获取技能 | `{ success: true, skills: ... }` | 403/404/503 `{ error }` |
| POST | `/api/sessions/:id/upload` | 上传文件 | `{ success: true, ... }` | 400/403/404/413/500 `{ error }` |
| POST | `/api/sessions/:id/upload/delete` | 删除上传文件 | `{ success: true }` | 400/403/404/500 `{ error }` |

### 1.3 Messages

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/api/sessions/:id/messages` | 分页消息 | `{ messages, page }` | 403/404/503 `{ error }` |
| POST | `/api/sessions/:id/messages` | 发送消息 | `{ ok: true }` | 400/403/404/409/503 `{ error }` |

### 1.4 Machines

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/api/machines` | 在线机器列表 | `{ machines }` | 503 `{ error }` |
| POST | `/api/machines/:id/spawn` | 创建会话 | `{ ... }` | 400/403/404/503 `{ error }` |
| POST | `/api/machines/:id/paths/exists` | 批量路径检查 | `{ exists }` | 400/403/404/500/503 `{ error }` |

### 1.5 Permissions

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| POST | `/api/sessions/:id/permissions/:requestId/approve` | 审批 | `{ ok: true }` | 400/403/404/503 `{ error }` |
| POST | `/api/sessions/:id/permissions/:requestId/deny` | 拒绝 | `{ ok: true }` | 400/403/404/503 `{ error }` |

### 1.6 Git / Files

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/api/sessions/:id/git-status` | 状态 | `{ success: true, ... }` | 403/404/503 `{ error }` |
| GET | `/api/sessions/:id/git-diff-numstat` | diff numstat | `{ success: true, ... }` | 400/403/404/503 `{ error }` |
| GET | `/api/sessions/:id/git-diff-file` | diff file | `{ success: true, ... }` | 400/403/404/503 `{ error }` |
| GET | `/api/sessions/:id/file` | 读取文件 | `{ success: true, ... }` | 400/403/404/503 `{ error }` |
| GET | `/api/sessions/:id/files` | 文件列表 | `{ success: true, files }` | 400/403/404/503 `{ error }` |

### 1.7 Push / Voice

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/api/push/vapid-public-key` | 获取 VAPID | `{ publicKey }` | - |
| POST | `/api/push/subscribe` | 订阅 Push | `{ ok: true }` | 400 `{ error }` |
| DELETE | `/api/push/subscribe` | 取消订阅 | `{ ok: true }` | 400 `{ error }` |
| POST | `/api/voice/token` | ElevenLabs token | `{ allowed, token?, agentId? }` | 400/500 `{ allowed:false, error }` |

### 1.8 SSE

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| GET | `/api/events` | SSE 流 | `data: SyncEvent JSON` | 401/403/404/503 `{ error }` |
| POST | `/api/visibility` | 更新可见性 | `{ ok: true }` | 400/404/503 `{ error }` |

**说明**
- `/api/events` 需要 `token`（query）或 `Authorization: Bearer`（header）。
- 连接建立后立即发送 `connection-changed` 事件。
- 心跳为 `: heartbeat` 注释行。

## 2. HTTP API（CLI）

| 方法 | 路径 | 说明 | 成功响应 | 错误响应 |
|------|------|------|----------|----------|
| POST | `/cli/sessions` | 创建或加载会话 | `{ session }` | 400/401/503 `{ error }` |
| GET | `/cli/sessions/:id` | 获取会话 | `{ session }` | 401/403/404/503 `{ error }` |
| GET | `/cli/sessions/:id/messages` | 拉取消息 | `{ messages }` | 400/401/403/404/503 `{ error }` |
| POST | `/cli/machines` | 创建或加载机器 | `{ machine }` | 400/401/403/503 `{ error }` |
| GET | `/cli/machines/:id` | 获取机器 | `{ machine }` | 401/403/404/503 `{ error }` |

**认证**
- `Authorization: Bearer <CLI_API_TOKEN[:namespace]>`
- 响应头包含 `X-Hapi-Protocol-Version`

## 3. Socket.IO

**协议**
- Engine.IO path: `/socket.io/`
- Namespaces: `/cli`, `/terminal`
- `/cli` 认证：`handshake.auth.token`（CLI_API_TOKEN）
- `/terminal` 认证：`handshake.auth.token`（JWT）
- 可选：`handshake.auth.sessionId`、`handshake.auth.machineId` 自动加入房间

### 3.1 /cli（Client -> Server）

事件名与结构由 `shared/src/socket.ts` 定义：
- `message`
- `session-alive`
- `session-end`
- `update-metadata`（ACK 返回 result/version）
- `update-state`（ACK 返回 result/version）
- `machine-alive`
- `machine-update-metadata`（ACK 返回 result/version）
- `machine-update-state`（ACK 返回 result/version）
- `rpc-register`
- `rpc-unregister`
- `terminal:ready`
- `terminal:output`
- `terminal:exit`
- `terminal:error`
- `ping`（ACK）
- `usage-report`（当前服务端未处理，保持兼容）

### 3.2 /cli（Server -> Client）

- `update`
- `rpc-request`（ACK 返回 string）
- `terminal:open`
- `terminal:write`
- `terminal:resize`
- `terminal:close`
- `error`（`{ message, code?, scope?, id? }`）

### 3.3 /terminal（Client -> Server）

- `terminal:create`
- `terminal:write`
- `terminal:resize`
- `terminal:close`

### 3.4 /terminal（Server -> Client）

- `terminal:ready`
- `terminal:output`
- `terminal:exit`
- `terminal:error`

## 4. SSE 事件类型

基于 `shared/src/schemas.ts` 的 `SyncEventSchema`：
- `session-added`
- `session-updated`
- `session-removed`
- `message-received`
- `machine-updated`
- `toast`
- `connection-changed`

**message-received 结构（源码推导）**
```
{
  type: 'message-received',
  namespace?: string,
  sessionId: string,
  message: {
    id: string,
    seq: number,
    localId?: string | null,
    content: unknown,
    createdAt: number
  }
}
```

## 5. 统一错误结构（约束）

绝大多数错误响应为：

```
{ error: string }
```

少量接口使用：
- `{ error, code }`（如 `/api/sessions/:id/resume`）
- `{ success: false, error }`（部分 Git/文件 RPC）

该结构必须保持不变。
