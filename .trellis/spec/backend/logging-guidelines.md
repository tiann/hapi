# 日志规范

> 本项目中日志的记录方式。

---

## 概述

HAPI Hub 使用**简单的控制台日志**（不依赖日志库）。日志写入 stdout/stderr，由进程管理器或容器运行时捕获。

**关键特征**：
- `console.log()` 用于信息性消息
- `console.warn()` 用于警告（配置问题、弃用提示）
- `console.error()` 用于错误（意外失败、异常）
- 前缀格式：`[Component] Message`
- 启动日志会展示配置来源
- 不使用结构化日志（纯文本）

**设计理念**：保持日志简单、可读，便于开发和调试。生产环境可由外部系统捕获并处理 stdout/stderr。

---

## 日志级别

### `console.log()` - 信息

适用于：
- **启动消息** - 服务器启动、配置加载完成
- **服务状态** - "Tunnel: ready"、"Push: enabled"
- **重要状态变化** - "Session resumed"、"Machine connected"
- **面向用户的事件** - 显示二维码、输出可访问 URL

```typescript
console.log('HAPI Hub 正在启动...')
console.log('[Hub] HAPI_LISTEN_PORT: 3000（environment）')
console.log('[Web] Hub 正在监听 :3000')
console.log('HAPI Hub 已就绪！')
```

**格式**：`[Component] Message`，或者用于启动横幅的纯文本消息。

### `console.warn()` - 警告

适用于：
- **配置问题** - 弱 token、无效设置
- **弃用提示** - 旧 API 用法
- **非致命错误** - 可选配置解析失败，已回退到默认值
- **安全问题** - 检测到弱密钥

```typescript
console.warn('[WARN] CLI_API_TOKEN 看起来过弱。建议使用更强的密钥。')
console.warn(`[WARN] 来自 ${source} 的 CLI_API_TOKEN 包含 ":"，但不是有效 token。`)
console.error(`[WARN] 解析 ${settingsFile} 失败：${error}`)  // 注意：为了可见性这里使用 console.error
```

**格式**：`[WARN] Message` 或 `[Component] Warning message`。

### `console.error()` - 错误

适用于：
- **意外错误** - 异常、数据库错误、网络失败
- **致命错误** - 服务器无法启动、关键依赖缺失
- **后台任务失败** - 通知发送失败、同步错误
- **服务失败** - Tunnel 启动失败、推送通知错误

```typescript
console.error('致命错误：', error)
console.error('[Tunnel] 启动失败：', error instanceof Error ? error.message : error)
```

**格式**：`[Component] Error message`，并附带错误对象或错误消息。

---

## 日志模式

### 启动配置日志

启动时记录所有配置及其来源：

```typescript
console.log('HAPI Hub 正在启动...')
console.log(`[Hub] HAPI_LISTEN_HOST: ${config.listenHost} (${formatSource(config.sources.listenHost)})`)
console.log(`[Hub] HAPI_LISTEN_PORT: ${config.listenPort} (${formatSource(config.sources.listenPort)})`)
console.log(`[Hub] HAPI_PUBLIC_URL: ${config.publicUrl} (${formatSource(config.sources.publicUrl)})`)
```

**原因**：便于排查配置问题——可以直接看出每个值的来源。

### 组件前缀

对不同组件使用一致的前缀：

- `[Hub]` - 主 hub 进程、配置
- `[Web]` - HTTP 服务器、API 路由
- `[Socket]` - Socket.IO 服务器
- `[Store]` - 数据库操作（较少，仅迁移等场景）
- `[Tunnel]` - WireGuard tunnel 管理
- `[WARN]` - 任意组件发出的警告

```typescript
console.log('[Web] Hub 正在监听 :3000')
console.log('[Socket] 客户端已连接：machine-123')
console.log('[Tunnel] Tunnel 已就绪')
```

### 错误日志

始终带上下文记录意外错误：

```typescript
try {
    await notificationHub.notify(event)
} catch (error) {
    console.error('发送通知失败：', error)
    // 不要重新抛出 - 后台服务应继续运行
}
```

**应包含**：
- 哪个操作失败了
- 错误对象（用于堆栈跟踪）
- 相关上下文（session ID、machine ID 等）

**不要包含**：
- 敏感数据（token、密码）
- 完整请求体（可能含有 PII）

### 条件日志

不要记录正常运行中预期发生的事件：

```typescript
// Bad - 过于嘈杂
socket.on('message', (data) => {
    console.log('收到消息：', data)  // 每条消息都记录
})

// Good - 只记录错误
socket.on('message', (data) => {
    const parsed = messageSchema.safeParse(data)
    if (!parsed.success) {
        // 静默忽略 - 来自有问题客户端的无效事件是预期情况
        return
    }
    // 处理消息，不记录日志
})
```

**谨慎记录**：只记录状态变化、错误和重要事件。不要记录每个请求/消息。

---

## 应记录什么

