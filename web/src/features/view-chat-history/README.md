# view-chat-history

## 职责

显示会话的聊天历史，包括：
- 消息列表展示
- 工具调用卡片
- 代码块渲染
- Diff 视图
- Markdown 渲染
- 自动滚动

## 依赖

### entities
- `entities/message` - 消息 API、类型定义
- `entities/session` - 会话信息

### shared
- `shared/ui` - Card, CodeBlock 等组件
- `shared/lib` - Markdown 渲染、语法高亮
- `shared/hooks` - useScrollToBottom

## 目录结构

```
view-chat-history/
├── ui/
│   ├── ChatHistory.tsx          # 聊天历史主组件
│   ├── MessageBlock.tsx         # 消息块
│   ├── ToolCallCard.tsx         # 工具调用卡片
│   └── ContentRenderer.tsx      # 内容渲染器
├── model/
│   └── useChatHistory.ts        # 聊天历史 hook
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/SessionChat.tsx` - 聊天组件
- `web/src/components/AssistantChat/` - Assistant UI 集成
- `web/src/components/ToolCard/` - 工具卡片组件
- `web/src/components/CodeBlock.tsx` - 代码块组件
- `web/src/components/DiffView.tsx` - Diff 视图组件
- `web/src/components/MarkdownRenderer.tsx` - Markdown 渲染器

## 使用示例

```tsx
import { ChatHistory } from '@/features/view-chat-history'

function ChatPage() {
  return (
    <ChatHistory
      api={api}
      sessionId={sessionId}
      messages={messages}
      onToolAction={(action) => handleToolAction(action)}
    />
  )
}
```

## 注意事项

- 需要支持多种内容类型（文本、代码、工具调用）
- 工具调用需要支持展开/折叠
- 需要自动滚动到最新消息
- 代码块需要语法高亮和复制功能
- Diff 视图需要并排或统一视图切换
- 需要处理长内容的折叠
