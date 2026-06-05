---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-06T01:44:00"
  target: ".xyz-harness/2026-06-05-hapi-pi-agent-backend/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，4条 MUST FIX：AC 不可测试、错误场景遗漏、shared 包变更未明确"

statistics:
  total_issues: 9
  must_fix: 4
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > AC-4"
    title: "AC-4 不可测试：set_model 无确认事件，'模型切换成功'无法验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-2 (agent_end) / AC-6"
    title: "遗漏 Pi 子进程异常退出场景：agent_end 无 AC 覆盖，清理仅单向"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md > FR (全局)"
    title: "遗漏 JSONL 协议错误场景：malformed JSON、partial read、stdin write fail"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "spec.md > Complexity Assessment / FR"
    title: "shared 包变更未明确：未指出 modes.ts 和 flavors.ts 需添加 'pi' flavor"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md > FR-2 (message_update)"
    title: "text_delta/thinking_delta 区分机制未说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md > FR-2 (turn_end)"
    title: "turn_end 映射为 turn_complete + usage 两条消息的细节未明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md > Constraints"
    title: "Pi RPC 协议版本未固定，仅源码路径引用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "spec.md > FR-2 (get_state)"
    title: "get_state 命令无对应 AC，返回值结构和用途未说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "spec.md > Decisions Made"
    title: "4 条决策均合理，与项目架构一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录

- 评审时间：2026-06-06 01:44
- 评审类型：计划评审 — spec 完整性专项
- 评审对象：`.xyz-harness/2026-06-05-hapi-pi-agent-backend/spec.md`
- 对比基线：SKILL 方法论「模式一：计划评审」第 1 项「spec 完整性」

## 逐项检查

### 1. spec 完整性

| 检查维度 | 结果 | 说明 |
|---------|------|------|
| 目标是否明确 | ✅ | 一段话：将 Pi agent 接入 HAPI CLI 本地模式，`hapi pi` 启动 |
| 范围是否合理 | ✅ | CLI local mode only，hub/web 后续 PR，边界清晰 |
| 六元素覆盖 | ⚠️ | Background/FR/AC/Constraints/Decisions/Out-of-Scope 均有，但 FR 和 AC 质量见下方问题 |
| AC 可测试性 | ❌ | AC-4 不可测试（#1），`get_state` 无 AC（#8） |
| `[待决议]` 项 | ✅ | 无 |
| 错误场景覆盖 | ❌ | 缺 Pi crash、JSONL 协议错误、反方向清理（#2, #3） |
| 架构一致性 | ⚠️ | 整体一致，但 shared 包变更描述不完整（#4） |

### 2. 六元素核查

| 元素 | 存在 | 质量 |
|------|------|------|
| Background | ✅ 清晰 | 充分说明了 HAPI 架构和 Pi 定位 |
| Functional Requirements | ✅ 4 项 FR | 命令映射和事件映射表清晰，但缺少错误处理 FR |
| Acceptance Criteria | ⚠️ 6 项 AC | AC-1/2/3/5/6 可测试，AC-4 不可测试 |
| Constraints | ✅ | 零依赖、scope 限制、协议版本等约束合理 |
| Decisions Made | ✅ 4 条 | 均有理由，与代码结构对齐 |
| Out of Scope | ✅ | hub/web/permission 等排除项明确 |

### 3. FR 与 AC 可测试性逐条分析

| AC | 可测试？ | 问题 |
|----|---------|------|
| AC-1 基本启动 | ✅ | 可验证 spawn + JSONL 通信 + session 创建 |
| AC-2 消息收发 | ✅ | 输入→prompt→事件转换→展示，链路完整 |
| AC-3 中断生成 | ✅ | abort 命令发送后 Pi 停止，可观察 |
| AC-4 模型切换 | ❌ | Pi RPC 的 `set_model` 无确认事件，"模型切换成功"无法判定 |
| AC-5 Pi 不可用 | ✅ | 错误信息 + 非零退出码，清晰 |
| AC-6 进程清理 | ⚠️ | 仅覆盖 HAPI 退出→Pi 清理，未覆盖 Pi 退出→HAPI 清理 |

### 4. 错误场景覆盖率

| 错误场景 | 覆盖？ | 对应 AC/FR |
|---------|--------|-----------|
| Pi 不在 PATH | ✅ | AC-5 |
| HAPI 退出→清理 Pi | ✅ | AC-6 |
| Pi 进程 crash（非零退出） | ❌ | FR-2 提及 agent_end 但无 AC |
| Pi 返回 malformed JSON | ❌ | 无 |
| JSONL 行被截断（partial read） | ❌ | 无 |
| stdin 写入失败（pipe broken） | ❌ | 无 |
| Pi 启动后立即退出 | ❌ | 无 |
| Pi 在 prompt 处理中 crash | ❌ | 无 |

### 5. 架构一致性核查

| 检查点 | 结果 | 说明 |
|--------|------|------|
| `cli/src/pi/` 目录结构 | ✅ | 与 `cli/src/gemini/` 对齐，一致 |
| 命令注册方式 | ✅ | 与 `cli/src/commands/gemini.ts` 模式一致 |
| TypeScript strict | ✅ | Constraints 明确声明 |
| Vitest 测试 | ✅ | Constraints 明确声明 |
| 4 空格缩进 | ✅ | Constraints 明确声明 |
| shared 包变更 | ❌ | 未明确指出需修改的文件和具体变更 |

