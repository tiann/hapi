# create-session Feature

> 创建会话功能

## 功能说明

提供新会话创建功能，支持：
- 会话类型选择（code、browse、ask）
- 机器选择
- 模型选择
- 目录选择
- YOLO 模式

## 依赖

- `@/entities/session` - 会话实体
- `@/entities/machine` - 机器实体
- `@/shared/ui/*` - 通用 UI 组件
- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { CreateSessionPanel } from '@/features/create-session'
import { useNavigate } from '@tanstack/react-router'

function NewSessionPage() {
  const navigate = useNavigate()
  const api = useAppContext().api

  return (
    <CreateSessionPanel
      api={api}
      onCreate={(sessionId) => {
        navigate({ to: '/sessions/$sessionId', params: { sessionId } })
      }}
    />
  )
}
```

## 组件

### CreateSessionPanel

创建会话面板组件。

**Props**:
- `api: ApiClient` - API 客户端
- `onCreate: (sessionId: string) => void` - 创建成功回调
