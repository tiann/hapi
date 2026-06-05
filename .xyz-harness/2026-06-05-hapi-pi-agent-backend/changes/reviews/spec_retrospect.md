---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — hapi-pi-agent-backend

## Phase Execution Quality

### 做得好的

1. **前置调研复用充分。** 进入 coding workflow 前，对话中已完成 issue 调研（tiann/hapi #335/#620/#770/#375）、pi RPC 协议分析、ACP 兼容性评估。workflow 启动后直接进入 assumption audit 和 spec 编写，零重复工作。

2. **Assumption audit 实际跑通了代码验证。** 逐个 grep 确认了 `AgentBackend`、`AgentMessage`、`AGENT_FLAVORS`、`AgentRegistry` 的实际签名和行为。关键发现：`runAgentSession` 虽然存在但未被任何命令使用，Gemini 直接复用 `AcpSdkBackend`。这直接影响了 spec 的 Decision #1（不用通用 runner）。

3. **Review 流程有效拦截了 spec 质量问题。** 第 1 轮 review 发现 4 条 MUST_FIX（AC 不可测试、错误场景遗漏、协议错误未覆盖、变更范围模糊），全部是真实质量问题。修复后第 2 轮 clean pass。

### 需要改进的

1. **Spec 初版质量不够。** 4 条 MUST_FIX 中有 2 条（错误场景遗漏、shared 包变更模糊）本可以在写 spec 时就避免——assumption audit 已经扫描了 `modes.ts` 和 `flavors.ts`，应该在 spec 中直接写出具体变更。错误场景遗漏是典型的"只有 happy path"问题，self-check checklist 应该在第一轮就拦截。

2. **Gate check 一次失败（untracked files）。** 应该在调用 gate 前先检查 `git status --short`，而不是等 gate 报错后再修。

3. **Brainstorming 步骤跳跃。** 由于前置讨论已经覆盖了 Step 2-4（提问、方案探索、设计展示），进入 workflow 后直接跳到了 Step 5（assumption audit）。虽然效率高，但 todo list 中 Step 1 标记完成的方式（"previous conversation covered"）不够精确——应该明确标注哪些步骤是前置完成的。

## Harness Usability

1. **skill 指令与实际流程的适配。** brainstorming skill 假设从零开始和用户对话，但我们的场景是"已经有了调研结论，直接写 spec"。skill 的 checklist 仍然是线性步骤，不适合"部分前置完成"的场景。建议：允许在 init 时声明哪些步骤已完成，跳过对应的 todo。

2. **Review subagent 的质量稳定。** 两轮 review 都给出了结构化、有具体修改建议的输出。第一轮的 4 条 MUST_FIX 全部是有效问题，没有误报。这比自行 self-check 更可靠。

3. **Gate check 的 untracked file 检测。** gate 要求 `.xyz-harness/` 下无 untracked file，但没有自动提示需要 git add。建议：gate 报错时直接提示 "run git add -A && git commit"。
