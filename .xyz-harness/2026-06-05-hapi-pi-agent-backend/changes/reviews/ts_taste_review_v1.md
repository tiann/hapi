---
verdict: needs_improvement
must_fix:
  - P0-01: PiTransport/PiEventConverter/runPi 全线使用 Record<string, unknown> + as 断言，无结构化类型定义
  - P0-02: Pi RPC 协议事件无类型定义，所有字段访问靠 as string / as boolean 猜测
  - P0-03: PiEventConverter 内部字段访问（ame.delta, event.toolCallId 等）无类型约束，拼写错误不报编译错误
  - P0-04: runPi.handleResponse 嵌套 Record<string, unknown> 断言链，data.model.modelId 三层 as 穿透
  - P1-01: PiTransport constructor 签名 (string, string, string) 而非使用已定义的 PiTransportOptions
  - P1-02: runPi 中 currentModel/currentPermissionMode 可变状态散落在闭包中，无法追踪变更来源
review_metrics:
  total_files: 4
  total_lines: 441
  p0_issues: 4
  p1_issues: 2
  p2_issues: 0
  p3_issues: 1
  any_count: 0
  record_unknown_count: 14
  as_assertion_count: 17
  magic_number_count: 1
---

# TypeScript 品味审查报告 — hapi pi agent backend

**审查范围**: `cli/src/pi/` (3 文件) + `cli/src/commands/pi.ts` (1 文件)
**总行数**: 441 行
**审查日期**: 2026-06-06

---

## 总结

核心问题集中在一点：**Pi RPC 协议缺乏类型定义**。四个文件中 14 处 `Record<string, unknown>` + 17 处 `as` 断言构成了一个贯穿性的类型空洞。`any` 为零是个假象——`Record<string, unknown>` + `as` 是 `any` 的变体，字段拼写错误不会在编译时暴露，只在运行时静默返回 `undefined`。

所有 P0 问题的修复路径一致：定义 Pi 协议类型 → 入口断言 → 内部用 discriminated union 收窄。

---

## cli/src/pi/PiTransport.ts（120 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 类型 | L12, L58, L72, L114 | event 和 message 全部是 `Record<string, unknown>`。JSON parse 结果在 L114 用 `as Record<string, unknown>` 断言，无任何运行时校验 | 定义 `PiRpcEvent` discriminated union 类型；L114 入口处用 type guard 或 zod 校验后断言为具体类型 |
| P1 | 结构 | L17-19 | constructor 接收三个原始参数 `(command, args, cwd)` 而非使用已定义的 `PiTransportOptions` 接口 | 改为 `constructor(options: PiTransportOptions)`，删除冗余的 `this.options` 包装 |
| P1 | 命名 | L108-109 | `handleLine` 中 `line.slice(0, 100)` 的 100 是魔法数字 | 提取为 `MAX_LOG_PREVIEW_LENGTH = 100` |

**白名单评估**: PiTransport 作为流式 JSONL 解析层，`JSON.parse` 结果天然是 `unknown`。但当前实现在解析后直接 `as Record<string, unknown>` 抛给外部，没有在边界处断言为具体类型。这属于"应在入口断言"的场景，不应白名单放行。

统计: P0: 1 | P1: 2

---

## cli/src/pi/PiEventConverter.ts（83 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 类型 | L10 | 函数签名 `event: Record<string, unknown>` — 入口处无类型断言，内部全靠 `as` | 定义 `PiAgentEvent` discriminated union；入口 `const e = event as PiAgentEvent`，内部 switch 自动收窄 |
| P0 | 类型 | L11, L17 | `event.type as string`、`ame.type as string` — 字段拼写错误不报编译错误 | 具体类型后由 TS 自动收窄，消除 as |
| P0 | 类型 | L15 | `event.assistantMessageEvent as Record<string, unknown> \| undefined` — 嵌套字段无类型 | `PiAgentEvent` 的 `message_update` 分支应包含 `assistantMessageEvent: { type: string; delta?: string }` |
| P0 | 类型 | L24, L31 | `event.toolCallId`、`event.toolName`、`event.args` 直接从 `Record<string, unknown>` 取值，拼写错误零编译检查 | 具体类型分支中这些字段为 `string`，TS 自动检查 |
| P0 | 类型 | L49-50 | `event.message as Record<string, unknown>`、`piMessage?.usage as Record<string, unknown>` — 二级嵌套又是 `Record` | `turn_end` 分支应定义 `message?: { usage?: UsageData; stopReason?: string }` |

**推荐的重构方向**:

```typescript
// cli/src/pi/types.ts — 新增
type PiAgentEvent =
  | { type: 'message_update'; assistantMessageEvent?: AssistantMessageEvent }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'turn_end'; message?: { usage?: PiUsage; stopReason?: string } }
  | { type: 'agent_start' | 'agent_end' | 'turn_start' | 'message_start' | 'message_end' | 'tool_execution_update' }
```

