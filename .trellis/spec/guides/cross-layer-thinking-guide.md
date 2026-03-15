# 跨层思维指南

> **目的**：在实现之前，先把跨层数据流想清楚。

---

## 为什么需要跨层思维？

**大多数 Bug 都发生在层与层的边界上**，而不是层内部。

常见的跨层 Bug：
- API 返回的是格式 A，前端却期待格式 B
- 数据库存的是 X，服务层转换成 Y 时却丢失了数据
- 多个层对同一逻辑做了不同实现

---

## 在实现跨层功能之前

### 第 1 步：绘制数据流

画出数据如何流动：

```
Source → Transform → Store → Retrieve → Transform → Display
```

对每一条箭头都问自己：
- 数据当前是什么格式？
- 可能出什么问题？
- 谁负责校验？

### 第 2 步：识别边界

| 边界 | 常见问题 |
|----------|---------------|
| API ↔ Service | 类型不匹配、字段缺失 |
| Service ↔ Database | 格式转换、null 处理 |
| Backend ↔ Frontend | 序列化、日期格式 |
| Component ↔ Component | Props 形状变化 |

### 第 3 步：定义契约

对于每个边界：
- 精确的输入格式是什么？
- 精确的输出格式是什么？
- 可能出现哪些错误？

---

## 常见的跨层错误

### 错误 1：隐式格式假设

**反例**：未校验就假设日期格式正确

**正例**：在边界处做显式格式转换

### 错误 2：校验分散

**反例**：在多个层重复校验同一件事

**正例**：在入口点集中校验一次

### 错误 3：抽象泄漏

**反例**：组件知道数据库 schema

**正例**：每一层只了解自己的相邻层

---

## 跨层功能检查清单

实现前：
- [ ] 已画出完整数据流
- [ ] 已识别所有层边界
- [ ] 已定义每个边界的数据格式
- [ ] 已决定校验发生的位置

实现后：
- [ ] 已用边界情况测试（null、空值、非法值）
- [ ] 已验证每个边界的错误处理
- [ ] 已检查数据往返后仍然完整

---

## Slash Command 契约检查清单（CLI ↔ Hub ↔ Web）

当修改 slash command 发现逻辑时，检查：
- [ ] CLI 函数签名与 handler wiring 是否携带了项目目录上下文
- [ ] Hub 响应类型是否包含 CLI 会使用到的全部 `source` 变体
- [ ] Web 类型联合与过滤逻辑是否包含同样的 `source` 值
- [ ] 嵌套命令路径是否被显式映射为命令名（例如 `group/file.md` -> `group:file`）
- [ ] 集成检查是否确认 `/api/sessions/:id/slash-commands` 能返回项目命令

参考可执行契约：
- `backend/quality-guidelines.md` → `Scenario: Slash Command Cross-Layer Contract (Project + Nested)`

---

## 合并后冲突契约检查清单（YAML Workflow ↔ Runtime Lifecycle）

当你在基础设施 / 运行时文件中解决 merge conflict 时，不要只删除冲突标记，而要从契约层验证合并结果：
- [ ] 对于 GitHub Actions YAML，所有 `needs:` 引用在合并后是否仍指向真实存在的 job？
- [ ] 对于发布 workflow，smoke / validation 步骤是否仍然排在任何不可逆制品推送之前？
- [ ] 对于 smoke 步骤，你验证的是否是显式准备好的候选镜像（`--no-build` / 注入镜像 tag），而不是在 smoke job 内重新构建一个新的本地镜像？
- [ ] 对于运行时可用性 helper，是否有 merged boolean 分支把 `running` / `degraded` / `stale` 语义重新压扁成单一的 `false` 路径？
- [ ] 对于回答“当前是否健康且可复用”的 helper 变更，是否回放了所有可能跳过启动、复用进程或抑制恢复逻辑的调用方？
- [ ] 冲突解决后，你是否回放了相关调用链（`helper -> caller -> side effect`），而不是只检查改动的文件？
- [ ] 是否至少有一个回归测试或静态校验，能在该契约再次退化时失败？

典型失败模式：
- 一次 merge 在语法层面保留了两边的合法性，但改变了契约语义：
  - YAML 保留了所有步骤，但 `needs` 指向了一个已经被删除的 job。
  - 发布流程保留了 smoke test 逻辑，却把它移到了 `push: true` 之后。
  - 可用性 helper 在本地仍保留显式状态，但调用方仍把合并后的返回值理解成“现在重启”。

参考可执行契约：
- `backend/quality-guidelines.md` → `Scenario: Post-Merge Conflict Resolution Contract (Workflow Dependencies + Runtime Availability)`

---

## Repair Cascade / Goal Drift 检查清单（许多小修复 ↔ 长调试周期）

