# select-session

## 职责

选择和导航到会话，包括：
- 显示会话列表
- 会话搜索/过滤
- 会话状态显示
- 点击进入会话

## 依赖

### entities
- `entities/session` - 会话列表 API、类型定义
- `entities/machine` - 机器信息

### shared
- `shared/ui` - List, Badge 等组件
- `shared/lib` - 工具函数

## 目录结构

```
select-session/
├── ui/
│   ├── SessionList.tsx          # 会话列表
│   └── SessionListItem.tsx      # 会话列表项
├── model/
│   └── useSessionList.ts        # 会话列表 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/SessionList.tsx` - 会话列表组件

## 使用示例

```tsx
import { SessionList } from '@/features/select-session'

function SessionsPage() {
  return (
    <SessionList
      sessions={sessions}
      onSelect={(sessionId) => navigate(`/sessions/${sessionId}`)}
    />
  )
}
```

## 注意事项

- 需要显示会话状态（active/archived）
- 需要显示机器信息
- 需要显示最后活动时间
- 支持搜索和过滤
- 需要处理空状态
