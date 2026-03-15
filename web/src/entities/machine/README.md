# Machine Entity

## 职责

管理远程机器/主机信息，包括机器状态监控、元数据管理和机器选择功能。

## 公共 API

### Types
- `Machine` - 机器实体类型
- `RunnerState` - 运行器状态类型
- `MachinesResponse` - 机器列表响应类型
- `MachinePathsExistsResponse` - 路径存在检查响应类型

### Hooks
- `useMachines(api, enabled)` - 获取机器列表

### Components
- `MachineList` - 机器列表组件
- `HostBadge` - 主机徽章组件

## 依赖

### Shared 层依赖
- `@/shared/ui/card` - Card 组件
- `@/shared/lib/host-utils` - 主机工具函数

### 其他依赖
- `@/api/client` - API 客户端
- `@/lib/query-keys` - 查询键
- `@/lib/use-translation` - 国际化

## 使用示例

```tsx
import { useMachines, MachineList } from '@/entities/machine'

function MyComponent() {
    const { machines, isLoading } = useMachines(api, true)

    return <MachineList machines={machines} onSelect={handleSelect} />
}
```
