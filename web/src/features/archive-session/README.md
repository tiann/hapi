# archive-session Feature

> 归档会话功能

## 功能说明

提供会话归档确认对话框功能，支持：
- 归档确认
- 归档操作反馈

## 依赖

- `@/shared/ui/dialog` - 对话框组件
- `@/shared/ui/button` - 按钮组件
- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { ArchiveSessionDialog } from '@/features/archive-session'

function SessionPage() {
  const [isOpen, setIsOpen] = useState(false)
  const session = useSession(api, sessionId)

  return (
    <ArchiveSessionDialog
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      sessionName={session?.title ?? ''}
      onArchive={async () => {
        await api.archiveSession(sessionId)
      }}
      isPending={false}
    />
  )
}
```

## 组件

### ArchiveSessionDialog

归档会话确认对话框组件。

**Props**:
- `isOpen: boolean` - 对话框是否打开
- `onClose: () => void` - 关闭对话框回调
- `sessionName: string` - 会话名称
- `onArchive: () => Promise<void>` - 归档回调
- `isPending: boolean` - 是否正在归档
