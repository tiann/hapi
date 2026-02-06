# Hub Go 进度清单

更新时间: 2026-02-05

## 已完成

- 契约文件迁移：`hub_go/test/contracts/*` + `README.md`
- 录制目录建立：`hub_go/test/recordings/http/*`, `hub_go/test/recordings/sse/*`
- Go 项目骨架：`go.mod`, `cmd/hub_go/main.go`, 基本配置加载与运行
- SQLite 持久化：`internal/store/*`（sessions/machines/messages/users/push_subscriptions 全套 CRUD + 版本更新 + 索引）
- HTTP 主路由覆盖：web/cli API 全量注册
- 认证与中间件：JWT auth、CLI token auth、CORS
- SSE 基础与过滤：connection-changed、namespace/filters、all/visibility 支持、心跳
- Socket.IO 基础：Engine.IO polling + WebSocket upgrade + ACK 支持
- Socket.IO 事件：/cli 主要事件 + /terminal 转发 + rpc-register 记录
- RPC 路由：按 method 精准投递（避免多客户端误 ACK）
- HTTP 业务端点逻辑：git/file/upload/permissions/skills/slash/visibility/machines/voice 接 RPC
- 语音 token：对齐 ElevenLabs 行为 + 自动创建 agent + 配置迁入
- VAPID keys：生成/持久化 + /api/push/vapid-public-key 返回真实 key
- 错误文案/契约对齐：Session/Machine not found、SSE connection-changed 结构、message-received localId null
- /api/sessions 列表排序与 pendingRequestsCount 对齐
- SSE/Socket 字段细节补齐：session/model/permission/todos、update seq 对齐、todos 提取
- 合约测试执行器：`hub_go/test/contract-runner.ts`（HTTP/SSE/Socket 基础校验）
- 真实 SSE 录制：session-added/session-updated/machine-updated 已补齐（`hub_go/test/recordings/sse`）
- Socket.IO 录制补齐：server->client `update` 已补齐（`hub_go/test/recordings/socket`）
- Socket.IO 兼容：polling namespace 过滤、room/target 投递、upgrade/ping-pong 对齐、sid idle 过期与 ws 心跳

## 未完成

- 录制补全：HTTP 真实响应字段仍不足（本环境限制导致 HTTP 录制失败，需在可联网脚本环境补录）
- Socket.IO 细节：polling server->client ping 与 sid 过期策略细分仍可优化
- Socket.IO 细节：重连语义、/terminal 更完整事件覆盖、room 行为
- SSE 事件字段对齐：message-received / session-updated / machine-updated 全字段对照录制
- 同步引擎与缓存层：`internal/sync/*` 初版落地（缓存/事件发布/消息/RPC）
- 通知系统：`internal/notifications/*` 初版落地（事件解析/去重/ready/permission）
- Telegram Bot：`internal/telegram/*` 初版落地（基础启动/占位）
- 隧道管理：`internal/tunnel/*` 初版落地（Manager 占位）
- 测试与验证：契约测试执行器、并行运行镜像、集成/负载测试
- 录制补全：Socket.IO server->client 事件录制仍缺（`hub_go/test/recordings/socket` 仅客户端事件）
- 文档同步：`hub_go/README.md` 与当前实现状态更新
