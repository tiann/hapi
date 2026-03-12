# Hook 规范

> 本项目中 hooks 的使用方式。

---

## 概述

HAPI Web 大量使用 React hooks 来管理状态与副作用。自定义 hooks 封装业务逻辑，使组件聚焦于表现层。数据获取使用 TanStack Query（React Query），并清晰区分 query 与 mutation。

**关键模式**：
- 使用自定义 hooks 封装可复用逻辑（平台检测、剪贴板、认证）
- 使用 TanStack Query 管理服务端状态（queries 放在 `hooks/queries/`，mutations 放在 `hooks/mutations/`）
- 使用基于 ref 的模式保持回调稳定并避免 stale closure
- 在需要时，与 hook 一起导出非 hook 工具函数

---

## 自定义 Hook 模式

### 基础自定义 Hook

```typescript
// hooks/useCopyToClipboard.ts
import { useState, useCallback } from 'react'
import { usePlatform } from './usePlatform'
import { safeCopyToClipboard } from '@/lib/clipboard'

export function useCopyToClipboard(resetDelay = 1500) {
    const [copied, setCopied] = useState(false)
    const { haptic } = usePlatform()

    const copy = useCallback(async (text: string) => {
        try {
            await safeCopyToClipboard(text)
            haptic.notification('success')
            setCopied(true)
            setTimeout(() => setCopied(false), resetDelay)
            return true
        } catch {
            haptic.notification('error')
            return false
        }
    }, [haptic, resetDelay])

    return { copied, copy }
}
```

关键点：
1. 使用具名导出（不要 default export）
2. 返回带描述性字段名的对象
3. 对返回的函数使用 `useCallback`
4. 配置参数带默认值

### Hook + 非 Hook 工具模式

当逻辑既需要在 React 组件内使用，也需要在组件外使用时，同时导出两者：

```typescript
// hooks/usePlatform.ts
export function usePlatform(): Platform {
    const isTouch = useMemo(
        () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
        []
    )
    return { isTouch, haptic }
}

// 非 hook 版本，供 React 组件外使用
export function getPlatform(): Platform {
    const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    return { isTouch, haptic }
}
```

### 基于 Ref 的稳定回调

对于依赖较多的复杂 hook，使用 refs 避免 stale closure：

```typescript
// 摘自 hooks/useAuth.ts
export function useAuth(authSource: AuthSource | null, baseUrl: string) {
    const [token, setToken] = useState<string | null>(null)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)

    // 让 ref 与 state 保持同步
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const refreshAuth = useCallback(async (options?: { force?: boolean }) => {
        const currentSource = authSourceRef.current  // 从 ref 读取，而不是闭包
        const currentToken = tokenRef.current
        // ... implementation
    }, [baseUrl])  // 最小依赖集

    return { token, api, refreshAuth }
}
```

**为什么**：避免每次渲染都重新创建回调，同时确保回调读取到的是最新值。

---

## 数据获取

### TanStack Query 结构

数据获取按以下方式组织：
- `hooks/queries/` - 读操作（GET 请求）
- `hooks/mutations/` - 写操作（POST/PUT/DELETE 请求）

### Query Hook 模式

```typescript
// hooks/queries/useSessions.ts
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useSessions(api: ApiClient | null): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getSessions()
        },
        enabled: Boolean(api),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
```

关键点：
1. 接受 `ApiClient | null` 以处理未认证状态
2. 使用来自 `lib/query-keys.ts` 的集中式 `queryKeys`
3. 返回归一化结构（data、loading、error、refetch）
4. 为数据提供默认值（如 `?? []`）
5. 使用 `enabled` 防止依赖缺失时发起请求

### Mutation Hook 模式

```typescript
// hooks/mutations/useSendMessage.ts
import { useMutation } from '@tanstack/react-query'
import { usePlatform } from '@/hooks/usePlatform'

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    sendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
    retryMessage: (localId: string) => void
    isSending: boolean
} {
    const { haptic } = usePlatform()

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) throw new Error('API unavailable')
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments)
        },
        onMutate: async (input) => {
            // 乐观更新
            appendOptimisticMessage(input.sessionId, optimisticMessage)
        },
        onSuccess: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'sent')
            haptic.notification('success')
        },
        onError: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'failed')
            haptic.notification('error')
        },
    })

    const sendMessage = (text: string, attachments?: AttachmentMetadata[]) => {
        if (!api || !sessionId) {
            options?.onBlocked?.(/* reason */)
            haptic.notification('error')
            return
        }
        mutation.mutate({ sessionId, text, localId: makeClientSideId('local'), createdAt: Date.now(), attachments })
    }

    return {
        sendMessage,
        retryMessage,
        isSending: mutation.isPending,
    }
}
```

