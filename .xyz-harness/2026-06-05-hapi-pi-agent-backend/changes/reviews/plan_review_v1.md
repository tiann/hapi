---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-06T02:01:30"
  target: ".xyz-harness/2026-06-05-hapi-pi-agent-backend/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 6
  must_fix: 2
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 2 (PiEventConverter) + Task 3 (Runner)"
    title: "response 事件处理缺失：converter 丢弃所有 response 事件，spec FR-5 错误响应和 FR-2 get_state 响应均未处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 3 Step 2"
    title: "parseRemoteAgentCommandOptions 使用与否自相矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md:Dependency Graph"
    title: "Task 1 → Task 2 依赖关系不必要"
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
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "plan.md:Execution Groups"
    title: "BG1 单组包含全部 3 个 Task，可接受但缺乏并行度"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-06 02:01
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-05-hapi-pi-agent-backend/plan.md`

---

## 1. spec 完整性

**结论：通过。**

- **目标明确**：将 Pi coding agent 作为新后端接入 HAPI CLI，通过 `hapi pi` 使用。一段话能说清。
- **范围合理**：明确限定为 CLI 本地模式，Out of Scope 列出了 Hub/Web 远程控制等后续工作。
- **AC 可量化**：8 条 AC 均可通过测试验证（启动/消息收发/中断/模型切换/命令检测/进程清理/异常退出/协议错误）。
- **无 `[待决议]` 项**。
- **Constraints 清晰**：零新增依赖、TypeScript strict、Vitest 测试框架。
- **Complexity Assessment 合理**：~500 行新建 + ~9 行修改，中等复杂度定位准确。

## 2. plan 可行性

**结论：基本可行，2 条 MUST FIX。**

**任务拆分**：3 个 Task 粒度合理。Task 1（Transport，2 文件）、Task 2（Converter，2 文件）、Task 3（Runner+注册，5 文件）。Task 3 文件数达到 subagent 上限（5 文件），但功能关联紧密（shared 类型注册 → 命令定义 → runner），拆分反而增加协调成本，可接受。

**依赖关系**：Task 1 → Task 2 → Task 3 串行。Task 2 对 Task 1 的代码依赖实际不存在（PiEventConverter 是纯函数，不 import PiTransport），串行不影响正确性但浪费时间（见 issue #3）。

**工作量估算**：~500 行新建 + ~9 行修改，现实。

**参考文件**：每个 Task 都列出了具体参考文件和行号范围，充分。

**测试覆盖**：Task 1/2 遵循 TDD（先写测试再写实现），Task 3 依赖 typecheck + 已有测试通过，runner 本身无专属单元测试（见 issue #4）。

## 3. spec 与 plan 一致性

**结论：存在 1 条关键不一致（issue #1）。**

逐条对照：

| Spec 需求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| FR-1: Pi CLI 命令 | Task 3 (`commands/pi.ts` + `runPi.ts`) | ✅ |
| FR-2: Pi RPC 协议（命令映射） | Task 1 (send) + Task 3 (runner 调用) | ⚠️ `get_state` 响应处理缺失 |
| FR-2: Pi RPC 协议（事件映射） | Task 2 (PiEventConverter) | ✅ |
| FR-3: 权限模型 | Task 3 (PI_PERMISSION_MODES) | ✅ |
| FR-4: Pi 命令检测 | Task 3 (assertPiAvailable) | ✅ |
| FR-5: 协议错误处理（malformed JSON） | Task 1 (onEvent warn+skip) | ✅ |
| FR-5: 协议错误处理（EPIPE） | Task 1 (send 捕获 EPIPE) | ✅ |
| FR-5: 协议错误处理（`success: false`） | **未覆盖** | ❌ issue #1 |
| AC-1 ~ AC-8 | Spec Coverage Matrix 全部映射 | ✅ |

**Plan 未提及的额外工作**：无。

## 4. Execution Groups 合理性

**结论：通过。**

| 检查项 | 结果 |
|--------|------|
| 分组文件数 ≤ 10 | ✅ 9 个文件 |
| Task 数 ≤ 4 | ✅ 3 个 Task |
| 类型划分 | ✅ 全部后端，无混合 |
| 功能关联度 | ✅ 同一功能模块，紧密关联 |
| Group 间依赖 | ✅ 单 Group，无跨 Group 依赖 |
| Wave 编排 | ✅ 单 Wave 单 Group，无冲突 |
| Subagent 配置完整性 | ✅ Agent/Model/上下文/读取文件/创建文件 均已列出 |
| 上下文充分性 | ✅ 每个 Task 注入 spec FR/AC + 参考文件路径，足够独立完成 |
| 文件数预估 | ✅ 6 create + 3 modify = 9，与 File Structure 表一致 |

## 5. 接口契约审查

**结论：发现 1 条关键问题（issue #1 的根因）。**

PiRpcCommand 类型定义正确，覆盖所有 RPC 命令。PiAgentEvent discriminated union 定义完整。

**关键问题**：PiEventConverter.convert() 对 `response` 类型事件返回 `[]`，这意味着：

1. **`get_state` 响应被丢弃**：spec FR-2 明确要求 `get_state` 的响应 `RpcSessionState` 用于"初始化 HAPI session 元数据"。但 converter 返回空数组，runner 代码也只说"使用 convertPiEvent 转换事件"，没有单独处理 response 的逻辑。初始 model 信息丢失。

2. **`set_model` 成功确认被丢弃**：plan 的 Spec Coverage Matrix 写 "send(set_model) → response(success)"，但 response 到达后 converter 返回 `[]`，成功/失败都无法感知。

3. **`success: false` 错误响应被丢弃**：spec FR-5 明确要求"将 error 消息转换为 HAPI error event，通知用户"。converter 不处理，runner 也不处理。

**根因**：plan 没有区分"runner 需要直接处理的 RPC response"和"需要转换为 AgentMessage 的事件"。所有 Pi stdout 输出都经过同一个 `onEvent` → `convertPiEvent` 管道，response 类事件在 converter 层被静默丢弃。

## 6. 后端设计充分性

**结论：通过，设计决策有理有据。**

- **"为什么"而非"做什么"**：Decisions Made 部分解释了 4 个关键设计选择（不用 AgentRegistry、不复用 AcpStdioTransport、独立 runner、不做额外抽象层），每个都有理由。
- **存储变更选型**：不适用（无 DB 变更）。
- **API 端点设计**：不适用（无 HTTP API 变更）。
- **边界条件**：AC-7（Pi crash）、AC-8（JSONL 错误）覆盖了主要边界。Task 3 runner 的 finally 块和 onClose handler 处理了异常路径。
- **非功能性要求**：non-functional-design.md 覆盖了稳定性、性能、安全，每个维度都有对应实现措施。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST_FIX | plan.md:Task 2 Step 3 + Task 3 Step 3 | **response 事件处理缺失**。PiEventConverter 对所有 `response` 事件返回 `[]`，导致：(a) `get_state` 响应中的初始 model 状态丢失，无法初始化 HAPI session 元数据；(b) `set_model` 的成功/失败确认丢失；(c) spec FR-5 要求的 `success: false` 错误事件转换未实现。Runner 中 `onEvent` → `convertPiEvent` 的管道设计没有给 response 事件留处理空间。 | 方案 A（推荐）：在 runner 中注册 `onEvent` 时做分支——`response` 类型由 runner 直接处理（提取 data、检查 success），其余类型走 `convertPiEvent`。方案 B：扩展 converter 使其处理 `success: false` 的 response（返回 error AgentMessage），`get_state`/`set_model` 的成功响应仍由 runner 直接消费。无论哪种方案，plan 需明确 response 事件的数据流和消费方。 |
| 2 | MUST_FIX | plan.md:Task 3 Step 2 | **parseRemoteAgentCommandOptions 矛盾**。同一步骤内写"不使用 `parseRemoteAgentCommandOptions`（Pi 不支持 remote mode）"，又写"使用 `parseRemoteAgentCommandOptions` 解析 `--started-by`, `--permission-mode`, `--yolo`, `--model` 参数"。执行 subagent 无法判断该用还是不用。 | 删除其中一条。如果 Pi 需要解析这些参数（`--permission-mode`, `--yolo`, `--model`），则保留使用语句，删除"不使用"那条，改为说明"虽然 Pi 不支持 remote mode，但本地启动仍需解析 `--permission-mode`/`--yolo`/`--model` 等参数"。如果确认不需要，则删除使用语句。 |
| 3 | LOW | plan.md:Dependency Graph | **Task 1 → Task 2 依赖不必要**。PiEventConverter 是纯函数，不 import PiTransport，两者可并行。当前串行安排不影响正确性，但增加总执行时间。 | 将 Task 1 和 Task 2 并行执行（同 Wave 内），Task 3 仍依赖两者。Wave 1: [Task 1, Task 2] → Wave 2: [Task 3]。 |
| 4 | LOW | plan.md:Task 3 | **Runner 无专属单元测试**。`runPi.ts` 是最复杂的集成点（session 生命周期、信号处理、错误路由、keep-alive），但只有 typecheck + 已有测试通过作为验证。e2e-test-plan 中 TS-5/TS-6/TS-7 为手动操作。 | 考虑为 runner 的关键路径（Pi crash 处理、abort 信号路由）编写集成测试，mock PiTransport 层。或至少在 Task 3 Step 3 中注明"runner 核心路径由 e2e 手动测试覆盖"。 |
| 5 | LOW | plan.md:Task 1 Step 1 | **PiTransport 测试场景缺少 EPIPE 用例**。Interface Contract 标注 send() 在 EPIPE 时 emit close 事件，但测试场景列表未包含此 case。send() 测试只写了"将 JSON 写入子进程 stdin"的正常路径。 | 在 Task 1 Step 1 测试场景中添加："send() 在 stdin 写入失败（EPIPE）时触发 close 事件"。 |
| 6 | INFO | plan.md:Execution Groups | BG1 单组 3 Task 串行执行。对于 3 个 Task 的规模，单 Group 是合理的。但如果 Task 1/2 并行化（issue #3），可考虑拆为 2 个 Group。 | 无需操作。如采纳 issue #3 则调整。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

### AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | Plan Task |
|----|------|---------|-----------|
| AC-1 | 基本启动和交互 | ✅ | Task 1 (PiTransport.start) + Task 3 (runner) |
| AC-2 | 消息收发 | ✅ | Task 1 (send) + Task 2 (convert) + Task 3 (runner 路由) |
| AC-3 | 中断生成 | ✅ | Task 1 (send abort) + Task 3 (abort handler) |
| AC-4 | 模型切换 | ⚠️ | Task 3 (set_model send)，但 response 处理缺失（issue #1） |
| AC-5 | Pi 不可用 | ✅ | Task 1 (ENOENT) + Task 3 (assertPiAvailable) |
| AC-6 | HAPI 退出时进程清理 | ✅ | Task 3 (SIGTERM handler → kill) |
| AC-7 | Pi 子进程异常退出 | ✅ | Task 3 (onClose handler → cleanup) |
| AC-8 | JSONL 协议错误 | ⚠️ | Task 1 (malformed JSON + EPIPE)，EPIPE 测试缺失（issue #5） |

### 结论

**需修改后重审。**

2 条 MUST FIX：
1. `response` 事件处理链断裂——converter 丢弃所有 response，runner 未做补救，导致 `get_state`/`set_model`/error 响应全部丢失。
2. `parseRemoteAgentCommandOptions` 使用与否在同一 Step 内矛盾，subagent 无法执行。

修复建议：在 plan 中明确 response 事件的双轨处理机制（runner 直接消费 + converter 转换错误），并消除 Task 3 Step 2 的矛盾。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。
