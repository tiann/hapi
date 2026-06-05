---
verdict: pass
---

# E2E Test Plan — hapi-pi-agent-backend

## Test Scenarios

### TS-1: Pi 不可用时启动失败 (AC-5)
- 前置条件：PATH 中无 `pi` 命令
- 步骤：执行 `hapi pi`
- 预期：输出错误信息，进程退出码非零

### TS-2: 基本启动与消息收发 (AC-1, AC-2)
- 前置条件：`pi` 在 PATH 中可用，`pi --mode rpc` 可正常启动
- 步骤：
  1. 执行 `hapi pi`
  2. 等待 session 建立
  3. 发送文本消息 "hello"
  4. 观察 Pi 响应事件流
- 预期：Pi 响应通过 HAPI session 正确展示

### TS-3: 中断生成 (AC-3)
- 前置条件：Pi session 已建立，Pi 正在生成响应
- 步骤：发送中断请求
- 预期：Pi 停止生成，HAPI session 恢复到 ready 状态

### TS-4: 模型切换 (AC-4)
- 前置条件：Pi session 已建立
- 步骤：通过 session config RPC 请求切换模型
- 预期：Pi 返回 success response，HAPI session 更新模型信息

### TS-5: 进程清理 (AC-6)
- 前置条件：Pi session 运行中
- 步骤：向 HAPI 进程发送 SIGTERM
- 预期：Pi 子进程被终止，无孤儿进程

### TS-6: Pi 异常退出处理 (AC-7)
- 前置条件：Pi session 运行中
- 步骤：模拟 Pi 子进程异常退出（kill -9 Pi PID）
- 预期：HAPI 检测到退出，展示错误信息，清理 session

### TS-7: JSONL 协议错误 (AC-8)
- 前置条件：Pi session 运行中
- 步骤：模拟 Pi stdout 输出 malformed JSON 行
- 预期：HAPI 记录 warning 日志，session 不中断

## Test Environment

- 需要 `pi` CLI 安装在 PATH 中（TS-1 需要临时移除）
- 运行在本地 macOS/Linux 环境
- 无需 Hub 或 Web 服务
- TS-5/TS-6/TS-7 需要手动操作（进程信号模拟），其他可通过集成测试自动化
