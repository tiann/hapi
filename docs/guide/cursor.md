# Cursor Agent

主神支持 [Cursor Agent CLI](https://cursor.com/docs/cli/using)，可在网页和手机端远程控制 Cursor 的 AI 编程代理。

## 前置条件

安装 Cursor Agent CLI：

- **macOS/Linux：** `curl https://cursor.com/install -fsS | bash`
- **Windows：** `irm 'https://cursor.com/install?win32=true' | iex`

验证安装：

```bash
agent --version
```

## 用法

```bash
zs cursor                    # 启动 Cursor Agent 会话
zs cursor resume <chatId>    # 恢复指定会话
zs cursor --continue         # 恢复最近一次会话
zs cursor --mode plan        # 以 Plan 模式启动
zs cursor --mode ask         # 以 Ask 模式启动
zs cursor --yolo             # 跳过审批提示（--force）
zs cursor --model <model>    # 指定模型
```

## 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 标准代理行为 |
| `plan` | Plan 模式：编码前先设计方案 |
| `ask` | Ask 模式：只探索代码，不修改 |
| `yolo` | 跳过审批提示 |

可通过 `--mode` 指定模式，也可以在会话中从 Web UI 切换。

## 运行模式

- **本地模式**：在终端运行 `zs cursor`，交互体验完整。
- **远程模式**：在 Web/手机端拉起（无终端场景）。底层使用 `agent -p` + `--output-format stream-json` + `--trust`。每条用户消息会拉起一个 Agent 进程，会话通过 `--resume` 延续。

## 限制说明

- **工具审批**：远程模式默认使用 `--trust`，工具不会逐次审批。若需完全跳过审批可用 `--yolo`。
- **会话恢复**：通过 `--resume <chatId>` 或 `--continue` 恢复；可用 `agent ls` 查看历史会话和 chat ID。

## 集成效果

启动后，Cursor 会话会出现在主神 Web 应用中。你可以：

- 监控会话活动
- 在手机端审批权限
- 在本地模式下发送消息（切换时消息会排队）

## 相关链接

- [Cursor CLI Documentation](https://cursor.com/docs/cli/using)
- [How it Works](./how-it-works.md) - 架构与数据流
