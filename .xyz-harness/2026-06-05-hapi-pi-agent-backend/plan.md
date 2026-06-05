---
verdict: pass
complexity: L1
---

# Pi Agent Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `hapi pi` CLI command that spawns Pi coding agent as subprocess and communicates via JSONL RPC over stdio.

**Architecture:** Spawn `pi --mode rpc` as child process, implement JSONL line-protocol transport, convert Pi RPC events to HAPI AgentMessage via event converter, wrap in runner that integrates with HAPI session management. Follows the same pattern as `cli/src/gemini/` but simpler (no hook server, no permission adapter, no ACP protocol).

**Tech Stack:** TypeScript, Node.js child_process, Vitest for testing.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `cli/src/pi/PiTransport.ts` | create | BG1 | JSONL stdio transport：spawn Pi 子进程，管理 stdin/stdout，行缓冲+JSON 解析 |
| `cli/src/pi/PiEventConverter.ts` | create | BG1 | Pi AgentEvent → HAPI AgentMessage 转换器 |
| `cli/src/pi/runPi.ts` | create | BG1 | Runner 入口：session 创建、消息队列、keep-alive、生命周期管理 |
| `cli/src/pi/PiTransport.test.ts` | create | BG1 | PiTransport 单元测试 |
| `cli/src/pi/PiEventConverter.test.ts` | create | BG1 | PiEventConverter 单元测试 |
| `cli/src/commands/pi.ts` | create | BG1 | `hapi pi` 命令定义 |
| `shared/src/modes.ts` | modify | BG1 | 添加 `'pi'` flavor + `PI_PERMISSION_MODES` |
| `shared/src/flavors.ts` | modify | BG1 | 添加 `'pi'` 到 FLAVOR_CAPS 和 FLAVOR_LABELS |
| `cli/src/commands/registry.ts` | modify | BG1 | 注册 piCommand |

## Interface Contracts

### Module: pi

#### Class: PiTransport

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| constructor | (command: string, args: string[], cwd: string) => PiTransport | PiTransport | — | AC-1 |
| start | () => Promise<void> | void | ENOENT: throw descriptive error | AC-1, AC-5 |
| send | (message: PiRpcCommand) => void | void | EPIPE: emit 'close' event | AC-8 |
| onEvent | (handler: (event: PiAgentEvent) => void) => void | void | malformed JSON: skip + warn | AC-8 |
| kill | () => void | void | already killed: no-op | AC-6 |
| onClose | (handler: (code: number \| null, signal: string \| null) => void) => void | void | — | AC-7 |
| isRunning | () => boolean | boolean | — | AC-7 |

#### Data: PiRpcCommand

| Field | Type | Description |
|-------|------|-------------|
| type | `"prompt" \| "abort" \| "new_session" \| "set_model" \| "get_state"` | RPC 命令类型 |
| message? | string | prompt 命令的消息文本 |
| provider? | string | set_model 的 provider |
| modelId? | string | set_model 的 model ID |

#### Data: PiAgentEvent (discriminated union on `type`)

| type 值 | 关键字段 | Description |
|---------|---------|-------------|
| `"response"` | command, success, data? | RPC 响应（ack） |
| `"message_update"` | assistantMessageEvent: { type, delta?, ... } | 流式文本/thinking 更新 |
| `"tool_execution_start"` | toolCallId, toolName, input | 工具调用开始 |
| `"tool_execution_end"` | toolCallId, output, is_error | 工具调用结束 |
| `"turn_start"` | — | turn 开始 |
| `"turn_end"` | usage: { inputTokens, outputTokens, ... } | turn 结束 |
| `"agent_end"` | — | agent 进程正常结束 |

