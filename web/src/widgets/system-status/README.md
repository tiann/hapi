# system-status Widget

系统状态横幅组件，用于显示系统连接状态。

## 功能

- 显示离线状态（OfflineBanner）
- 显示重连中状态（ReconnectingBanner）
- 显示同步中状态（SyncingBanner）

## 依赖

- `@/shared/hooks/useOnlineStatus` - 在线状态检测
- `@/shared/ui` - 通用 UI 组件
- `@/components/Spinner` - 加载动画

## 使用

```tsx
import { SystemStatus } from '@/widgets/system-status'

<SystemStatus
  isReconnecting={false}
  reconnectReason={null}
  isSyncing={false}
/>
```
