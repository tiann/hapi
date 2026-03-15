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

### 当前架构（FSD 迁移中）

项目正在从传统结构迁移到 **Feature-Sliced Design (FSD)** 架构。当前处于过渡阶段，新旧结构并存。

```
web/src/
├── shared/                 # [FSD] 共享层 - 无业务逻辑的通用代码
│   ├── ui/                 # 通用 UI 组件（button, badge, card, dialog 等）
│   ├── lib/                # 通用工具函数（utils, clipboard, host-utils 等）
│   └── hooks/              # 通用 React hooks（usePlatform, useTheme 等）
├── entities/               # [FSD] 实体层 - 业务实体（规划中）
├── features/               # [FSD] 功能层 - 用户功能（规划中）
├── widgets/                # [FSD] 组件层 - 页面区块（规划中）
├── pages/                  # [FSD] 页面层 - 完整页面（规划中）
├── app/                    # [FSD] 应用层 - 全局配置（规划中）
│
├── api/                    # [旧] API 客户端与 HTTP 工具
├── chat/                   # [旧] 聊天相关逻辑（消息归一化等）
├── components/             # [旧] React 组件（逐步迁移到 FSD 层）
│   ├── assistant-ui/       # Assistant UI 集成组件
│   ├── AssistantChat/      # 主聊天界面组件
│   ├── ChatInput/          # 带自动补全的聊天输入组件
│   ├── NewSession/         # 会话创建流程
│   ├── SessionFiles/       # 文件管理界面
│   ├── Terminal/           # 终端模拟器组件
│   └── ToolCard/           # 工具调用展示组件
├── hooks/                  # [旧] 自定义 React hooks（已迁移到 shared/hooks）
│   ├── mutations/          # React Query mutation hooks
│   └── queries/            # React Query query hooks
├── lib/                    # [旧] 共享工具（已迁移到 shared/lib）
│   └── locales/            # i18n 翻译文件
├── realtime/               # [旧] 实时连接逻辑（Socket.IO、SSE）
│   └── hooks/              # 实时连接专用 hooks
├── routes/                 # [旧] 路由组件（TanStack Router）
│   ├── sessions/           # 会话相关路由
│   └── settings/           # 设置相关路由
├── types/                  # [旧] TypeScript 类型定义
├── utils/                  # [旧] 通用工具函数
├── App.tsx                 # 根应用组件
├── main.tsx                # 应用入口
└── router.tsx              # 路由配置
```

---

## FSD 架构分层规则

### 层级依赖原则

FSD 架构遵循严格的单向依赖规则：

```
app → pages → widgets → features → entities → shared
```

**核心规则**：
- 上层可以依赖下层
- 下层**绝不能**依赖上层
- 同层之间**不能**相互依赖
- shared 层**不能**依赖任何其他层

### 各层职责

#### shared/ - 共享层
**职责**：无业务逻辑的通用代码，可在任何项目中复用

**包含**：
- `ui/` - 通用 UI 组件（button, badge, card, dialog, Toast, ConfirmDialog）
- `lib/` - 通用工具函数（utils, clipboard, host-utils, shiki, runtime-config）
- `hooks/` - 通用 React hooks（usePlatform, useTheme, useOnlineStatus, useCopyToClipboard 等）

**禁止**：
- ❌ 依赖业务实体或功能
- ❌ 依赖旧层级路径（`@/components/ui/*`, `@/lib/*`, `@/hooks/*`）
- ❌ 包含业务逻辑或领域知识

**导入规则**：
```typescript
// ✅ 正确 - shared 层内部引用
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { usePlatform } from '@/shared/hooks/usePlatform'

// ❌ 错误 - 不能依赖业务层
import { useSession } from '@/entities/session'
import { SessionList } from '@/features/session-list'
```

#### entities/ - 实体层 ✅ 已完成
**职责**：业务实体的数据模型、类型定义和基础操作

**已实现的实体**：
- `entities/machine/` - 机器实体（类型、API hooks、UI 组件）
- `entities/auth/` - 认证实体（认证逻辑、登录提示）
- `entities/git/` - Git 实体（Git 状态、diff 视图）
- `entities/file/` - 文件实体（文件类型、路径工具）
- `entities/session/` - 会话实体（会话管理、UI 组件）
- `entities/message/` - 消息实体（消息类型、发送逻辑）

