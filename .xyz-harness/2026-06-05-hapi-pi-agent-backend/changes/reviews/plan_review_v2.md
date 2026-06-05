---
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-06T02:10:00"
  target: ".xyz-harness/2026-06-05-hapi-pi-agent-backend/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮，0条MUST FIX，通过"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 2
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 2 (PiEventConverter) + Task 3 (Runner)"
    title: "response 事件处理缺失：converter 丢弃所有 response 事件，spec FR-5 错误响应和 FR-2 get_state 响应均未处理"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 3 Step 2"
    title: "parseRemoteAgentCommandOptions 使用与否自相矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "plan.md:Execution Flow"
    title: "Task 1 → Task 2 依赖关系不必要（Execution Flow 仍标注串行，但 Dependency Graph 已修正为并行）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md:Task 3"
    title: "Runner 集成代码无专属单元测试"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan.md:Task 1 Step 1"
    title: "PiTransport 测试场景缺少 EPIPE 明确用例"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: INFO
    location: "plan.md:Execution Groups"
    title: "BG1 单组包含全部 3 个 Task，可接受但缺乏并行度"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-06 02:10
- 评审类型：计划评审（增量审查，第 2 轮）
- 评审对象：`.xyz-harness/2026-06-05-hapi-pi-agent-backend/plan.md`

---

## MUST_FIX 修复验证

### [FIXED] Issue #1: response 事件处理链缺失

**原问题**：PiEventConverter 对所有 `response` 事件返回 `[]`，导致 `get_state` 初始状态丢失、`set_model` 成功/失败确认丢失、`success: false` 错误事件未转换。

**修复验证**：

plan.md Task 3 Step 3 现在明确描述了**双轨事件分发**机制：

```
transport.onEvent() 双轨事件分发：
  - type === 'response' → runner 直接处理
  - 其他类型 → convertPiEvent() 转换为 AgentMessage[] → emit 到 session
```

并附带完整的 "Response 事件处理逻辑（runner 直接消费）" 章节：

| response command | 处理方式 | 对应子问题 |
|-----------------|----------|-----------|
| `get_state` | 提取 data 中 model 信息，更新 HAPI session 元数据 | ✅ (a) 初始状态 |
| `set_model` + `success: true` | 确认模型切换成功 | ✅ (b) 成功确认 |
| `set_model` + `success: false` | emit error AgentMessage | ✅ (c) 错误转换 |
| `new_session` | 记录初始化完成 | ✅ |
| `abort` | 确认中断完成，恢复 ready 状态 | ✅ |
| `prompt` | ack，无需特殊处理 | ✅ |

三个子问题全部解决。架构清晰：converter 保持纯转换职责（不处理 response），runner 负责 RPC 状态管理。职责划分合理，无回归。

**结论：已修复。**

### [FIXED] Issue #2: parseRemoteAgentCommandOptions 矛盾

**原问题**：Task 3 Step 2 同时写"不使用 `parseRemoteAgentCommandOptions`"和"使用 `parseRemoteAgentCommandOptions`"。

**修复验证**：

当前 plan.md Task 3 Step 2 内容：

> Pi 不支持 remote mode，但本地启动仍需解析 `--started-by`、`--permission-mode`、`--yolo`、`--model` 参数，因此使用 `parseRemoteAgentCommandOptions`

矛盾已消除。语义一致：不支持 remote mode ≠ 不使用参数解析函数。subagent 可以明确执行。

**结论：已修复。**

## 回归检查

逐项检查修复是否引入新问题：

| 检查项 | 结果 |
|--------|------|
| 双轨分发是否与 PiEventConverter 的 `response → []` 冲突 | ❌ 不冲突。converter 返回空数组是正确的，response 在 runner 层被拦截，不会到达 converter |
| 双轨分发是否改变了非 response 事件的处理路径 | ❌ 未改变。非 response 事件仍走 convertPiEvent() |
| parseRemoteAgentCommandOptions 使用是否引入不必要的 remote 逻辑 | ❌ 参考 gemini.ts 的模式，该函数解析本地参数，不触发远程连接 |
| Task 2 测试场景是否仍与实现一致 | ✅ 一致。converter 对 response 返回 `[]` 的测试用例（原 plan 就有）仍然正确 |
| Wave Schedule 与 Execution Flow 一致性 | ⚠️ Dependency Graph 已修正为 Task 1 + Task 2 并行（Wave 1），但 Execution Flow 仍写 "Task 2 (PiEventConverter, depends on Task 1)"。不影响正确性，属于 v1 issue #3 的残留（LOW），不算回归 |

**无回归。**

## 附带修复验证

Issue #5（EPIPE 测试用例缺失）在本次修复中顺带解决：

Task 1 Step 1 测试场景现在包含：
> `send()` 在 stdin 写入失败（EPIPE）时触发 close 事件（AC-8）

与 Interface Contract 中 send() 的 EPIPE 行为描述一致。

---

### 问题状态总表

| # | 优先级 | 状态 | 描述 |
|---|--------|------|------|
| 1 | MUST_FIX | ✅ 已修复 | response 事件处理链 — 双轨分发 + runner 直接消费 |
| 2 | MUST_FIX | ✅ 已修复 | parseRemoteAgentCommandOptions 矛盾消除 |
| 3 | LOW | open | Execution Flow 仍标注 Task 2 depends on Task 1（与 Wave Schedule 矛盾） |
| 4 | LOW | open | Runner 无专属单元测试 |
| 5 | LOW | ✅ 已修复 | EPIPE 测试用例已添加 |
| 6 | INFO | open | BG1 单组，缺乏并行度 |

### 结论

**通过。** 2 条 MUST_FIX 均已修复，无回归。剩余 3 条 LOW / 1 条 INFO 不阻塞流程。

### Summary

计划评审完成，第2轮通过，0条MUST FIX。
