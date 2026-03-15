# session-header Widget

会话头部组件，显示会话信息和视图切换。

## 功能

- 显示会话标题和主机信息
- Git 状态显示
- 视图切换（聊天/终端/文件）
- 会话操作菜单

## 依赖

- `@/entities/session` - 会话实体
- `@/entities/git` - Git 实体
- `@/shared/ui` - 通用 UI 组件

## 使用

```tsx
import { SessionHeader } from '@/widgets/session-header'

<SessionHeader
  session={session}
  onBack={() => navigate(-1)}
  api={apiClient}
  onSessionDeleted={() => navigate('/sessions')}
  gitSummary={gitData}
  currentView="chat"
  onSelectView={(view) => setCurrentView(view)}
/>
```
