# Message Entity

## 职责

管理会话消息的查询、发送、状态管理和附件处理。

## 公共 API

### Types
- `MessageStatus` - 消息状态类型
- `DecryptedMessage` - 解密后的消息类型
- `MessagesResponse` - 消息列表响应类型

### Hooks
- `useMessages(api, sessionId, options)` - 获取消息列表（支持分页）
- `useSendMessage(api, sessionId)` - 发送消息

### Components
- `AssistantMessage` - AI 助手消息组件
- `UserMessage` - 用户消息组件
- `SystemMessage` - 系统消息组件
- `ToolMessage` - 工具调用消息组件
- `MessageAttachments` - 消息附件组件
- `MessageStatusIndicator` - 消息状态指示器

### Utils
- `messages` - 消息处理工具函数
- `attachmentAdapter` - 附件适配器
- `fileAttachments` - 文件附件工具函数

## 依赖

### Shared 层依赖
- 无直接依赖

### 其他依赖
- `@/api/client` - API 客户端
- `@/lib/query-keys` - 查询键
- `@zs/protocol/types` - Protocol 类型定义

## 使用示例

```tsx
import { useMessages, useSendMessage, AssistantMessage, UserMessage } from '@/entities/message'

function ChatView({ sessionId }: { sessionId: string }) {
    const { messages, isLoading } = useMessages(api, sessionId)
    const { sendMessage } = useSendMessage(api, sessionId)

    return (
        <div>
            {messages.map(msg => 
                msg.role === 'assistant' 
                    ? <AssistantMessage key={msg.seq} message={msg} />
                    : <UserMessage key={msg.seq} message={msg} />
            )}
        </div>
    )
}
```
