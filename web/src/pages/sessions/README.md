# Sessions Page

会话列表页面。

## 职责

- 读取路由参数和路径状态
- 组装会话列表和详情视图的布局
- 处理响应式显示逻辑（移动端/桌面端）

## 依赖

- `entities/session` - 会话数据和 SessionList 组件
- `shared/ui` - 通用 UI 组件

## 路由

- `/sessions` - 会话列表页
- `/sessions/:sessionId` - 会话详情（嵌套路由）
- `/sessions/new` - 新建会话（嵌套路由）