#### Class: PiEventConverter

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| convert | (event: PiAgentEvent) => AgentMessage[] | AgentMessage[] (0-N 条) | unknown event type: return [] | AC-2 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 基本启动 | PiTransport.start() | start → spawn → onEvent ready | Task 1 |
| AC-2 消息收发 | PiTransport.send(prompt) + PiEventConverter.convert() | send → Pi → events → convert → AgentMessage[] | Task 1 + Task 2 |
| AC-3 中断生成 | PiTransport.send(abort) | send(abort) → Pi stops → turn_end | Task 1 |
| AC-4 模型切换 | PiTransport.send(set_model) | send(set_model) → response(success) | Task 3 |
| AC-5 Pi 不可用 | PiTransport.start() | start → ENOENT → throw error | Task 1 |
| AC-6 进程清理 | PiTransport.kill() | HAPI exit → kill → SIGTERM | Task 3 |
| AC-7 Pi 异常退出 | PiTransport.onClose() | Pi crash → onClose → cleanup | Task 3 |
| AC-8 JSONL 错误 | PiTransport.onEvent() (malformed) + send() (EPIPE) | malformed → warn+skip; EPIPE → close | Task 1 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 基本启动和交互 | adopted | Task 1, Task 3 |
| AC-2 消息收发 | adopted | Task 1, Task 2 |
| AC-3 中断生成 | adopted | Task 1, Task 3 |
| AC-4 模型切换 | adopted | Task 3 |
| AC-5 Pi 不可用 | adopted | Task 1 |
| AC-6 HAPI 退出时进程清理 | adopted | Task 3 |
| AC-7 Pi 子进程异常退出 | adopted | Task 3 |
| AC-8 JSONL 协议错误 | adopted | Task 1 |

---

## Tasks

### Task 1: PiTransport — JSONL 传输层

**Type:** backend

**Files:**
- Create: `cli/src/pi/PiTransport.ts`
- Create: `cli/src/pi/PiTransport.test.ts`

**参考文件（实现时需读取）：**
- `cli/src/agent/backends/acp/AcpStdioTransport.ts` — spawn + line-protocol 参考模式
- `cli/src/codex/utils/codexVersion.ts:55-80` — ENOENT 错误处理模式

- [ ] **Step 1: 写失败测试**

测试文件 `cli/src/pi/PiTransport.test.ts`，测试框架使用 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 `npx vitest run`。

关键测试场景：
- `start()` 在命令不存在时抛出包含 "not found" 的错误（模拟 ENOENT）
- `send()` 将 JSON 写入子进程 stdin
- `send()` 在 stdin 写入失败（EPIPE）时触发 close 事件（AC-8）
- `onEvent()` 从 stdout 解析 JSONL 行并调用 handler
- `onEvent()` 在 malformed JSON 时记录 warning 且不中断
- `kill()` 向子进程发送 SIGTERM
- `onClose()` 在子进程退出时调用 handler
- `isRunning()` 正确反映子进程状态

mock `child_process.spawn`，不依赖真实 `pi` 二进制。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run cli/src/pi/PiTransport.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

`cli/src/pi/PiTransport.ts`:

核心逻辑：
- `constructor(command, args, cwd)` — 保存参数，不启动
- `start()` — 调用 `child_process.spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })`，设置 stdout 的行缓冲（`readline.createInterface`），ENOENT 时抛出描述性错误
- `send(message)` — `this.process.stdin.write(JSON.stringify(message) + '\n')`，捕获 EPIPE 触发 close
- 行解析器在每行上 `JSON.parse`，失败时 `logger.warn` 并跳过
- `kill()` — `this.process.kill('SIGTERM')`，设 killed flag
- `onClose` — 监听 `process.on('close', ...)`
- `isRunning()` — 检查 process 是否存在且未退出
- 不引入任何 npm 依赖

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run cli/src/pi/PiTransport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/pi/PiTransport.ts cli/src/pi/PiTransport.test.ts
git commit -m "feat(pi): add PiTransport with JSONL stdio communication"
```

---

### Task 2: PiEventConverter — 事件转换器

**Type:** backend

**Files:**
- Create: `cli/src/pi/PiEventConverter.ts`
- Create: `cli/src/pi/PiEventConverter.test.ts`

**参考文件（实现时需读取）：**
- `cli/src/agent/types.ts:31-44` — AgentMessage 类型定义
- `cli/src/agent/backends/acp/AcpMessageHandler.ts` — ACP 事件转换参考模式

- [ ] **Step 1: 写失败测试**

测试文件 `cli/src/pi/PiEventConverter.test.ts`。测试框架使用 vitest。

关键测试场景：
- `message_update` + `assistantMessageEvent.type === 'text_delta'` → `[{ type: 'text', text: delta }]`
- `message_update` + `assistantMessageEvent.type === 'thinking_delta'` → `[{ type: 'reasoning', text: delta, live: true }]`
- `tool_execution_start` → `[{ type: 'tool_call', id, name, input, status: 'in_progress' }]`
- `tool_execution_end` (成功) → `[{ type: 'tool_result', id, output, status: 'completed' }]`
- `tool_execution_end` (失败) → `[{ type: 'tool_result', id, output, status: 'failed' }]`
- `turn_end` → `[{ type: 'usage', ...tokens }, { type: 'turn_complete', stopReason }]`（两条消息）
- `agent_end` → `[]`
- `response` → `[]`（RPC ack，不转换为 AgentMessage）
- unknown event type → `[]`

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run cli/src/pi/PiEventConverter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

`cli/src/pi/PiEventConverter.ts`:

纯函数 `convertPiEvent(event: Record<string, unknown>): AgentMessage[]`。

转换逻辑（按 `event.type` 分支）：
- `message_update`: 从 `event.assistantMessageEvent` 取子类型。`text_delta` → text AgentMessage（取 `delta` 字段）。`thinking_delta` → reasoning AgentMessage（取 `delta` 字段，`live: true`）。其他子类型（start/end）返回空数组。
- `tool_execution_start`: 取 `event.toolCallId`, `event.toolName`, `event.input` → tool_call AgentMessage
- `tool_execution_end`: 取 `event.toolCallId`, `event.output`, `event.is_error` → tool_result AgentMessage（is_error ? 'failed' : 'completed'）
- `turn_end`: 取 `event.usage` → usage AgentMessage。再追加 `turn_complete` AgentMessage（stopReason: 'stop'）。返回两条。
- `agent_end`, `response`, `turn_start`, 其他: 返回 `[]`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run cli/src/pi/PiEventConverter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/pi/PiEventConverter.ts cli/src/pi/PiEventConverter.test.ts
git commit -m "feat(pi): add PiEventConverter for Pi RPC event → AgentMessage"
```

