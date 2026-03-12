# 前端目录结构

> 本项目中前端代码的组织方式。

---

## 概述

HAPI Web 采用基于功能的组织方式，在 UI 组件、业务逻辑（hooks）与工具函数之间保持清晰分离。该结构强调：

- **组件隔离**：UI 组件按功能/领域拆分
- **基于 Hook 的逻辑**：业务逻辑放在自定义 hooks 中，而不是组件里
- **类型安全**：共享类型放在专门目录中
- **路径别名**：`@/*` 映射到 `src/*`，保持导入整洁

---

## 目录布局

```
web/src/
├── api/                    # API 客户端与 HTTP 工具
├── chat/                   # 聊天相关逻辑（消息归一化等）
├── components/             # React 组件
│   ├── assistant-ui/       # Assistant UI 集成组件
│   ├── AssistantChat/      # 主聊天界面组件
│   ├── ChatInput/          # 带自动补全的聊天输入组件
│   ├── NewSession/         # 会话创建流程
│   ├── SessionFiles/       # 文件管理界面
│   ├── Terminal/           # 终端模拟器组件
│   ├── ToolCard/           # 工具调用展示组件
│   └── ui/                 # 可复用 UI 基元（Button、Dialog 等）
├── hooks/                  # 自定义 React hooks
│   ├── mutations/          # React Query mutation hooks
│   └── queries/            # React Query query hooks
├── lib/                    # 共享工具与辅助函数
│   └── locales/            # i18n 翻译文件
├── realtime/               # 实时连接逻辑（Socket.IO、SSE）
│   └── hooks/              # 实时连接专用 hooks
├── routes/                 # 路由组件（TanStack Router）
│   ├── sessions/           # 会话相关路由
│   └── settings/           # 设置相关路由
├── types/                  # TypeScript 类型定义
├── utils/                  # 通用工具函数
├── App.tsx                 # 根应用组件
├── main.tsx                # 应用入口
└── router.tsx              # 路由配置
```

---

## 模块组织

### 组件

**按功能分组**：组件按功能/领域分组，而不是按类型分组。

- `components/AssistantChat/` - 所有聊天相关组件
- `components/Terminal/` - 终端模拟器组件
- `components/ui/` - 通用、可复用的 UI 基元

**组件文件结构**：
```
components/AssistantChat/
├── HappyThread.tsx         # 主线程组件
├── HappyComposer.tsx       # 消息编辑器
├── context.tsx             # 共享上下文
├── messages/               # 各类消息组件
│   ├── AssistantMessage.tsx
│   ├── UserMessage.tsx
│   └── SystemMessage.tsx
└── StatusBar.tsx
```

### Hooks

**按用途分离**：
- `hooks/` - 通用自定义 hooks（auth、clipboard、平台检测）
- `hooks/queries/` - React Query 数据获取 hooks
- `hooks/mutations/` - React Query 变更 hooks
- `realtime/hooks/` - 实时连接相关 hooks

**Hook 命名**：始终以 `use` 开头（例如 `useAuth`、`useCopyToClipboard`）

### Routes

使用 TanStack Router 的**文件路由**：
- 路由组件放在 `routes/`
- 嵌套路由使用子目录（例如 `routes/sessions/`）
- 路由配置位于 `router.tsx`

---

## 命名约定

### 文件

- **组件**：PascalCase（例如 `HappyThread.tsx`、`Button.tsx`）
- **Hooks**：带 `use` 前缀的 camelCase（例如 `useAuth.ts`、`useCopyToClipboard.ts`）
- **工具函数**：camelCase（例如 `utils.ts`、`clipboard.ts`）
- **类型**：camelCase（例如 `api.ts`、`session.ts`）

### 目录

- **功能目录**：PascalCase（例如 `AssistantChat/`、`Terminal/`）
- **工具目录**：lowercase（例如 `hooks/`、`lib/`、`utils/`）

### 导入

始终使用路径别名以保持导入整洁：

```typescript
// 推荐
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import type { Session } from '@/types/api'

// 避免
import { Button } from '../../../components/ui/button'
```

---

## 示例

### 组织良好的模块

- **`components/AssistantChat/`** - 功能完整的聊天界面，组件层次清晰
- **`hooks/useAuth.ts`** - 复杂认证逻辑封装在 hook 中
- **`components/ui/`** - 遵循一致模式的可复用 UI 基元

### 添加新功能

当新增一个功能（例如 "CodeReview"）时：

1. 创建功能目录：`components/CodeReview/`
2. 添加主组件：`components/CodeReview/CodeReviewPanel.tsx`
3. 添加功能专用 hooks：`hooks/useCodeReview.ts`
4. 添加类型：`types/codeReview.ts`
5. 需要时添加路由：`routes/code-review.tsx`

---

## 反模式

### 不要

- ❌ 在 `components/ui/` 中混入业务组件与 UI 基元
- ❌ 直接在组件中写业务逻辑（应使用 hooks）
- ❌ 在已有路径别名时仍使用相对导入
- ❌ 创建深层嵌套目录结构（最多 3 层）
- ❌ 在同一目录混合不同关注点（例如把 components 与 hooks 放一起）

### 要

- ✅ 按功能对相关组件分组
- ✅ 将业务逻辑抽取到自定义 hooks
- ✅ 所有导入统一使用路径别名（`@/*`）
- ✅ 保持目录结构扁平、易发现
- ✅ 分离关注点（components、hooks、types、utils）
