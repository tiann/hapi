# connect-server Feature

> 连接服务器功能

## 功能说明

提供服务器连接配置功能，支持：
- 服务器 URL 输入
- URL 验证
- 连接状态管理

## 依赖

- `@/entities/auth` - 认证实体（包含 useServerUrl hook）
- `@/shared/ui/*` - 通用 UI 组件
- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { ServerUrlDialog } from '@/features/connect-server'

function SettingsPage() {
  return (
    <ServerUrlDialog
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
    />
  )
}
```

## 组件

### ServerUrlDialog

服务器 URL 配置对话框组件。

**Props**:
- `isOpen: boolean` - 对话框是否打开
- `onClose: () => void` - 关闭对话框回调