当同一类 bug 在短时间内需要很多小 commit 才能收敛时，停下来检查：这项工作是否已经变成 repair cascade，而不是一个有边界的修复：
- [ ] 你是否已经用一句话写下当前的主要目标（例如：`publish 必须被 pre-publish smoke gate 住`、`degraded 不得等于健康可复用 runner`），并拒绝所有不直接服务于这个目标的修改？
- [ ] 你是否把 **根因修复**、**review 跟进**、**spec 固化**、**相邻清理** 分成不同范围，而不是混在同一个 patch 里？
- [ ] 在开始下一次修复 commit 之前，你是否确认了是哪一个之前的 commit 引入了回归，以及这次工作是在回滚还是在补偿那个 commit？
- [ ] 你是否已经把每个新想法明确归类为：必要的根因修复、必要的传播修复、可选 hardening，或无关改进？
- [ ] 你是否停止了对同一证据层的反复检查（例如只看 PR UI、只看一个 helper、只看一个测试）却没有获得新信息？
- [ ] 如果连续 3 个以上修复 commit 都在触碰同一个契约边界，你是否暂停并重建端到端模型（`trigger -> state model -> caller -> side effect -> verification`）后再继续写代码？
- [ ] 你是否验证过 merge commit 是否重新引入了一个已经修好的行为，而不是又发明了一个新的根因？
- [ ] 你是否维护了一个单一结论来源，避免后续 commit 重复使用已经被证伪的旧假设？

典型失败模式：
- 一个大功能 / 重构同时改动了运行时状态模型、workflow 结构和测试面。
- 后续修复虽然分别解决了某个症状，但每个 commit 都在轻微改变对 bug 的工作理论。
- merge / review 又把旧行为带回来，下一次修复却从最新症状出发，而不是从原始契约边界出发。
- 分支里积累了很多“看起来很小”的 commit，但其中有几条实际上只是重试、范围蔓延，或对同一证据的重复诊断。

参考可执行契约：
- `backend/quality-guidelines.md` → `Scenario: Repair Cascade Control Contract (Commit Chain Triage + Goal Drift)`

---

## 高风险修改前的历史提交检查清单

当你准备修改高风险区域（冲突解决、连续修复文件、workflow/CI/Docker、runtime 状态机、helper 语义、被 review 指向的文件）时，先检查是否已经回放相关历史 commit：
- [ ] 你是否已经查看该文件最近 **3 个相关 commit**，并区分：事故修复 / review 修正 / 功能演进 / 重构清理？
- [ ] 你能否说清当前这段“复杂 / 保守 / 奇怪”的代码，是为了解决哪个历史 bug 或 review 意见？
- [ ] 如果这是冲突解决，你是否按历史优先级处理：**事故修复 > review 修正 > 功能演进 > 重构清理**？
- [ ] 如果你要修改 helper / 状态判断 / workflow 依赖，是否同时查看了 caller / downstream job 的历史，而不是只看 helper 当前实现？
- [ ] 如果你觉得某个 test 多余、啰嗦、奇怪，是否先查过它是哪个 commit 引入、锁的是哪类回归？
- [ ] 你是否已经写下：`相关历史 commit：A/B/C` 与 `本次修改不能破坏：契约 X / 契约 Y`？
- [ ] 如果同一文件在 24 小时内已被连续修复，你这次是否先做了 commit 回放，而不是直接继续补丁？

典型失败模式：
- 只看当前文件，不看历史 commit，于是把事故修复误判成“可删复杂度”。
- 冲突时只求“能编译、能跑”，却没有保留历史语义优先级。
- helper 看起来可以简化，但调用方历史上依赖的是更保守的契约，结果一改就回归。
- 某个 test 看起来奇怪就被删掉，之后旧问题重新出现。

参考可执行契约：
- `backend/quality-guidelines.md` → `Scenario: 高风险修改前的历史提交检查契约（相关 Commit 回放 + 冲突语义保留）`

---

## 低 ROI 工作停止信号检查清单

当你已经深陷某个修复 / 功能 / 重构，请定期检查：这项工作是否已经变成应该停止或延后的低 ROI 消耗：
- [ ] 你能否用一句话说清：这项工作解除的是哪个**用户可见影响**或**业务关键 blocker**？如果说不清，它真的是当前 P0 吗？
- [ ] 如果这项工作已经持续 2 小时以上，而结果仍只是“内部状态更整洁一点”或“规范覆盖更完整一点”，它是否应该延后？
- [ ] 你现在修的是**真实用户 / reviewer / CI 已经指出的问题**，还是只是基于假想 edge case 做预防性 hardening？
- [ ] 如果完全删掉这项工作，是否有任何**可观察契约**会坏，还是只影响内部“整洁度 / 完整度 / 优雅性”？
- [ ] 原始症状已经解决的前提下，你现在投入时间，是在“让修复更优雅”“多补一些边界”，还是在解决新的明确 blocker？
- [ ] 你是否显式比较过：**继续的成本**（时间、上下文切换、review 往返、merge 风险）vs **延后的成本**（未来 bug 风险、未来返工）？
- [ ] 如果有人问“为什么这件事还没停？”，你能否给出一个新的明确 blocker，而不是回答“感觉还没收干净”？
- [ ] 你是否已经写下这项工作的 **done 定义**，还是在没有退出条件的情况下反复迭代？

典型失败模式：
- 修复起点是明确的 P0 blocker（例如：publish gate 失效、runner 崩溃）。
- blocker 被修掉后，工作继续扩展到：更好的日志、更多边缘 case、顺手重构相邻代码、穷尽式 spec、预防性 hardening。
- 每一步单独看都很小、很合理，但累计 ROI 已经快速下降，因为原始 blocker 早就不存在了。
- 没有人明确问“现在是不是应该停”，因为工作被表述成“顺手收尾”“一次性收干净”，而不是“可选 polish”。
- 最终分支累积大量 commit、review 往返和上下文切换，但后续每个 commit 的边际收益接近于 0。

