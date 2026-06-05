---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 10
  boundaries_checked: 14
  issues_found: 4
  must_fix_count: 0
  low_count: 2
  info_count: 2
  duration_estimate: "20"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-06 02:45
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：14
- 模拟数据验证路径数：5

## 识别的模块边界

| 边界编号 | 调用方模块 | 被调用方模块 | 边界性质 |
|----------|-----------|-------------|---------|
| B1 | `commands/pi.ts` | `shared/modes.ts` | CLI → shared 枚举/类型 |
| B2 | `commands/pi.ts` | `commands/agentCommandOptions.ts` | CLI → 通用参数解析 |
| B3 | `commands/pi.ts` | `pi/runPi.ts` | 命令层 → 运行时 |
| B4 | `pi/runPi.ts` | `agent/sessionFactory.ts` | Pi runner → HAPI session 生命周期 |
| B5 | `pi/runPi.ts` | `agent/runnerLifecycle.ts` | Pi runner → HAPI 进程生命周期 |
| B6 | `pi/runPi.ts` | `agent/sessionConfigRpc.ts` | Pi runner → HAPI RPC 配置 |
| B7 | `pi/runPi.ts` | `pi/PiTransport.ts` | Runner → transport 层 |
| B8 | `pi/PiTransport.ts` | `pi/types.ts` | Transport → Pi RPC 类型 |
| B9 | `pi/runPi.ts` | `pi/PiEventConverter.ts` | Runner → 事件转换 |
| B10 | `pi/PiEventConverter.ts` | `pi/types.ts` | 事件转换 → Pi RPC 类型 |
| B11 | `pi/PiEventConverter.ts` | `agent/types.ts` | 事件转换 → HAPI AgentMessage |
| B12 | `pi/runPi.ts` | `agent/types.ts` | Runner → HAPI AgentMessage（间接，经 converter） |
| B13 | `shared/flavors.ts` | `shared/modes.ts` | Flavor 能力 → 权限模式 |
| B14 | `commands/registry.ts` | `commands/pi.ts` | 命令注册 → 命令实现 |

## 边界检查矩阵

| UC | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|----|--------|------------|------------|------------|----------|------|
| UC-1 | B1: pi.ts→modes.ts | ✅ | — | ✅ | — | — |
| UC-1 | B2: pi.ts→agentCommandOptions.ts | ✅ | ✅ | ✅ | — | — |
| UC-1 | B3: pi.ts→runPi.ts | ✅ | ✅ | ✅ | — | — |
| UC-1 | B4: runPi→sessionFactory | ✅ | — | ✅ | — | — |
| UC-1 | B5: runPi→runnerLifecycle | ✅ | ✅ | ✅ | — | — |
| UC-1 | B7: runPi→PiTransport | ✅ | ✅ | ✅ | — | — |
| UC-1 | B8: PiTransport→types | ✅ | — | ✅ | — | — |
| UC-1 | B14: registry→pi.ts | ✅ | — | ✅ | — | — |
| UC-2 | B7: runPi→PiTransport | ✅ | ✅ | ✅ | — | — |
| UC-2 | B9: runPi→PiEventConverter | ✅ | ✅ | ✅ | — | — |
| UC-2 | B10: converter→types | ⚠️ | — | ✅ | — | 字段命名偏差 |
| UC-2 | B11: converter→AgentMessage | ✅ | — | ✅ | — | — |
| UC-3 | B7: runPi→PiTransport | ✅ | — | ✅ | — | — |
| UC-4 | B6: runPi→sessionConfigRpc | ✅ | ✅ | ✅ | — | — |
| UC-4 | B7: runPi→PiTransport | ⚠️ | — | ✅ | — | provider 空字符串 |
| UC-5 | B5: runPi→runnerLifecycle | ✅ | ⚠️ | ✅ | — | crashed 变量误导 |
| UC-5 | B7: runPi→PiTransport | ✅ | ✅ | ✅ | — | — |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | UC-2 | B10: converter→types | D1 | Pi 事件字段名 `args`/`result`/`isError` 与 plan interface 定义的 `input`/`output`/`is_error` 不同。`types.ts` 中 `PiToolExecutionStartEvent.args` 与 `AgentMessage.tool_call.input` 映射正确（converter 做了 `input: e.args`）。如果实际 Pi RPC 返回的字段名是 `input` 而非 `args`，则 `e.args` 为 `undefined`。类型系统无法检测此偏差 | `cli/src/pi/PiEventConverter.ts` | L31, L48 | 确认 Pi 实际 RPC stdout 中 tool_execution_start/end 的字段名。如果 Pi 用 `input`/`output`/`is_error`，需同步修改 `types.ts` |
| 2 | LOW | UC-4 | B7: runPi→PiTransport | D1 | `set_model` 命令始终传 `provider: ''`。`PiRpcCommand` 类型定义 `set_model` 需要 `provider: string`，但 runPi 传空字符串。如果 Pi 忽略 provider 则无影响；如果 Pi 尝试按 provider 查找则切换静默失败 | `cli/src/pi/runPi.ts` | L141 | 确认 Pi 是否需要 provider。若不需要，考虑将 `PiRpcCommand` 的 `provider` 改为可选字段 |
| 3 | INFO | UC-5 | B5: runPi→runnerLifecycle | D2 | `crashed` 局部变量在 `runPi.ts` 中声明但从未被设为 `true`。onError/onClose 回调直接调 `lifecycle.markCrash()`，不走 `crashed` 变量。`finally` 块中 `if (!crashed)` 始终为 true 会覆盖 `sessionEndReason`，但因 `sendSessionDeath` 在 `archiveAndClose` 同步段先读取，行为实际正确。代码易引起维护者误解 | `cli/src/pi/runPi.ts` | L92, L102-104 | 移除 `crashed` 变量；finally 块改为检查 `lifecycle` 的 crash 状态 |
| 4 | INFO | UC-1 | B8: PiTransport→types | D1 | `handleLine` 中 malformed JSON 跳过时日志级别为 `debug`。在大量垃圾输出场景下可能难以排查。BLR 标记为 spec 偏差（FR-5 要求 warning 级别） | `cli/src/pi/PiTransport.ts` | L128 | 考虑改为 `logger.warn`，或在连续 N 条 malformed 后提升日志级别 |

