# session-list-panel Widget

会话列表面板组件，显示所有会话并支持分组、搜索和操作。

## 功能

- 按目录和机器分组显示会话
- 会话状态指示（活跃/思考中/非活跃）
- 会话操作（重命名、归档、删除）
- 长按菜单支持（移动端）
- 折叠/展开分组

## 依赖

- `@/entities/session` - 会话实体
- `@/shared/ui` - 通用 UI 组件
- `@/shared/hooks` - 通用 hooks

## 使用

```tsx
import { SessionListPanel } from '@/widgets/session-list-panel'

<SessionListPanel
  sessions={sessions}
  onSelect={(id) => navigate(`/sessions/${id}`)}
  onNewSession={() => navigate('/new')}
  onRefresh={() => refetch()}
  isLoading={false}
  api={apiClient}
  selectedSessionId={currentSessionId}
/>
```