关键点：
1. 用 `onMutate` 实现乐观更新
2. 用 `onSuccess` / `onError` 处理副作用（触感反馈、状态更新）
3. 对 mutation 做用户友好封装（如 `sendMessage`，而不是直接暴露 `mutate`）
4. 防御缺失依赖（api、sessionId）
5. 通过 options 提供灵活回调

### Query Keys

将 query keys 集中定义在 `lib/query-keys.ts`：

```typescript
export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (id: string) => ['session', id] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
}
```

**为什么**：保证一致性，并让失效控制更容易。

---

## 命名约定

### Hook 名称

- 始终使用 `use` 前缀（如 `useAuth`、`useSessions`）
- 使用能表达用途的名称（如 `useCopyToClipboard`，而不是 `useClipboard`）
- Query hooks：`use<Resource>` 或 `use<Resource>s`（如 `useSessions`、`useSession`）
- Mutation hooks：`use<Action><Resource>`（如 `useSendMessage`、`useSpawnSession`）

### 文件名

- 与 hook 名称一致：`useAuth.ts`、`useSessions.ts`
- 每个文件一个 hook（除非是紧密相关的辅助逻辑）
- 放在合适目录中：
  - `hooks/` - 通用自定义 hooks
  - `hooks/queries/` - TanStack Query 读操作
  - `hooks/mutations/` - TanStack Query 写操作
  - `realtime/hooks/` - 实时连接 hooks

### 返回值

返回带描述性字段名的对象，而不是数组：

```typescript
// Good
return { sessions, isLoading, error, refetch }

// Bad - 很难看出每个位置代表什么
return [sessions, isLoading, error, refetch]
```

---

## 常见模式

### 清理与取消

始终清理副作用：

```typescript
useEffect(() => {
    let isCancelled = false

    async function run() {
        const result = await fetchData()
        if (isCancelled) return  // 卸载后不要更新状态
        setData(result)
    }

    run()

    return () => { isCancelled = true }
}, [])
```

### 稳定事件监听器

使用 refs 构建稳定的事件监听器：

```typescript
useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleScroll = () => {
        // 从 refs 读取，而不是闭包
        const isNearBottom = /* ... */
        if (isNearBottom !== atBottomRef.current) {
            atBottomRef.current = isNearBottom
            onAtBottomChangeRef.current(isNearBottom)
        }
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
}, [])  // 稳定：无依赖，从 refs 读取
```

### 条件查询

使用 `enabled` 防止依赖缺失时执行查询：

```typescript
const query = useQuery({
    queryKey: queryKeys.session(sessionId),
    queryFn: async () => api.getSession(sessionId),
    enabled: Boolean(api) && Boolean(sessionId),  // 仅在两者都存在时运行
})
```

---

## 场景：Session header Git 状态（跨层契约）

### 1. 范围 / 触发条件

- 触发条件：在 session header 中新增/更新 Git 状态摘要，并通过 query hook 获取。
- 为什么需要 code-spec 深度：
  - 这是跨层数据流：backend Git RPC -> API client methods -> query hook -> SessionChat -> SessionHeader。
  - loading / unavailable / normal 这些对契约敏感的 UI 状态，在 refetch 期间必须保持稳定。

### 2. 签名

- Query hook 签名：

```typescript
useGitStatusFiles(api: ApiClient | null, sessionId: string | null): {
  status: GitStatusFiles | null
  error: string | null
  isLoading: boolean
}
```

- 该 hook 消费的 API client 签名：

```typescript
api.getGitStatus(sessionId: string): Promise<GitStatus>
api.getGitDiffNumstat(sessionId: string): Promise<GitDiffNumstat>
```

- Header props 契约：

```typescript
gitSummary?: Pick<GitStatusFiles, 'branch' | 'totalStaged' | 'totalUnstaged'> | null
gitLoading?: boolean
gitError?: boolean
```

### 3. 契约

- 请求前置条件：
  - `api` 与 `sessionId` 必须都非 null 后才能执行查询。
  - 如果任一缺失，hook 不得发起网络请求。

