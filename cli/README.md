# zhushen CLI

在终端中运行 Claude Code、Codex、Cursor Agent、Gemini 或 OpenCode 会话，并通过 zs hub 进行远程控制。

## 功能概览

- 启动 Claude Code 会话并注册到 zhushen-hub。
- 启动 Codex 模式用于 OpenAI 会话。
- 启动 Cursor Agent 模式用于 Cursor CLI 会话。
- 通过 ACP（Anthropic Code Plugins）启动 Gemini 模式。
- 通过 ACP 与其插件 hook 系统启动 OpenCode 模式。
- 提供 MCP stdio bridge 供外部工具接入。
- 管理长时间运行会话的后台 runner。
- 提供诊断和认证辅助功能。

## 典型流程

1. 启动 hub 并设置环境变量（见 `../hub/README.md`）。
2. 在本机设置相同的 `CLI_API_TOKEN`，或运行 `zs auth login`。
3. 运行 `zs` 启动会话。
4. 在 Web 应用中监控和控制会话。

## 命令

### 会话命令

- `zs` - 启动 Claude Code 会话（透传 Claude CLI 参数）。见 `src/index.ts`。
- `zs codex` - 启动 Codex 模式。见 `src/codex/runCodex.ts`。
- `zs codex resume <sessionId>` - 恢复已有 Codex 会话。
- `zs cursor` - 启动 Cursor Agent 模式。见 `src/cursor/runCursor.ts`。
  支持 `zs cursor resume <chatId>`、`zs cursor --continue`、`--mode plan|ask`、`--yolo`、`--model`。
  支持本地与远程模式；远程模式使用 `agent -p` + `stream-json`。
- `zs gemini` - 通过 ACP 启动 Gemini 模式。见 `src/agent/runners/runAgentSession.ts`。
  说明：Gemini 当前仅支持远程模式，会等待来自 hub UI 的消息。
- `zs opencode` - 通过 ACP 启动 OpenCode 模式。见 `src/opencode/runOpencode.ts`。
  说明：OpenCode 支持本地与远程模式；本地模式通过 OpenCode 插件流式输出。

### 认证

- `zs auth status` - 显示认证配置与 token 来源。
- `zs auth login` - 交互输入并保存 `CLI_API_TOKEN`。
- `zs auth logout` - 清除已保存凭据。

见 `src/commands/auth.ts`。

### Runner 管理

- `zs runner start` - 以 detached 进程启动 runner。
- `zs runner stop` - 优雅停止 runner。
- `zs runner status` - 显示 runner 诊断信息。
- `zs runner list` - 列出 runner 管理的活跃会话。
- `zs runner stop-session <sessionId>` - 终止指定会话。
- `zs runner logs` - 输出最新 runner 日志路径。

见 `src/runner/run.ts`。

### 诊断

- `zs doctor` - 显示完整诊断（版本、runner 状态、日志、进程）。
- `zs doctor clean` - 清理失控的主神进程。

见 `src/ui/doctor.ts`。

### 其他

- `zs mcp` - 启动 MCP stdio bridge。见 `src/codex/happyMcpStdioBridge.ts`。
- `zs hub` - 启动内置 hub（单二进制工作流）。
- `zs server` - `zs hub` 的别名。

## 配置

完整配置见 `src/configuration.ts`。

### 必填项

- `CLI_API_TOKEN` - 共享密钥，必须与 hub 一致。可通过环境变量或 `~/.zhushen/settings.json` 设置（环境变量优先）。
- `ZS_API_URL` - hub 基础 URL（默认：`http://localhost:3006`）。

### 可选项

- `ZS_HOME` - 配置/数据目录（默认：`~/.zhushen`）。
- `ZS_EXPERIMENTAL` - 启用实验功能（`true/1/yes`）。
- `ZS_CLAUDE_PATH` - 指定 `claude` 可执行文件路径。
- `ZS_HTTP_MCP_URL` - `zs mcp` 的默认 MCP 目标。

### Runner

- `ZS_RUNNER_HEARTBEAT_INTERVAL` - 心跳间隔（毫秒，默认：60000）。
- `ZS_RUNNER_HTTP_TIMEOUT` - runner 控制 HTTP 超时（毫秒，默认：10000）。

### Worktree（由 runner 设置）

- `ZS_WORKTREE_BASE_PATH` - 仓库根路径。
- `ZS_WORKTREE_BRANCH` - 当前分支名。
- `ZS_WORKTREE_NAME` - worktree 名称。
- `ZS_WORKTREE_PATH` - 完整 worktree 路径。
- `ZS_WORKTREE_CREATED_AT` - 创建时间戳（毫秒）。

## 存储

数据存储在 `~/.zhushen/`（或 `$ZS_HOME`）：

- `settings.json` - 用户设置（machineId、token、onboarding 标记）。见 `src/persistence.ts`。
- `runner.state.json` - runner 状态（pid、port、version、heartbeat）。
- `logs/` - 日志文件。

## 运行要求

- 已安装并登录 Claude CLI（`claude` 在 PATH 中）。
- 使用 `zs cursor` 需安装 Cursor Agent CLI（`agent` 在 PATH 中）。
  安装命令：`curl https://cursor.com/install -fsS | bash`（macOS/Linux），`irm 'https://cursor.com/install?win32=true' | iex`（Windows）。
- 已安装 OpenCode CLI（`opencode` 在 PATH 中）。
- 从源码构建需安装 Bun。

## 从源码构建

在仓库根目录执行：

```bash
bun install
bun run build:cli
bun run build:cli:exe
```

若需构建同时内嵌 web app 的一体化二进制：

```bash
bun run build:single-exe
```

## 源码结构

- `src/api/` - Bot 通信（Socket.IO + REST）。
- `src/claude/` - Claude Code 集成。
- `src/codex/` - Codex 模式集成。
- `src/cursor/` - Cursor Agent 集成。
- `src/agent/` - 多 Agent 支持（Gemini via ACP）。
- `src/opencode/` - OpenCode ACP + hook 集成。
- `src/runner/` - 后台服务。
- `src/commands/` - CLI 命令处理。
- `src/ui/` - 用户界面与诊断。
- `src/modules/` - 工具实现（ripgrep、difftastic、git）。

## 相关文档

- `../hub/README.md`
- `../web/README.md`
