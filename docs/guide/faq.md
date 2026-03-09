# 常见问题（FAQ）

## 通用

### 主神是什么？

主神是一个本地优先（local-first）、自托管的平台，用于远程运行和控制 AI 编程代理（Claude Code、Codex、Gemini、OpenCode）。你可以在电脑上启动编码会话，并在手机上查看与控制。

### 主神名字代表什么？

主神（zhushen）是 “Happy” 的中文音译，表达了项目希望把 AI 编程协作变得更轻松愉快的目标。

### 主神免费吗？

是的。主神是开源项目，采用 AGPL-3.0-only 许可证，可免费使用。

### 主神支持哪些 AI Agent？

- **Claude Code**（推荐）
- **OpenAI Codex**
- **Cursor Agent**
- **Google Gemini**
- **OpenCode**

## 安装与配置

### 我必须单独部署 hub 吗？

不需要。主神内置 hub，直接运行 `zs hub` 即可。

完整部署方式（本地、relay、自托管隧道）见：[安装指南 - Hub 配置](./installation.md#hub-配置)。


### 如何在手机上访问主神？

推荐先阅读：[安装指南 - Hub 配置](./installation.md#hub-配置)。

简要原则：
- 局域网：直接访问 `http://<你的电脑IP>:3006`
- 公网：优先使用 `zs hub --relay`，或使用自托管隧道（Cloudflare/Tailscale）

### access token 是做什么的？

`CLI_API_TOKEN` 是共享密钥，用于 CLI 与 Web 登录认证。

首次启动 hub 时会自动生成，并保存到 `~/.zhushen/settings.json`。

更多认证与环境变量细节见：[安装指南 - CLI 配置](./installation.md#cli-配置)。

### 支持多账号吗？

支持。我们通过 namespace 提供轻量级多账号能力，适用于团队共享 hub 场景。见 [Namespace（高级）](./namespace.md)。

## 使用相关

### 如何远程审批权限请求？

1. 当 AI Agent 请求权限（如编辑文件）时，你会收到通知
2. 在手机上打开主神
3. 进入对应会话
4. 对待处理权限选择批准或拒绝

### 如何接收通知？

主神支持以下方式：

1. **PWA Push Notifications**：授权后可在应用关闭时仍接收通知

### 可以远程启动会话吗？

可以，使用 runner 模式：

1. 在电脑运行 `zs runner start`
2. 机器会出现在 Web 应用的 “Machines” 列表
3. 点击即可从任意地点拉起新会话

### 如何查看变更文件？

在会话页面打开 “Files” 标签页可：

- 浏览项目文件
- 查看 git status
- 查看变更 diff

### 能在手机上给 AI 发送消息吗？

可以。打开任意会话后，直接在聊天界面发送消息给 AI Agent。

### 能远程访问终端吗？

可以。在 Web 应用中打开会话，进入 Terminal 标签页即可使用远程 shell。

## 安全

### 我的数据安全吗？

是的。主神采用本地优先设计：

- 数据保留在你的机器上
- 不上传到外部服务器
- 数据库存储在本地 `~/.zhushen/`

### token 认证安全性如何？

自动生成的 token 为 256-bit（密码学安全）。对外访问时请始终通过 HTTPS（建议配合隧道）。

### 别人能访问我的主神吗？

只有拿到你的 access token 才能访问。建议额外采取：

- 使用强且唯一的 token
- 对外访问始终使用 HTTPS
- 使用 Tailscale 构建私有网络

## 故障排查

### “Connection refused” 错误

- 确认 hub 正在运行：`zs hub`
- 检查防火墙是否放行 3006 端口
- 确认 `ZS_API_URL` 配置正确

### “Invalid token” 错误

- 重新执行 `zs auth login`
- 检查 CLI 与 hub 的 token 是否一致
- 确认 `~/.zhushen/settings.json` 中 `cliApiToken` 正确

### Runner 无法启动

```bash
# 查看状态
zs runner status

# 清理陈旧锁文件
rm ~/.zhushen/runner.state.json.lock

# 查看日志
zs runner logs
```

### 找不到 Claude Code

安装 Claude Code 或设置自定义路径：

```bash
npm install -g @anthropic-ai/claude-code
# 或
export ZS_CLAUDE_PATH=/path/to/claude
```

### 找不到 Cursor Agent

安装 Cursor Agent CLI：

```bash
# macOS/Linux
curl https://cursor.com/install -fsS | bash

# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex
```

并确保 `agent` 已加入 PATH。

### 如何运行诊断？

```bash
zs doctor
```

会检查 hub 连通性、token 有效性、Agent 可用性等。

## 对比

### 主神 vs Happy

| 维度 | Happy | HAPI |
|--------|-------|------|
| 设计 | Cloud-first | Local-first |
| 用户模型 | Multi-user | Single user |
| 部署 | 多服务 | 单二进制 |
| 数据 | 服务器端加密存储 | 数据不离开你的机器 |

详见 [Why HAPI](./why-hapi.md)。

### 主神 vs 直接使用 Claude Code

| 功能 | Claude Code | 主神 + Claude Code |
|---------|-------------|-------------------|
| 远程访问 | 否 | 是 |
| 手机控制 | 否 | 是 |
| 权限审批 | 仅终端 | 手机/Web |
| 会话持久化 | 否 | 是 |
| 多机器协作 | 手动 | 内置 |

## 参与贡献

### 如何参与贡献？

访问 [GitHub 仓库](https://github.com/jlovec1024/hapi)：

- 提交 issue
- 提交 PR
- 提出功能建议

### 在哪里反馈 bug？

请在 [GitHub Issues](https://github.com/jlovec1024/hapi/issues) 提交问题。
