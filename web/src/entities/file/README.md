# File Entity

## 职责

管理会话目录浏览、文件搜索、文件上传和删除等文件系统操作。

## 公共 API

### Types
- `DirectoryEntry` - 目录条目类型
- `ListDirectoryResponse` - 目录列表响应类型
- `FileSearchItem` - 文件搜索项类型
- `FileSearchResponse` - 文件搜索响应类型
- `FileReadResponse` - 文件读取响应类型
- `UploadFileResponse` - 文件上传响应类型
- `DeleteUploadResponse` - 文件删除响应类型

### Hooks
- `useSessionDirectory(api, sessionId, path)` - 获取会话目录列表
- `useSessionFileSearch(api, sessionId, query)` - 搜索会话文件

### Components
- `DirectoryTree` - 目录树组件
- `FileIcon` - 文件图标组件

## 依赖

### Shared 层依赖
- 无直接依赖

### 其他依赖
- `@/api/client` - API 客户端
- `@/lib/query-keys` - 查询键

## 使用示例

```tsx
import { useSessionDirectory, DirectoryTree, FileIcon } from '@/entities/file'

function FileExplorer({ sessionId }: { sessionId: string }) {
    const { entries, isLoading } = useSessionDirectory(api, sessionId, '/')

    return <DirectoryTree entries={entries} />
}
```