转换函数入口：`const e = event as PiAgentEvent`，之后 switch 各分支自动收窄，所有 `as string` / `as Record` 消除。

统计: P0: 5

---

## cli/src/pi/runPi.ts（208 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 类型 | L80 | `event.type as string` — 从 Record 取 type 用 as 断言 | 入口断言为 `PiRpcEvent`，TS 自动收窄 |
| P0 | 类型 | L84 | `handleResponse(event as Record<string, unknown>)` — 二次 as 穿透 | `PiRpcEvent` 中 `response` 分支已有具体类型 |
| P0 | 类型 | L98-117 | `handleResponse` 内部 6 处 `as` 断言（command as string, success as boolean, data as Record, model as Record, modelId as string）— 最密集的 as 穿透区域 | 定义 `PiResponseEvent` 类型，`command` 做 discriminated union key，每个 command 有自己的 data 结构 |
| P1 | 结构 | L88-136 | `handleResponse` 闭包内嵌 switch，48 行，混合了状态更新 + 日志 + 响应路由 | 可提取为独立函数 `handlePiResponse(response: PiResponseEvent, ctx: PiRunnerContext)` |
| P1 | 结构 | L86-90, L99 | `currentModel` 和 `currentPermissionMode` 可变 let 在闭包中被多处修改（L117, L125, L150, L154），变更来源难以追踪 | 考虑封装为 `PiSessionState` 对象，变更走 `state.setModel()` 等方法，便于日志追踪 |
| P1 | 类型 | L155 | `transport.send({ type: 'set_model', provider: '', modelId: currentModel })` — provider 传空字符串 | 要么 provider 有意义就传值，要么协议不需要就删掉。空字符串暗示协议定义不清 |
| P3 | 细节 | L171 | `lifecycle.cleanupAndExit` 被 monkey-patch（先保存 orig 再覆盖） | 这是一个不太常规的模式。如果 `createRunnerLifecycle` 支持 `onBeforeCleanup` 回调会更清晰，但属于已有架构约束，低优先级 |

统计: P0: 3 | P1: 3 | P3: 1

---

## cli/src/commands/pi.ts（30 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | — | — | 无品味问题 | — |

命令入口文件，职责清晰：解析参数 → 初始化 → 调用 runPi。错误处理有 try/catch + 区分 Error 实例 + DEBUG 模式输出堆栈。动态 import `@/pi/runPi` 合理（按需加载）。

统计: 无发现

---

## 跨文件问题

### 跨文件重复：Pi 协议事件类型

当前 Pi RPC 协议事件在三个文件中以 `Record<string, unknown>` 的形式被"各自理解"：

| 文件 | 假设的事件字段 |
|------|--------------|
| PiEventConverter.ts | `type`, `assistantMessageEvent`, `toolCallId`, `toolName`, `args`, `result`, `isError`, `message`, `usage` |
| runPi.ts (event handler) | `type` |
| runPi.ts (handleResponse) | `type`, `command`, `success`, `error`, `data`, `data.model`, `data.modelId` |

三个文件各自用 `as` 假设不同的字段名。一旦 Pi 侧协议变更（如 `toolCallId` → `tool_call_id`），需要逐文件查找所有 `as` 断言，容易漏改。

**建议**: 新增 `cli/src/pi/types.ts`，定义 Pi RPC 协议的完整类型体系：

```
PiRpcEvent = PiAgentEvent | PiResponseEvent | PiLifecycleEvent
```

三个文件统一 import，变更时只改一处。

---

## 问题汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 | 4 | 全部指向同一个根因：Pi 协议无类型定义，Record+as 贯穿全局 |
| P1 | 2 | constructor 签名不一致 + 可变状态散落 |
| P2 | 0 | — |
| P3 | 1 | monkey-patch cleanupAndExit |

## 建议重构顺序

1. **新增 `cli/src/pi/types.ts`** — 定义 `PiAgentEvent`、`PiResponseEvent` discriminated union
2. **重构 `PiEventConverter.ts`** — 入口断言 `as PiAgentEvent`，消除所有内部 `as`
3. **重构 `runPi.ts` handleResponse** — 入口断言 `as PiResponseEvent`，按 command 分支收窄
4. **重构 `PiTransport.ts`** — `onEvent` 回调签名改为 `(event: PiAgentEvent) => void`
5. **次要**: constructor 签名统一、魔法数字提取

预计改动范围：新增 1 文件（types.ts ~60 行），修改 3 文件（合计净减 ~20 行，as 断言消除量 > 新增类型定义）。
