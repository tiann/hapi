# 类型安全

> 本项目中的类型安全模式。

---

## 概述

HAPI Web 使用**严格模式的 TypeScript**，并具备全面的类型覆盖。类型集中在 `types/` 目录中，并通过路径别名导入。项目强调：

- **严格 TypeScript**（`strict: true`、`noImplicitAny: true`、`strictNullChecks: true`）
- **共享协议类型**，来自 `@hapi/protocol` workspace 包
- **仅类型导入**，以便更好地 tree-shaking
- **前端无运行时验证**（验证在后端进行）
- **显式 null 处理**（无隐式 undefined）

---

## 类型组织

### 共享类型（`types/api.ts`）

所有 API 相关类型都位于 `types/api.ts`：

```typescript
// 从共享协议包重新导出类型
export type {
    AgentState,
    AttachmentMetadata,
    Session,
    SessionSummary,
} from '@hapi/protocol/types'

// 前端特定扩展
export type DecryptedMessage = ProtocolDecryptedMessage & {
    status?: MessageStatus
    originalText?: string
}

// API 响应类型
export type SessionsResponse = { sessions: SessionSummary[] }
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        beforeSeq: number | null
        nextBeforeSeq: number | null
        hasMore: boolean
    }
}
```

**模式**：从协议导入，按需扩展，定义响应形状。

### 本地类型

组件特定类型在同一文件中定义：

```typescript
// components/Spinner.tsx
type SpinnerProps = {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string | null
}
```

**何时使用本地类型**：
- 组件的 props 类型
- 内部状态类型
- 仅在一个文件中使用的类型

**何时使用共享类型**：
- API 数据结构
- 跨多个文件使用的类型
- 领域模型（Session、Message、Machine）

### 仅类型导入

始终对仅类型导入使用 `type` 关键字：

```typescript
// Good - 仅类型导入
import type { Session, Message } from '@/types/api'

// Bad - 运行时导入（即使只用于类型）
import { Session, Message } from '@/types/api'
```

**为什么**：更好的 tree-shaking，明确意图，避免循环依赖。

---

## 类型模式

### 判别联合

对变体类型使用判别联合：

```typescript
type MessageStatus =
    | { type: 'pending' }
    | { type: 'sent', timestamp: number }
    | { type: 'failed', error: string }

function renderStatus(status: MessageStatus) {
    switch (status.type) {
        case 'pending':
            return <Spinner />
        case 'sent':
            return <span>发送于 {formatTime(status.timestamp)}</span>
        case 'failed':
            return <span className="error">{status.error}</span>
    }
}
```

**为什么**：TypeScript 可以在 switch 中收窄类型，确保处理所有情况。

### 类型守卫

为运行时检查创建类型守卫：

```typescript
function isSession(value: unknown): value is Session {
    return (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        'namespace' in value
    )
}

// 使用
if (isSession(data)) {
    // TypeScript 知道 data 是 Session
    console.log(data.id)
}
```

### Null 处理

显式处理 `null` 和 `undefined`：

```typescript
// Good - 显式处理
function getSessionName(session: Session | null): string {
    return session?.metadata?.name ?? '未命名会话'
}

// Bad - 非空断言
function getSessionName(session: Session | null): string {
    return session!.metadata!.name  // 可能崩溃
}
```

### 字面量类型

对常量使用 `as const`：

```typescript
// Good - 字面量类型
const SIZES = ['sm', 'md', 'lg'] as const
type Size = typeof SIZES[number]  // 'sm' | 'md' | 'lg'

// Bad - 字符串数组
const SIZES = ['sm', 'md', 'lg']
type Size = string  // 过于宽泛
```

---

## API 类型

### 请求类型

```typescript
// types/api.ts
export type CreateSessionRequest = {
    tag?: string
    metadata?: Record<string, unknown>
}

export type UpdateSessionRequest = {
    metadata?: Record<string, unknown>
    metadataVersion?: number
}
```

### 响应类型

```typescript
// types/api.ts
export type SessionResponse = {
    session: Session
}

export type ErrorResponse = {
    error: string
}
```

### API 客户端类型

