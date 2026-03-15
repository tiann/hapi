# answer-question

## 职责

回答 AI 提出的问题，包括：
- 显示问题内容
- 提供文本输入框
- 提交答案
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
answer-question/
├── ui/
│   └── AskUserQuestionFooter.tsx  # 问答 UI
├── lib/
│   └── validation.ts              # 答案验证
└── index.ts                       # 公共导出
```

## 迁移来源

- `web/src/components/ToolCard/AskUserQuestionFooter.tsx` - 问答 UI
- `web/src/components/ToolCard/askUserQuestion.ts` - 工具识别逻辑

## 使用示例

```tsx
import { AskUserQuestionFooter, isAskUserQuestionTool } from '@/features/answer-question'

function ToolCard({ tool }) {
  if (isAskUserQuestionTool(tool.name) && tool.permission?.status === 'pending') {
    return (
      <AskUserQuestionFooter
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

- 问题内容从 tool.input 中提取
- 提交后需要刷新消息列表
- 需要触觉反馈
- 支持取消操作
