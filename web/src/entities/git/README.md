# Git Entity

## 职责

管理 Git 状态查询、文件状态解析和 Diff 视图展示。

## 公共 API

### Types
- `GitFileStatus` - Git 文件状态类型
- `GitStatusFiles` - Git 状态文件列表类型
- `GitCommandResponse` - Git 命令响应类型

### Hooks
- `useGitStatusFiles(api, sessionId)` - 获取 Git 状态文件列表

### Components
- `DiffView` - Diff 视图组件

### Utils
- `gitParsers` - Git 输出解析工具函数

## 依赖

### Shared 层依赖
- 无直接依赖

### 其他依赖
- `@/api/client` - API 客户端
- `@/lib/query-keys` - 查询键

## 使用示例

```tsx
import { useGitStatusFiles, DiffView } from '@/entities/git'

function GitStatus({ sessionId }: { sessionId: string }) {
    const { stagedFiles, unstagedFiles, branch } = useGitStatusFiles(api, sessionId)

    return (
        <div>
            <div>Branch: {branch}</div>
            <DiffView files={stagedFiles} />
        </div>
    )
}
```
