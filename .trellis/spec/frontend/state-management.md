# 状态管理

> 本项目中状态的管理方式。

---

## 概述

HAPI Web 采用**混合式状态管理方案**：

1. **本地组件状态**（`useState`、`useReducer`）用于仅影响 UI 的状态
2. **TanStack Query** 用于服务端状态（API 数据、缓存、同步）
3. **模块级 store** 用于不适合 React Query 的跨组件状态
4. **URL 状态**（TanStack Router）用于导航与可分享状态
5. **Context** 用于依赖注入（API client、session context）

**不使用全局状态库**（Redux、Zustand 等）——状态尽量保持在靠近使用处。

---

## 状态分类

### 1. 本地组件状态

对于只影响单个组件的状态，使用 `useState` 或 `useReducer`：

```typescript
// 仅 UI 使用的状态
const [isOpen, setIsOpen] = useState(false)
const [copied, setCopied] = useState(false)
const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
```

**适用场景**：
- UI 开关（modal、dropdown、展开/收起）
- 表单输入值（提交前）
- 临时 UI 状态（loading spinner、动画）

### 2. 服务端状态（TanStack Query）

所有服务端数据都使用 TanStack Query：

```typescript
// 读取查询
const { sessions, isLoading, error, refetch } = useSessions(api)

// 写入 mutation
const { sendMessage, isSending } = useSendMessage(api, sessionId)
```

**适用场景**：
- 任何来自 API endpoint 的数据
- 需要缓存的数据
- 需要后台重新获取的数据
- 乐观更新

**配置**（`lib/query-client.ts`）：
```typescript
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5_000,           // 缓存 5 秒
            refetchOnWindowFocus: false, // Tab 聚焦时不自动重新获取
            retry: 1,                    // 查询失败后重试一次
        },
        mutations: {
            retry: 0,                    // mutation 不自动重试
        },
    },
})
```

### 3. 模块级 Store

对于不适合 React Query 的跨组件状态，使用带订阅模式的模块级 store：

```typescript
// lib/message-window-store.ts
const states = new Map<string, MessageWindowState>()
const listeners = new Map<string, Set<() => void>>()

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return states.get(sessionId) ?? createInitialState(sessionId)
}

export function subscribeToMessageWindow(sessionId: string, listener: () => void): () => void {
    const sessionListeners = listeners.get(sessionId) ?? new Set()
    sessionListeners.add(listener)
    listeners.set(sessionId, sessionListeners)
    return () => sessionListeners.delete(listener)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    const state = getMessageWindowState(sessionId)
    // ... 更新状态
    notifyListeners(sessionId)
}
```

**适用场景**：
- 实时消息窗口（乐观更新、待发送消息）
- 需要在组件卸载后继续保留的状态
- 多个无直接关系组件共享的状态
- 对性能敏感的状态（避免 React 级联重渲染）

**模式**：暴露 getters、setters 与订阅函数。组件在 `useEffect` 中订阅。

### 4. URL 状态（TanStack Router）

可分享 / 可收藏的状态使用 URL 参数表示：

```typescript
// 路由定义
export const Route = createFileRoute('/sessions/$sessionId')({
    component: SessionPage,
})

// 组件中读取
const { sessionId } = Route.useParams()
```

**适用场景**：
- 当前页面/视图（session ID、settings tab）
- 筛选条件与搜索参数
- 任何应该能通过 URL 分享的状态

### 5. Context（依赖注入）

Context 用于向组件树下传递依赖，而不是承载频繁变化的状态：

```typescript
// components/AssistantChat/context.tsx
export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
}

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return <HappyChatContext.Provider value={props.value}>{props.children}</HappyChatContext.Provider>
}
```

**适用场景**：
- 向深层组件传递 API client
- 功能级配置（session context、theme）
- 需要在深层组件中可访问的 callbacks

**不要用于**：
- 高频变化的状态（会导致整棵子树重渲染）
- 本可以放在本地状态或 React Query 中的状态

---

## 何时使用全局状态

**默认优先本地状态。** 只有在以下情况下才提升为全局：

1. **多个无直接关系的组件**需要共享同一份状态
2. **状态必须持久化**，即使组件卸载也不能丢失
3. **性能敏感**（避免 prop drilling 导致重复渲染）
4. **实时更新**，且不适合 React Query 的数据模型

**示例**：消息窗口状态之所以做成全局，是因为：
- 多个组件都需要它（thread、composer、status bar）
- 滚动或切换导致组件卸载时也必须保留
- 乐观更新需要立刻反馈到 UI
- 实时消息通过 WebSocket 到达

---

## 服务端状态最佳实践

### Query Keys

统一收敛在 `lib/query-keys.ts`：

