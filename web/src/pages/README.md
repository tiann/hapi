# Pages 层

路由页面层，每个页面对应一个路由。

## 职责
- 定义路由页面
- 组装 widgets 和 features
- 处理页面级数据获取
- 管理页面级状态

## 目录结构
```
pages/
├── sessions/           # 会话列表页
├── session-detail/     # 会话详情页
├── settings/           # 设置页
└── ...
```

## 依赖规则
可依赖：widgets, features, entities, shared
不可依赖：app, processes
