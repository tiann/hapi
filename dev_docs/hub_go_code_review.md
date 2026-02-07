# 代码审查：hub_go Go 实现（综合版）

**审查对象**：commit `a785eaff` + 所有未提交变更（17 个文件，+1700/-113 行）
**审查日期**：2026-02-07
**版本**：v3（合并 v1、v2 审查并更新状态）

---

## 概述

hub_go 是现有 Node.js hub 服务器的 Go 重写，包含 HTTP 路由、Socket.IO、SSE、SQLite 存储、认证、Telegram 集成、Cloudflare Tunnel、Web Push、Terminal Registry 等模块。

本文档追踪所有已发现问题的修复状态。

---

## 问题追踪

### Critical — 13 个（0 已修复）

---

#### C01. `INSERT OR REPLACE` 会将会话序列号重置为 0

**文件**：`store/sessions.go:189`
**状态**：未修复
**来源**：v1 #1

`CreateSessionWithID` 使用 `INSERT OR REPLACE`，当目标 session ID 已存在时，SQLite 先删除旧行再插入新行，导致 `seq` 被重置为 0，破坏消息排序。

**建议**：改用 `INSERT OR IGNORE`，或在插入前先检查是否已存在。

---

#### C02. 缺少会话去重逻辑——与 Node.js 原版行为不一致

**文件**：`http/routes.go:1262`
**状态**：未修复
**来源**：v1 #2

Node.js 原版的 `getOrCreateSession` 会先按 `tag + namespace` 查询已有会话，存在则复用。Go 版本在 `POST /cli/sessions` 中每次都直接创建新会话。

---

#### C03. 可见性追踪器始终注册为 "visible"，忽略初始状态参数

**文件**：`sse/visibility.go:19`
**状态**：未修复
**来源**：v1 #3

`Register` 硬编码 `Visibility: "visible"`，不接受初始状态参数。以 hidden 状态开始的连接被错误标记为 visible，可能触发不必要的通知推送。

---

#### C04. sessions map 缺少互斥锁保护（数据竞争）

**文件**：`socketio/handler.go:37`
**状态**：未修复
**来源**：v1 #4

`Server.sessions` map 被多个 goroutine 并发访问（`touchSession`、`markPong`、`trackSessionTargets`、`trackNamespace`、`Handle` 等），但没有加锁。现有的 `mu sync.RWMutex` 只保护 `wsConns`。

**建议**：为 sessions map 添加独立的 `sync.RWMutex`，或扩展现有锁的覆盖范围。

---

#### C05. permission-mode 和 model 接口静默丢弃 RPC 错误

**文件**：`http/routes.go:699`, `http/routes.go:725`
**状态**：未修复
**来源**：v1 #5

两个 handler 使用 `_, _ = rpcCallUnified(...)` 丢弃错误，始终返回 `{"ok": true}`。同文件其他 handler 都正确检查错误并返回 HTTP 500。

---

#### C06. Telegram Bot `Start()`/`Stop()` goroutine 生命周期管理缺陷

**文件**：`telegram/bot.go`
**状态**：未修复
**来源**：v2 C1

`Start()` 中重建 `stopCh` 导致旧 goroutine 泄漏；`Stop()` 不等待 goroutine 退出，如果立刻再次 `Start()`，旧 goroutine 可能还没退出就创建了新的，产生竞争。

**建议**：使用 `sync.WaitGroup` 等待 goroutine 退出，或使用 `context.WithCancel` 替代手动 `stopCh`。

---

#### C07. Telegram Bot `engine` 字段读写竞争

**文件**：`telegram/bot.go`
**状态**：未修复
**来源**：v2 C2

`SetEngine` 在锁内写 `b.engine`，但 `handleCallbackQuery`、`approvePermission`、`callSessionRPC` 等在无锁下读 `b.engine`。`SetEngine(nil)` 在 nil 检查之后、实际使用之前被调用会导致 nil pointer panic。

---

#### C08. Tunnel Manager 重复 `Start()` 导致僵尸进程

**文件**：`tunnel/manager.go`
**状态**：未修复
**来源**：v2 C3