---

### Task 3: Shared 类型注册 + CLI 命令 + Runner

**Type:** backend

**Files:**
- Modify: `shared/src/modes.ts:10` (AGENT_FLAVORS)
- Modify: `shared/src/modes.ts:30` 附近 (新增 PI_PERMISSION_MODES)
- Modify: `shared/src/modes.ts:100-120` (getPermissionModesForFlavor 添加 pi 分支)
- Modify: `shared/src/flavors.ts` (FLAVOR_CAPS + FLAVOR_LABELS)
- Modify: `cli/src/commands/registry.ts:1-45` (import + COMMANDS 数组)
- Create: `cli/src/commands/pi.ts`
- Create: `cli/src/pi/runPi.ts`

**参考文件（实现时需读取）：**
- `cli/src/commands/gemini.ts` — 命令定义模式
- `cli/src/commands/agentCommandOptions.ts` — 参数解析
- `cli/src/gemini/runGemini.ts` — Runner 入口模式
- `cli/src/agent/runners/runAgentSession.ts` — session 管理、消息队列、keep-alive 参考模式
- `shared/src/modes.ts` — 现有 flavor 注册模式
- `shared/src/flavors.ts` — 现有 capability 注册模式

- [ ] **Step 1: 修改 shared 类型**

`shared/src/modes.ts`:
- Line 10: `AGENT_FLAVORS` 数组末尾添加 `'pi'`
- Line 30 附近（在 OPENCODE_PERMISSION_MODES 之后）新增: `export const PI_PERMISSION_MODES = ['default', 'yolo'] as const` + `export type PiPermissionMode = typeof PI_PERMISSION_MODES[number]`
- `getPermissionModesForFlavor()` 函数（~line 100-120）添加: `if (flavor === 'pi') { return PI_PERMISSION_MODES }`

`shared/src/flavors.ts`:
- `FLAVOR_CAPS` 添加: `pi: new Set([Capabilities.ModelChange])`
- `FLAVOR_LABELS` 添加: `pi: 'Pi'`

- [ ] **Step 2: 创建 CLI 命令**

`cli/src/commands/pi.ts`:

参考 `cli/src/commands/gemini.ts` 的结构。关键差异：
- Pi 不支持 remote mode，但本地启动仍需解析 `--started-by`、`--permission-mode`、`--yolo`、`--model` 参数，因此使用 `parseRemoteAgentCommandOptions`
- 使用 `PI_PERMISSION_MODES` 代替 `GEMINI_PERMISSION_MODES`
- 在本地模式下先调用 `assertPiAvailable()`（检测 `pi` 是否在 PATH），不可用时抛出错误
- `requiresRuntimeAssets: true`（与 gemini 对齐）

