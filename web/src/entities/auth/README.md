# Auth Entity

## 职责

管理用户认证和授权，包括 Token 管理（刷新、过期检测）、API 客户端初始化和用户信息管理。

## 公共 API

### Types
- `AuthResponse` - 认证响应类型
- `AuthSource` - 认证源类型

### Hooks
- `useAuth(authSource, baseUrl)` - 认证主 Hook，管理 token 和用户信息
- `useAuthSource()` - 认证源管理 Hook

### Components
- `LoginPrompt` - 登录提示组件

## 依赖

### Shared 层依赖
- 无直接依赖

### 其他依赖
- `@/api/client` - API 客户端

## 使用示例

```tsx
import { useAuth, useAuthSource, LoginPrompt } from '@/entities/auth'

function App() {
    const authSource = useAuthSource()
    const { token, user, api, isLoading, error } = useAuth(authSource, baseUrl)

    if (!token) {
        return <LoginPrompt />
    }

    return <div>Welcome {user?.username}</div>
}
```
