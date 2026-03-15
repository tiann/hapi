# Session Detail Page

会话详情页面。

## 职责

- 读取路由参数（sessionId）
- 组装会话头部和内容区域
- 处理视图切换（chat/files/terminal）
- 管理 Git 状态刷新逻辑

## 依赖

- `entities/session` - SessionHeader 组件
- `entities/git` - Git 状态数据
- `components/SessionChat` - 聊天组件（待迁移到 widgets）

## 路由

- `/sessions/:sessionId` - 聊天视图
- `/sessions/:sessionId/files` - 文件视图
- `/sessions/:sessionId/terminal` - 终端视图