```typescript
export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (id: string) => ['session', id] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
    machines: ['machines'] as const,
}
```

### 乐观更新

对于需要即时反馈的 mutation：

```typescript
const mutation = useMutation({
    mutationFn: async (input) => {
        await api.sendMessage(input.sessionId, input.text, input.localId)
    },
    onMutate: async (input) => {
        // 立即把消息加到 UI 中
        appendOptimisticMessage(input.sessionId, {
            id: input.localId,
            content: { role: 'user', content: { type: 'text', text: input.text } },
            status: 'sending',
        })
    },
    onSuccess: (_, input) => {
        // 更新状态为 'sent'
        updateMessageStatus(input.sessionId, input.localId, 'sent')
    },
    onError: (_, input) => {
        // 更新状态为 'failed'
        updateMessageStatus(input.sessionId, input.localId, 'failed')
    },
})
```

### 缓存失效

mutation 成功后要使相关查询失效：

```typescript
const mutation = useMutation({
    mutationFn: async (sessionId) => {
        await api.deleteSession(sessionId)
    },
    onSuccess: () => {
        // 重新获取 sessions 列表
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    },
})
```

---

## 派生状态

### 在 render 中直接计算

对于简单派生状态，直接在 render 中计算：

```typescript
function SessionList({ sessions }: { sessions: Session[] }) {
    const activeSessions = sessions.filter(s => s.active)
    const inactiveSessions = sessions.filter(s => !s.active)
    // ...
}
```

### 仅在昂贵计算时使用 useMemo

只有在计算成本较高时才使用 `useMemo`：

```typescript
const sortedSessions = useMemo(() => {
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}, [sessions])
```

**不要**把 `useMemo` 用在便宜计算上——它本身也有开销。

---

## 常见错误

- ❌ 对频繁变化的状态使用 Context（导致重渲染）
- ❌ 过早提升状态（在真的需要共享之前应保持本地）
- ❌ 不用 TanStack Query 管理服务端数据（重复造缓存/重新获取轮子）
- ❌ 存储派生状态而不是直接计算
- ❌ 对便宜计算使用 `useMemo`（过早优化）
- ❌ mutation 后没有失效相关 queries
- ❌ 忘记清理模块级 store 的订阅
- ❌ 把纯 UI 状态塞进 URL（只有可分享状态才适合放那里）
- ❌ 在本地状态足够时仍使用全局状态
- ❌ 对可选 query 数据不提供默认值（`?? []`）
- ❌ 将 composer 草稿文本视为全局/thread 状态，而产品预期其实是**按 session 作用域持久化草稿**

---

## Session 级草稿契约（聊天输入框）

当聊天输入内容需要在 session 切换后仍然保留时，应遵循以下契约：

### 必需行为

- 草稿文本按 `session.id`（或等价的稳定 session 标识）进行作用域隔离。
- 从 session A 切走再回到 session A 时，应恢复它之前的草稿。
- 切到 session B 时，不得显示 session A 的草稿。
- 发送成功时，只清空当前活跃 session 的草稿。
- 未发送草稿在应用内部的 route/session tab 切换时不得丢失。

### 实现模式

- 维护一个以 session 为 key 的 draft store（`Map<sessionId, draft>` / 模块级 store / 持久化层）。
- 在活跃 session 变化时：
  - 通过 `draftStore.get(session.id) ?? ''` 将草稿注入到输入框
  - 每次变更或 debounce 后，都将编辑结果持久化到对应的 session key
- 对多 session UX，绝不能依赖一个未分作用域的 `composer.text` 值。

### 最低测试用例

- `A -> 输入 "123" -> 切换 B -> 切回 A` => 输入框内容应为 `123`。
- `A 有 "foo"，B 有 "bar"` => 切换 session 时应显示各自独立草稿。
- `A 发送消息` => A 的草稿被清空；B 的草稿保持不变。
- route remount / re-entry 后，仍能从 session 级 store 中恢复草稿。

---

## 状态流示例

**发送一条消息**：

1. 用户在 composer 中输入（本地状态：`useState`）
2. 用户点击发送 -> 调用 `useSendMessage` mutation
3. mutation 的 `onMutate` 将乐观消息写入模块级 store
4. 模块级 store 通知订阅者 -> UI 立即更新
5. API 调用完成 -> `onSuccess` 更新消息状态
6. 实时 WebSocket 收到确认 -> 再次更新模块级 store

**为什么这样可行**：
- 输入框使用本地状态（无需共享）
- API 调用使用 TanStack Query（缓存、重试、错误处理）
- 消息窗口使用模块级 store（跨组件、实时、乐观更新）
- 没有 prop drilling，也避免了不必要的重渲染
