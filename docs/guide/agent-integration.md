# 集成新 Agent：统一解决方案

为了支持除 Claude Code 之外的更多 Agent（如 Local LLM, Gemini, Codex 等），HAPI 采用了一套**统一的 Agent 协议 (Universal Agent Protocol, UAP)**。

本指南介绍了如何通过这套协议集成新的 Agent，并确保其在 Lark、Telegram 和 Web 界面中获得一致的体验。

## 核心架构

HAPI 的多 Agent 架构分为三层：

1.  **Agent Backend (CLI 端)**: 负责运行具体的 Agent 逻辑（调用 LLM、执行工具）。它必须将 Agent 的内部状态转换为 **标准消息格式**。
2.  **Sync Engine (Server 端)**: 负责消息的中转、持久化和会话管理。它不关心具体 Agent 的实现，只传输标准消息。
3.  **UI 适配层 (Lark/Web)**: 负责将标准消息渲染为用户界面（卡片、气泡）。

## 统一协议 (Unified Protocol)

所有 Agent 必须输出符合 `server/src/types/agentProtocol.ts` 定义的消息结构。

### 消息结构 (`AgentMessage`)

一个标准的 Agent 消息包含一个角色 (`role`) 和一组内容块 (`content`)。

```typescript
interface AgentMessage {
    role: 'user' | 'assistant' | 'agent';
    content: ContentBlock[];
}
```

### 内容块类型 (`ContentBlock`)

UI 层会自动根据这些块的类型渲染相应的界面元素。

| 类型 | 描述 | UI 表现 |
| :--- | :--- | :--- |
| `text` | 普通文本 | 文本消息或 Markdown 卡片 |
| `thinking` | 思考过程 | 可折叠的思考详情块 |
| `tool_use` | 工具调用请求 | 显示工具名称、参数预览，状态为 "Running" |
| `tool_result` | 工具执行结果 | 显示工具输出，更新对应的 `tool_use` 状态为 "Success/Error" |

### 示例

一个完整的交互过程可能包含如下消息流：

**1. Agent 思考并调用工具**
```json
{
  "role": "assistant",
  "content": [
    { "type": "thinking", "thinking": "用户想要查看文件..." },
    { 
      "type": "tool_use", 
      "id": "call_1", 
      "name": "ls", 
      "input": { "path": "./src" } 
    }
  ]
}
```

**2. 工具执行结果**
```json
{
  "role": "user",
  "content": [
    { 
      "type": "tool_result", 
      "tool_use_id": "call_1", 
      "content": "index.ts\nutils.ts" 
    }
  ]
}
```

**3. Agent 最终回复**
```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "目录中包含 index.ts 和 utils.ts。" }
  ]
}
```

## 如何接入新 Agent

### 1. 实现 Agent Backend
在 `cli/src/agent/backends/` 下创建一个新的 Backend（例如 `OllamaBackend`），实现 `AgentBackend` 接口。

关键在于 `prompt()` 方法，它必须将 LLM 的流式输出（Token 流）实时转换为上述的 **Content Blocks**。

### 2. 使用适配器
如果你的 Agent 输出是非结构化的文本（如 "思考: xxx\n执行: xxx"），你需要编写一个流式解析器（Parser），将其转换为结构化的 JSON 对象。

### 3. 注册 Flavor
在 `cli/src/agent/AgentRegistry.ts` 中注册你的新 Agent 类型。

```typescript
// cli/src/agent/AgentRegistry.ts
registerBackend('ollama', () => new OllamaBackend());
```

### 4. 验证 UI
HAPI Server 端已经内置了 `Universal Agent Message Converter` (`server/src/lark/messageConverter.ts`)。只要你的 Agent 输出符合标准协议，飞书机器人就能自动获得以下能力：
- ✅ 思考过程折叠
- ✅ 工具调用状态实时更新 (Running -> Success/Error)
- ✅ 结构化的结果展示
- ✅ 交互式卡片

## 现有实现参考

- **协议定义**: `server/src/types/agentProtocol.ts`
- **消息转换器**: `server/src/lark/messageConverter.ts`
- **卡片累加器**: `server/src/lark/responseAccumulator.ts`