参考可执行契约：
- `backend/quality-guidelines.md` → `Scenario: 低 ROI 工作控制契约（停止信号 + 延后判定）`

---

## Session-Scoped Client Cache 检查清单（Web State ↔ Session Identity）

当 UI 状态会跨渲染缓存（例如 `useRef`、query fallback、optimistic state）时：
- [ ] 缓存是否按稳定身份（`session.id`、`workspaceId` 等）分 key / 作用域？
- [ ] 身份切换时，是否会在推导 fallback UI 之前先重置旧身份缓存？
- [ ] fallback 逻辑是否能防止前一个实体的错误 / 状态泄漏到当前实体？
- [ ] loading / error 三态是否在作用域重置后再判断？

---

## WebSocket 跨层契约检查清单（Frontend ↔ Hub ↔ CLI）

当实现或修改 WebSocket 连接功能时，必须检查以下跨层契约：

### 前端层（Web）

- [ ] **组件生命周期与 Socket 同步**：组件 unmount 时是否调用 `disconnect()`？
- [ ] **清理所有监听器**：`disconnect()` 是否调用了 `socket.removeAllListeners()`？
- [ ] **区分 terminal 进程复用与 socket 复用**：允许复用 registry 里的 `terminalId` / terminal 进程，但页面离开后不得保留旧页面 socket。
- [ ] **重连协议与页面生命周期一致**：同一组件实例内可复用现有 socket；跨页面重新挂载必须依赖 cleanup 先断开旧 socket，再由新页面创建新 socket。
- [ ] **等待连接建立**：是否在 `socket.on('connect')` 回调中发送初始化消息（如 `terminal:create`），而不是立即发送？
- [ ] **错误日志上下文**：错误日志是否包含 `sessionId`、`terminalId`、`socketId`、`cause` 等关键信息？

### 服务端层（Hub）

- [ ] **disconnect 自动 detach**：socket 断开时，Hub 是否自动 `detachSocket(socket.id)`？
- [ ] **允许 detached terminal reattach**：当 registry 中 terminal 的 `socketId === null` 时，新的 socket 是否可以用同一个 `terminalId` 重绑？
- [ ] **拒绝活跃 socket 冲突**：当 terminal 仍绑定在另一个活跃 socket 上时，是否返回明确冲突错误，而不是静默抢占？
- [ ] **幂等性保证**：重复的 `terminal:create` 请求是否能正确处理（返回已存在的终端或拒绝）？

### 跨层状态同步

- [ ] **页面生命周期优先于连接优化**：不要为了“返回页面更快恢复”而保留旧页面 socket。
- [ ] **前端不假设服务端状态**：前端不应假设 socket 在服务端仍然有效，每次操作前应检查连接状态
- [ ] **服务端不假设前端清理**：服务端应在 socket 断开时自动 detach，不依赖前端主动调用 `terminal:close`
- [ ] **重连协议明确**：重连时的握手流程是否明确（页面 mount → connect → `terminal:create` → Hub attach/reattach → `terminal:ready`）？
- [ ] **状态机一致性**：前端和服务端对连接状态的理解是否一致（idle/connecting/connected/reconnecting/error）？

### 常见陷阱

**陷阱 1：把“恢复终端”误解成“保留旧 socket”**
- **症状**：`socket_not_connected`、`Terminal ID is already in use by another socket.`
- **根因**：前端为了支持恢复 terminal，页面离开时没有断开旧 socket；回来后新页面又创建新 socket，两个 socket 竞争同一个 `terminalId`。
- **解决**：页面 unmount 时必须 `disconnect()`；恢复的是 Hub registry 里的 terminal 进程，不是旧页面 socket。

**陷阱 2：组件 unmount 时未清理**
- **症状**：内存泄漏、事件监听器累积、页面切换后仍收到旧数据
- **根因**：未在 useEffect cleanup 中调用 `disconnect()`
- **解决**：添加 cleanup effect

**陷阱 3：立即发送消息**
- **症状**：`socket_not_connected`、消息丢失
- **根因**：在 `socket.connect()` 后立即 `socket.emit()`，但连接尚未建立
- **解决**：在 `socket.on('connect')` 回调中发送

### 调试检查清单

当遇到 WebSocket 连接问题时：

1. **检查前端日志**：
   - 是否有 `socket_not_connected` 错误？
   - 是否有 `socket_already_connected` 警告？
   - `connect()` 和 `disconnect()` 的调用顺序是否正确？

2. **检查服务端日志**：
   - 是否有 `detachSocket` 操作？
   - 是否有 `Terminal ID is already in use by another socket.` 错误？
   - `rebindSocket` 是否成功？

3. **检查页面 cleanup**：
   - 终端页面 unmount 时 cleanup 是否真的执行？
   - cleanup 是否调用了 `disconnect()`，而不是只保留 `terminalId`？

4. **检查重连对象**：
   - 当前是在同一组件实例内复用 socket，还是跨页面重新 mount？
   - 是否错误地把“terminal 可恢复”实现成了“旧 socket 不断开”？

参考实现：
- `web/src/hooks/useTerminalSocket.ts` - 前端 Socket 管理
- `web/src/routes/sessions/terminal.tsx` - 页面生命周期 cleanup
- `hub/src/socket/handlers/terminal.ts` - 服务端 Socket 处理
- `hub/src/socket/terminalRegistry.ts` - 服务端状态管理
- [ ] 是否有集成测试覆盖“创建新实体 -> 初次加载 -> 不泄漏旧缓存”？

