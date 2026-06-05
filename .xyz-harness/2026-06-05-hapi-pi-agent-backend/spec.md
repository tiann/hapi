---
verdict: pass
---

# Pi Agent Backend — CLI Local Mode

## Background

HAPI 是一个本地优先的 AI coding agent 远程控制平台。CLI 包装 agent 子进程，通过 Socket.IO 连接 Hub，Hub 再通过 SSE 广播给 Web/Telegram 客户端。

当前 HAPI 已支持 6 种 agent：Claude Code、Codex、Cursor、Gemini、Kimi、OpenCode。其中 Gemini/Kimi/OpenCode 通过 ACP 协议接入，Codex 通过自定义 JSON-RPC 接入。

Pi（`@earendil-works/pi-coding-agent`）是另一个本地优先的开源 coding agent CLI，支持 `--mode rpc` 提供 JSONL over stdio 的 RPC 协议。用户希望将 Pi 接入 HAPI，在终端通过 `hapi pi` 使用。

## Functional Requirements

### FR-1: Pi CLI 命令

`hapi pi` 启动 Pi agent 的本地 session。行为与 `hapi gemini` 对齐：
- 检测 `pi` 命令是否在 PATH 中可用
- spawn `pi --mode rpc` 子进程
- 通过 stdin/stdout JSONL 与 Pi 通信
- 接入 HAPI 的 session 管理、消息队列、keep-alive 机制

### FR-2: Pi RPC 协议适配

实现 Pi 的自定义 JSONL RPC 协议客户端（非 ACP JSON-RPC 2.0）：

**命令映射（HAPI → Pi）：**

| HAPI AgentBackend 方法 | Pi RPC 命令 | Pi 响应 |
|---|---|---|
| `newSession()` | `{ type: "new_session" }` | `{ type: "response", command: "new_session", success: true, data: { cancelled } }` |
| `prompt()` | `{ type: "prompt", message: "..." }` | `{ type: "response", command: "prompt", success: true }` + 事件流 |
| `cancelPrompt()` | `{ type: "abort" }` | `{ type: "response", command: "abort", success: true }` |
| `setModel()` | `{ type: "set_model", provider, modelId }` | `{ type: "response", command: "set_model", success: true, data: Model }` |
| — | `{ type: "get_state" }` | `{ type: "response", command: "get_state", success: true, data: RpcSessionState }` |

**事件映射（Pi → HAPI AgentMessage）：**

Pi 的 `AgentEvent` 通过 `type` 字段区分事件类型。`message_update` 事件携带 `assistantMessageEvent` 子字段，其 `type` 值区分文本类型：

| Pi 事件 (`AgentEvent.type`) | `assistantMessageEvent.type` | HAPI AgentMessage |
|---|---|---|
| `message_update` | `text_delta`（`delta` 字段为增量文本） | `{ type: 'text', text: delta }` |
| `message_update` | `thinking_delta`（`delta` 字段为增量文本） | `{ type: 'reasoning', text: delta, live: true }` |
| `tool_execution_start` | — | `{ type: 'tool_call', id, name, input, status: 'in_progress' }` |
| `tool_execution_end` | — | `{ type: 'tool_result', id, output, status }` |
| `turn_end` | — | 先 emit `{ type: 'usage', ...tokens }`，再 emit `{ type: 'turn_complete', stopReason }`（两次独立 emit） |
| `agent_end` | — | 断开连接，清理资源 |

`get_state` 用于 session 建立后首次调用，获取当前 model 和 streaming 状态，用于初始化 HAPI session 元数据。

### FR-3: 权限模型

Pi 无工具级权限审批机制。初始实现使用 yolo 模式，与 Gemini/OpenCode 的 yolo 模式行为一致。

### FR-4: Pi 命令检测

启动时检测 `pi` 是否可用。不可用时输出明确错误信息并退出（参考 `assertCodexLocalSupported` 模式）。

## Acceptance Criteria

### AC-1: 基本启动和交互
- Given `pi` 在 PATH 中可用
- When 执行 `hapi pi`
- Then spawn `pi --mode rpc`，建立 JSONL 通信，创建 session，进入交互循环

### AC-2: 消息收发
- Given Pi session 已建立
- When 用户发送文本消息
- Then 消息通过 `{ type: "prompt" }` 发送给 Pi，Pi 的响应事件被转换为 HAPI AgentMessage 并展示

### AC-3: 中断生成
- Given Pi 正在生成响应
- When 用户请求中断
- Then 发送 `{ type: "abort" }` 给 Pi，Pi 停止生成

### AC-4: 模型切换
- Given Pi session 已建立
- When 通过 HAPI session config RPC 切换模型
- Then 发送 `{ type: "set_model" }` 给 Pi，收到 `{ type: "response", command: "set_model", success: true }` 响应即视为成功

### AC-5: Pi 不可用
- Given `pi` 不在 PATH 中
- When 执行 `hapi pi`
- Then 输出 "pi is not installed or not in PATH" 类错误信息，进程以非零退出码退出

