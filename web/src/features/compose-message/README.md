# compose-message

## 职责

提供消息输入界面，包括：
- 多行文本输入
- 自动补全（slash commands、skills）
- 附件上传
- 快捷键支持
- 输入状态管理

## 依赖

### entities
- `entities/session` - 会话 API
- `entities/message` - 消息类型

### shared
- `shared/ui` - Textarea, Button 等组件
- `shared/hooks` - 键盘事件处理
- `shared/lib` - 工具函数

## 目录结构

```
compose-message/
├── ui/
│   ├── ChatInput.tsx            # 主输入组件
│   ├── Autocomplete.tsx         # 自动补全组件
│   └── FloatingOverlay.tsx      # 浮动覆盖层
├── model/
│   ├── useAutocomplete.ts       # 自动补全逻辑
│   └── useInputState.ts         # 输入状态管理
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/ChatInput/` - 整个目录
- `web/src/hooks/queries/useSlashCommands.ts` - slash commands
- `web/src/hooks/queries/useSkills.ts` - skills

## 使用示例

```tsx
import { ChatInput } from '@/features/compose-message'

function ChatPage() {
  const { sendMessage } = useSendMessage(api, sessionId)

  return (
    <ChatInput
      api={api}
      sessionId={sessionId}
      onSend={sendMessage}
      disabled={isSending}
    />
  )
}
```

## 注意事项

- 支持 Cmd/Ctrl+Enter 发送
- 支持 / 触发 slash commands 自动补全
- 支持 @ 触发 skills 自动补全
- 需要处理多行文本和自动高度调整
- 支持附件上传
