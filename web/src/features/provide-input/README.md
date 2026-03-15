# provide-input

## 职责

为 AI 提供用户输入，包括：
- 显示输入提示
- 提供文本输入框
- 提交输入内容
- 处理提交状态

## 依赖

### entities
- `entities/session` - 会话 API
- `entities/message` - 工具调用类型

### shared
- `shared/ui` - Button, Input 等组件
- `shared/hooks` - usePlatform（触觉反馈）

## 目录结构

```
provide-input/
├── ui/
│   └── RequestUserInputFooter.tsx  # 输入 UI
├── lib/
│   └── validation.ts               # 输入验证
└── index.ts                        # 公共导出
```

## 迁移来源

- `web/src/components/ToolCard/RequestUserInputFooter.tsx` - 输入 UI
- `web/src/components/ToolCard/requestUserInput.ts` - 工具识别逻辑

## 使用示例

```tsx
import { RequestUserInputFooter, isRequestUserInputTool } from '@/features/provide-input'

function ToolCard({ tool }) {
  if (isRequestUserInputTool(tool.name) && tool.permission?.status === 'pending') {
    return (
      <RequestUserInputFooter
        api={api}
        sessionId={sessionId}
        tool={tool}
        onDone={() => refetch()}
      />
    )
  }
}
```

## 注意事项

- 提示内容从 tool.input 中提取
- 提交后需要刷新消息列表
- 需要触觉反馈
- 支持取消操作
