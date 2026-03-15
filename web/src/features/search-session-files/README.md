# search-session-files Feature

> 搜索会话文件功能

## 功能说明

提供会话文件搜索功能，支持：
- 文件名搜索
- 路径匹配
- 搜索结果过滤

## 依赖

- `@/entities/file` - 文件实体（包含 useSessionFileSearch hook）
- `@/shared/ui/*` - 通用 UI 组件

## 使用示例

```tsx
import { FileSearchInput } from '@/features/search-session-files'

function SessionFilesPage() {
  return (
    <div>
      <FileSearchInput sessionId="123" />
    </div>
  )
}
```

## 组件

### FileSearchInput

文件搜索输入框组件。

**Props**:
- `sessionId: string` - 会话 ID
- `onResultSelect?: (path: string) => void` - 选择结果回调
