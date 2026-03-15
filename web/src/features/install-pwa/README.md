# install-pwa Feature

> 安装 PWA 应用功能

## 功能说明

提供 PWA 安装提示和安装流程，支持：
- Chrome/Edge 的原生安装提示
- iOS Safari 的安装指引
- 安装状态管理
- 用户关闭提示的持久化

## 依赖

- `@/shared/hooks/usePlatform` - 平台检测和触觉反馈
- `@/shared/ui/*` - 通用 UI 组件

## 使用示例

```tsx
import { InstallPrompt } from '@/features/install-pwa'

function App() {
  return (
    <div>
      <InstallPrompt />
    </div>
  )
}
```

## 组件

### InstallPrompt

PWA 安装提示组件，自动检测平台并显示相应的安装界面。

**Props**: 无

**行为**:
- 已安装时不显示
- 用户关闭后不再显示（localStorage 持久化）
- iOS 显示安装指引
- Chrome/Edge 显示原生安装提示
