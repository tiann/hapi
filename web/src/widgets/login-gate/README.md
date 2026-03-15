# login-gate Widget

登录门户组件，用于未登录用户的登录界面。

## 功能

- 登录表单
- 服务器地址配置
- 语言切换
- 登录状态管理

## 依赖

- `@/shared/ui` - 通用 UI 组件
- `@/shared/hooks` - 通用 hooks
- `@/api/client` - API 客户端

## 使用

```tsx
import { LoginGate } from '@/widgets/login-gate'

<LoginGate
  onLogin={(token) => console.log('Logged in')}
  baseUrl="https://api.example.com"
  serverUrl={null}
  setServerUrl={(url) => ({ ok: true, value: url })}
  clearServerUrl={() => {}}
/>
```
