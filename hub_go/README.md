# hub_go

HAPI Hub 的 Go 实现，替代原有的 Bun (TypeScript) Hub 服务器。提供完整的 HTTP API、Socket.IO、SSE 实时通信、Telegram Bot、Web Push 通知和隧道管理功能。

## 架构

```
cmd/hub_go/main.go          入口，配置加载 + 信号处理

internal/
├── server/                  服务编排，组装所有组件
├── config/                  配置管理（settings.json、JWT、CLI token、VAPID keys）
├── store/                   SQLite 持久化（WAL 模式，sessions/machines/messages/users/push）
├── http/                    HTTP 路由、中间件（JWT/CLI auth、CORS）、业务端点
├── socketio/                自定义 Engine.IO/Socket.IO 实现（polling + WebSocket）
├── sse/                     SSE 事件总线（pub/sub、心跳、visibility tracker）
├── sync/                    同步引擎（SessionCache、MachineCache、MessageService、RPC、EventPublisher）
├── notifications/           通知中心（多通道推送、去重、冷却）
├── push/                    Web Push（RFC 8291 加密、VAPID、ECDH）
├── telegram/                Telegram Bot（long-polling、命令、权限审批、inline keyboard）
├── tunnel/                  隧道管理（tunwg 子进程、自动重启、TLS 等待）
├── voice/                   语音集成（ElevenLabs API）
├── auth/                    加密工具（AES、access token 解析）
└── assets/                  静态资源嵌入（go:embed、SPA 路由）
```

## 运行

```bash
cd hub_go
go run ./cmd/hub_go
```

构建：

```bash
go build -o hub_go ./cmd/hub_go
./hub_go
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HAPI_HOME` | `~/.hapi` | 数据目录 |
| `DB_PATH` | `{HAPI_HOME}/hapi.db` | SQLite 数据库路径 |
| `HAPI_LISTEN_HOST` | `127.0.0.1` | 监听地址 |
| `HAPI_LISTEN_PORT` | `3006` | 监听端口 |
| `HAPI_PUBLIC_URL` | `http://localhost:{port}` | 公开 URL |
| `CORS_ORIGINS` | 从 `HAPI_PUBLIC_URL` 派生 | CORS 允许的源 |
| `TELEGRAM_BOT_TOKEN` | - | Telegram Bot Token |
| `TELEGRAM_NOTIFICATION` | `true` | 启用 Telegram 通知 |
| `CLI_API_TOKEN` | settings.json 或自动生成 | CLI 认证 Token |

## 通信协议

### HTTP API

- **Web API** (`/api/*`)：认证、会话管理、消息、机器、权限审批、Git/文件操作、Push 订阅、语音 Token、设置
- **CLI API** (`/cli/*`)：会话/机器 CRUD，使用 `Authorization: Bearer <CLI_API_TOKEN[:namespace]>` 认证
- **SSE** (`/api/events`)：实时事件流（session-added/updated/removed、message-received、machine-updated、connection-changed、toast）

### Socket.IO

自定义 Engine.IO 协议实现（非第三方库），支持：

- **传输**：HTTP long-polling + WebSocket upgrade
- **命名空间**：`/cli`（CLI 客户端）、`/terminal`（终端会话）
- `/cli` 认证：`handshake.auth.token`（CLI_API_TOKEN）
- `/terminal` 认证：`handshake.auth.token`（JWT）
- 完整的 ACK 回调、room/target 投递、ping/pong 心跳

## 数据库

使用 SQLite（WAL 模式），与原 Bun Hub 共享同一数据库文件，schema 完全兼容。

表：`sessions`、`machines`、`messages`、`users`、`push_subscriptions`

## 契约测试

```bash
cd hub_go/test
npx tsx contract-runner.ts
```

契约定义：`test/contracts/`（HTTP/Socket/SSE）
录制数据：`test/recordings/`（http/sse/socket）

## 相关文档

- [重构计划](docs/refactor/HUB_GO_REFACTOR_PLAN.md)
- [兼容性保障计划](docs/refactor/HUB_COMPATIBILITY_PLAN.md)
- [契约基线](docs/refactor/HUB_CONTRACT_BASELINE.md)
- [进度清单](docs/refactor/HUB_GO_STATUS.md)
- [代码审查](../dev_docs/hub_go_code_review.md)
