# view-terminal

## 职责

查看会话的终端输出，包括：
- 显示终端内容
- ANSI 颜色支持
- 自动滚动
- 终端交互

## 依赖

### entities
- `entities/session` - 会话 API

### shared
- `shared/ui` - Terminal 组件
- `shared/lib` - ANSI 解析工具

## 目录结构

```
view-terminal/
├── ui/
│   └── TerminalViewer.tsx       # 终端查看器
├── model/
│   └── useTerminalData.ts       # 终端数据 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/routes/sessions/terminal.tsx` - 终端查看页面
- `web/src/components/Terminal/` - 终端组件

## 使用示例

```tsx
import { TerminalViewer } from '@/features/view-terminal'

function TerminalPage() {
  return (
    <TerminalViewer
      api={api}
      sessionId={sessionId}
    />
  )
}
```

## 注意事项

- 需要支持 ANSI 颜色代码
- 需要自动滚动到底部
- 大量输出需要考虑性能优化
- 可能需要支持终端交互（输入）
