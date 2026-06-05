---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-06T01:50:00"
  target: ".xyz-harness/2026-06-05-hapi-pi-agent-backend/spec.md"
  verdict: pass
  summary: "Spec 评审完成，第2轮通过，0条 MUST FIX，4条历史 MUST FIX 已全部修复"

statistics:
  total_issues: 9
  must_fix: 0
  must_fix_resolved: 4
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > AC-4"
    title: "AC-4 不可测试：set_model 无确认事件，'模型切换成功'无法验证"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-2 (agent_end) / AC-6"
    title: "遗漏 Pi 子进程异常退出场景：agent_end 无 AC 覆盖，清理仅单向"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md > FR (全局)"
    title: "遗漏 JSONL 协议错误场景：malformed JSON、partial read、stdin write fail"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "spec.md > Complexity Assessment / FR"
    title: "shared 包变更未明确：未指出 modes.ts 和 flavors.ts 需添加 'pi' flavor"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

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
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

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

# Spec 评审 v2

## 评审记录

- 评审时间：2026-06-06 01:50
- 评审类型：计划评审 — spec 增量审查（第 2 轮）
- 评审对象：`.xyz-harness/2026-06-05-hapi-pi-agent-backend/spec.md`
- 审查模式：增量审查 — 验证 v1 的 4 条 MUST_FIX 修复情况，检查回归

## MUST_FIX 修复验证

### [FIXED] #1 — AC-4 不可测试

**v1 问题**：Pi RPC 的 `set_model` 无确认事件，AC-4 "模型切换成功"无法验证。

**v2 修复确认**：
- AC-4 现在明确写："收到 `{ type: "response", command: "set_model", success: true }` 响应即视为成功"
- FR-2 命令映射表补充了 set_model 的响应格式：`{ type: "response", command: "set_model", success: true, data: Model }`
- 成功判据清晰：发送 set_model → 等待 response → 检查 `success: true`。可测试 ✅
- 失败场景由 FR-5 通用错误处理覆盖（`success: false` → 转换为 HAPI error event）

### [FIXED] #2 — Pi 子进程异常退出无 AC 覆盖

**v1 问题**：`agent_end` 无 AC 覆盖，清理仅覆盖 HAPI→Pi 方向，未覆盖 Pi→HAPI。

**v2 修复确认**：
- 新增 AC-7："Pi 子进程异常退出（非零 exit code 或 signal）→ HAPI 检测到退出，展示错误信息，清理 session 资源，触发 session end"
- 覆盖了 Pi crash 的完整处理链：检测 → 用户通知 → 资源清理 → session 结束
- AC-8 的 stdin 写入失败也引用 AC-7 的处理流程，形成闭环

### [FIXED] #3 — JSONL 协议错误场景遗漏

**v1 问题**：完全缺失 malformed JSON、partial read、stdin write fail 的处理。

**v2 修复确认**：
- 新增 AC-8：覆盖 malformed JSON（warning + 丢弃 + 不中断）和 stdin 写入失败（按 AC-7 处理）
- 新增 FR-5：完整的协议错误处理表，4 种错误类型各有明确处理策略：
  - Malformed JSON → warning 日志，丢弃，继续
  - JSONL 行缓冲不完整 → 缓冲至换行符（标准 JSONL）
  - stdin 写入失败 (EPIPE) → 视为 Pi 退出，走 AC-7 清理
  - `success: false` 响应 → 转换为 HAPI error event
- 错误场景覆盖完整，处理策略合理

### [FIXED] #4 — shared 包变更未明确

**v1 问题**：shared 包变更描述过于笼统，未指明具体文件和修改内容。

**v2 修复确认**：
- Complexity Assessment 现在明确列出：
  - `shared/src/modes.ts`：`AGENT_FLAVORS` 添加 `'pi'`、新增 `PI_PERMISSION_MODES = ['default', 'yolo']`、`getPermissionModesForFlavor()` 添加 pi 分支（~5 行）
  - `shared/src/flavors.ts`：`FLAVOR_CAPS` 添加 `'pi': new Set([Capabilities.ModelChange])`、`FLAVOR_LABELS` 添加 `'pi': 'Pi'`（~2 行）
  - `cli/src/commands/registry.ts`：import 并注册 `piCommand`（~2 行）
- 文件、修改项、行数估算均明确

## 回归检查

逐一检查修复是否引入新问题：

| 检查点 | 结果 | 说明 |
|--------|------|------|
| AC-4 与 FR-2 一致性 | ✅ | AC-4 的响应格式与 FR-2 命令映射表一致 |
| AC-7 可测试性 | ✅ | 给定/当/则结构完整，可验证：exit 检测、错误信息展示、session 清理 |
| AC-8 可测试性 | ✅ | 两个 When-Then 分支各自可验证 |
| FR-5 与 AC-7/AC-8 一致性 | ✅ | EPIPE 引用 AC-7 流程，malformed JSON 引用 AC-8 行为，无矛盾 |
| FR-5 错误类型完整性 | ✅ | 4 种 JSONL 层错误 + 1 种 RPC 层错误（`success: false`），覆盖传输层和应用层 |
| shared 包变更与 FR-3 一致性 | ✅ | `PI_PERMISSION_MODES = ['default', 'yolo']` 与 FR-3 "yolo 模式" 一致 |
| FLAVOR_CAPS 设置 | ✅ | `Capabilities.ModelChange` 与 AC-4 模型切换功能一致 |
| 总体 spec 结构 | ✅ | FR 1-5、AC 1-8、Constraints、Decisions、Out-of-Scope 完整无遗漏 |

未发现回归问题。

## LOW 项状态更新

| # | 状态 | 说明 |
|---|------|------|
| #5 text_delta/thinking_delta 区分 | 部分改善 | FR-2 事件映射表增加了 `assistantMessageEvent.type` 列头，区分字段已隐含在表中，但未显式说明"通过 `assistantMessageEvent.type` 字段值区分"。影响不大，实现时可从 Pi 类型定义推断 |
| #6 turn_end 映射细节 | 已解决 | 明确标注"先 emit usage，再 emit turn_complete（两次独立 emit）" |
| #7 协议版本未固定 | 未变 | 仍为源码路径引用，无 commit hash。风险可控（Pi RPC 协议尚在活跃迭代，固定 commit 反而可能导致对接失败） |
| #8 get_state 无 AC | 部分改善 | 补充了使用场景说明（"session 建立后首次调用，获取当前 model 和 streaming 状态"），但仍无独立 AC。由于 get_state 是初始化辅助，非核心功能，影响不大 |

## 结论

**通过。**

第 1 轮的 4 条 MUST_FIX 已全部修复，修复质量高：
- AC-4 补充了明确的响应验证条件，解决了可测试性问题
- AC-7 补充了 Pi crash 的完整处理链
- AC-8 + FR-5 系统性地覆盖了 JSONL 传输层和应用层错误
- shared 包变更精确到文件、函数和行数

未发现回归或新引入的 MUST_FIX 问题。剩余 LOW 项均不影响 spec 的可执行性。

## Summary

Spec 评审完成，第2轮通过，4条 MUST FIX 已全部修复，0条新增 MUST FIX。