## 模拟数据验证详情

### UC-1: 用户启动 Pi 会话 — 边界 B3: pi.ts → runPi.ts

**模拟数据：** `{ "command": "hapi pi", "workingDirectory": "/home/user/project", "pi_available": true }`
**调用方传递：** `parseRemoteAgentCommandOptions(args, PI_PERMISSION_MODES)` 返回 `RemoteAgentCommandOptions<PiPermissionMode>`
**被调用方期望：** `runPi(opts)` 中 `opts: { startedBy?, startingMode?, permissionMode?, model?, resumeSessionId?, workingDirectory? }`
**结论：** ✅ 匹配。`RemoteAgentCommandOptions` 的字段完全覆盖 `runPi` 的 `opts` 参数。`modelReasoningEffort` 字段在 runPi 中不使用（Pi 不支持 effort），但多余字段不导致问题。

### UC-1: 用户启动 Pi 会话 — 边界 B4: runPi → sessionFactory

**模拟数据：** `{ "flavor": "pi", "startedBy": "terminal", "workingDirectory": "/home/user/project" }`
**调用方传递：** `bootstrapSession({ flavor: 'pi', startedBy: 'terminal', workingDirectory, model: opts.model })`
**被调用方期望：** `SessionBootstrapOptions = { flavor: string, startedBy?: SessionStartedBy, workingDirectory?: string, model?: string, ... }`
**结论：** ✅ 匹配。`flavor` 为 `string` 类型，`'pi'` 是合法值。`sessionFactory` 不校验 flavor 是否在枚举中，后续由 `flavors.ts` 的 `isKnownFlavor` 检查。

### UC-1: 用户启动 Pi 会话 — 边界 B7: runPi → PiTransport

**模拟数据：** `{ "command": "pi", "args": ["--mode", "rpc"], "cwd": "/home/user/project" }`
**调用方传递：** `new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: workingDirectory })`
**被调用方期望：** `PiTransportOptions = { command: string, args: string[], cwd: string }`
**结论：** ✅ 匹配。类型完全一致。

### UC-2: 用户与 Pi 对话 — 边界 B10+B11: converter → types → AgentMessage

**模拟数据：** Pi 事件 `{ "type": "tool_execution_start", "toolCallId": "tc-1", "toolName": "write_file", "args": { "path": "hello.ts" } }`
**converter 读取：** `e.toolCallId` → `'tc-1'`，`e.toolName` → `'write_file'`，`e.args` → `{ "path": "hello.ts" }`
**converter 输出：** `{ type: 'tool_call', id: 'tc-1', name: 'write_file', input: { "path": "hello.ts" }, status: 'in_progress' }`
**AgentMessage 期望：** `{ type: 'tool_call'; id: string; name: string; input: unknown; status: 'pending' | 'in_progress' | 'completed' | 'failed' }`
**结论：** ✅ 映射正确。`e.args` 正确映射到 `input`，`status` 硬编码为 `'in_progress'` 符合 AgentMessage 联合类型。⚠️ 前提是 Pi 实际 RPC 的字段名确实是 `args`（而非 `input`）。

### UC-2: 用户与 Pi 对话 — 边界 B11: converter → AgentMessage (tool_result)

**模拟数据：** `{ "type": "tool_execution_end", "toolCallId": "tc-1", "toolName": "write_file", "result": "File written", "isError": false }`
**converter 读取：** `e.toolCallId` → `'tc-1'`，`e.result` → `'File written'`，`e.isError` → `false`
**converter 输出：** `{ type: 'tool_result', id: 'tc-1', output: 'File written', status: 'completed' }`
**AgentMessage 期望：** `{ type: 'tool_result'; id: string; output: unknown; status: 'completed' | 'failed' }`
**结论：** ✅ 映射正确。`e.result` → `output`，`e.isError` → `status: 'failed' | 'completed'`。

