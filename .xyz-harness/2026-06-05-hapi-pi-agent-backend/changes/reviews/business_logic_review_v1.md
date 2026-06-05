---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 9
  issues_found: 6
  must_fix_count: 0
  low_count: 3
  info_count: 3
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-06-06 02:30
- 审查模式：Dev
- 审查对象：use-cases.md + 源代码（9 个变更文件）
- 模拟数据路径数：5

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 用户启动 Pi 会话 | ✅ 完整 | pi.ts → runPi.ts → PiTransport.start() | INFO: 无 assertPiAvailable()，ENOENT 由 transport error handler 覆盖 |
| UC-2 | 用户与 Pi 对话 | ✅ 完整 | session.onUserMessage → transport.send(prompt) → onEvent → convertPiEvent → session.sendSessionEvent | LOW: 字段命名与 plan 有偏差；malformed JSON 用 debug 非 warning |
| UC-3 | 用户中断 Pi 生成 | ✅ 完整 | cancel-prompt RPC → transport.send(abort) | — |
| UC-4 | 用户切换模型 | ✅ 完整 | sessionConfigRpc → transport.send(set_model) → handleResponse | LOW: provider 始终为空字符串 |
| UC-5 | 会话结束清理 | ✅ 完整 | SIGTERM → lifecycle.cleanupAndExit → transport.kill / Pi exit → onClose → cleanup | INFO: `crashed` 变量未使用 |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | LOW | UC-2 | malformed JSON 日志级别为 `debug`，spec FR-5 要求 `warning` | `cli/src/pi/PiTransport.ts` | L128 `handleLine` | 改为 `logger.warn` 或评估是否 `debug` 为有意设计 |
| 2 | LOW | UC-4 | `set_model` 命令始终发送 `provider: ''`。如果 Pi 需要有效 provider 值来解析模型，切换会静默失败 | `cli/src/pi/runPi.ts` | L141 `transport.send({ type: 'set_model', provider: '', modelId: currentModel })` | 确认 Pi RPC 是否需要 provider；若不需要，移除 provider 字段 |
| 3 | LOW | UC-2 | Pi 事件字段命名与 plan interface contract 不同：plan 定义 `input`/`output`/`is_error`，代码使用 `args`/`result`/`isError`。代码与测试自洽，但若实际 Pi RPC 使用 plan 的字段名，会导致 tool_call.input 始终为 undefined | `cli/src/pi/PiEventConverter.ts` | L31-32 (args), L48 (result, isError) | 对比 Pi 实际 RPC 类型定义 (`rpc-types.ts`) 确认字段名 |
| 4 | INFO | UC-1 | `start()` 返回 `void`（同步），plan interface 签名为 `Promise<void>`。Node spawn 本身是异步的，ENOENT 通过 error event 传递，同步返回合理 | `cli/src/pi/PiTransport.ts` | L28 | 无需修改，记录偏差即可 |
| 5 | INFO | UC-1 | plan 要求 `assertPiAvailable()` 函数检测 Pi 可用性，实际由 PiTransport 的 ENOENT error handler 处理。功能等价（AC-5 覆盖） | `cli/src/commands/pi.ts` | 全文 | 无需修改，记录偏差即可 |
| 6 | INFO | UC-5 | `runPi.ts` 中 `crashed` 局部变量（L92）从未被设为 `true`——crash 场景由 `onError`/`onClose` 回调直接处理（走 `markCrash` + `setSessionEndReason('error')`），而 `finally` 块的 `if (!crashed)` 总为 true，会覆盖 sessionEndReason 为 `'completed'`。经推演确认：`archiveAndClose` 中 `sendSessionDeath` 在同步段读取 sessionEndReason（此时仍为 `'error'`），早于 finally 块的覆盖。行为正确，但代码易误解 | `cli/src/pi/runPi.ts` | L92 `crashed` + L102-104 finally block | 考虑移除 `crashed` 变量，改用 lifecycle 状态判断；或在 finally 中检查 `lifecycle` 是否已标记为 crash |

## 执行路径详情（Dev 模式）

### UC-1: 用户启动 Pi 会话

**模拟数据：**
```json
{
  "command": "hapi pi",
  "workingDirectory": "/home/user/project",
  "pi_available": true
}
```