**实体内部结构**：
```
entities/<entity-name>/
├── model/              # 数据模型和类型定义
│   ├── types.ts        # TypeScript 类型
│   └── index.ts        # 导出
├── api/                # API 请求和 React Query hooks
│   ├── queries.ts      # useQuery hooks
│   ├── mutations.ts    # useMutation hooks
│   └── index.ts        # 导出
├── ui/                 # UI 组件
│   ├── Component.tsx   # 实体相关组件
│   └── index.ts        # 导出
├── lib/                # 工具函数和业务逻辑
│   ├── utils.ts        # 工具函数
│   └── index.ts        # 导出
├── index.ts            # 实体公共 API
└── README.md           # 实体文档

**可依赖**：shared, 其他 entities 的类型（仅用于 UI props）
**禁止依赖**：features, widgets, pages, app, 其他 entities 的业务逻辑

**重要约束**：
- ✅ 同一实体内部可以自由引用（model ← api ← ui ← lib）
- ✅ UI 组件可以使用其他实体的类型作为 props（如 `Machine` 类型）
- ❌ 业务逻辑（lib/api）不能依赖其他实体的类型，应使用结构化类型
- ❌ 同层实体之间不能相互调用业务逻辑

#### features/ - 功能层（规划中）
**职责**：用户交互功能，实现具体业务逻辑

**示例**：
- `features/send-message/` - 发送消息功能
- `features/create-session/` - 创建会话功能
- `features/file-upload/` - 文件上传功能

**可依赖**：shared, entities
**禁止依赖**：widgets, pages, app

#### widgets/ - 组件层 ✅ 已完成
**职责**：页面区块，组合多个 features 形成完整功能模块

**已实现的 widgets**：
- `widgets/system-status/` - 系统状态横幅（离线/重连/同步）
- `widgets/login-gate/` - 登录门户
- `widgets/session-header/` - 会话头部（标题、Git 状态、视图切换）
- `widgets/session-list-panel/` - 会话列表面板（分组、搜索、操作）
- `widgets/session-chat-panel/` - 会话聊天面板（消息、输入、工具卡片）
- `widgets/session-files-panel/` - 会话文件面板（目录树）
- `widgets/session-terminal-panel/` - 会话终端面板（xterm.js）

**Widget 内部结构**：
```
widgets/<widget-name>/
├── README.md           # Widget 说明
├── ui/                 # UI 组件
│   └── Widget.tsx      # 主组件
├── model/              # 状态管理（可选）
│   └── hooks.ts
├── lib/                # 工具函数（可选）
│   └── utils.ts
└── index.ts            # 统一导出
```

**可依赖**：shared, entities, features
**禁止依赖**：pages, app, 其他 widgets

#### pages/ - 页面层 ✅ 已完成
**职责**：完整页面，组合 widgets 和 features

**已实现的页面**：
- `pages/sessions/` - 会话列表页
- `pages/session-detail/` - 会话详情页
- `pages/new-session/` - 新建会话页
- `pages/settings/` - 设置页

**页面内部结构**：
```
pages/<page-name>/
├── README.md           # 页面说明
├── ui/
│   └── Page.tsx        # 页面组件
├── model/              # 页面级状态（可选）
│   └── hooks.ts
└── index.ts            # 统一导出
```

**可依赖**：shared, entities, features, widgets
**禁止依赖**：app

**页面精简原则**：
- ✅ 保留路由参数读取（useParams, useSearchParams）
- ✅ 保留 widgets 组装和布局
- ✅ 保留页面级导航逻辑
- ✅ 保留简单的页面状态（如当前选中的 tab）
- ❌ 数据获取应移到 widgets/features
- ❌ 数据变更应移到 widgets/features
- ❌ 复杂的状态管理应移到 widgets/features
- ❌ 业务逻辑处理应移到 widgets/features

#### app/ - 应用层 ✅ 已完成
**职责**：全局配置、路由、Provider、初始化逻辑

**已实现**：
- `app/router/` - 路由配置

**可依赖**：所有层

---

## 迁移策略

### 已完成：shared 层迁移 ✅

**迁移内容**：
- 6个 UI 组件：button, badge, card, dialog, Toast, ConfirmDialog
- 5个工具函数：utils, clipboard, host-utils, shiki, runtime-config
- 8个通用 hooks：usePlatform, useTheme, useOnlineStatus, useFontScale, useCopyToClipboard, useScrollToBottom, useLongPress, usePointerFocusRing

**路径更新**：
- 所有 `@/components/ui/*` → `@/shared/ui/*`
- 所有 `@/lib/*` → `@/shared/lib/*`（通用工具）
- 所有 `@/hooks/*` → `@/shared/hooks/*`（通用 hooks）

**验证**：
- ✅ TypeScript 类型检查通过
- ✅ 无循环依赖
- ✅ shared 层不依赖业务层

### 已完成：entities 层迁移 ✅

**已实现的实体**：
- `entities/machine/` - 机器实体
- `entities/auth/` - 认证实体
- `entities/git/` - Git 实体
- `entities/file/` - 文件实体
- `entities/session/` - 会话实体
- `entities/message/` - 消息实体

### 已完成：widgets 层迁移 ✅

**已实现的 widgets**：
- `widgets/system-status/` - 系统状态横幅
- `widgets/login-gate/` - 登录门户
- `widgets/session-header/` - 会话头部
- `widgets/session-list-panel/` - 会话列表面板
- `widgets/session-chat-panel/` - 会话聊天面板
- `widgets/session-files-panel/` - 会话文件面板
- `widgets/session-terminal-panel/` - 会话终端面板

### 待规划：features/pages 层

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
// ✅ 推荐 - FSD 架构路径
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
import { usePlatform } from '@/shared/hooks/usePlatform'

// ✅ 推荐 - 业务层路径（迁移后）
import { useSession } from '@/entities/session'
import { SendMessageButton } from '@/features/send-message'

// ❌ 避免 - 旧路径（已废弃）
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'

// ❌ 避免 - 相对路径
import { Button } from '../../../shared/ui/button'
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

- ❌ 在 `shared/` 中包含业务逻辑或领域知识
- ❌ 让下层依赖上层（违反 FSD 依赖规则）
- ❌ 让同层之间相互依赖
- ❌ 使用旧路径（`@/components/ui/*`, `@/lib/*`, `@/hooks/*`）
- ❌ 直接在组件中写业务逻辑（应使用 hooks）
- ❌ 在已有路径别名时仍使用相对导入
- ❌ 创建深层嵌套目录结构（最多 3 层）
- ❌ 在同一目录混合不同关注点

### 要

- ✅ 遵循 FSD 分层依赖规则（上层依赖下层）
- ✅ shared 层只包含无业务逻辑的通用代码
- ✅ 使用新的 FSD 路径（`@/shared/*`, `@/entities/*` 等）
- ✅ 按功能对相关组件分组
- ✅ 将业务逻辑抽取到自定义 hooks
- ✅ 所有导入统一使用路径别名（`@/*`）
- ✅ 保持目录结构扁平、易发现
- ✅ 分离关注点（按 FSD 层级组织）

---

## 常见错误

### ❌ 错误：shared 层依赖业务层

```typescript
// shared/ui/ConfirmDialog.tsx
import { useTranslation } from '@/lib/use-translation' // ❌ 旧路径
import { useSession } from '@/entities/session'        // ❌ 依赖业务层
```

### ✅ 正确：shared 层只依赖 shared 层

```typescript
// shared/ui/ConfirmDialog.tsx
import { cn } from '@/shared/lib/utils'                // ✅ shared 内部引用
import { Button } from '@/shared/ui/button'            // ✅ shared 内部引用
```

### ❌ 错误：使用旧路径

```typescript
import { Button } from '@/components/ui/button'        // ❌ 已废弃
import { cn } from '@/lib/utils'                       // ❌ 已废弃
```

### ✅ 正确：使用 FSD 路径

```typescript
import { Button } from '@/shared/ui/button'            // ✅ FSD 路径
import { cn } from '@/shared/lib/utils'                // ✅ FSD 路径
```

### ❌ 错误：Props 使用 interface

```typescript
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}
```

### ✅ 正确：Props 使用 type

```typescript
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'secondary'
}
```

### ❌ 错误：实体业务逻辑依赖其他实体类型

```typescript
// entities/session/lib/formatRunnerSpawnError.ts
import type { Machine } from '@/entities/machine'  // ❌ 同层依赖

export function formatRunnerSpawnError(machine: Machine | null): string | null {
    const lastSpawnError = machine?.runnerState?.lastSpawnError
    // ...
}
```

**问题**：违反了 FSD "同层不能相互依赖"的核心规则。

### ✅ 正确：使用结构化类型避免跨实体依赖

```typescript
// entities/session/lib/formatRunnerSpawnError.ts
type MachineWithRunnerState = {
    runnerState?: {
        lastSpawnError?: {
            message: string
            at: number
        } | null
    } | null
} | null

export function formatRunnerSpawnError(machine: MachineWithRunnerState): string | null {
    const lastSpawnError = machine?.runnerState?.lastSpawnError
    // ...
}
```

**原则**：
- ✅ UI 组件可以使用其他实体的类型作为 props（类型引用是允许的）
- ❌ 业务逻辑（lib/api）不能依赖其他实体的类型（应使用结构化类型）
- ✅ 如果多个实体都需要某个类型，考虑将其提升到 `shared/model`

### ✅ 正确：UI 组件使用其他实体类型作为 props

```typescript
// entities/session/ui/NewSession/index.tsx
import type { Machine } from '@/entities/machine'  // ✅ UI 组件可以引用类型

type NewSessionProps = {
    machines: Machine[]  // ✅ 作为 props 类型使用
}

export function NewSession(props: NewSessionProps) {
    // ...
}
```

**说明**：UI 组件接收其他实体的数据作为 props 是合理的，这是类型引用而非业务逻辑依赖。
