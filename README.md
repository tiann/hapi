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

## Docker (zs-hub + zs-runner)

使用 Docker 将 hub 和 runner 作为独立服务运行。runner 镜像预装了常用开发/运维工具，并支持运行时切换 Go/Node.js 版本。

```bash
cp .env.example .env
mkdir -p ./.claude

# 编辑 .env，至少设置：
# - CLI_API_TOKEN
# - CLAUDE_CONFIG_DIR（必须是宿主机绝对路径）

bun run docker:check
docker compose up -d --build zs-hub zs-runner
docker compose logs -f zs-hub zs-runner
```

> `bun run docker:check` 现在会同时校验 `.env` 语义与 `docker compose config --quiet`，可以在真正启动前尽早发现配置错误。

### 配置

- `CLI_API_TOKEN`: zs-hub 和 zs-runner 共用的密钥
- `ZS_API_URL`: CLI 连接 hub 的 URL (compose 网络内为 `http://zs-hub:3006`)
- `CLAUDE_CONFIG_DIR`: 挂载到容器的 Claude Code 认证/会话配置的宿主机绝对路径（必填）
- `ZS_GO_VERSION`: 运行时 Go 版本（默认 `1.24.3`，由 goenv 管理）
- `ZS_NODE_VERSION`: 运行时 Node.js 主版本号（默认 `22`，由 nvm 管理）
- `ZCF_API_KEY`: 运行时注入 Claude API Key（仅在设置时触发覆盖，不能填 URL）
- `ZCF_API_URL`: 运行时注入 Claude API URL（仅在设置时触发覆盖，必须是 `http(s)://` URL）
- `ZCF_API_MODEL`: 运行时覆盖主模型
- `ZCF_API_HAIKU_MODEL`: 运行时覆盖 Haiku 模型
- `ZCF_API_SONNET_MODEL`: 运行时覆盖 Sonnet 模型
- `ZCF_API_OPUS_MODEL`: 运行时覆盖 Opus 模型
- `ZCF_DEFAULT_OUTPUT_STYLE`: 运行时覆盖默认输出样式
- `ZCF_ALL_LANG`: 运行时统一覆盖语言参数
- `ZCF_AI_OUTPUT_LANG`: 运行时覆盖 AI 输出语言

### 运行模式

- 默认服务: `zs-runner` (前台运行 `zs runner start-sync`)
- 仅保留 `zs-hub` + `zs-runner`，不再提供 compose 交互 profile 服务。
- compose 已配置 healthcheck：`zs-hub` 通过 `/health` 探针检查，`zs-runner` 通过主进程命令行检查。
- GitHub Actions 会额外断言 `zs-runner` 的 `RestartCount=0` 且未进入 `Restarting`，避免“健康但实际处于重启环”的回归。

### 常见错误

- `CLAUDE_CONFIG_DIR` 未设置或不是绝对路径
- `.env` 不存在（先执行 `cp .env.example .env`）
- `ZCF_API_KEY` / `ZCF_API_URL` 写反（前者是 token，后者是 URL）

详细使用方法请参阅 [Runner Docker 独立使用指南](docs/guide/docker-runner.md)。

## 文档

- [快速开始](docs/guide/quick-start.md)
- [安装与部署](docs/guide/installation.md)
- [Runner Docker 使用](docs/guide/docker-runner.md)
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
