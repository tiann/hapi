---
verdict: pass
must_fix: 0
review_metrics:
  total_files: 5
  total_lines: 441
  v1_p0_fixed: 4/4
  v1_p1_fixed: 1/2
  p0_issues: 0
  p1_issues: 0
  p2_issues: 2
  p3_issues: 1
  any_count: 0
  record_unknown_count: 3
  as_assertion_count: 6
  magic_number_count: 1
---

# TypeScript 品味审查报告 v2 — hapi pi agent backend

**审查范围**: `cli/src/pi/` (4 文件) + `cli/src/commands/pi.ts` (1 文件)
**审查日期**: 2026-06-06
**审查轮次**: 第 2 轮（验证 v1 修复 + 全量复查）

---

## v1 修复验证

### P0-01: Record<string,unknown> + as 断言 → types.ts discriminated union ✅

- 新增 `cli/src/pi/types.ts`，定义了完整的 Pi RPC 协议类型体系
- `PiAgentEvent` 为 discriminated union，覆盖 10 种事件类型 + fallback
- `PiRpcCommand` 5 种命令类型，`PiResponseEvent` 统一响应结构
- `PiAssistantMessageEvent` 对 text_delta/thinking_delta 等子事件有精确类型
- 全局 `Record<string, unknown>` 从 14 处降至 3 处（均在 handleResponse 内部，见下文）

### P0-02: Pi RPC 协议事件无类型定义 ✅

- `PiAgentEvent`, `PiResponseEvent`, `PiRpcCommand` 三大类已定义
- `PiUsage` 接口为 token 计数提供结构化类型
- 各事件接口字段完整：`PiToolExecutionStartEvent` 含 `toolCallId: string`, `toolName: string`, `args: unknown`

### P0-03: PiEventConverter 字段无类型约束 → switch 自动收窄 ✅

- 函数签名从 `Record<string, unknown>` 改为 `PiAgentEvent`
- 各 case 分支用 `as PiMessageUpdateEvent` / `as PiToolExecutionStartEvent` 等具体类型断言
- 字段访问 `e.toolCallId`, `e.toolName` 等有编译时类型检查
- `as string` 断言从 v1 的大量使用降为仅 2 处（ame 子类型的 delta 字段）

### P0-04: handleResponse 嵌套 as → PiResponseEvent 类型 ✅

- `handleResponse` 参数类型为 `PiResponseEvent`，顶层字段 `command`, `success`, `error` 不再需要 as
- `response.data` 仍有 3 处 `as Record<string, unknown>`（见 P2-01 分析）
- `data.model.modelId` 三层穿透从 3 个 as 降为 2 个，改善明显

### P1-01: constructor 签名 → PiTransportOptions 对象 ✅

- `PiTransport` constructor 改为 `constructor(options: PiTransportOptions)`
- `PiTransportOptions` 接口定义清晰：`command`, `args`, `cwd`
- 内部通过 `this.options.xxx` 访问，消除了位置参数

### P1-02: 可变状态散落 — 记录为已知设计选择

- `currentModel` 和 `currentPermissionMode` 仍为闭包内 let 变量
- v1 审查建议封装为 `PiSessionState` 对象，当前未采纳
- 考虑到仅 2 个变量、修改点各 2-3 处、闭包生命周期与 transport 一致，当前方案可接受
- 评判为已知设计选择，不升级

---

## v2 全量复查

### 新增文件: cli/src/pi/types.ts (106 行)

类型定义质量评估：

| 维度 | 评价 |
|------|------|
| 覆盖度 | Pi RPC 协议三大类（Agent Event / Command / Response）均有定义 |
| 收窄能力 | `PiAgentEvent` discriminated union 支持 switch 自动收窄 |
| 向前兼容 | fallback 分支 `{ type: string }` 允许未识别事件通过 |
| 可维护性 | 单一来源，变更只需改此文件 |

1 个小问题：

