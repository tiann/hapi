# view-session-header

## 职责

显示会话头部信息，包括：
- 会话名称
- 会话状态
- 机器信息
- 操作菜单入口
- 视图切换（chat/files/terminal）

## 依赖

### entities
- `entities/session` - 会话信息
- `entities/machine` - 机器信息

### shared
- `shared/ui` - Badge, Button 等组件
- `shared/lib` - 工具函数

## 目录结构

```
view-session-header/
├── ui/
│   ├── SessionHeader.tsx        # 会话头部
│   └── ViewTabs.tsx             # 视图切换标签
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/SessionHeader.tsx` - 会话头部组件

## 使用示例

```tsx
import { SessionHeader } from '@/features/view-session-header'

function SessionPage() {
  return (
    <>
      <SessionHeader
        session={session}
        machine={machine}
        currentView="chat"
        onViewChange={setView}
        onOpenMenu={() => setShowMenu(true)}
      />
      <SessionContent />
    </>
  )
}
```

## 注意事项

- 需要显示会话运行状态
- 需要显示机器连接状态
- 视图切换需要路由同步
- 需要响应式设计（移动端适配）