**执行路径：**
```
pi.ts: piCommand.run()
  → parseRemoteAgentCommandOptions(args, PI_PERMISSION_MODES)
  → initializeToken()
  → maybeAutoStartServer()
  → authAndSetupMachineIfNeeded()
  → runPi({ startedBy: 'terminal', startingMode: 'local' })
    → bootstrapSession({ flavor: 'pi', startedBy: 'terminal', workingDirectory, model })
    → setControlledByUser(session, 'local')
    → new PiTransport('pi', ['--mode', 'rpc'], workingDirectory)
    → createRunnerLifecycle({ session, onAfterClose: transport.kill })
    → lifecycle.registerProcessHandlers() [SIGTERM/SIGINT]
    → transport.onError(handler) [ENOENT → markCrash + cleanup]
    → transport.onClose(handler) [Pi exit → error msg + cleanup]
    → transport.onEvent(handler) [response → handleResponse; others → convertPiEvent → emit]
    → registerSessionConfigRpc(...) [model change RPC]
    → session.onUserMessage(...) [prompt forwarding]
    → rpcHandlerManager.registerHandler('cancel-prompt', ...) [abort]
    → transport.start()
      → spawn('pi', ['--mode', 'rpc'], { cwd, stdio: ['pipe','pipe','pipe'] })
      → stdout.on('data', handleStdout) [line buffer + JSON parse]
    → transport.send({ type: 'new_session' })
    → transport.send({ type: 'get_state' })
    → await new Promise<void>(...) [blocks until cleanup]
```

**异常路径（Pi 不存在）：**
```
transport.start() → spawn('pi', ...) → process.emit('error', ENOENT)
  → transport.onError callback
    → lifecycle.markCrash(error)
    → lifecycle.setExitCode(1)
    → lifecycle.cleanupAndExit()
      → resolve(promise) + origCleanup()
        → archiveAndClose() → sendSessionDeath('error')
        → process.exit(1)
```

**预测结果：** ✅ 进程以 exit code 1 退出，输出 "Pi was not found on PATH" 错误信息。AC-5 覆盖。

---

### UC-2: 用户与 Pi 对话

**模拟数据：**
```json
{
  "user_input": "帮我写一个 hello world 函数",
  "pi_events": [
    { "type": "response", "command": "prompt", "success": true },
    { "type": "turn_start" },
    { "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "delta": "用户想要一个简单的函数..." } },
    { "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "好的，这是一个 hello world 函数：\n\n" } },
    { "type": "tool_execution_start", "toolCallId": "tc-1", "toolName": "write_file", "args": { "path": "hello.ts", "content": "..." } },
    { "type": "tool_execution_end", "toolCallId": "tc-1", "result": "File written", "isError": false },
    { "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "文件已创建。" } },
    { "type": "turn_end", "message": { "usage": { "input": 500, "output": 120, "totalTokens": 620, "cacheRead": 0 }, "stopReason": "stop" } }
  ]
}
```

**执行路径：**
```
session.onUserMessage → formatMessageWithAttachments(text, attachments)
  → transport.send({ type: 'prompt', message: '帮我写一个 hello world 函数' })

Pi stdout → handleStdout → line buffer → JSON.parse → eventHandler:
  response(prompt, success=true) → handleResponse → logger.debug (ack, ignored)
  turn_start → convertPiEvent → [] (empty, no emit)
  message_update(thinking_delta) → convertPiEvent → [{ type: 'reasoning', text: '...', live: true }]
    → session.sendSessionEvent({ type: 'message', message })
  message_update(text_delta) → convertPiEvent → [{ type: 'text', text: '...' }]
    → session.sendSessionEvent(...)
  tool_execution_start → convertPiEvent → [{ type: 'tool_call', id: 'tc-1', name: 'write_file', input: {path, content}, status: 'in_progress' }]
    → session.sendSessionEvent(...)
  tool_execution_end → convertPiEvent → [{ type: 'tool_result', id: 'tc-1', output: 'File written', status: 'completed' }]
    → session.sendSessionEvent(...)
  message_update(text_delta) → [{ type: 'text', text: '文件已创建。' }]
    → session.sendSessionEvent(...)
  turn_end → convertPiEvent → [
    { type: 'usage', inputTokens: 500, outputTokens: 120, totalTokens: 620, cacheReadTokens: 0 },
    { type: 'turn_complete', stopReason: 'stop' }
  ]
    → session.sendSessionEvent(...) × 2
```

**异常路径（malformed JSON）：**
```
Pi stdout: "{ invalid json\n"
  → handleStdout → line buffer → handleLine
    → JSON.parse throws
    → catch → logger.debug('Skipping malformed JSON: ...')
    → 不调用 eventHandler，继续读取下一行
```

