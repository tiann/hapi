# session-files-panel Widget

会话文件面板组件，显示会话相关的文件树。

## 功能

- 显示目录树结构
- 展开/折叠目录
- 打开文件
- 空目录处理
- 加载状态和错误处理

## 依赖

- `@/entities/file` - 文件实体
- `@/shared/hooks` - 通用 hooks

## 使用

```tsx
import { SessionFilesPanel } from '@/widgets/session-files-panel'

<SessionFilesPanel
  api={apiClient}
  sessionId={sessionId}
  rootLabel="Project Root"
  onOpenFile={(path) => navigate(`/sessions/${sessionId}/file?path=${path}`)}
/>
```