`Start()` 不检查已有进程。连续调用两次：新 `stopCh` 覆盖旧的，旧 `cancelFunc` 被覆盖，旧子进程变成僵尸。

**建议**：在 `Start()` 中先检查 `m.process != nil`，如果存在则先 `Stop()` 旧进程。

---

#### C09. Tunnel stdout reader 收到 `"ready"` 后停止读取

**文件**：`tunnel/manager.go`
**状态**：未修复
**来源**：v2 C4

stdout reader goroutine 收到 `"ready"` 事件后立即 `return`。如果 `tunwg` 进程继续向 stdout 写入，buffer 满后进程会被阻塞挂起。

**建议**：发送 URL 后继续读取 stdout 直到 EOF。

---

#### C10. Tunnel 进程未发出 `"ready"` 时主 goroutine 挂起

**文件**：`tunnel/manager.go`
**状态**：部分修复
**来源**：v2 C5

新增了 `errCh` 用于 scanner 错误，但进程正常退出（exit code 0）不发 ready 时，scanner 到 EOF 后 `scanner.Err()` 返回 nil，仍会等到 30 秒超时。

**建议**：scanner 循环结束后如果没有收到 ready 事件，应向 `errCh` 发送错误信号。

---

#### C11. Terminal Registry `StopIdleLoop` 后无法重启

**文件**：`socketio/terminal_registry.go:75-86`
**状态**：未修复
**来源**：v2 C6

`StopIdleLoop` 调用 `close(r.stopIdleLoop)` 后，如果再次调用 `StartIdleLoop`，新 goroutine 的 `<-r.stopIdleLoop` 会立即返回（closed channel 永远可读），idle loop 瞬间退出。

**建议**：在 `StopIdleLoop` 中 close 后重新创建 channel：`r.stopIdleLoop = make(chan struct{})`。

---

#### C12. Push Channel `sendToast` 空指针 panic

**文件**：`push/channel.go:129`
**状态**：未修复
**来源**：v2 C7

当 `payload.Data` 为 `nil` 时，L120-122 仅保护了 `url` 变量，但 L129 的 `payload.Data.SessionID` 仍会被执行，导致 nil pointer panic。

---

#### C13. Assets 非安全类型断言可能 panic

**文件**：`assets/assets.go:52,74,94`
**状态**：未修复
**来源**：v2 C8

`file.(readSeeker)` 非安全类型断言。若底层 `fs.FS` 不支持 `io.ReadSeeker`，将直接 panic。

**建议**：使用 `rs, ok := file.(readSeeker)` 带检查的类型断言。

---

### High — 6 个（0 已修复）

---

#### H01. Telegram `truncate` 截断 UTF-8 多字节字符

**文件**：`telegram/bot.go`
**状态**：未修复
**来源**：v2 H1

`len(s)` 和 `s[:maxLen-3]` 操作字节而非 rune。对含中文、emoji 的字符串，截断位置可能落在 UTF-8 字符中间，Telegram API 会拒绝无效 UTF-8。

---

#### H02. Telegram `apiCall` 不检查 API `ok` 字段

**文件**：`telegram/bot.go`
**状态**：部分修复
**来源**：v2 H2

`getUpdates` 方法现在检查 `result.OK`，但通用 `apiCall`（被 `sendMessage`、`editMessageText` 等调用）仍只检查 HTTP status code，不检查 `ok` 字段。

---

#### H03. Telegram `pollUpdates` 停止信号延迟响应

**文件**：`telegram/bot.go`
**状态**：未修复
**来源**：v2 H3

`pollUpdates` 在 `getUpdates` HTTP 请求期间（最长 30 秒）无法响应 `ctx.Done()` 或 `stopCh`，因为 HTTP 请求未使用 `context`。

**建议**：使用 `http.NewRequestWithContext` 将 context 传入 HTTP 请求。

---

#### H04. Tunnel 指数退避整数溢出和竞态条件

**文件**：`tunnel/manager.go`
**状态**：未修复
**来源**：v2 H4

