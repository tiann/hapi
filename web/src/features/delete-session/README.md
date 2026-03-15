# delete-session Feature

> 删除会话功能

## 功能说明

提供会话删除确认对话框功能，支持：
- 删除确认
- 会话名称验证
- 删除操作反馈

## 依赖

- `@/shared/ui/dialog` - 对话框组件
- `@/shared/ui/button` - 按钮组件
- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { DeleteSessionDialog } from '@/features/delete-session'

function SessionPage() {
  const [isOpen, setIsOpen] = useState(false)
  const session = useSession(api, sessionId)

  return (
    <DeleteSessionDialog
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      sessionName={session?.title ?? ''}
      onDelete={async () => {
        await api.deleteSession(sessionId)
      }}
      isPending={false}
    />
  )
}
```

## 组件

### DeleteSessionDialog

删除会话确认对话框组件。

**Props**:
- `isOpen: boolean` - 对话框是否打开
- `onClose: () => void` - 关闭对话框回调
- `sessionName: string` - 会话名称
- `onDelete: () => Promise<void>` - 删除回调
- `isPending: boolean` - 是否正在删除
