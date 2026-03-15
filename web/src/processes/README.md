# Processes 层

跨页面的业务流程编排层。

## 职责
- 协调多个页面的业务流程
- 管理跨页面的状态
- 处理复杂的业务编排逻辑

## 已实现的 Processes

### 1. auth-bootstrap - 认证初始化流程

负责应用启动时的认证状态建立和管理。

**职责**：
- Server URL 管理（从 URL 参数或 localStorage 读取）
- Auth Source 初始化（检测环境、读取 token）
- Token 建立（使用 auth source 获取 access token）
- URL 参数清理（认证成功后清理敏感参数）

**使用**：
```tsx
import { useAuthBootstrap } from '@/processes/auth-bootstrap'

const {
  serverUrl,
  baseUrl,
  authSource,
  token,
  api,
  isAuthSourceLoading,
  isAuthLoading,
  authError,
  setAccessToken
} = useAuthBootstrap()
```

### 2. session-sync - 会话同步流程

负责 SSE 连接管理、数据同步和推送通知订阅。

**职责**：
- SSE 连接管理（建立、断开、重连）
- Query invalidation 触发
- Visibility reporter 上报
- Push notifications 首次授权/订阅
- Toast 消息分发

**使用**：
```tsx
import { useSessionSync } from '@/processes/session-sync'

const {
  isSyncing,
  sseDisconnected,
  sseDisconnectReason,
  subscriptionId
} = useSessionSync({
  enabled: Boolean(token),
  token,
  baseUrl,
  selectedSessionId,
  api,
  addToast
})
```

## 目录结构

每个 process 遵循以下结构：

```
processes/<process-name>/
├── README.md           # 流程说明
├── model/              # 流程状态管理
│   └── hooks.ts        # 流程 hooks
├── lib/                # 流程工具函数
│   └── *.ts
└── index.ts            # 统一导出
```

## 依赖规则

- Processes 可以依赖 pages、widgets、features、entities 和 shared
- Processes 之间可以有依赖关系（但要避免循环依赖）
- Processes 通常在 app 层（App.tsx）被调用

## 设计原则

**应该放在 processes**：
- 跨页面的业务流程
- 需要协调多个 entities/features 的逻辑
- 应用级的状态管理
- 复杂的异步流程编排

**不应该放在 processes**：
- 单一页面的逻辑（应该在 pages/widgets）
- 单一功能的逻辑（应该在 features）
- 通用工具函数（应该在 shared）
