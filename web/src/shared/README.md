# Shared 层

共享基础设施层，不包含业务逻辑。

## 职责
- 提供通用 UI 组件
- 提供工具函数和辅助方法
- 提供 API 客户端和配置
- 提供通用 hooks 和上下文

## 目录结构
```
shared/
├── ui/                  # 通用 UI 组件（button, dialog, badge 等）
├── lib/                 # 工具库和上下文
├── api/                 # API 客户端基础设施
├── config/              # 配置文件
├── types/               # 通用类型定义
└── hooks/               # 通用 hooks（平台、主题、网络状态等）
```

## 原则
- **不包含业务逻辑**：不知道 session、message、file 等业务概念
- **高度可复用**：可以在任何项目中使用
- **稳定性高**：变更频率低

## 示例
### ✅ 应该放在 shared 的：
- Button, Dialog, Badge 等基础 UI 组件
- usePlatform, useTheme, useOnlineStatus 等平台相关 hooks
- formatDate, debounce, throttle 等工具函数
- API 客户端基础类

### ❌ 不应该放在 shared 的：
- SessionHeader（知道 session 业务概念）
- useSpawnSession（业务操作）
- formatRunnerSpawnError（业务错误处理）

## 依赖规则
不可依赖任何业务层（app, processes, pages, widgets, features, entities）
