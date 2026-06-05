---
verdict: pass
---

# Use Cases — hapi-pi-agent-backend

> 本需求为纯技术性功能接入（将 Pi agent 接入 HAPI CLI），无直接业务用例。
> 以下为技术性用例，描述用户与 `hapi pi` 的交互场景。

## UC-1: 用户启动 Pi 会话

**Actor:** 终端用户

**Preconditions:**
- `pi` 已安装在 PATH 中
- 用户已在终端中

**Main Flow:**
1. 用户执行 `hapi pi`
2. 系统检测 `pi` 命令可用
3. 系统 spawn `pi --mode rpc` 子进程
4. 系统建立 JSONL 通信通道
5. 系统发送 `{ type: "new_session" }` 初始化 Pi session
6. 系统发送 `{ type: "get_state" }` 获取初始状态
7. 用户进入交互循环，可输入消息

**Alternative Paths:**
- 3a. `pi` 不在 PATH → 系统输出错误信息，进程退出（AC-5）
- 4a. Pi 子进程启动失败 → 系统输出错误信息，进程退出（AC-7）

**Postconditions:** Pi session 已建立，用户可发送消息

**Module Boundaries:** `cli/src/commands/pi.ts` → `cli/src/pi/runPi.ts` → `cli/src/pi/PiTransport.ts`

**AC 覆盖:** AC-1, AC-5, AC-7

---

## UC-2: 用户与 Pi 对话

**Actor:** 终端用户

**Preconditions:**
- UC-1 已完成，Pi session 运行中

**Main Flow:**
1. 用户输入文本消息
2. 系统将消息放入队列
3. 系统通过 `{ type: "prompt" }` 发送给 Pi
4. Pi 返回事件流（text_delta, thinking_delta, tool_execution_start/end, turn_end）
5. 系统将 Pi 事件转换为 HAPI AgentMessage
6. HAPI 展示转换后的消息

**Alternative Paths:**
- 4a. Pi 返回 malformed JSON → 系统记录 warning，跳过该行（AC-8）
- 4b. Pi 进程 crash → 系统展示错误信息，清理 session（AC-7）

**Postconditions:** Pi 响应已完整展示

**Module Boundaries:** `cli/src/pi/runPi.ts` → `cli/src/pi/PiTransport.ts` → `cli/src/pi/PiEventConverter.ts`

**AC 覆盖:** AC-2, AC-7, AC-8

---

## UC-3: 用户中断 Pi 生成

**Actor:** 终端用户

**Preconditions:**
- Pi 正在生成响应

**Main Flow:**
1. 用户请求中断
2. 系统发送 `{ type: "abort" }` 给 Pi
3. Pi 停止生成
4. 系统恢复到 ready 状态

**Postconditions:** Pi 已停止生成，用户可发送新消息

**Module Boundaries:** `cli/src/pi/runPi.ts` → `cli/src/pi/PiTransport.ts`

**AC 覆盖:** AC-3

---

## UC-4: 用户切换模型

**Actor:** 终端用户（通过 HAPI session config RPC）

**Preconditions:**
- Pi session 运行中

**Main Flow:**
1. 用户通过 HAPI RPC 请求切换模型
2. 系统发送 `{ type: "set_model", provider, modelId }` 给 Pi
3. Pi 返回 `{ type: "response", command: "set_model", success: true }`
4. 系统确认模型切换成功

**Alternative Paths:**
- 3a. Pi 返回 `success: false` → 系统将错误转换为 HAPI error event（FR-5）

**Postconditions:** Pi 使用新模型

**Module Boundaries:** `cli/src/pi/runPi.ts` → `cli/src/pi/PiTransport.ts`

**AC 覆盖:** AC-4

---

## UC-5: 会话结束清理

**Actor:** 系统（HAPI 进程或 Pi 进程）

**Preconditions:**
- Pi session 运行中

**Main Flow (HAPI 退出):**
1. HAPI 收到 SIGTERM 或正常退出信号
2. 系统调用 `transport.kill()` 终止 Pi 子进程
3. 系统清理 session 资源

**Main Flow (Pi 退出):**
1. Pi 子进程异常退出（非零 exit code / signal）
2. 系统通过 `transport.onClose` 检测到退出
3. 系统向用户展示 "Pi process exited unexpectedly" 错误信息
4. 系统清理 session 资源，触发 session end

**Postconditions:** 所有资源已释放，无孤儿进程

**Module Boundaries:** `cli/src/pi/runPi.ts` → `cli/src/pi/PiTransport.ts`

**AC 覆盖:** AC-6, AC-7

---

## UC 覆盖映射表

| Spec AC | UC 覆盖 |
|---------|--------|
| AC-1 基本启动 | UC-1 |
| AC-2 消息收发 | UC-2 |
| AC-3 中断生成 | UC-3 |
| AC-4 模型切换 | UC-4 |
| AC-5 Pi 不可用 | UC-1 (alt path) |
| AC-6 HAPI 退出清理 | UC-5 |
| AC-7 Pi 异常退出 | UC-2 (alt), UC-5 |
| AC-8 JSONL 错误 | UC-2 (alt) |
