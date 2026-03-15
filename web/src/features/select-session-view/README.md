# select-session-view Feature

> 选择会话视图功能

## 功能说明

提供会话视图切换功能，支持：
- 聊天视图
- 文件视图
- 终端视图

## 依赖

- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { ViewSelector } from '@/features/select-session-view'
import { useNavigate } from '@tanstack/react-router'

function SessionDetailPage() {
  const navigate = useNavigate()
  const { sessionId } = useParams({ from: '/sessions/$sessionId' })

  return (
    <ViewSelector
      currentView="chat"
      onViewChange={(view) => {
        if (view === 'chat') {
          navigate({ to: '/sessions/$sessionId', params: { sessionId } })
        } else if (view === 'files') {
          navigate({ to: '/sessions/$sessionId/files', params: { sessionId } })
        } else if (view === 'terminal') {
          navigate({ to: '/sessions/$sessionId/terminal', params: { sessionId } })
        }
      }}
    />
  )
}
```

## 组件

### ViewSelector

视图选择器组件。

**Props**:
- `currentView: 'chat' | 'files' | 'terminal'` - 当前视图
- `onViewChange: (view: 'chat' | 'files' | 'terminal') => void` - 视图切换回调