典型失败模式：
- 先前会话状态（例如 `Git unavailable` 或旧 branch 计数）仍然残留在 ref fallback 中，而新会话查询还在加载。
- 用户会在路由重新挂载 / 重进之前看到错误状态。

---

## GitHub Review Trigger 检查清单（分支 Push ↔ PR 事件 Workflow）

当 commit 已推到一个打开中的 PR 分支，但 review 自动化（例如 `Codex PR Review`）看起来没有重新运行时：
- [ ] 分支引用是否真的前进了？请用 `git ls-remote origin refs/heads/<branch>` 验证，而不是只看 PR UI / `gh pr view`。
- [ ] 新 SHA 是否触发了 push workflow，而 `pull_request` / `pull_request_target` workflow 没有触发？
- [ ] review workflow 是否本来就是由 PR 事件（`pull_request` / `pull_request_target`）触发，而不是由 `push` 触发？
- [ ] workflow 级过滤器（`types`、branch filters、labels、draft gating、bot gating）是否满足新的事件条件？
- [ ] 你是否直接对比了 workflow 运行历史（`gh run list`、workflow-specific runs API），而不是从状态聚合反推？
- [ ] 在下结论说“review 没跑”之前，你是否区分了分支 SHA 新鲜度与 PR 元数据新鲜度（`headRefOid`、review 聚合、status rollup）？

典型失败模式：
- `git push` 成功了，分支级 `push` workflow 也立即开始。
- reviewer 查看 `gh pr view` 或 PR 评论时，仍看到旧的 `headRefOid` 和旧的 bot review。
- 团队误判成“push 没有发生”或“review bot 挂了”，而实际问题是 PR 事件 workflow 延迟 / 未触发。

参考可执行契约：
- `backend/quality-guidelines.md` → `Scenario: GitHub PR Review Trigger Contract (Push SHA vs pull_request_target Review)`

---

## ACP Prompt Completion Boundary 检查清单（Transport RPC ↔ Session Update Stream ↔ UI Message Flush）

当一个 prompt / request 已返回最终 stop reason，但相关 session update 仍可能异步到达时：
- [ ] 完成边界是否由 **RPC 完成 + update stream 静默时间** 共同定义，而不是只看 RPC 响应？
- [ ] 在等待静默窗口之前，你是否先推进 / 更新本地“最近活动时间”标记，以便迟到的 update 能消耗完整静默窗口，而不是继承过旧时间戳？
- [ ] 消息 flush 顺序是否保证尾随 tool update 会先于最终缓冲文本与 `turn_complete` 发出？
- [ ] 如果 updates 与 response completion 分别走不同异步通道，是否有回归测试覆盖 `response 先完成 -> tool updates 稍后到达`？
- [ ] timeout / quiet-period 常量是否通过窄而确定性的 fixture 测试，以便 CI 抓住竞态回归？

典型失败模式：
- `session/prompt` 很快返回 `stopReason=end_turn`。
- 客户端立刻用旧的 `lastSessionUpdateAt` 时间戳开始 quiet-wait。
- 等待过早结束，缓冲文本被 flush，`turn_complete` 在同一轮的尾随 `tool_call` / `tool_result` 更新处理前就已发出。
- CI 随后出现顺序敏感失败，例如 `['text', 'turn_complete']`，而不是 `['tool_call', 'tool_result', 'text', 'turn_complete']`。

参考可执行契约：
- `backend/quality-guidelines.md` → `ACP Session Completion Ordering Contract`

---

## Terminal Session Resume 检查清单（Web ↔ Hub ↔ CLI Terminal Lifecycle）

当终端页面离开后再进入，需要在 idle timeout 前恢复同一终端会话时：
- [ ] 前端是否按 `sessionId` 维护 session 级 `terminalId` 状态，而不是每次页面进入都生成新 ID？
- [ ] Hub 侧 socket disconnect 时是否仅 `detach`（设 `socketId = null`），而不是立即从 registry 删除？
- [ ] 同 session 同 terminalId 重新连接时，Hub 是否执行 `reattach` 并返回 `terminal:ready`，而不是再次向 CLI 发送 `terminal:open`？
- [ ] 若 terminal 已过期/不存在，前端是否自动 `reset` 并创建新终端，同时显示 toast 提示用户？
- [ ] **恢复型 buffer replay 是否与流式 output append 明确分离？** replay 只应发生在 terminal identity 切换 / 重新挂载恢复阶段，而不是每个新 chunk 到达时。
- [ ] **任何 replay gate/ref（例如 `replayedBufferRef`）是否只在 session/terminal 切换或显式 reset 时清空？**
- [ ] 是否有集成测试覆盖：`页面进入 -> 离开 -> 再进入（idle timeout 前）-> 恢复同一 terminalId`？
- [ ] 是否有测试覆盖：`terminal 已过期 -> 前端收到 not-found -> 自动 reset + toast + 重连`？
- [ ] **是否有测试覆盖：`first chunk -> second chunk` 只追加新输出，不发生 `reset + full replay`，并且该测试等待了 React state/effect flush？**

