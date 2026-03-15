# send-message

## 职责

发送用户消息到会话，包括：
- 发送文本消息
- 附加文件附件
- 乐观更新（optimistic update）
- 重试失败消息
- 消息状态管理（sending/sent/failed）

## 依赖

### entities
- `entities/message` - 消息类型定义、消息存储
- `entities/session` - 会话 ID 解析

### shared
- `shared/hooks` - usePlatform（触觉反馈）
- `shared/lib` - 工具函数

## 目录结构

```
send-message/
├── model/
│   ├── useSendMessage.ts        # 发送消息 hook
│   └── types.ts                 # 类型定义
├── lib/
│   └── optimistic.ts            # 乐观更新逻辑
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/hooks/mutations/useSendMessage.ts` - 发送消息 hook

## 使用示例

```tsx
import { useSendMessage } from '@/features/send-message'

function ChatInput() {
  const { sendMessage, retryMessage, isSending } = useSendMessage(api, sessionId)

  const handleSend = (text: string) => {
    sendMessage(text)
  }

  return <input onSubmit={handleSend} disabled={isSending} />
}
```

## 注意事项

- 使用乐观更新立即显示消息，提升用户体验
- 失败消息需要支持重试
- 需要触觉反馈（成功/失败）
- 支持会话 ID 解析（用于 worktree 等场景）