- 响应契约（供 header 使用的归一化结果）：
  - `branch: string | null`（`null` 表示 detached 状态，必须渲染本地化的 detached 标签）
  - `totalStaged: number`（>= 0）
  - `totalUnstaged: number`（>= 0）

- UI 文本契约：
  - 所有状态标签必须来自 i18n keys：
    - `session.git.staged`
    - `session.git.unstaged`
    - `session.git.loading`
    - `session.git.unavailable`
    - `session.git.detached`

- 边界契约（防闪烁）：
  - 将最近一次成功的 `GitStatusFiles` 保存在 ref 中。
  - refetch 期间优先显示缓存状态，而不是短暂切到 loading/error。

### 4. 校验与错误矩阵

- `api === null || sessionId === null` -> query disabled，不发请求，header 中 Git 区块隐藏或保持非 loading 状态。
- Hook 请求进行中且无缓存状态 -> 显示 loading UI。
- Hook 请求失败且无缓存状态 -> 显示 unavailable UI。
- Hook 请求失败但有缓存状态 -> 继续显示缓存的正常状态（不出现 unavailable 闪烁）。
- Session identity 改变（`session.id`）-> 在判断 loading/error 回退前必须先重置缓存 git summary，防止上一个 session 的状态/错误泄漏到新 header。
- `branch === null` -> 显示 detached 标签（而不是空字符串）。
- `session.metadata.path` 缺失 -> 不渲染 header 中的 Git 状态区块。

### 5. 良好 / 基线 / 反例

- Good：
  - Session path 指向脏仓库，branch 为 `main`，staged/unstaged 计数带本地化标签正常渲染。
- Base：
  - Session path 指向干净仓库，计数显示 `0`，branch 仍正常显示。
- Bad：
  - Session path 存在，但一次短暂 refetch 错误把已有摘要替换成 `Git unavailable`（闪烁回归）。

### 6. 必需测试

- Unit（hook 级别）：
  - 断言 `useGitStatusFiles` 能从组合 API 数据中返回归一化 totals 和 branch。
  - 断言当 `api` 或 `sessionId` 缺失时 query 不执行。
- Component（SessionHeader）：
  - 断言三态渲染：
    - 当 `gitLoading=true` 且无 summary 时显示 loading
    - 当 `gitError=true` 且无 summary 时显示 unavailable
    - 当有 summary 时显示正常状态
  - 断言当 `branch` 为 null 时显示 detached 回退标签。
- Integration（SessionChat -> SessionHeader）：
  - 断言在后续 loading/error 期间，最近一次成功的 git summary 仍保持可见。
  - 断言点：若存在缓存 summary，不应切换到 `session.git.unavailable` 文本。

### 7. 错误示例 vs 正确示例

#### 错误

```typescript
// 临时重算摘要，丢失了现有的类型化契约
const gitSummary = gitStatus
  ? {
      branch: gitStatus.branch,
      staged: gitStatus.totalStaged,
      unstaged: gitStatus.totalUnstaged,
    }
  : null

// 任何 query error 都直接显示 unavailable
<SessionHeader gitError={Boolean(gitError)} gitSummary={gitSummary} />
```

#### 正确

```typescript
// 直接复用 GitStatusFiles 结构，避免重复映射
const lastGitStatusRef = useRef<GitStatusFiles | null>(null)
if (gitStatus) lastGitStatusRef.current = gitStatus
const gitStatusForHeader = gitStatus ?? lastGitStatusRef.current

<SessionHeader
  gitSummary={gitStatusForHeader}
  gitLoading={gitLoading && !gitStatusForHeader}
  gitError={Boolean(gitError) && !gitStatusForHeader}
/>
```

---

## 常见错误

- ❌ 忘记给 hook 名称加 `use` 前缀
- ❌ 把业务逻辑直接写在组件里，而不是抽到 hooks 中
- ❌ 返回函数不使用 `useCallback`
- ❌ 出现 stale closure（在回调中读取旧 state/props）- 应使用 refs
- ❌ 不清理副作用（事件监听、计时器、异步操作）
- ❌ 硬编码 query keys，而不是使用集中式 `queryKeys`
- ❌ 在 query/mutation hooks 中不处理 `api: null` 的情况
- ❌ 在 hook 返回值中使用 `any`
- ❌ 对复杂返回值使用数组，而不是对象
- ❌ 不给可选数据提供默认值（如 `?? []`）
- ❌ 当 query 依赖其他状态时忘记设置 `enabled`