典型失败模式：
- 每次页面进入都生成新 `terminalId`，导致旧终端泄漏且无法恢复输出缓冲。
- Hub disconnect 时直接删除 terminal registry entry，导致短暂断线后无法 reattach。
- 重连时重复发送 `terminal:open` 到 CLI，导致 CLI 侧终端实例重复创建。
- terminal 过期后前端无提示，用户不知道为什么终端重置了。
- **前端把 replay effect 依赖到 `outputBuffer`，每个 output chunk 到达时都先 `terminal.reset()` 再重放整段历史缓冲，导致终端闪烁、重复输出和性能退化。**

参考可执行契约：
- `frontend/state-management.md` → `Terminal Session Resume Contract`
- `backend/error-handling.md` → `Terminal Socket Lifecycle Contract`

---

## Session-Switch Draft Persistence 检查清单（Composer ↔ Session Identity）

当聊天输入框文本需要在不同会话间切换后仍然保留时：
- [ ] draft 状态是否按 `session.id` 建 key，而不是单一全局 composer 值？
- [ ] 会话切换时，是否会在渲染交互输入前先从目标会话 draft 恢复内容？
- [ ] 发送成功后，是否只清空当前活跃会话对应的 draft key？
- [ ] drafts 是否彼此隔离（A 的草稿不会出现在 B）？
- [ ] 是否有集成测试覆盖：`在 A 输入 -> 切到 B -> 再切回 A -> 草稿恢复`？

典型失败模式：
- Composer 依赖一个共享的 `composer.text` 状态，没有按会话分作用域。
- 切走再回来后重新挂载 / 同步为空状态，导致未发送输入丢失。

---

## Terminal Session 契约检查清单（Web ↔ Hub ↔ CLI）

当终端会话跨层打通时：
- [ ] `terminalId` 是否按 session 分作用域（同一 UI 生命周期中不同 session 不复用）？
- [ ] Web 客户端是否会在 session 切换时先重置缓存的 `terminalId`，再重连？
- [ ] Hub 是否会在 **web socket 断开** 和 **CLI socket 断开** 两种情况下都清理 registry entry？
- [ ] 重复创建 `terminalId` 时，是否被当作幂等，或以明确错误暴露？
- [ ] 平台约束（例如 Windows 不支持 terminal）是否一致地暴露给 UI？
- [ ] 是否有集成测试覆盖“重连后重新打开终端”且不会发生 ID 冲突？

典型失败模式：
- 断开后旧 `terminalId` 仍残留在 Hub 中，下一次连接时会报
  `Terminal ID is already in use`，而 UI 却以为这是一个全新会话。

---

## Terminal Copy/Interrupt Input 契约检查清单（Web Keybinding ↔ Browser Clipboard ↔ PTY）

当终端输入涉及 `Ctrl+C`、`Enter`、选区复制和剪贴板回退时：
- [ ] `Ctrl+C` 是否有确定性的判定顺序？（有选区时复制 > 否则发送 `\u0003` 中断）
- [ ] 走复制分支时，是否避免在同一按键路径中把输入字节转发给 PTY？
- [ ] 如果进入复制分支，handler 是否显式 `preventDefault` / `stopPropagation`，避免意外换行 / 提交命令副作用？
- [ ] 浏览器不支持 clipboard API 时，是否有回退方案（手动复制对话框或明确提示）？
- [ ] 是否记录了平台差异下的按键规则（Windows/Linux 的 `Ctrl+C`、macOS 的 `Cmd+C`）？
- [ ] 是否有集成测试覆盖 `选中文本 -> 复制 -> shell 不会收到 ^C/\n`？

典型失败模式：
- 前端把 `Ctrl+C` 直接经 terminal `onData` 转发到后端 PTY（`\u0003`），即便用户此时真实意图是复制。
- 结果就是复制失败，当前命令被中断（或表现成意外回车 / 换行）。

---

## 独立主线迁移检查清单

当从 upstream 协作模式切换到独立开发模式时：
- [ ] 在改变 remote 拓扑前，`main` 是否已经和预期来源分支完成 merge / rebase？
- [ ] 如果 rebase / merge 处于暂停状态，是否已先彻底解决冲突再执行 `pull`？
- [ ] `main` 是否显式跟踪 `origin/main`？
- [ ] `upstream` remote 是否被移除（或被有意识保留）并有明确策略？
- [ ] 是否验证了端到端同步（`pull --rebase origin main` 然后 `push origin main`）？

参考可执行契约：
- `backend/quality-guidelines.md` -> `Scenario: Independent Development Mode (Origin-only Mainline)`

---

## 分支策略思维检查清单

当为 fork + upstream 协作决定分支策略时：
- [ ] 是否存在一个干净的上游镜像分支（`main`），其中不包含产品线专属 commit？
- [ ] 面向上游的 PR 分支是否从镜像 `main` 创建，而不是从产品分支创建？
- [ ] 产品开发是否被隔离在一个专用的长期分支中（例如 `main-custom`）？
- [ ] 是否有从 `main` 定期同步到产品分支的计划？
- [ ] 在 force-push `origin/main` 之前，是否确认过可能丢失的独有 commit？

参考可执行契约：
- `backend/quality-guidelines.md` -> `Scenario: Branch Topology for Upstream Collaboration + Custom Product Line`

---

## Monorepo Workspace Dependency 检查清单（构建路径）