**shared 包实际需变更的文件（代码分析结果）：**

1. `shared/src/modes.ts`：`AGENT_FLAVORS` 数组添加 `'pi'`、新增 `PI_PERMISSION_MODES`（`['default', 'yolo']`）、`getPermissionModesForFlavor()` 添加 pi 分支
2. `shared/src/flavors.ts`：`FLAVOR_CAPS` 添加 `'pi': new Set([Capabilities.ModelChange])`、`FLAVOR_LABELS` 添加 `'pi': 'Pi'`
3. `shared/src/schemas.ts`：可能需要 Pi RPC 消息的 Zod schema（项目约定：Zod for runtime validation）

spec 仅说"修改 shared 类型定义（~15 行）"，未指出具体文件和内容，预估行数也可能偏低。

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md > AC-4 | Pi RPC 的 `set_model` 无确认/响应事件，AC-4 "模型切换成功"无法验证。当前事件映射表中 set_model 无对应响应事件，HAPI 无法判定切换是否生效 | 方案 A：明确 AC-4 为"发送 set_model 命令后，无错误即视为成功"（fire-and-forget）；方案 B：补充 Pi RPC 的 set_model 响应事件（如果 Pi 实际支持）|
| 2 | MUST FIX | spec.md > FR-2 (agent_end) / AC-6 | `agent_end` 映射为"断开连接，清理资源"但无 AC 覆盖。AC-6 仅覆盖 HAPI 退出触发清理（HAPI→Pi），未覆盖 Pi 主动退出/crash 时的反向清理（Pi→HAPI）。生产环境 Pi crash 是必然场景 | 新增 AC 或扩展 AC-6：覆盖 Pi 子进程异常退出（非零 exit code / signal）时 HAPI 的清理行为和用户通知 |
| 3 | MUST FIX | spec.md > FR | 完全缺失 JSONL 协议层的错误处理：malformed JSON、行截断、stdin write fail。这些不是边缘场景——子进程 stdout 在高负载下完全可能产生 partial read | 新增 FR-5（协议错误处理）或扩展 FR-2，覆盖：malformed JSON 解析、JSONL 行缓冲不完整时的处理、stdin write 失败时的降级策略 |
| 4 | MUST_FIX | spec.md > Complexity Assessment | shared 包变更描述过于笼统。实际需修改 `shared/src/modes.ts`（添加 `'pi'` 到 `AGENT_FLAVORS`、新增 `PI_PERMISSION_MODES`、修改 `getPermissionModesForFlavor`）和 `shared/src/flavors.ts`（添加 `'pi'` 到 `FLAVOR_CAPS` 和 `FLAVOR_LABELS`）。"~15 行"可能低估 | 明确列出 shared 包的变更文件和具体修改项。同步更新 Complexity Assessment 的工作量估算 |
| 5 | LOW | spec.md > FR-2 (message_update) | `message_update` 同时映射 `text_delta` 和 `thinking_delta`，但未说明区分机制。Pi 事件的哪个字段用于区分两种类型？ | 补充 Pi 的 `message_update` 事件结构，说明 `text_delta` vs `thinking_delta` 的判定字段（如 `content_type` 或 `role` 字段）|
| 6 | LOW | spec.md > FR-2 (turn_end) | `turn_end` 映射为 `turn_complete` + `usage` 两条 AgentMessage，但未明确是两次独立 emit 还是一条合并消息。这影响 message pipeline 的消费端逻辑 | 明确说明：`turn_end` 触发时，先 emit `turn_complete` AgentMessage，再 emit `usage` AgentMessage（或合并为一条）|
| 7 | LOW | spec.md > Constraints | 协议版本约束仅给出源码路径 `pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts`，未固定 commit hash 或版本号。Pi RPC 协议变更可能导致 HAPI 集成静默失败 | 在 Constraints 中固定 Pi RPC 协议的 commit hash 或版本标签 |
| 8 | LOW | spec.md > FR-2 (get_state) | `get_state` 命令出现在 FR-2 的命令映射表中，但无对应 AC，也未说明其返回值结构和使用场景（初始化？状态同步？）| 补充 `get_state` 的使用时机说明（如：session 建立后首次调用以获取当前 model 信息），如果用于 AC-4 的模型确认，则与 #1 联动 |
| 9 | INFO | spec.md > Decisions Made | 4 条决策均合理，与代码库实际结构一致：(1) 不用 AgentRegistry — 已验证仅测试引用；(2) 不复用 AcpStdioTransport — JSON-RPC 2.0 与 Pi JSONL 确实不兼容；(3) 独立 runner — Gemini 模式验证可行；(4) 不引入额外抽象层 — ~500 行规模合理 | 无需操作 |

## 结论

**需修改后重审。**

spec 的整体方向正确（目录结构、命令模式、RPC 协议映射均与现有架构一致），但在以下方面存在 4 条 MUST FIX：

1. **AC 可测试性**：AC-4 的成功判据缺失
2. **错误场景覆盖**：Pi crash、JSONL 协议错误完全遗漏
3. **变更范围精度**：shared 包变更未指明具体文件和内容

建议修复后重新提交评审。

## Summary

Spec 评审完成，第1轮，4条 MUST FIX（AC-4 不可测试、Pi 异常退出无覆盖、JSONL 协议错误遗漏、shared 包变更不明确），需修改后重审。
