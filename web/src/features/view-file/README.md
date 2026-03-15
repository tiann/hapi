# view-file

## 职责

查看会话工作目录中的文件内容，包括：
- 显示文件内容
- 语法高亮
- 代码折叠
- 文件路径导航

## 依赖

### entities
- `entities/file` - 文件 API、类型定义

### shared
- `shared/ui` - CodeBlock 等组件
- `shared/lib` - 语法高亮工具

## 目录结构

```
view-file/
├── ui/
│   └── FileViewer.tsx           # 文件查看器
├── model/
│   └── useFileContent.ts        # 文件内容 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/routes/sessions/file.tsx` - 文件查看页面
- 相关文件查看组件

## 使用示例

```tsx
import { FileViewer } from '@/features/view-file'

function FilePage() {
  const { path } = useParams()

  return (
    <FileViewer
      api={api}
      sessionId={sessionId}
      path={path}
    />
  )
}
```

## 注意事项

- 需要根据文件类型选择合适的语法高亮
- 大文件需要考虑性能优化
- 需要显示加载状态和错误信息
- 支持文件路径面包屑导航