`retryCount` 在两次锁操作之间存在竞争窗口。另一个 goroutine 可能在此期间修改 `retryCount`，导致位移运算异常。

**建议**：合并两次锁操作为一次，并对移位值加上限约束。

---

#### H05. WebSocket `lastPong` 数据竞争

**文件**：`socketio/websocket.go:29,124,148,152,154,247`
**状态**：未修复
**来源**：v2 H5

`lastPong` 在主读取循环 goroutine 中写入，同时在 `startPingLoop` goroutine 中读取，无任何同步保护。

**建议**：使用 `atomic.Value` 或在读写 `lastPong` 时加锁。

---

#### H06. SSE `writeEvent` 不再发送 `event:` 行（regression）

**文件**：`sse/sse.go` diff
**状态**：新发现
**来源**：v3 N1

变更移除了 `fmt.Fprintf(w, "event: %s\n", event.Type)` 行，将 type 嵌入 JSON data。SSE 客户端将不再收到 `event:` 字段，所有事件都走 `message` 默认类型。如果前端使用 `addEventListener('session-added', ...)` 监听特定事件类型，将收不到事件。除非前端已同步修改，否则这是破坏性变更。

---

### Medium — 12 个（0 已修复）

---

#### M01. `CreateSessionWithID` 错误被丢弃

**文件**：`socketio/events.go:154,208`
**状态**：未修复
**来源**：v2 M1

变更将返回值改为 `_, _`（丢弃错误），但 `created` 始终设为 `true`。如果创建失败，代码会错误地触发 `session-added` 事件。

---

#### M02. SSE `writeEvent` 中 `type` 键可被覆盖

**文件**：`sse/sse.go:65-68`
**状态**：未修复
**来源**：v2 M2

`obj := map[string]any{"type": event.Type}` 后 range `event.Data` 覆盖。如果 Data 含 `"type"` 键，会覆盖 `event.Type`。

---

#### M03. `sendToast` 总返回 1，推送通知可能永不发送

**文件**：`push/channel.go:136`
**状态**：未修复
**来源**：v2 M3

`sendToast` 始终 `return 1`，导致 `SendReady` 和 `SendPermissionRequest` 中 `delivered > 0` 始终为 true，跳过推送通知。

---

#### M04. Push Service 吞掉所有推送错误

**文件**：`push/service.go:103-109`
**状态**：改善
**来源**：v2 M4

`SendToNamespace` 仍返回 nil（吞掉个别 subscription 失败），但调用方 `channel.go` 现在正确检查并传播 `SendToNamespace` 的错误。

---

#### M05. Push endpoint 未验证，存在 SSRF 风险

**文件**：`push/service.go:125`
**状态**：未修复
**来源**：v2 M5

`sub.Endpoint` 来自用户提交的数据，未做 scheme 或地址限制。

**建议**：限制为 HTTPS scheme 并排除内网 IP。

---

#### M06. Push response body 无大小限制

**文件**：`push/service.go:148`
**状态**：未修复
**来源**：v2 M6

`io.ReadAll(resp.Body)` 无大小限制，恶意端点可返回超大响应导致 OOM。

**建议**：使用 `io.LimitReader(resp.Body, maxSize)`。

---

#### M07. `getToolName` 遍历 map 行为不确定

**文件**：`push/channel.go:154-161`
**状态**：未修复
**来源**：v2 M7

遍历 `requests` map 后无条件 `break`。Go map 遍历顺序不确定，每次调用可能返回不同的工具名称。

---

#### M08. Tunnel 进程正常退出不触发重启

**文件**：`tunnel/manager.go`
**状态**：未修复
**来源**：v2 M8

`if exitErr != nil` 条件导致 exit code 0 时不触发重试逻辑，隧道进程静默消失。

---

#### M09. Assets `Stat()` 错误被忽略（SPA 回退路径）

**文件**：`assets/assets.go:50,72`
**状态**：部分修复
**来源**：v2 M9

正常文件路径增加了 Stat 错误检查，但 SPA 回退路径仍然 `stat, _ := indexFile.Stat()`。

---