`cli/src/commands/registry.ts`:
- 顶部 import: `import { piCommand } from './pi'`
- `COMMANDS` 数组中 `geminiCommand` 之后添加 `piCommand`

- [ ] **Step 3: 创建 Runner**

`cli/src/pi/runPi.ts`:

参考 `cli/src/gemini/runGemini.ts` 和 `cli/src/agent/runners/runAgentSession.ts`。

核心流程：
1. `bootstrapSession({ flavor: 'pi', ... })` 创建 HAPI session
2. 创建 `PiTransport('pi', ['--mode', 'rpc'], workingDirectory)`
3. `transport.start()` 启动 Pi 子进程
4. 注册 `transport.onClose()` 处理 Pi crash（AC-7: 展示错误信息，清理 session）
5. 注册 `transport.onEvent()` **双轨事件分发**：
   - `type === 'response'` → runner 直接处理（见下方 response 处理逻辑）
   - 其他类型 → `convertPiEvent()` 转换为 AgentMessage[] → emit 到 session
6. `transport.send({ type: 'new_session' })` 初始化 Pi session
7. `transport.send({ type: 'get_state' })` 获取初始状态
8. 消息队列循环：`session.onUserMessage` → `transport.send({ type: 'prompt', message })`
9. 注册 abort RPC handler: `transport.send({ type: 'abort' })`
10. 注册 session config RPC handler: `transport.send({ type: 'set_model', provider, modelId })`
11. keep-alive interval (2s)
12. finally 块: `transport.kill()`, session cleanup

**Response 事件处理逻辑（runner 直接消费）：**
- `command === 'new_session'` → 记录 Pi session 初始化完成
- `command === 'get_state'` → 提取 `data` 中的 model 信息，更新 HAPI session 元数据
- `command === 'set_model'` → `success: true` 确认模型切换成功；`success: false` → emit error AgentMessage
- `command === 'abort'` → 确认中断完成，恢复 ready 状态
- `command === 'prompt'` → prompt 命令已被 Pi 接收的 ack，无需特殊处理
- 其他 response → 记录 debug 日志

生命周期管理：
- HAPI 退出 → SIGTERM handler → `transport.kill()` (AC-6)
- Pi crash → `transport.onClose` → error message + session end (AC-7)
- SIGINT → handleAbort → `transport.send({ type: 'abort' })` (AC-3)

- [ ] **Step 4: 类型检查**

Run: `bun typecheck`
Expected: PASS

- [ ] **Step 5: 运行所有测试**

Run: `bun run test`
Expected: PASS（已有的测试不受影响）

- [ ] **Step 6: Commit**

```bash
git add shared/src/modes.ts shared/src/flavors.ts cli/src/commands/pi.ts cli/src/commands/registry.ts cli/src/pi/runPi.ts
git commit -m "feat(pi): add hapi pi command with session management and event routing"
```

---

## Execution Groups

#### BG1: Pi Agent Backend

**Description:** 所有 Pi agent 后端文件：transport、event converter、runner、CLI 命令、shared 类型注册。这些文件紧密关联，共同构成 `hapi pi` 的完整功能。

**Tasks:** Task 1, Task 2, Task 3

**Files (预估):** 9 个文件（6 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 描述 + spec FR/AC + 参考文件路径 |
| 读取文件 | `cli/src/agent/backends/acp/AcpStdioTransport.ts`, `cli/src/agent/types.ts`, `cli/src/gemini/runGemini.ts`, `cli/src/agent/runners/runAgentSession.ts`, `shared/src/modes.ts`, `shared/src/flavors.ts`, `cli/src/commands/gemini.ts`, `cli/src/commands/agentCommandOptions.ts`, `cli/src/commands/registry.ts`, `cli/src/codex/utils/codexVersion.ts` |
| 修改/创建文件 | 见 File Structure 表 |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (PiTransport):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (PiEventConverter, depends on Task 1):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3 (Runner + Registration, depends on Task 1 + Task 2):
    1. general-purpose (read xyz-harness-backend-dev) → 写 shared 类型 + 命令 + runner
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 直接写在此处（L1）

## Dependency Graph & Wave Schedule

```
BG1 (Pi Agent Backend)
  Task 1 (PiTransport) ─┬─→ Task 3 (Runner + Registration)
  Task 2 (Converter)  ─┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1: Task 1 + Task 2 | Transport 和 Converter 并行（无代码依赖） |
| Wave 2 | BG1: Task 3 | Runner 依赖 Task 1 + Task 2 |

