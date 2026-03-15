# browse-directory

## 职责

浏览会话工作目录的文件树，包括：
- 展示目录树结构
- 展开/折叠目录
- 懒加载子目录
- 打开文件

## 依赖

### entities
- `entities/session` - 会话 API
- `entities/file` - 文件类型定义

### shared
- `shared/ui` - Tree, Icon 等组件
- `shared/lib` - 工具函数

## 目录结构

```
browse-directory/
├── ui/
│   ├── DirectoryTree.tsx        # 目录树组件
│   └── DirectoryNode.tsx        # 目录节点组件
├── model/
│   └── useDirectory.ts          # 目录数据 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/SessionFiles/DirectoryTree.tsx` - 目录树组件
- `web/src/hooks/queries/useSessionDirectory.ts` - 目录查询 hook

## 使用示例

```tsx
import { DirectoryTree } from '@/features/browse-directory'

function FilesPage() {
  return (
    <DirectoryTree
      api={api}
      sessionId={sessionId}
      rootLabel={session.directory}
      onOpenFile={(path) => navigate(`/sessions/${sessionId}/file?path=${path}`)}
    />
  )
}
```

## 注意事项

- 使用懒加载，只在展开时加载子目录
- 需要维护展开状态
- 需要显示加载状态和错误信息
- 支持文件图标显示
