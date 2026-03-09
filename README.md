# 主神 (Zhushen)

在本地运行官方 Claude Code / Codex / Gemini / OpenCode 会话，并通过 Web / PWA 远程控制。

> **为什么选择主神?** 主神是 Happy 的本地优先替代方案。详见 [为什么选择主神](docs/guide/why-hapi.md)。

## 特性

- **无缝切换** - 在本地工作，需要时切换到远程，随时切换回来。无上下文丢失，无需重启会话。
- **原生优先** - 主神包装你的 AI 代理而非替代它。同样的终端、同样的体验、同样的操作习惯。
- **离开也不停** - 离开工位？在手机上一键批准 AI 请求。
- **自由选择 AI** - Claude Code、Codex、Cursor Agent、Gemini、OpenCode -- 不同模型，统一工作流。
- **随时随地终端** - 从手机或浏览器运行命令，直连工作机器。

## 演示

https://github.com/user-attachments/assets/38230353-94c6-4dbe-9c29-b2a2cc457546

## 快速开始

```bash
npx @jlovec/zhushen hub --relay     # 启动 hub 并开启端到端加密中继
npx @jlovec/zhushen                 # 运行 claude code
```

终端会显示一个 URL 和二维码。用手机扫描二维码或在浏览器中打开该 URL 即可访问。

> 中继使用 WireGuard + TLS 进行端到端加密。你的数据从设备到机器全程加密。

如需自托管方案 (Cloudflare Tunnel、Tailscale)，请参阅[安装指南](docs/guide/installation.md)。

## Breaking Changes (从 hapi 迁移)

本项目已从 `hapi` 重命名为 `主神 / zhushen`。以下是迁移要点：

| 旧值 | 新值 | 说明 |
|------|------|------|
| 命令 `hapi` | 命令 `zs` | CLI 命令硬切，不保留旧别名 |
| 包名 `@jlovec/hapi` | `@jlovec/zhushen` | npm 包名变更 |
| `HAPI_*` 环境变量 | `ZS_*` 环境变量 | 所有环境变量前缀变更 |
| `~/.hapi/` | `~/.zhushen/` | 配置目录变更 |
| `@hapi/protocol` | `@zs/protocol` | 内部协议包变更 |

迁移命令示例：

```bash
# 旧方式
hapi hub --relay
export HAPI_API_URL="http://your-hub:3006"
export HAPI_HOME="~/.hapi"

# 新方式
zs hub --relay
export ZS_API_URL="http://your-hub:3006"
export ZS_HOME="~/.zhushen"
```

如需迁移现有数据：

```bash
cp -r ~/.hapi/* ~/.zhushen/
```

## Docker (Hub + CLI)

使用 Docker 将 hub 和 CLI 作为独立服务运行。

```bash
cp .env.example .env
# 先在 .env 中设置 CLI_API_TOKEN 和 CLAUDE_CONFIG_DIR

docker compose up -d hub cli-runner
```

### 配置

- `CLI_API_TOKEN`: hub 和 CLI 共用的密钥
- `ZS_API_URL`: CLI 连接 hub 的 URL (compose 网络内为 `http://hub:3006`)
- `CLAUDE_CONFIG_DIR`: 挂载到容器的 Claude Code 认证/会话配置的宿主机绝对路径（必填）

### CLI 模式

- 默认服务: `cli-runner` (前台运行 `zs runner start-sync`)
- 可选交互模式:

```bash
docker compose --profile interactive run --rm cli
```

也可以覆盖命令，例如:

```bash
docker compose --profile interactive run --rm cli --help
```

## 文档

- [快速开始](docs/guide/quick-start.md)
- [安装与部署](docs/guide/installation.md)
- [工作原理](docs/guide/how-it-works.md)
- [应用](docs/guide/pwa.md)
- [Cursor Agent](docs/guide/cursor.md)
- [为什么选择主神](docs/guide/why-hapi.md)
- [常见问题](docs/guide/faq.md)

## 从源码构建

```bash
bun install
bun run build:single-exe
```

## 讨论

- GitHub: [Issues](https://github.com/jlovec1024/hapi/issues)

## 致谢

主神（zhushen）的灵感来源于《无限恐怖》中的"主神空间"。项目前身为 [HAPI](https://github.com/jlovec1024/hapi)，即"哈皮"，是 [Happy](https://github.com/slopus/happy) 的中文音译。感谢原项目 hapi 和 Happy 的贡献。
