# Hub Go 进度清单

更新时间: 2026-02-07

## 已完成

### 基础设施层
- Go 项目骨架：`go.mod`, `cmd/hub_go/main.go`, 基本配置加载与信号处理
- 配置管理：`internal/config/*`（settings.json、JWT 密钥、CLI token、Owner ID、VAPID keys 生成/持久化）
- SQLite 持久化：`internal/store/*`（sessions/machines/messages/users/push_subscriptions 全套 CRUD + 版本更新 + 索引）
- 主服务编排：`internal/server/server.go`（组件组装、HTTP 服务启动、graceful shutdown）

### 通信层
- HTTP 路由与中间件：`internal/http/*`（模式匹配路由、JWT auth、CLI token auth、CORS、JSON 响应工具）
- HTTP 业务端点：web/cli API 全量注册（auth/bind/sessions/messages/machines/permissions/git/file/upload/skills/slash/visibility/voice/push/settings）
- Socket.IO：`internal/socketio/*`（自定义 Engine.IO polling + WebSocket upgrade + ACK + namespace 支持 + terminal registry）
- Socket.IO 事件：/cli 全量事件 + /terminal 转发 + rpc-register/unregister + room/target 投递
- Socket.IO 兼容：polling namespace 过滤、upgrade/ping-pong 对齐、sid idle 过期与 ws 心跳
- SSE 事件总线：`internal/sse/*`（pub/sub bus、HTTP SSE handler、namespace/filters、connection-changed、心跳、visibility tracker）
- RPC 路由：按 method 精准投递（避免多客户端误 ACK）

### 同步引擎
- 同步引擎核心：`internal/sync/engine.go`（协调 SessionCache/MachineCache/MessageService/RpcGateway/EventPublisher）
- 会话缓存：`internal/sync/session_cache.go`（内存缓存 + mutex 保护 + DB 回源 + debounced 事件广播）
- 机器缓存：`internal/sync/machine_cache.go`（内存缓存 + mutex 保护 + DB 回源）
- 消息服务：`internal/sync/message_service.go`（分页查询 + before/after cursor + PageInfo）
- RPC 网关：`internal/sync/rpc_gateway.go`（超时 RPC 调用，默认 10s）
- 事件发布器：`internal/sync/event_publisher.go`（线程安全 listener 注册 + 同时推送 SSE bus）
- 事件类型与辅助：`internal/sync/event.go`, `event_helpers.go`, `types.go`, `aliases.go`, `todos.go`

### 通知系统
- 通知中心：`internal/notifications/notification_hub.go`（事件订阅 + 多通道推送 + 权限请求去重 500ms + ready 冷却 5s）
- 通知接口：`internal/notifications/notification_types.go`（NotificationChannel 接口定义）
- 事件解析：`internal/notifications/event_parsing.go`（消息类型提取）
- 会话信息：`internal/notifications/session_info.go`（显示名、agent 名称映射）

### Web Push
- Push 服务：`internal/push/service.go`（RFC 8291 aes128gcm 加密 + ECDH 密钥交换 + VAPID JWT 签名 + 过期订阅自动清理）
- Push 通道：`internal/push/channel.go`（实现 NotificationChannel 接口 + SSE toast fallback + visibility 检查）

### Telegram Bot
- Bot 完整实现：`internal/telegram/bot.go`（~913 行，long-polling 架构 + /start /app 命令 + 回调查询处理 + 权限审批 approve/deny + inline keyboard + WebApp 深链接 + graceful shutdown）
- InitData 验证：`internal/telegram/init_data.go`（Telegram WebApp initData HMAC 校验）
- 实现 NotificationChannel 接口：SendReady / SendPermissionRequest

### 隧道管理
- 隧道管理器：`internal/tunnel/manager.go`（~493 行，tunwg 子进程管理 + JSON 事件解析 + 指数退避重启 max 5 次 + 平台二进制检测 Linux/Darwin/Windows x64/ARM64 + TLS 证书轮询等待 + IPv6 安全 URL 解析）

### 语音集成
- Voice 客户端：`internal/voice/client.go`（ElevenLabs API 集成 + agent ID 缓存/创建 + conversation token）
- Voice 配置：`internal/voice/config.go`（agent 配置定义）

### 静态资源
- 资源嵌入：`internal/assets/assets.go`（go:embed + SPA 路由 + MIME 类型 + 版本化缓存头）

### 契约对齐
- 错误文案/契约对齐：Session/Machine not found、SSE connection-changed 结构、message-received localId null
- /api/sessions 列表排序与 pendingRequestsCount 对齐
- SSE/Socket 字段细节补齐：session/model/permission/todos、update seq 对齐、todos 提取
- VAPID keys：生成/持久化 + /api/push/vapid-public-key 返回真实 key

### 测试基础设施
- 契约文件迁移：`hub_go/test/contracts/*`（HTTP/Socket/SSE 契约定义）
- 合约测试执行器：`hub_go/test/contract-runner.ts`（HTTP/SSE/Socket 静态校验）
- 录制目录与数据：`hub_go/test/recordings/http|sse|socket/*`
- 真实 SSE 录制：session-added/session-updated/machine-updated 已补齐
- Socket.IO 录制：server->client `update` 已补齐
- 单元测试：`internal/auth/crypto_test.go`（AES 加密测试）

### 代码质量
- 代码审查 v1-v5 全部修复（39 个问题，见 `dev_docs/hub_go_code_review.md`）
- 生产代码中无 TODO/FIXME/HACK 注释

## 未完成

### 测试覆盖 🟡
- Go 单元测试：`auth/`、`store/`、`socketio/`、`telegram/`、`notifications/`、`sse/`、`push/`、`http/`、`sync/`、`config/`、`tunnel/` 共 11 个包已有测试（195 用例通过），仅 `assets/`、`server/`、`voice/` 无测试（均为薄封装层）
- Go 集成测试：HTTP 端到端测试 32 用例（health、auth、session CRUD/PATCH、machine、messages、push subscribe、visibility、VAPID）
- 负载/基准测试：重构计划要求的 k6/wrk 性能测试未实施

### 录制与契约验证 🟡
- HTTP 录制补全：真实响应字段仍不足（需在可联网环境补录）
- SSE 全字段录制：message-received / session-updated / machine-updated 全字段对照录制待补齐
- Socket.IO 录制补全：server->client 事件录制仍不完整

### Socket.IO 细节优化 ✅
- 后台 session cleanup loop：每 60s 清理过期 session（idle > 70s），防止内存泄漏
- Outbox 容量限制：每 namespace 最多 1000 条，超出丢弃最旧条目
- Terminal idle loop：60s 周期检测过期 terminal，自动通知 web 和 CLI 端
- Terminal 操作错误反馈：write/resize/close 失败时返回 terminal:error
- Server.Stop() graceful shutdown：停止 cleanup loop 和 terminal idle loop
- room 行为细节对齐（待观察是否有差异）

### CI/CD 🟡
- GitHub Actions 流水线已创建（`.github/workflows/hub-go.yml`：vet + test + build）
- Makefile 已创建（`hub_go/Makefile`：build、test、vet、lint、check 目标）
- 待补充：自动化兼容性测试（契约验证集成到 CI）

### 文档 ✅
- `hub_go/README.md` 已更新至当前实现状态
