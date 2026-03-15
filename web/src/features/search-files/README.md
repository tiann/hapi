# search-files

## 职责

在会话工作目录中搜索文件，包括：
- 文件名搜索
- 实时搜索结果
- 搜索结果展示
- 打开文件

## 依赖

### entities
- `entities/session` - 会话 API
- `entities/file` - 文件类型定义

### shared
- `shared/ui` - Input, List 等组件
- `shared/lib` - 防抖等工具函数

## 目录结构

```
search-files/
├── ui/
│   ├── FileSearchInput.tsx      # 搜索输入框
│   └── FileSearchResults.tsx    # 搜索结果列表
├── model/
│   └── useFileSearch.ts         # 搜索 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/hooks/queries/useSessionFileSearch.ts` - 文件搜索 hook
- 相关搜索 UI 组件（从 SessionFiles 中提取）

## 使用示例

```tsx
import { useFileSearch, FileSearchResults } from '@/features/search-files'

function FilesPage() {
  const [query, setQuery] = useState('')
  const { files, isLoading } = useFileSearch(api, sessionId, query)

  return (
    <>
      <input value={query} onChange={e => setQuery(e.target.value)} />
      <FileSearchResults files={files} onOpenFile={handleOpen} />
    </>
  )
}
```

## 注意事项

- 需要防抖处理避免频繁请求
- 支持限制搜索结果数量
- 空查询时不触发搜索
- 需要显示加载状态和错误信息