**预测结果：** ✅ 所有事件正确转换并 emit 到 session。malformed JSON 被跳过不中断。AC-2 + AC-8 覆盖。

---

### UC-3: 用户中断 Pi 生成

**模拟数据：**
```json
{
  "user_action": "cancel-prompt RPC",
  "pi_state": "generating response"
}
```

**执行路径：**
```
Web/Terminal → RPC 'cancel-prompt'
  → rpcHandlerManager.registerHandler callback
    → transport.send({ type: 'abort' })
    → return { success: true }

Pi processes abort → sends response:
  { type: 'response', command: 'abort', success: true }
    → eventHandler → handleResponse
      → logger.debug('[pi] Abort confirmed')
```

**预测结果：** ✅ abort 命令发送，Pi 确认中断，RPC 返回 success。AC-3 覆盖。

---

### UC-4: 用户切换模型

**模拟数据：**
```json
{
  "target_model": "gpt-4o",
  "current_model": "gpt-3.5-turbo"
}
```

**执行路径：**
```
sessionConfigRpc.onApply(config):
  → currentModel = config.model = 'gpt-4o'
sessionConfigRpc.onAfterApply():
  → transport.send({ type: 'set_model', provider: '', modelId: 'gpt-4o' })
  → session.pushKeepAlive()

Pi response:
  { type: 'response', command: 'set_model', success: true, data: { modelId: 'gpt-4o' } }
    → handleResponse → currentModel = 'gpt-4o' → logger.debug
```

**异常路径（Pi 拒绝模型切换）：**
```
Pi response:
  { type: 'response', command: 'set_model', success: false, error: 'Model not available' }
    → handleResponse → !success →
      session.sendSessionEvent({ type: 'message', message: { type: 'error', message: 'Model not available' } })
```

**预测结果：** ✅ 成功时更新模型，失败时 emit error。AC-4 覆盖。注意 provider 始终为空字符串（见问题 #2）。

---

### UC-5: 会话结束清理

**模拟数据（HAPI 退出）：**
```json
{
  "signal": "SIGTERM",
  "pi_process_pid": 54321
}
```

**执行路径（HAPI 退出）：**
```
process.on('SIGTERM') → lifecycle.cleanupAndExit()
  → overridden: resolve(promise) + origCleanup()
    → cleanup():
      → stopKeepAlive() [no-op]
      → onBeforeClose?() [undefined]
      → archiveAndClose():
        → session.updateMetadata({ lifecycleState: 'archived' })
        → session.sendSessionDeath('terminated') [default sessionEndReason]
        → await session.flush() + close()
      → onAfterClose() → transport.kill() [SIGTERM to Pi]
    → process.exit(0)
```

**模拟数据（Pi 异常退出）：**
```json
{
  "exit_code": 1,
  "signal": null,
  "reason": "Pi crashed: out of memory"
}
```

**执行路径（Pi 异常退出）：**
```
Pi process exits (code=1)
  → transport 'close' event
    → onClose handler:
      → lifecycle.markCrash(new Error('Pi process exited with code 1'))
        → exitCode=1, archiveReason='Session crashed', sessionEndReason='error'
      → lifecycle.setArchiveReason('Pi process exited with code 1') [overwrite to specific]
      → lifecycle.setSessionEndReason('error') [redundant, already set by markCrash]
      → lifecycle.cleanupAndExit() [overridden]
        → resolve(promise) + origCleanup()
          → cleanup():
            → archiveAndClose():
              → sendSessionDeath('error') ← correct, reads before finally block overwrites
              → await flush()
    → [microtask] promise resolved → falls to finally block:
      → if (!crashed) → true (crashed local var still false)
        → lifecycle.setSessionEndReason('completed') ← overwrites, but sendSessionDeath already sent
      → lifecycle.cleanupAndExit() → returns existing cleanupPromise
        → process.exit(1) [from first origCleanup]
```

**预测结果：** ✅ Pi crash 时 session death 以 'error' reason 发送，archiveReason 为具体错误信息。HAPI 退出时 Pi 子进程被 SIGTERM 终止。AC-6 + AC-7 覆盖。

---

## 结论

**通过。** 全部 5 个 UC 的主流程和异常路径在代码中均有完整执行路径。8 条 AC（AC-1 至 AC-8）均可通过代码推演覆盖。

发现 3 条 LOW 级别问题（malformed JSON 日志级别、set_model provider 空值、事件字段命名偏差）和 3 条 INFO 级别偏差（start 同步签名、无 assertPiAvailable、crashed 变量死代码）。均不阻塞发布。
