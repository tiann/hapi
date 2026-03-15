# approve-tool

## 职责

处理工具调用的权限审批，包括：
- 批准单次工具调用
- 批准会话内所有同类工具
- 批准所有编辑操作
- 拒绝工具调用
- 中止会话执行

## 依赖

### entities
- `entities/session` - 会话元数据、API
- `entities/message` - 工具调用类型定义

### shared
- `shared/ui` - Card, Button 等组件
- `shared/hooks` - usePlatform（触觉反馈）
- `shared/lib` - 工具函数

## 目录结构

```
approve-tool/
├── ui/
│   └── PermissionFooter.tsx     # 权限审批 UI
├── lib/
│   ├── permission-logic.ts      # 权限判断逻辑
│   └── tool-validation.ts       # 工具验证
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/ToolCard/PermissionFooter.tsx` - 权限审批 UI

## 使用示例

```tsx
import { PermissionFooter } from '@/features/approve-tool'

function ToolCard({ tool }) {
  return (
    <Card>
      <ToolContent tool={tool} />
      {tool.permission?.status === 'pending' && (
        <PermissionFooter
          api={api}
          sessionId={sessionId}
          tool={tool}
          onDone={() => refetch()}
        />
      )}
    </Card>
  )
}
```

## 注意事项

- 需要区分 Claude 和 Codex 的权限模式
- 支持三种批准级别：单次、会话内、所有编辑
- Bash 命令需要特殊处理（可以按命令批准）
- 需要触觉反馈
- 批准后需要刷新消息列表
