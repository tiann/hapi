# view-git-status

## 职责

查看会话工作目录的 Git 状态，包括：
- 显示 Git 状态文件列表
- 文件状态标识（modified/added/deleted）
- 打开文件查看
- 刷新 Git 状态

## 依赖

### entities
- `entities/git` - Git 状态 API、类型定义
- `entities/file` - 文件类型

### shared
- `shared/ui` - List, Badge 等组件
- `shared/lib` - 工具函数

## 目录结构

```
view-git-status/
├── ui/
│   ├── GitStatusList.tsx        # Git 状态列表
│   └── GitStatusBadge.tsx       # 状态标识
├── model/
│   └── useGitStatus.ts          # Git 状态 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/hooks/queries/useGitStatusFiles.ts` - Git 状态 hook
- 相关 Git 状态 UI 组件（从 SessionFiles 中提取）

## 使用示例

```tsx
import { GitStatusList } from '@/features/view-git-status'

function FilesPage() {
  return (
    <GitStatusList
      api={api}
      sessionId={sessionId}
      onOpenFile={(path) => navigate(`/sessions/${sessionId}/file?path=${path}`)}
    />
  )
}
```

## 注意事项

- 需要定期刷新 Git 状态
- 不同状态需要不同的视觉标识
- 需要处理 Git 不可用的情况
- 支持手动刷新
