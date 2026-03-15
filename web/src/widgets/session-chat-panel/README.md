# session-chat-panel Widget

会话聊天面板组件，显示聊天消息和输入框。

## 功能

- 显示聊天消息列表
- 消息输入框
- 工具调用展示
- 附件支持
- 权限模式切换
- 模型模式切换

## 依赖

- `@/entities/session` - 会话实体
- `@/entities/message` - 消息实体
- `@/shared/ui` - 通用 UI 组件
- `@/shared/hooks` - 通用 hooks

## 使用

```tsx
import { SessionChatPanel } from '@/widgets/session-chat-panel'

<SessionChatPanel
  api={apiClient}
  session={session}
  messages={messages}
  messagesWarning={null}
  hasMoreMessages={false}
  isLoadingMessages={false}
  isLoadingMoreMessages={false}
  isSending={false}
  pendingCount={0}
  messagesVersion={0}
  onRefresh={() => refetch()}
  onLoadMore={async () => {}}
  onSend={(text) => sendMessage(text)}
  onFlushPending={() => {}}
  onAtBottomChange={(atBottom) => {}}
/>
```