### AC-6: HAPI 退出时的进程清理
- Given Pi session 运行中
- When HAPI 进程退出（正常退出或 SIGTERM）
- Then Pi 子进程被正确终止，无孤儿进程

### AC-7: Pi 子进程异常退出
- Given Pi session 运行中
- When Pi 子进程异常退出（非零 exit code 或 signal）
- Then HAPI 检测到子进程退出，向用户展示错误信息（"Pi process exited unexpectedly"），清理 session 资源，触发 session end

### AC-8: JSONL 协议错误
- Given Pi session 运行中
- When Pi stdout 输出无法解析为 JSON（malformed JSONL）
- Then 记录 warning 日志，丢弃该行，不中断 session
- When stdin 写入失败（EPIPE / pipe broken）
- Then 视为 Pi 已退出，按 AC-7 处理

### FR-5: 协议错误处理

JSONL 传输层需处理以下错误场景：

| 错误类型 | 处理方式 |
|---------|----------|
| Malformed JSON（解析失败） | 记录 warning 日志，丢弃该行，继续读取下一行 |
| JSONL 行缓冲不完整（partial read） | 缓冲至换行符出现后再解析（标准 JSONL 行协议） |
| stdin 写入失败（EPIPE） | 视为 Pi 已退出，触发清理流程（同 AC-7） |
| Pi 返回 `{ type: "response", success: false }` | 将 error 消息转换为 HAPI error event，通知用户 |

## Constraints

- **零新增依赖**：不引入 Pi 的任何 npm 包（`pi-agent-core`、`pi-ai`、`pi-coding-agent`），只 spawn 子进程
- **Scope 限制**：仅 CLI 本地模式，不涉及 Hub/Web 远程控制（后续 PR）
- **权限限制**：Pi 无 `request_permission` 能力，只支持 yolo 模式
- **协议版本**：基于 Pi RPC 协议的当前稳定版本。协议类型定义在 `pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts`，事件类型定义在 `pi-mono/packages/ai/src/types.ts`（`AssistantMessageEvent`）和 `pi-mono/packages/agent/src/types.ts`（`AgentEvent`）
- **TypeScript strict**：遵循项目 strict 模式
- **测试框架**：Vitest，运行命令 `bun run test`
- **代码风格**：4 空格缩进，遵循项目 ESLint 配置

## 业务用例

> 本需求为纯技术性功能接入，无直接业务用例。

## Complexity Assessment

**中等复杂度。**

**新建文件（~500 行）：**
- `cli/src/pi/` 目录：transport + protocol + event converter + runner（~400 行）
- `cli/src/pi/runPi.ts`：runner 入口（~80 行，参考 `cli/src/gemini/runGemini.ts`）
- `cli/src/commands/pi.ts`：CLI 命令定义（~40 行，参考 `cli/src/commands/gemini.ts`）

**修改文件：**
- `shared/src/modes.ts`：`AGENT_FLAVORS` 数组添加 `'pi'`、新增 `PI_PERMISSION_MODES = ['default', 'yolo']`、`getPermissionModesForFlavor()` 添加 pi 分支（~5 行）
- `shared/src/flavors.ts`：`FLAVOR_CAPS` 添加 `'pi': new Set([Capabilities.ModelChange])`、`FLAVOR_LABELS` 添加 `'pi': 'Pi'`（~2 行）
- `cli/src/commands/registry.ts`：import 并注册 `piCommand`（~2 行）

架构模式与 Gemini 接入完全对齐，风险可控。

主要风险点：
1. Pi RPC 事件流的生命周期管理（turn_start/turn_end 的配对）
2. Pi 子进程异常退出时的清理
3. Thinking stream 的增量拼接（与 AcpMessageHandler 的 reasoning buffer 类似）

---

## Decisions Made

1. **不使用 `AgentRegistry` + `runAgentSession` 通用 runner** — 当前该 runner 未被任何命令使用（仅有测试引用），风险不明。参考 Gemini 的独立 runner 模式更稳妥
2. **不尝试复用 `AcpStdioTransport`** — ACP 传输层内嵌了 JSON-RPC 2.0 的消息解析（id/method/params/result/error），与 Pi 的自定义 JSONL 格式不兼容。新写传输层更清晰
3. **Pi runner 独立于 Gemini/Codex runner** — Pi 的生命周期管理与 Gemini 不同（无需 hook server、无需 permission adapter），保持独立避免耦合
4. **事件转换不引入额外抽象** — 直接在 runner 内做 Pi event → AgentMessage 映射，不创建独立的 "PiMessageHandler" 类（规模不够大，不值得额外抽象层）

## Out of Scope

- Hub 远程 spawn（`hub/src/web/routes/machines.ts` 修改）
- Web UI agent 选择器（`web/src/components/NewSession/` 修改）
- Pi session 恢复（resume from Pi's SQLite session）
- Pi 的 `fork`/`clone`/`compact` 命令支持
- Pi 的图片输入支持（images 字段）
- Permission/tool approval 机制
- Pi 配置透传（`PI_PERMISSION_MODES` env 等）