当修复 Bun workspace monorepo（`web`/`hub`/`cli` + shared package）的构建失败时：
- [ ] 每个导入的 workspace package 名称是否与产出方 package 的 `name` 字段完全一致？
- [ ] 在 rename 或 workspace 元数据变化后，是否已在仓库根目录重新安装依赖？
- [ ] 在继续排查 bundler 配置前，consumer 侧是否已经能看到依赖链接（`web/node_modules/<pkg>`）？
- [ ] 如果 Vite/Rollup 报 `failed to resolve import`，你是否先验证了 package linking，而不是立刻做 alias/external 绕过？
- [ ] 是否有 CI / 本地预构建检查，用来验证关键 shared package 的 workspace link？

典型失败模式：
- 应用代码里的 import path 是正确的，但因为 package rename 后没重新 install，workspace link 仍然过期 / 缺失。
- 表面症状是 bundler 解析失败，根因却是依赖图状态问题。

推荐快速验证：
1. 检查产出方 package 名称（例如 `shared/package.json`）。
2. 检查消费方依赖声明（例如 `web/package.json`）。
3. 检查消费方 `node_modules` 中是否已安装链接。
4. 在仓库根目录运行安装（`bun install`）并重新构建。

---

## 容器服务生命周期检查清单（Compose ↔ Entrypoint ↔ CLI 进程）

当把一个 CLI 命令打包成长期运行的 Docker / Compose 服务时：
- [ ] 配置的 service command 是否设计为以前台 PID 1 方式持续运行？
- [ ] 该命令是否可能在完成初始化、切换控制权或检测到“已在运行”后合法地以 `0` 退出？
- [ ] 如果命令本身管理后台 daemon，容器契约是否应该改为托管 daemon 进程，而不是 bootstrap 命令？
- [ ] `restart: unless-stopped` 是否会和“成功退出”安全配合，还是会制造无限重启循环？
- [ ] 是否有 compose 层面的校验，在 bootstrap 稳定后同时检查 `docker compose ps` 状态和 health 状态？
- [ ] 日志是否明确区分：退出表示成功、handoff，还是失败？

典型失败模式：
- 某个 CLI 子命令如 `runner start-sync` 完成启动检查后，发现已有匹配版本的 runner 在运行，于是打印 `Runner already running with matching version` 并以 `0` 退出。
- Docker 会把这个退出解释为容器已完成，并因为 restart policy 反复拉起它，从而形成一种误导性的 crash loop，尽管实际上没有抛出异常。

推荐快速验证：
1. 检查命令源码中是否存在在成功 / already-running 分支调用 `process.exit(0)` 的逻辑。
2. 运行 `docker compose up -d`，并在 bootstrap 延迟后检查 `docker compose ps`。
3. 查看容器状态中是否存在 `ExitCode=0` 但伴随重复重启。
4. 只有当服务持续保持 `Up` 且进入 `healthy` 时，才算契约正确。

---

## Runner Availability 契约检查清单（State File ↔ Process Liveness ↔ Control Port）

当一个 CLI 或后台守护进程通过持久化状态 + 运行时探测来报告可用性时：
- [ ] 可用性 API 是否至少区分了 `missing`、`stale`、`degraded`、`running` 四种状态，而不是只返回 bare boolean？
- [ ] 如果同时检查 PID 存活性与 control-port 可达性，这两者是否被分别暴露为不同结果，而不是被压成一个 false 分支？
- [ ] 调用方路径（`start`、`status`、`doctor`、升级逻辑）是否显式决定了如何处理 `degraded`，而不是把它当作“未运行”？
- [ ] stale-state 清理是否只发生在拥有者 PID 确认已死亡时，而不是任意临时探测失败时？
- [ ] 是否有集成测试覆盖“PID 仍存活 + control port 暂时不可达”，并断言状态 / 锁保留与调用方行为正确？

典型失败模式：
- 类似 `checkIfRunnerRunningAndCleanupStaleState()` 的 helper，对“根本没有 runner”和“runner 进程还活着但 control endpoint 超时”都返回 `false`。
- 调用方把 `false` 统一理解成“没有 runner”，从而在后续启动、停止、doctor 输出或版本检查中走错分支。

推荐快速验证：
1. 追踪可用性 helper 的每个调用方，并列出它们在每个返回值下会走哪条分支。
2. 当运行时状态超过两种时，确认 helper 返回的是一个有类型的状态 / 结果对象，而不是 boolean。
3. 增加一个集成测试，模拟 control-port 超时但 PID 仍然存活。
4. 确认 `start`、`status` 和版本检查路径不会把一个临时 degraded 状态升级成清理或重启。

---

## Docker 锁文件冻结契约检查清单（CI 构建路径）

当 Docker 镜像构建在 CI 中使用 `bun install --frozen-lockfile` 时：
- [ ] Dockerfile 是否在安装前复制了 **所有参与 `bun.lock` 解析的 workspace manifests**（根目录 + 各 workspace `package.json`）？
- [ ] 任何 workspace 依赖 / script / workspace 元数据变化后，是否都已在仓库根目录重新生成并提交 `bun.lock`？
- [ ] 如果 CLI 发布产物包、`optionalDependencies`、平台二进制包列表发生变化，是否也视为依赖图变化并同步更新 `bun.lock`？
- [ ] 本地验证是否使用了同样严格的模式（`bun install --frozen-lockfile`）再推送？
- [ ] CI 是否和本地 / 开发容器固定了同样的 Bun 版本，以避免 lockfile 格式漂移？
- [ ] PR 检查是否配置为在 `bun.lock` 变脏时尽早失败（例如安装后执行 `git diff --exit-code bun.lock`）？

