# Session Entity

## 职责

管理 AI 对话会话的完整生命周期，包括会话创建、查询、更新、删除和元数据管理。

## 公共 API

### Types
- `Session` - 会话完整信息类型
- `SessionSummary` - 会话摘要类型
- `SessionSummaryMetadata` - 会话摘要元数据类型
- `WorktreeMetadata` - Worktree 元数据类型
- `SessionMetadataSummary` - 会话元数据摘要类型
- `SessionsResponse` - 会话列表响应类型
- `SessionResponse` - 单个会话响应类型
- `SpawnResponse` - 会话创建响应类型

### Hooks
- `useSession(api, sessionId)` - 获取单个会话详情
- `useSessions(api, enabled)` - 获取会话列表
- `useSessionActions(api)` - 会话操作（重命名、删除等）
- `useSpawnSession(api)` - 创建新会话

### Components
- `SessionHeader` - 会话头部组件
- `SessionList` - 会话列表组件
- `SessionActionMenu` - 会话操作菜单
- `RenameSessionDialog` - 重命名会话对话框
- `SpawnSession` - 创建会话组件
- `NewSession/*` - 新建会话相关组件

### Utils
- `sessionTitle` - 会话标题工具函数

## 依赖

### Shared 层依赖
- `@/shared/ui/card` - Card 组件
- `@/shared/lib/host-utils` - 主机工具函数

### 其他依赖
- `@/api/client` - API 客户端
- `@/lib/query-keys` - 查询键
- `@zs/protocol/types` - Protocol 类型定义

## 使用示例

```tsx
import { useSessions, SessionList } from '@/entities/session'

function SessionsPage() {
    const { sessions, isLoading } = useSessions(api, true)

    return <SessionList sessions={sessions} />
}
```
