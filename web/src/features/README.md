# Features 层

> 用户可感知的功能和业务交互能力

## 概述

features 层承载用户可以直接感知和操作的功能。每个 feature 代表一个独立的用户交互能力。

## 依赖规则

- ✅ 可以依赖：shared, entities
- ❌ 禁止依赖：widgets, pages, app, 其他 features

## Features 列表

| Feature | 说明 | 状态 |
|---------|------|------|
| [install-pwa](./install-pwa/) | 安装 PWA 应用 | ✅ 已完成 |
| [change-language](./change-language/) | 切换界面语言 | ✅ 已完成 |
| [rename-session](./rename-session/) | 重命名会话 | ✅ 已完成 |
| [archive-session](./archive-session/) | 归档会话 | ✅ 已完成 |
| [delete-session](./delete-session/) | 删除会话 | ✅ 已完成 |
| [select-session-view](./select-session-view/) | 选择会话视图 | ✅ 已完成 |
| [search-session-files](./search-session-files/) | 搜索会话文件 | ✅ 已完成 |
| [connect-server](./connect-server/) | 连接服务器 | ✅ 已完成 |
| [create-session](./create-session/) | 创建新会话 | ✅ 已完成 |

## Feature 结构

每个 feature 应包含：

```
features/<feature-name>/
├── README.md           # 功能说明
├── model/              # 状态管理（可选）
│   └── hooks.ts        # 状态 hooks
├── api/                # API 调用（可选）
│   └── index.ts
├── ui/                 # UI 组件
│   └── Component.tsx
├── lib/                # 工具函数（可选）
│   └── utils.ts
└── index.ts            # 统一导出
```

## 开发指南

1. **单一职责**：每个 feature 只做一件事
2. **独立性**：features 之间不能相互依赖
3. **可组合**：在 widgets 或 pages 层组合多个 features
4. **类型安全**：使用 TypeScript 确保类型安全

## 架构说明

根据 FSD 架构规范：

- **entities/** - 业务实体的数据模型、类型定义和基础操作
- **features/** - 用户交互功能，实现具体业务逻辑
- **widgets/** - 页面区块，组合多个 features
- **pages/** - 完整页面，组合 widgets 和 features

features 层应该聚焦于"用户可感知的动作"，而不是简单地包装 entities 的功能。
