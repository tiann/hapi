# Entities 层

业务实体和领域模型层。

## 职责
- 定义业务实体的数据结构
- 提供实体相关的查询和操作
- 管理实体的状态

## 示例
- session（会话实体）
- message（消息实体）
- machine（机器实体）
- file（文件实体）

## 目录结构
```
entities/
├── session/
│   ├── model/           # 类型定义、状态管理
│   ├── api/             # API 调用（queries/mutations）
│   ├── ui/              # 实体展示组件（可选）
│   └── index.ts         # 公共 API
├── message/
├── machine/
└── ...
```

## 依赖规则
可依赖：shared
不可依赖：app, processes, pages, widgets, features
