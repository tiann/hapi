# 目录结构

> 本项目后端代码的组织方式。

---

## 概述

HAPI Hub 是一个基于 Bun 的后端服务，提供：
- HTTP API 服务器（Hono 框架）
- Socket.IO 服务器用于实时 CLI 连接
- SSE（Server-Sent Events）用于 Web 客户端更新
- SQLite 数据库（WAL 模式）
- WireGuard 隧道管理

**核心特征**：
- 基于功能的组织方式（notifications、socket、store 等）
- 扁平的模块结构（最多 2 层深度）
- 清晰的关注点分离（handlers、stores、services）
- 严格的 TypeScript 类型安全

---

## 目录布局

```
hub/src/
├── config/                 # 配置管理
│   ├── jwtSecret.ts        # JWT 密钥生成/加载
│   ├── vapidKeys.ts        # 推送通知的 VAPID 密钥
│   ├── settings.ts         # 服务器设置（端口、CORS 等）
│   └── ...
├── notifications/          # 通知系统
│   ├── notificationHub.ts  # 中央通知分发器
│   ├── eventParsing.ts     # 将同步事件解析为通知
│   └── notificationTypes.ts # 通知通道接口
├── push/                   # Web 推送通知
│   ├── pushService.ts      # 推送通知服务
│   └── pushNotificationChannel.ts # 推送通道实现
├── socket/                 # Socket.IO 服务器
│   ├── server.ts           # Socket.IO 服务器设置
│   ├── handlers/           # Socket 事件处理器
│   │   ├── cli/            # CLI 客户端处理器
│   │   │   ├── machineHandlers.ts
│   │   │   ├── sessionHandlers.ts
│   │   │   ├── terminalHandlers.ts
│   │   │   └── rpcHandlers.ts
│   │   └── terminal.ts     # 终端模拟器处理器
│   ├── rpcRegistry.ts      # RPC 方法注册表
│   └── terminalRegistry.ts # 终端会话注册表
├── sse/                    # Server-Sent Events
│   └── sseManager.ts       # SSE 连接管理器
├── store/                  # 数据库层（SQLite）
│   ├── index.ts            # Store 初始化与 schema
│   ├── sessionStore.ts     # Session CRUD 操作
│   ├── machineStore.ts     # Machine CRUD 操作
│   ├── messageStore.ts     # Message CRUD 操作
│   ├── userStore.ts        # User CRUD 操作
│   ├── pushStore.ts        # Push subscription CRUD
│   ├── sessions.ts         # Session 业务逻辑
│   ├── machines.ts         # Machine 业务逻辑
│   ├── messages.ts         # Message 业务逻辑
│   └── types.ts            # Store 类型定义
├── sync/                   # 同步引擎
│   └── syncEngine.ts       # 中央状态同步
├── tunnel/                 # WireGuard 隧道管理
│   └── ...
├── types/                  # 共享类型定义
│   └── ...
├── utils/                  # 工具函数
│   └── ...
├── visibility/             # 可见性跟踪
│   └── visibilityTracker.ts
├── web/                    # HTTP API 服务器
│   ├── server.ts           # Hono 服务器设置
│   ├── middleware/         # HTTP 中间件
│   └── routes/             # API 路由处理器
├── configuration.ts        # 配置加载
└── index.ts                # 主入口点
```

---

## 模块组织

### Store 层模式

**数据访问与业务逻辑分离**：

- `*Store.ts` 文件 = 纯 CRUD 操作（数据库交互）
- `*.ts` 文件（无 Store 后缀）= 业务逻辑（使用 store 函数）

**示例**：
```typescript
// sessionStore.ts - 数据访问
export function getSessionById(db: Database, id: string): Session | null {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
}

// sessions.ts - 业务逻辑
export function activateSession(db: Database, id: string): Result<void> {
  const session = getSessionById(db, id)
  if (!session) return { ok: false, error: 'Session not found' }
  // ... 业务规则
}
```

### Socket 处理器

**按客户端类型组织**：
- `socket/handlers/cli/` - CLI 客户端特定处理器
- `socket/handlers/terminal.ts` - 终端模拟器处理器

**RPC 注册表模式**：
```typescript
// rpcRegistry.ts
export const rpcRegistry = {
  'session:create': handleSessionCreate,
  'session:stop': handleSessionStop,
  // ...
}
```

### 通知系统

**中心化分发**：
- `notificationHub.ts` - 中央分发器
- `notificationTypes.ts` - 通道接口定义
- 具体通道实现（`pushNotificationChannel.ts`、SSE 等）

**事件驱动**：
```typescript
// 同步事件 → 通知
syncEngine.on('session:updated', (event) => {
  notificationHub.dispatch({
    type: 'session:updated',
    sessionId: event.sessionId,
    // ...
  })
})
```

---

## 命名约定

### 文件

- **Store 文件**：`*Store.ts`（例如 `sessionStore.ts`）
- **业务逻辑**：`*.ts`（例如 `sessions.ts`）
- **服务**：`*Service.ts`（例如 `pushService.ts`）
- **处理器**：`*Handlers.ts`（例如 `machineHandlers.ts`）
- **类型**：`types.ts` 或 `*Types.ts`

### 目录

- **功能目录**：小写，连字符分隔（例如 `notifications/`、`socket/`）
- **处理器子目录**：按客户端类型（例如 `handlers/cli/`）

### 导入

始终使用命名导出，避免默认导出：

```typescript
// 推荐
export function getSessionById(db: Database, id: string): Session | null

// 避免
export default function getSessionById(db: Database, id: string): Session | null
```

---

## 示例

### 组织良好的模块

- **`store/`** - 清晰的 CRUD 与业务逻辑分离
- **`socket/handlers/cli/`** - 按客户端类型清晰组织处理器
- **`notifications/`** - 自包含功能，包含 hub、解析、类型

### 添加新功能

当添加新功能（例如"Analytics"）时：

1. 创建功能目录：`analytics/`
2. 添加主服务：`analytics/analyticsService.ts`
3. 添加类型：`analytics/types.ts`
4. 添加测试：`analytics/analyticsService.test.ts`
5. 从 barrel 导出：`analytics/index.ts`
6. 在 `index.ts` 主入口点集成

---

## 反模式

### 不要

- ❌ 创建深层嵌套目录（最多 2 层：`socket/handlers/cli/`）
- ❌ 混合业务逻辑与数据访问（使用 store 层模式）
- ❌ 把所有东西放在 `index.ts` 中（使用功能模块）
- ❌ 使用默认导出（使用命名导出）
- ❌ 在模块之间创建循环依赖
- ❌ 将类型放在单独的 `types/` 目录中，除非跨多个模块共享

### 要

- ✅ 保持模块扁平且易于发现
- ✅ 分离 CRUD 与业务逻辑（store 模式）
- ✅ 在功能目录中分组相关功能
- ✅ 一致使用命名导出
- ✅ 将类型保持在使用位置附近（同一模块中）
- ✅ 使用 barrel 导出作为公共 API
