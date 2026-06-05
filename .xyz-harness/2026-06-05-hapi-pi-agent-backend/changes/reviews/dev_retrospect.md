---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — hapi-pi-agent-backend

## Phase Execution Quality

### 做得好的

1. **MUST_FIX 一次性全修复，零回归。** Robustness review v1 的 3 条 MUST_FIX（double-cleanup、double-start、converter 无安全网）和 Taste review v1 的 4 个 P0（类型定义缺失）有共同根因——缺少 Pi RPC 类型定义。一次性新增 `types.ts` + 重构三个文件，所有问题同时解决，Robustness v2 和 Taste v2 均 pass，无需第三轮。

2. **TDD 流程严格执行。** Task 1 (PiTransport) 和 Task 2 (PiEventConverter) 各自先写 15 个失败测试，确认 import 报错后再写实现。最终 33 个测试全部通过，typecheck 零错误。

3. **Review 发现了真实问题。** Robustness review 的 double-cleanup 竞态是真正会在生产中触发的 bug（Pi crash 时 error + close 事件同时触发）。Taste review 发现的 `Record<string, unknown>` 泛滥会导致运行时字段拼写错误静默失败。这两类问题自审很难发现。

4. **sendAgentMessage vs sendSessionEvent 的 API 理解错误被 typecheck 捕获。** 初始实现用 `sendSessionEvent({ type: 'message', message: AgentMessage })` 但该 API 的 message 字段类型是 `string`。`tsc --noEmit` 立即报错，修正为 `sendAgentMessage(msg)` + `sendSessionEvent({ type: 'message', message: error })`。这证明 typecheck 在 HAPI 项目中是有效的防护层。

### 需要改进的

1. **自审应该拦截 PiTransportOptions 接口不一致。** 定义了 `PiTransportOptions` 接口但构造函数用了三个散参数。Standards review 正确标记为 LOW，但这类"接口定义了但没用"的代码异味应该在编码时就发现。

2. **runPi.ts 的 `crashed` 变量从头到尾都是死代码。** Business logic review 和 Integration review 都标记了这个变量。初始写法是参考 Gemini runner 的 `crashed` 变量，但 Pi runner 的 crash 处理走了不同的路径（onError/onClose 直接调 lifecycle），导致 `crashed` 永远不会被设为 `true`。应该在首次 typecheck 通过后就清理掉。

3. **handleLine 中 malformed JSON 的日志级别用了 `debug` 而非 `warn`。** Plan 和 spec 都写了 "warning"，但实现时习惯性用了 `debug`。Business logic review 正确标记了。虽然功能上不影响（debug 级别在 HAPI 中默认可见），但与 spec 的偏差应该是有意选择而非遗漏。

4. **生命周期 monkey-patch 模式不够清晰。** `runPi.ts` 中 override `lifecycle.cleanupAndExit` 来 resolve Promise + 调用原始实现。这是对 `createRunnerLifecycle` API 的非典型用法，Robustness review 和 Taste review 都标记了。如果有 `onBeforeCleanup` 回调会更清晰，但属于已有架构约束。

## Harness Usability

1. **五步专项审查比单一 code review 有效得多。** Business logic review 捕获了 `crashed` 死代码和 `provider: ''` 语义问题；Standards review 发现了接口不一致；Robustness review 发现了 double-cleanup 竞态和 double-start；Taste review 发现了类型空洞；Integration review 验证了跨模块数据流。单一 review 很难覆盖这么多维度。

2. **Review 轮次机制合理。** Robustness v1 的 3 条 MUST_FIX → 修复 → v2 pass，整个过程不回退到 TDD 起点。但 Taste review 的 P0 问题（类型定义缺失）在代码层面已经和 Robustness 的 MUST_FIX 一起修复了，只是 review 文件本身没有 re-run，导致 gate 检查时失败。教训：**多个 review 并行运行时，如果一个 review 的修复也解决了另一个 review 的问题，需要重新 dispatch 后者或更新其 verdict。**

3. **Gate 检查对 review 文件的 YAML 解析严格。** Taste review v1 的 `must_fix` 字段是一个数组而非数字，gate 无法解析。这个严格检查是好事——它强制要求每个 review 文件都达到 pass 状态才能进入下一阶段。

4. **测试运行环境有摩擦。** 项目 `bun run test` 因为缺少 `tar` 包失败，`npx vitest run` 也找不到 vitest 二进制。最终用 `node ../node_modules/vitest/vitest.mjs run` 绕过。这不是 harness 的问题，是项目本身的依赖安装不完整。但对于 harness 的"运行测试"步骤来说，如果能自动检测并回退到可用命令会更流畅。

5. **33 个测试对 ~500 行实现代码的比例合理。** Transport 16 个测试覆盖了所有公开方法和边界条件（ENOENT、EPIPE、malformed JSON、double-start）。Converter 17 个测试覆盖了所有事件类型的转换和异常降级。Runner 本身无专属测试（计划中标记为 LOW），这是合理的 trade-off——runner 是胶水代码，核心逻辑在 Transport 和 Converter 中。
