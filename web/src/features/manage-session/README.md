# manage-session

## 职责

管理会话的各种操作，包括：
- 重命名会话
- 归档会话
- 删除会话
- 中止会话
- 切换会话
- 设置权限模式
- 设置模型模式

## 依赖

### entities
- `entities/session` - 会话 API、类型定义

### shared
- `shared/ui` - Dialog, Button 等组件
- `shared/lib` - 工具函数

## 目录结构

```
manage-session/
├── ui/
│   ├── RenameSessionDialog.tsx  # 重命名对话框
│   └── SessionActionMenu.tsx    # 会话操作菜单
├── model/
│   └── useSessionActions.ts     # 会话操作 hooks
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/hooks/mutations/useSessionActions.ts` - 会话操作 hooks
- `web/src/components/RenameSessionDialog.tsx` - 重命名对话框
- `web/src/components/SessionActionMenu.tsx` - 操作菜单

## 使用示例

```tsx
import { useSessionActions, RenameSessionDialog } from '@/features/manage-session'

function SessionHeader() {
  const { renameSession, archiveSession, deleteSession } = useSessionActions(api, sessionId)

  return (
    <>
      <button onClick={() => setShowRename(true)}>Rename</button>
      <RenameSessionDialog
        isOpen={showRename}
        currentName={session.name}
        onRename={renameSession}
      />
    </>
  )
}
```

## 注意事项

- 删除会话后需要清理消息缓存
- 归档和删除需要根据会话状态显示不同选项
- 权限模式需要根据 agent flavor 验证
- 所有操作完成后需要刷新会话列表