```typescript
// lib/api.ts
export class ApiClient {
    async getSessions(): Promise<SessionsResponse> {
        const response = await fetch(`${this.baseUrl}/sessions`)
        return response.json()
    }

    async createSession(request: CreateSessionRequest): Promise<SessionResponse> {
        const response = await fetch(`${this.baseUrl}/sessions`, {
            method: 'POST',
            body: JSON.stringify(request)
        })
        return response.json()
    }
}
```

---

## React 类型

### 组件 Props

```typescript
// 使用 type，不用 interface
type ButtonProps = {
    variant?: 'primary' | 'secondary'
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    onClick?: () => void
    children: React.ReactNode
}

export function Button({ variant = 'primary', size = 'md', ...props }: ButtonProps) {
    // ...
}
```

### Hook 返回类型

```typescript
// Good - 对象返回类型
function useSession(id: string) {
    const [session, setSession] = useState<Session | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    return { session, loading, error }
}

// Bad - 数组返回类型（难以记住顺序）
function useSession(id: string) {
    return [session, loading, error]
}
```

### 事件处理器

```typescript
// Good - 显式类型
function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
}

// Good - 推断类型
<button onClick={(e) => console.log(e.currentTarget)}>
```

---

## 类型推断

### 何时标注类型

```typescript
// Good - 让 TypeScript 推断
const sessions = await api.getSessions()  // 推断为 SessionsResponse

// Good - 标注不明确的情况
const [data, setData] = useState<Session | null>(null)

// Bad - 过度标注
const sessions: SessionsResponse = await api.getSessions()
```

### 何时使用 `unknown`

```typescript
// Good - 对真正未知的数据使用 unknown
function handleMessage(data: unknown) {
    if (isSession(data)) {
        // 收窄后使用
    }
}

// Bad - 使用 any
function handleMessage(data: any) {
    // 失去类型安全
}
```

---

## 常见模式

### 可选链与空值合并

```typescript
// Good - 安全访问
const name = session?.metadata?.name ?? '默认名称'

// Bad - 多个 if 检查
let name = '默认名称'
if (session && session.metadata && session.metadata.name) {
    name = session.metadata.name
}
```

### 类型断言

```typescript
// Good - 使用类型守卫
if (isSession(data)) {
    console.log(data.id)
}

// Bad - 使用 as（绕过类型检查）
const session = data as Session
console.log(session.id)  // 可能崩溃
```

### 泛型

```typescript
// Good - 泛型工具函数
function pick<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
    const result = {} as Pick<T, K>
    for (const key of keys) {
        result[key] = obj[key]
    }
    return result
}

// 使用
const partial = pick(session, ['id', 'namespace'])
```

---

## 类型 vs Interface

### 始终使用 `type`

```typescript
// Good - 使用 type
type ButtonProps = {
    variant: 'primary' | 'secondary'
    onClick: () => void
}

// Bad - 使用 interface
interface ButtonProps {
    variant: 'primary' | 'secondary'
    onClick: () => void
}
```

**为什么**：`type` 更灵活（联合、交叉），并与代码库保持一致。

---

## 常见错误

- ❌ 使用 `any` 而不是 `unknown`
- ❌ 仅类型导入时不使用 `type` 关键字
- ❌ 对 props 使用 `interface` 而不是 `type`
- ❌ 使用 `@ts-ignore` 忽略 TypeScript 错误
- ❌ 不进行 null 检查就使用非空断言（`!`）
- ❌ 不显式处理 `null` 和 `undefined`
- ❌ 内联定义类型而不是提取它们
- ❌ 对变体类型不使用判别联合
- ❌ 使用 `as any` 进行类型强制转换
- ❌ 不利用类型推断（过度标注）

---

## 最佳实践

- ✅ 对所有类型定义使用 `type`
- ✅ 对仅类型导入使用 `type` 关键字
- ✅ 显式处理 `null` 和 `undefined`
- ✅ 对变体使用判别联合
- ✅ 对真正未知的数据使用 `unknown`
- ✅ 为运行时检查创建类型守卫
- ✅ 对字面量类型使用 `as const`
- ✅ 利用类型推断（不要过度标注）
- ✅ 将类型保持在使用位置附近（本地类型在同一文件中）
- ✅ 需要跨文件共享时通过 `types/api.ts` 共享类型