#### M10. Telegram `apiCall` 不读取 response body 影响连接复用

**文件**：`telegram/bot.go`
**状态**：未修复
**来源**：v2 M10

HTTP 200 时不读取 body。Go `net/http` 中未完全读取的 body 导致 TCP 连接无法被连接池复用。

**建议**：添加 `io.Copy(io.Discard, resp.Body)`。

---

#### M11. 新方法缺少 `rows.Err()` 检查

**文件**：`store/push.go`（`GetPushSubscriptionsByNamespace`）、`store/users.go`（`GetUsersByPlatformAndNamespace`）
**状态**：新发现
**来源**：v3 N4

两个新增方法在 `rows.Next()` 循环后都没有检查 `rows.Err()`，I/O 错误被静默忽略，可能返回不完整结果。

---

#### M12. Telegram Bot `lastUpdate` 数据竞争

**文件**：`telegram/bot.go`
**状态**：新发现
**来源**：v3 N5

`b.lastUpdate` 在 `pollUpdates` goroutine 中读写（无锁）。应使用 `atomic.Int64` 或在锁内操作。

---

### Low — 2 个（0 已修复）

---

#### L01. `parseHostPort` 对 IPv6 处理不正确

**文件**：`tunnel/manager.go`
**状态**：未修复
**来源**：v2 L4

使用 `strings.LastIndex(url, ":")` 分割 host:port，对 IPv6 地址解析错误。

**建议**：使用 `net.SplitHostPort`。

---

#### L02. 旧 `push.go`/`users.go` 中原有查询方法缺少 `rows.Err()` 检查

**文件**：`store/push.go:55`、`store/users.go:52`
**状态**：未修复（仅 `ensureColumn` 已修复）
**来源**：v2 L1

---

## 已修复问题

| 编号 | 问题 | 修复方式 |
|------|------|----------|
| L2 (v2) | `hapiNS` 字段未使用 | 现在在 `websocket.go:183` 赋值，在 `events.go` 中使用 |
| L3 (v2) | 变量名 `os` 遮蔽标准库包 | 使用 `getPlatformDir()` 函数替代 |
| N2 (v3) | `ensureColumn` SQL 注入风险 | 改为查表固定字符串，消除拼接 |
| N3 (v3) | `ConstantTimeEquals` 泄露长度信息 | 使用等长 buffer + `ConstantTimeEq` |

---

## 统计

| 严重级别 | 总数 | 已修复 | 部分修复 | 未修复 |
|----------|------|--------|----------|--------|
| Critical | 13 | 0 | 1 | 12 |
| High | 6 | 0 | 1 | 5 |
| Medium | 12 | 0 | 2 | 10 |
| Low | 2 | 0 | 0 | 2 |
| **合计** | **33** | **0** | **4** | **29** |

另有 4 项已修复问题（见上表）。

---

## 修复优先级建议

### 第一优先级（服务稳定性）
- C04：sessions map 竞态 → 并发下 panic
- C06-C07：Telegram Bot goroutine 泄漏和 engine 竞态
- C08-C10：Tunnel Manager 僵尸进程和 goroutine 挂起
- C11-C13：Terminal Registry 重启失败、Push 空指针 panic、Assets panic
- H05：WebSocket `lastPong` 竞态
- H06：SSE event 行移除（如前端未同步则破坏性）

### 第二优先级（数据正确性）
- C01：INSERT OR REPLACE 重置 seq → 消息序列号丢失
- C02：会话去重 → 重复会话
- C05：RPC 错误静默丢弃 → 虚假成功确认
- M01：CreateSessionWithID 错误丢弃 → 虚假 session-added 事件

### 第三优先级（功能完整性）
- C03：可见性初始状态
- M02-M04：错误处理链修复
- M05-M06：安全加固（SSRF、OOM）

### 第四优先级（代码质量）
- H01-H04：UTF-8 截断、API 响应检查、停止信号延迟、退避竞态
- M07-M12：map 遍历不确定、进程退出处理、rows.Err()、lastUpdate 竞态
- L01-L02：IPv6 解析、rows.Err()
