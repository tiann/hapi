# Widgets 层

Widgets 是 FSD 架构中的页面区块层，承载页面上的大块独立区域。

## 职责

- 组合多个 features 形成页面区块
- 提供页面级的复合 UI 组件
- 处理区块级的交互逻辑

## 依赖规则

- ✅ 可以依赖：shared, entities, features
- ❌ 不能依赖：pages, app, 其他 widgets

## 已实现的 Widgets

### 1. system-status
系统状态横幅，显示离线/重连/同步状态。

### 2. login-gate
登录门户，处理用户登录界面。

### 3. session-header
会话头部，显示会话信息、Git 状态和视图切换。

### 4. session-list-panel
会话列表面板，按目录分组显示所有会话。

### 5. session-chat-panel
会话聊天面板，显示消息列表和输入框。

### 6. session-files-panel
会话文件面板，显示文件树结构。

### 7. session-terminal-panel
会话终端面板，渲染 xterm.js 终端。

## 目录结构

每个 widget 遵循统一的结构：

```
widgets/<widget-name>/
├── README.md           # Widget 说明文档
├── ui/                 # UI 组件
│   └── Widget.tsx      # 主组件
├── model/              # 状态管理（可选）
│   └── hooks.ts
├── lib/                # 工具函数（可选）
│   └── utils.ts
└── index.ts            # 统一导出
```

## 使用示例

```tsx
import { SessionHeader, SessionChatPanel } from '@/widgets'

function SessionPage() {
  return (
    <>
      <SessionHeader
        session={session}
        onBack={handleBack}
        api={api}
        currentView="chat"
        onSelectView={setView}
      />
      <SessionChatPanel
        api={api}
        session={session}
        messages={messages}
        onSend={handleSend}
        // ...
      />
    </>
  )
}
```

## 设计原则

1. **独立性**：每个 widget 应该是独立的，不依赖其他 widgets
2. **可组合**：widgets 可以在 pages 层自由组合
3. **完整性**：widget 应该是一个完整的功能模块，而不是碎片化的组件
4. **边界清晰**：widget 应该有明确的职责边界