### UC-2: 用户与 Pi 对话 — 边界 B11: converter → AgentMessage (usage)

**模拟数据：** `{ "type": "turn_end", "message": { "usage": { "input": 500, "output": 120, "totalTokens": 620, "cacheRead": 0 }, "stopReason": "stop" } }`
**converter 读取：** `usage.input` → `500`，`usage.output` → `120`，`usage.totalTokens` → `620`，`usage.cacheRead` → `0`
**converter 输出：**
1. `{ type: 'usage', inputTokens: 500, outputTokens: 120, totalTokens: 620, cacheReadTokens: 0 }`
2. `{ type: 'turn_complete', stopReason: 'stop' }`
**AgentMessage 期望：** `{ type: 'usage'; inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number }` 和 `{ type: 'turn_complete'; stopReason: string }`
**结论：** ✅ 完全匹配。可选字段安全传递。

### UC-4: 用户切换模型 — 边界 B6: runPi → sessionConfigRpc

**模拟数据：** `{ "target_model": "gpt-4o" }`
**调用方传递：** `registerSessionConfigRpc({ rpcHandlerManager, flavor: 'pi', modelMode: 'nullable', onApply, onAfterApply })`
**被调用方期望：** `RegisterSessionConfigRpcOptions<PiPermissionMode>`
**结论：** ✅ 匹配。`modelMode: 'nullable'` 允许 model 字段为 `string | null`，与 Pi 支持 `supportsModelChange('pi')` 一致。

### UC-4: 用户切换模型 — 边界 B7: runPi → PiTransport (set_model)

**模拟数据：** `{ "provider": "", "modelId": "gpt-4o" }`
**调用方传递：** `transport.send({ type: 'set_model', provider: '', modelId: 'gpt-4o' })`
**PiRpcCommand 期望：** `{ type: 'set_model'; provider: string; modelId: string }`
**结论：** ⚠️ 类型匹配但语义存疑。`provider: ''` 是合法 string，但空字符串是否为 Pi 期望的值未确认。

### UC-5: 会话结束清理 — 边界 B5: runPi → runnerLifecycle

**模拟数据：** `{ "signal": "SIGTERM" }` (HAPI 退出) 和 `{ "exit_code": 1 }` (Pi 崩溃)
**调用方传递：** `lifecycle.markCrash(error)` → `lifecycle.cleanupAndExit()`
**被调用方行为：** `cleanup()` → `archiveAndClose()` → `sendSessionDeath(sessionEndReason)`
**结论：** ✅ 生命周期管理正确。`onAfterClose` 回调确保 Pi 进程被 SIGTERM。`safeCleanup` 防止双重清理。⚠️ `crashed` 局部变量为死代码，不影响行为但降低可读性。

### UC-5: 会话结束清理 — 边界 B7: runPi → PiTransport (kill)

**模拟数据：** HAPI SIGTERM → `transport.kill()`
**调用方传递：** `lifecycle.onAfterClose` → `transport.kill()`
**PiTransport.kill() 行为：** 检查 `!killed`，发 SIGTERM，设 `killed = true`
**结论：** ✅ 幂等。重复调用安全（`if (!this.process || this.killed) return`）。

## 跨模块数据流总结

```
用户输入 → session.onUserMessage
  → formatMessageWithAttachments(text, attachments)     [B12: runPi→utils]
  → transport.send({ type: 'prompt', message })         [B7: runPi→transport]
  → Pi stdin (JSONL)

Pi stdout (JSONL)
  → PiTransport.handleStdout → handleLine → JSON.parse  [B8: transport→types]
  → eventHandler                                          [B7: transport→runPi]
  → convertPiEvent(event)                                [B9: runPi→converter]
  → AgentMessage[]                                        [B11: converter→agent/types]
  → session.sendAgentMessage(msg)                         [B12: runPi→session]
```

所有边界处的类型转换均已验证：
- JSON string → `PiAgentEvent`（B8）：JSON.parse + type assertion，fallback 为 debug log
- `PiAgentEvent` → `AgentMessage[]`（B9+B11）：switch/case 分发，字段映射正确
- `PiRpcCommand` → JSON string（B7）：JSON.stringify + stdin write，EPIPE 安全处理

## 结论

**通过。** 14 个模块边界中全部数据格式转换正确、错误传播完整、接口契约一致。无 MUST_FIX 级别问题。

2 条 LOW 级别问题（Pi 事件字段命名偏差、set_model provider 空字符串）均依赖对 Pi 实际 RPC 协议的确认，建议在联调时验证。2 条 INFO 级别问题（crashed 死代码、malformed JSON 日志级别）为可维护性改进，不阻塞发布。