### ✅ 始终应记录

1. **启动事件**
   - 服务器启动
   - 配置加载完成（含来源）
   - 服务初始化完成（tunnel、push 等）
   - 服务器就绪（含 URL）

2. **配置问题**
   - 检测到弱密钥
   - 无效设置（包含回退信息）
   - 缺失可选配置

3. **服务状态变化**
   - Tunnel 已连接/断开
   - 推送通知服务已启动/停止
   - 数据库迁移已应用

4. **意外错误**
   - 后台任务中的异常
   - 数据库错误
   - 网络失败
   - 服务初始化失败

5. **安全事件**
   - 弱 token 警告
   - 认证失败（应限流）

### ❌ 绝不要记录

1. **密钥和 token**
   ```typescript
   // Bad - 泄露密钥
   console.log('JWT 密钥：', jwtSecret)

   // Good - 只记录其已加载
   console.log('[Hub] JWT 密钥：已从文件加载')
   ```

2. **完整请求/响应体**
   ```typescript
   // Bad - 可能包含 PII
   console.log('请求体：', req.body)

   // Good - 记录校验失败
   console.error('请求体无效：缺少必填字段 "name"')
   ```

3. **用户数据 / PII**
   - 用户 ID（使用通用的 "user" 或哈希）
   - 邮箱地址
   - IP 地址（安全事件除外）
   - 消息内容

4. **高频事件**
   ```typescript
   // Bad - 每条消息都记录
   socket.on('message', (data) => {
       console.log('收到消息')
   })

   // Good - 只记录错误
   socket.on('message', (data) => {
       if (!valid(data)) {
           console.error('消息格式无效')
       }
   })
   ```

5. **预期的校验失败**
   - 400 Bad Request（用户输入无效）
   - 404 Not Found（正常运行中可预期）
   - 401 Unauthorized（未登录时属正常现象）

---

## 格式规范

### 消息格式

```typescript
// 组件前缀 + 消息
console.log('[Hub] 服务器正在启动...')
console.log('[Web] 正在监听 :3000')

// 警告前缀
console.warn('[WARN] 检测到弱 token')

// 带上下文的错误
console.error('[Tunnel] 连接失败：', error)
```

### 多行输出

用于横幅和结构化输出：

```typescript
console.log('')
console.log('='.repeat(70))
console.log('  已生成新的 CLI_API_TOKEN')
console.log('='.repeat(70))
console.log('')
console.log(`  Token: ${config.cliApiToken}`)
console.log('')
console.log(`  已保存到：${config.settingsFile}`)
console.log('')
console.log('='.repeat(70))
console.log('')
```

### 错误对象

始终传入错误对象，以保留堆栈：

```typescript
// Good - 包含堆栈
console.error('操作失败：', error)

// Bad - 丢失堆栈
console.error('操作失败：', error.message)

// Good - 先检查是否为 Error 实例
console.error('[Tunnel] 失败：', error instanceof Error ? error.message : error)
```

---

## 生产环境注意事项

### 日志采集

在生产环境中，日志通常由以下方式采集：
- **Docker**：`docker logs <container>`
- **systemd**：`journalctl -u hapi-hub`
- **PM2**：`pm2 logs`

### 日志轮转

应用本身不处理轮转——使用外部工具：
- Docker：`--log-opt max-size=10m --log-opt max-file=3`
- systemd：由 journald 自动处理
- PM2：内置日志轮转

### 敏感数据

**绝不要记录**：
- `CLI_API_TOKEN` 的值（只记录来源）
- `JWT_SECRET` 的值
- 用户消息内容
- 包含密码的数据库连接串

**可以安全记录**：
- 配置来源（`environment`、`file`、`default`）
- 服务状态（`enabled`、`disabled`）
- 非敏感配置值（port、host、public URL）

---

## 常见错误

- ❌ 记录密钥或 token
- ❌ 记录每个请求/消息（噪音过大）
- ❌ 不记录意外错误
- ❌ 记录 `error.message` 而不是错误对象（会丢失堆栈）
- ❌ 对错误使用 `console.log`（应使用 `console.error`）
- ❌ 不包含组件前缀
- ❌ 记录 PII（用户 ID、邮箱、消息内容）
- ❌ 启动时不记录配置来源
- ❌ 记录预期的校验失败（400、404）

---

## 最佳实践

- ✅ 使用组件前缀（`[Hub]`、`[Web]`、`[Socket]`）
- ✅ 启动时记录配置及其来源
- ✅ 带上下文记录意外错误
- ✅ 传入错误对象以保留堆栈
- ✅ 错误使用 `console.error`，警告使用 `console.warn`
- ✅ 保持日志简洁且可执行
- ✅ 记录状态变化，而不是每个事件
- ✅ 永远不要记录密钥、token 或 PII
- ✅ 访问 `.message` 之前先用 `error instanceof Error` 检查
- ✅ 记录“哪个操作失败了”，而不只是“发生错误”
