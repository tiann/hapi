# Auth Bootstrap Process

## 职责

认证初始化流程，负责应用启动时的认证状态建立和管理。

## 功能

1. **Server URL 管理**
   - 从 URL 参数读取 hub/server 参数
   - 从 localStorage 读取存储的 server URL
   - 提供 server URL 设置和清除方法

2. **Auth Source 初始化**
   - 检测运行环境（浏览器 vs CLI）
   - 从 URL 参数读取 token
   - 建立认证源（token 或 localStorage）

3. **Token 建立**
   - 使用 auth source 获取 access token
   - 创建 API client 实例
   - 处理认证错误

4. **URL 参数清理**
   - 认证成功后清理 URL 中的敏感参数（server/hub/token）
   - 保持其他 URL 参数和路由状态

## 使用

```tsx
import { useAuthBootstrap } from '@/processes/auth-bootstrap'

function App() {
  const {
    // Server URL 状态
    serverUrl,
    baseUrl,
    setServerUrl,
    clearServerUrl,

    // Auth 状态
    authSource,
    isAuthSourceLoading,
    token,
    api,
    isAuthLoading,
    authError,
    setAccessToken,

    // 是否已完成初始化
    isReady
  } = useAuthBootstrap()

  if (!isReady) {
    return <LoadingState />
  }

  if (!authSource) {
    return <LoginPrompt onLogin={setAccessToken} />
  }

  return <AppContent api={api} token={token} />
}
```

## 依赖

- `entities/auth` - 认证实体（useAuth, useAuthSource, useServerUrl）
- `shared/lib/runtime-config` - 运行时配置

## 输出

- 认证状态（token, api, authSource）
- Server URL 管理方法
- 登录/登出方法
