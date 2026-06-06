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
- TS-5/TS-6/TS-7 需要手动操作（进程信号模拟），其他可通过集成测试自动化

## Manual E2E Protocol Tests (TC-4)

这些测试需要真实 Pi + Hub 环境，验证完整 RPC 协议对接。

### 前置条件

```bash
# 编译 HAPI
bun run build:single-exe
HAPI_BIN=cli/dist-exe/bun-darwin-arm64/hapi

# 终端 1: 启动 hub
$HAPI_BIN server
# 记下生成的 CLI_API_TOKEN

# 终端 2: 设置 token
TOKEN=<hub生成的token>
```

### P0: 必须验证

| ID | 场景 | 命令/操作 | 验证点 |
|-----|------|----------|--------
| TC-4-02 | 文件读取工具 | `echo 'test' > /tmp/t.txt` → hapi pi → "Read /tmp/t.txt" | `tool_execution_start{toolCallId,toolName,args}` + `tool_execution_end{result,isError:false}` 字段名与 types.ts 匹配 |
| TC-4-04 | 工具执行失败 | hapi pi → "Read /tmp/no-exist.txt" | `tool_execution_end{isError:true}` → HAPI 显示错误 |
| TC-4-05 | 思考生命周期 | hapi pi → "What is 17^13?" | `thinking_delta` → `thinking_end` → `text_delta` → `text_end` 完整序列 + usage 数据 |
| TC-4-06 | 多轮上下文 | round1: "My color is blue" → round2: "What is my color?" | 回答包含 "blue"，turn_end/turn_start 循环正常 |
| TC-4-07 | 中断生成 | 发长问题 → 2秒后 Ctrl+C | 生成停止，session 不 crash |

### P1: 应该验证

| ID | 场景 | 命令/操作 | 验证点 |
|-----|------|----------|--------
| TC-4-01 | 基础对话 | hapi pi → "Say hello world" | 完整事件序列：response→agent_start→text_delta→turn_end→agent_end |
| TC-4-03 | 文件写入工具 | hapi pi → "Create /tmp/test.txt with hello" | `tool_execution_start/end` 另一种工具类型 |
| TC-4-11 | 模型切换 | 通过 web UI 切换模型 | `set_model` RPC 发送 + response.success=true |
| TC-4-14 | Token 计数 | hapi pi → "Hello" | `turn_end.message.usage` 含 input>0, output>0, totalTokens>0 |

### P2: 边缘场景

| ID | 场景 | 命令/操作 | 验证点 |
|-----|------|----------|--------
| TC-4-08 | Pi 不在 PATH | `PATH=/tmp CLI_API_TOKEN=$TOKEN $HAPI_BIN pi` | 报错 "not found"，exit != 0 |
| TC-4-09 | Hub 未启动 | 停 hub → `CLI_API_TOKEN=$TOKEN $HAPI_BIN pi` | 连接错误，exit != 0 |
| TC-4-10 | 无效 token | `CLI_API_TOKEN=wrong $HAPI_BIN pi` | 401/Invalid token |
| TC-4-12 | Ctrl+C 退出 | hapi pi → Ctrl+C | 无孤儿 pi 进程，session 结束 |
| TC-4-13 | Pi 崩溃 | hapi pi (终端A) → `pkill -f 'pi --mode rpc'` (终端B) | 错误消息，session 清理 |
| TC-4-15 | 扩展事件 | hapi pi 启动 | `extension_ui_request` 被静默忽略 |

### 实测协议数据参考

Pi `--mode rpc` 实际输出的事件序列（2026-06-06 实测验证）：

```
启动 → extension_ui_request* (静默忽略)
发送 prompt → response{command:"prompt",success:true}
              → agent_start
              → turn_start
              → message_start(user) → message_end(user)
              → message_start(assistant)
              → message_update{thinking_start} → message_update{thinking_delta}* → message_update{thinking_end}
              → message_update{text_start} → message_update{text_delta}* → message_update{text_end}
              → message_end(assistant)
              → turn_end{message.usage:{input,output,totalTokens,...},toolResults:[]}
              → agent_end
```
