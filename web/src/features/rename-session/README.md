# rename-session Feature

> 重命名会话功能

## 功能说明

提供会话重命名对话框功能，支持：
- 会话名称编辑
- 表单验证
- 错误处理
- 键盘快捷键（ESC 关闭）

## 依赖

- `@/shared/ui/dialog` - 对话框组件
- `@/shared/ui/button` - 按钮组件
- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { RenameSessionDialog } from '@/features/rename-session'

function SessionPage() {
  const [isOpen, setIsOpen] = useState(false)
  const session = useSession(api, sessionId)

  return (
    <RenameSessionDialog
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      currentName={session?.title ?? ''}
      onRename={async (newName) => {
        await api.renameSession(sessionId, newName)
      }}
      isPending={false}
    />
  )
}
```

## 组件

### RenameSessionDialog

重命名会话对话框组件。

**Props**:
- `isOpen: boolean` - 对话框是否打开
- `onClose: () => void` - 关闭对话框回调
- `currentName: string` - 当前会话名称
- `onRename: (newName: string) => Promise<void>` - 重命名回调
- `isPending: boolean` - 是否正在保存
