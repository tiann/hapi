# Session Sync Process

## 职责

会话同步流程，负责 SSE 连接管理、数据同步和推送通知订阅。

## 功能

1. **SSE 连接管理**
   - 建立 SSE 连接（/api/events）
   - 处理连接/断开事件
   - 自动重连（指数退避 + 抖动）
   - 心跳超时检测

2. **Query Invalidation**
   - 连接成功后触发数据刷新
   - 批量处理 invalidation 请求（16ms 防抖）
   - 区分首次连接和后续连接

3. **Visibility Reporter**
   - 监听页面可见性变化
   - 上报 visibility 状态到服务器
   - 错误重试机制

4. **Push Notifications**
   - 检测推送通知支持
   - 首次权限请求
   - 订阅服务器推送

5. **Toast 消息分发**
   - 处理 SSE 中的 toast 事件
   - 分发到 toast 上下文

## 使用

```tsx
import { useSessionSync } from '@/processes/session-sync'

function App() {
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
    api
  })

  return (
    <>
      <SyncingBanner isSyncing={isSyncing} />
      <ReconnectingBanner
        isReconnecting={sseDisconnected && !isSyncing}
        reason={sseDisconnectReason}
      />
    </>
  )
}
```

## 依赖

- `hooks/useSSE` - SSE 连接管理
- `hooks/useSyncingState` - 同步状态管理
- `hooks/useVisibilityReporter` - 可见性上报
- `hooks/usePushNotifications` - 推送通知
- `lib/query-keys` - React Query keys
- `lib/message-window-store` - 消息存储
- `lib/toast-context` - Toast 上下文

## 输出

- 同步状态（isSyncing）
- SSE 连接状态（sseDisconnected, sseDisconnectReason）
- 订阅 ID（subscriptionId）