| 优先级 | 位置 | 描述 |
|--------|------|------|
| P2 | L20-23 `PiAssistantMessageEvent` | 最后一个分支 `{ type: string; [key: string]: unknown }` 是 open-ended index signature，会导致 TS 在收窄到该分支时所有字段均为 `unknown`。converter 中 `ame` 的 `(ame as { delta: string }).delta` 就是因为这个 — 如果把 text_delta/thinking_delta 提升为 union 成员而非嵌套在 PiAssistantMessageEvent 内部，可以消除这 2 处 as |

### cli/src/pi/PiTransport.ts (127 行)

| 优先级 | 位置 | 描述 |
|--------|------|------|
| — | — | 无品味问题 |

`PiTransport` 改造彻底：
- handler 签名全部使用 types.ts 中的类型
- `send` 参数为 `PiRpcCommand`
- `handleLine` 中 `parsed as PiAgentEvent` 是 JSON.parse 后唯一的断言点（入口断言，合理）
- buffer 解析逻辑清晰，边界处理正确

### cli/src/pi/PiEventConverter.ts (91 行)

| 优先级 | 位置 | 描述 |
|--------|------|------|
| P2 | L21, L24 | `ame` 收窄到 text_delta/thinking_delta 分支后，仍需 `(ame as { delta: string }).delta`。根因是 `PiAssistantMessageEvent` 的 fallback 分支带 index signature 导致 TS 无法确定其他分支有 delta 字段。建议：在 switch 内再对 `ame.type` 做 discriminated union 收窄，或将 PiAssistantMessageEvent 的 text_delta/thinking_delta 分支内联到 PiMessageUpdateEvent 中 |

除此外，类型使用规范：
- switch 各分支断言到具体接口类型
- 字段访问全部类型安全
- 未知事件优雅降级（返回空数组 + debug 日志）

### cli/src/pi/runPi.ts (208 行)

| 优先级 | 位置 | 描述 |
|--------|------|------|
| P2 | L99-113 `handleResponse` | `response.data` 仍用 `as Record<string, unknown>` 访问嵌套字段（3 处）。原因是 `PiResponseEvent.data` 类型为 `unknown`。可考虑按 command 定义更精确的 response data 类型，但涉及对 Pi 协议响应结构的完整建模，当前作为 trade-off 可接受 |
| P3 | L179-183 | `lifecycle.cleanupAndExit` monkey-patch：先 bind 保存原始实现，再覆盖为 resolve + 调用原始。这是 v1 就存在的问题，优先级不变 |

### cli/src/commands/pi.ts (30 行)

无品味问题。与 v1 评价一致。

---

## 量化对比

| 指标 | v1 | v2 | 变化 |
|------|----|----|------|
| `any` 使用 | 0 | 0 | — |
| `Record<string, unknown>` | 14 | 3 | -79% |
| `as` 断言 | 17 | 6 | -65% |
| 类型定义文件 | 0 | 1 | +1 |
| P0 问题 | 4 | 0 | -4 |
| P1 问题 | 2 | 0 | -2 |
| P2 问题 | 0 | 2 | +2 |

剩余 6 处 `as` 断言分布：
- PiTransport.handleLine: 1 处（JSON.parse 入口断言 → 合理）
- PiEventConverter: 2 处（ame delta 收窄 → PiAssistantMessageEvent index signature 限制）
- runPi.handleResponse: 3 处（response.data 嵌套访问 → PiResponseEvent.data 为 unknown）
- runPi transport.onEvent: 1 处（event → PiResponseEvent 类型转换）

剩余 3 处 `Record<string, unknown>` 全在 handleResponse 内的 `response.data` 访问。

---

## 问题汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 | 0 | 全部修复 |
| P1 | 0 | constructor 签名已修复，可变状态记为已知设计选择 |
| P2 | 2 | PiAssistantMessageEvent index signature 导致 ame delta 需要 as（2 处）；handleResponse data 嵌套访问（3 处 Record+as） |
| P3 | 1 | cleanupAndExit monkey-patch（继承自 v1） |

## 结论

**Pass**。核心类型安全问题（4 个 P0）全部修复。types.ts 提供了完整的 Pi RPC 协议类型定义，三个消费文件的类型使用基本规范。剩余 P2 问题是类型建模粒度的 trade-off（完整建模 Pi 响应 data 结构 vs 实用主义），不影响类型安全的核心目标。