典型失败模式：
- Docker build 走到 `RUN bun install --frozen-lockfile` 时失败，报 `lockfile had changes, but lockfile is frozen`。
- CLI `optionalDependencies` 新增 / 移除了某个发布产物包（例如新的平台包），但只提交了 `package.json`，忘了提交 `bun.lock`。
- 多架构 Buildx 日志里可能出现无关的平台阶段取消（`arm64 CANCELED`），但真正根因是 `amd64` 上发生了 lockfile mutation。

推荐快速验证：
1. 在仓库根目录运行 `bun install`。
2. 检查 `bun.lock` 是否发生变化。
3. 如果变化了，把 `bun.lock` 和对应 manifest 改动一起提交。
4. 在本地与 Docker 上下文中重新执行 `bun install --frozen-lockfile`。

---

## Docker Workflow Scope 检查清单（PR 校验 vs 发布）

当 GitHub Actions 同时承担 Docker 校验与镜像发布职责时：
- [ ] PR 触发的 Docker job 是否有明确校验目标（例如仅验证 Dockerfile 可构建）？
- [ ] 如果 PR 不产出用户可见制品，是否避免了发布级成本（QEMU、多架构 Buildx、registry login）？
- [ ] 多架构构建是否只保留在 `main` / tag 发布路径，或已有明确文档说明为什么 PR 必须验证多架构？
- [ ] `packages: write` 是否只授予真正需要推送镜像的 job / 事件？
- [ ] path filter 是否足够精确，避免与 Docker 无关的 PR 触发镜像流程？
- [ ] 发布 job 是否显式 `needs` 前置 smoke/validation，并在其失败时禁止进入打包上传？
- [ ] 评审时是否明确区分了“验证失败导致未进入发布阶段”与“发布步骤本身失败”？
- [ ] 评审时是否明确区分了“验证失败”与“流程成本设计错误”？

典型坏味道：
- PR 中 `push=false`，但仍完整执行 QEMU + `linux/amd64,linux/arm64` 构建。
- 表面上没有“发布”，实际上 PR 仍在消耗接近发布级别的 CI 成本。
- `publish` job 因 `needs: compose-smoke` 被跳过，但排查时被误读成“上传逻辑没有执行 / 失效”，而不是“前置门禁未通过”。

推荐快速判断：
1. 先看 workflow 的事件边界：`pull_request` 是校验还是发布复用？
2. 再看 Buildx 参数：PR 是否真的需要多架构。
3. 查看 job 依赖：发布是否被 smoke/validation gate 住。
4. 最后看权限与登录：PR 是否不必要地申请 `packages: write` / GHCR 登录。

参考可执行契约：
- `backend/quality-guidelines.md` -> `Scenario: Docker Workflow Scope Contract (PR Validation vs Mainline Publish)`

---

## 全局包管理器上下文检查清单（依赖告警分诊）

当分析 `pnpm install -g` 或其他全局安装告警时：
- [ ] 该告警是否来自本项目的直接依赖图，还是来自机器上已有的无关全局包？
- [ ] 在修改仓库依赖前，是否已经在干净环境 / profile 中复现？
- [ ] 安装是否成功，且发布出去的 CLI 二进制是否能正常运行（`--help` / 基础命令）？
- [ ] 如果告警来自外部且非阻塞，你是否把它记录为受监控风险，而不是强行在仓库层做 override？
- [ ] 如果告警来自直接依赖，是否已经有明确兼容性方案（升级 / 隔离 / pin）并评估过发布影响？

参考可执行契约：
- `backend/quality-guidelines.md` -> `Scenario: Global npm Install Peer-Dependency Drift (Published CLI Package)`

---

## Runner Spawn Context 检查清单（Launcher ↔ Runtime ↔ Session Metadata）

当一个 CLI / runner 功能会拉起真实本地进程时：
- [ ] 你是否区分了 runtime 执行 cwd 与用户请求的业务工作目录？
- [ ] 如果 runtime 需要项目根目录 / 模块解析上下文，这个约束是否通过结构化方式固定，而不是从业务 cwd 猜出来？
- [ ] 如果业务 cwd 必须在 spawn 后保留，是否通过显式传参（env / config / arg）传递，而不是隐藏在 runtime 启动 cwd 里？
- [ ] 你是否验证了所有会读取 `process.cwd()` 或等效启动上下文的入口？
- [ ] 在重写测试前，你是否同时检查了内部契约与传输契约（例如内部 union type vs HTTP response shape）？
- [ ] 是否有集成测试能证明 runner 拉起的 session 和 terminal 启动的 session 都能被正确追踪？
- [ ] 你是否把宿主机影响与 state-directory 隔离分开评估？

典型失败模式：
- 一个 spawn helper 把业务 cwd 直接复用成 runtime cwd。
- runtime 从错误目录启动，导致 alias / assets 无法解析。
- 调试于是一路漂移到测试断言，尽管真正的 bug 是 launcher / runtime 契约违规。

---

## 文件迁移相对路径检查清单

当在 FSD 架构重构或任何代码迁移过程中移动文件时：

### 必须检查的相对路径引用

- [ ] **CSS 中的 `@config` 和 `@import`**：检查所有 CSS/SCSS 文件中的相对路径引用
- [ ] **TypeScript/JavaScript 导入**：检查所有 `import`/`require` 语句中的相对路径
- [ ] **配置文件引用**：检查 `tsconfig.json`、`vite.config.ts` 等配置文件中的相对路径
- [ ] **静态资源引用**：检查图片、字体等静态资源的相对路径
- [ ] **文档中的相对路径**：检查 README、注释中的文件路径引用

