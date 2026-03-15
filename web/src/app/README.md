# app 层

应用入口层，负责应用的启动、Provider 装配和路由配置。

## 目录结构

```
app/
├── README.md           # 本文档
├── entry/              # 应用入口
│   ├── main.tsx        # React 应用挂载点
│   └── App.tsx         # 应用根组件
├── router/             # 路由配置
│   └── index.tsx       # 路由定义
└── styles/             # 全局样式
    └── index.css       # 全局 CSS
```

## 职责

### entry/main.tsx
- 挂载 React 应用到 DOM
- 注册 Service Worker (PWA)
- 初始化全局配置（字体缩放等）

### entry/App.tsx
- Provider 装配（QueryClient, Router, I18n, Toast）
- 认证流程控制
- 会话同步管理
- 系统状态展示

### router/index.tsx
- 定义应用路由结构
- 配置路由参数验证
- 导出路由实例

### styles/index.css
- 全局 CSS 变量
- 主题样式
- 通用动画

## 依赖规则

- app 层可以依赖所有其他层
- app 层应该尽量轻量，只做装配工作
- 复杂的业务逻辑应该在 processes/widgets/features 层实现

## 重构计划

当前 App.tsx 包含较多业务逻辑，未来将逐步提取到：
- `processes/auth-bootstrap` - 认证初始化流程
- `processes/session-sync` - 会话同步流程
- `widgets/login-gate` - 登录门控组件
- `widgets/system-status` - 系统状态横幅