### 迁移后验证步骤

- [ ] **立即运行构建**：文件迁移后立即运行 `pnpm run build` 或 `pnpm run dev` 验证路径正确性
- [ ] **检查所有引用该文件的文件**：使用 `grep -r "old/path" .` 查找所有引用旧路径的地方
- [ ] **运行 lint 和 typecheck**：确保类型检查和 lint 工具能够捕获路径错误

### 典型失败模式

**反例**：迁移 CSS 文件时忘记更新 `@config` 路径
```css
/* 从 web/src/index.css 迁移到 web/src/app/styles/index.css */
/* 旧路径：@config "../tailwind.config.ts" */
/* 新路径：应该是 @config "../../../tailwind.config.ts" */
/* 错误：仍然使用 @config "../tailwind.config.ts" */
```

**正例**：迁移后立即更新所有相对路径引用
```css
/* 正确更新为 3 层向上（styles → app → src → web） */
@config "../../../tailwind.config.ts"
```

### 快速验证命令

```bash
# 查找所有 CSS 文件中的相对路径引用
find . -name "*.css" -o -name "*.scss" | xargs grep -n "@config\|@import.*\.\./"

# 查找所有 TypeScript 文件中的深层相对路径
find . -name "*.ts" -o -name "*.tsx" | xargs grep -n "\.\./\.\./\.\./"
```

### 预防机制

1. **使用 TypeScript path aliases**：在 `tsconfig.json` 中配置 `@/` 别名，减少相对路径依赖
2. **迁移前搜索引用**：使用 `grep -r "filename" .` 查找所有引用待迁移文件的地方
3. **构建验证**：迁移后立即运行构建，而不是等到最后
4. **Code Review 检查项**：在 PR 模板中添加"文件迁移时检查相对路径"的检查项

参考可执行契约：
- `frontend/directory-structure.md` → FSD 架构文件组织规范
- `frontend/quality-guidelines.md` → 代码质量检查清单

---

## 前端组件生命周期 vs 后端资源生命周期检查清单

当前端组件需要持有后端资源（WebSocket、终端进程、文件监听等）时：
- [ ] 你是否明确区分了"组件 unmount"和"资源销毁"这两个不同的事件？
- [ ] 页面切换时，后端资源是否应该保持存活（session-scoped）还是应该销毁（component-scoped）？
- [ ] 如果资源是 session-scoped，前端状态管理是否使用了稳定的资源标识符（不随组件重新 mount 而变化）？
- [ ] React cleanup 函数中是否只清理"组件相关的副作用"（事件监听、定时器），而不是"后端资源本身"？
- [ ] 如果后端支持 detach/reattach 机制，前端是否正确使用了相同的资源 ID 进行重连？
- [ ] 资源标识符的生成时机是否正确（应该在资源创建时生成，而不是在组件 mount 时生成）？
- [ ] 是否有明确的"显式销毁"操作（如用户点击"关闭终端"按钮），与"隐式 detach"（页面切换）区分开？

典型失败模式：
- **终端页面切换导致终端退出**：
  - 前端在 `useEffect` cleanup 中调用 `resetTerminalSessionState()`，生成新的 `terminalId`
  - 用户返回终端页面时，前端使用新 ID 尝试连接，但后端仍持有旧 ID 的终端进程
  - 后端的旧终端因为找不到匹配的 socket 而被 idle timeout 清理
  - **根因**：混淆了"组件生命周期"和"资源生命周期"

- **WebSocket 重连失败**：
  - 组件 unmount 时断开连接并清空 session ID
  - 组件重新 mount 时生成新 session ID
  - 后端无法识别新 ID，拒绝连接

推荐模式：

```typescript
// ❌ 错误：在 cleanup 中重置资源标识符
useEffect(() => {
    return () => {
        closeConnection()
        resetSessionState()  // 生成新 ID - 错误！
    }
}, [sessionId])

// ✅ 正确：cleanup 只 detach，不重置 ID
useEffect(() => {
    return () => {
        detachConnection()  // 只断开连接，保留 ID
    }
}, [sessionId])

// ✅ 正确：显式销毁操作单独处理
const handleCloseTerminal = () => {
    closeConnection()
    destroyTerminalSession()  // 明确的销毁意图
}
```

资源所有权模型：

| 资源类型 | 生命周期 | 标识符生成时机 | Cleanup 行为 |
|---------|---------|---------------|-------------|
| 终端进程 | Session-scoped | 首次创建终端时 | Detach socket，保留 ID |
| WebSocket 连接 | Session-scoped | 会话初始化时 | Disconnect，保留 session ID |
| UI 状态（滚动位置） | Component-scoped | 组件 mount 时 | 完全清理 |
| 临时缓存 | Component-scoped | 组件 mount 时 | 完全清理 |

快速验证：
1. 检查所有 `useEffect` cleanup 函数，确认是否误用了"重置资源 ID"的操作
2. 追踪资源标识符的生成位置，确认是否在正确的时机生成
3. 添加 E2E 测试：页面切换后返回，资源应该仍然可用
4. 在后端添加监控：孤立资源数量（有进程但无 socket 的资源）

---
