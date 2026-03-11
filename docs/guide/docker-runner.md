# Runner Docker 独立使用指南

本文档介绍如何使用 Docker 构建和运行主神 runner 镜像（`zs-runner`），以及如何与 `zs-hub` 通过 compose 协同运行。

## 构建镜像

从仓库根目录构建：

```bash
docker compose build zs-runner
```

或手动构建：

```bash
docker build -f Dockerfile.runner -t zs-runner:local .
```

## 运行方式

### 作为后台 Runner 服务

推荐先完成环境检查，再启动 compose：

```bash
cp .env.example .env
mkdir -p ./.claude

# 编辑 .env：
# - CLI_API_TOKEN=your-secret
# - CLAUDE_CONFIG_DIR=/absolute/path/to/your/.claude

bun run docker:check
docker compose up -d --build zs-hub zs-runner
docker compose logs -f zs-hub zs-runner
```

`bun run docker:check` 会同时检查：

- `.env` 是否存在、关键变量是否齐全；
- `ZCF_API_KEY` / `ZCF_API_URL` 是否满足语义约束；
- `docker compose config --quiet` 是否可以成功展开当前配置。

`zs-runner` 默认以前台模式运行 `zs runner start-sync`，保持容器常驻并与 `zs-hub` 同步。

### 直接使用 docker run

```bash
docker run --rm -it \
  -e ZCF_API_KEY=ah-your-api-key \
  -e ZCF_API_URL=https://your-api-host \
  -v ~/.claude:/root/.claude \
  zs-runner:local \
  bun run --cwd cli src/index.ts --help
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLI_API_TOKEN` | - | `zs-hub` 和 `zs-runner` 共用的认证密钥 |
| `ZS_API_URL` | `http://zs-hub:3006` | runner 连接 `zs-hub` 的 URL |
| `CLAUDE_CONFIG_DIR` | - | 宿主机 Claude 配置目录（必须挂载） |
| `ZS_GO_VERSION` | `1.24.3` | 运行时 Go 版本（由 goenv 管理） |
| `ZS_NODE_VERSION` | `22` | 运行时 Node.js 版本（由 nvm 管理） |
| `ZCF_API_KEY` | - | 运行时注入 Claude API Key（仅在设置时触发覆盖，不能填 URL） |
| `ZCF_API_URL` | - | 运行时注入 Claude API URL（仅在设置时触发覆盖，必须是 `http(s)://` URL） |
| `ZCF_API_MODEL` | - | 运行时覆盖主模型 |
| `ZCF_API_HAIKU_MODEL` | - | 运行时覆盖 Haiku 模型 |
| `ZCF_API_SONNET_MODEL` | - | 运行时覆盖 Sonnet 模型 |
| `ZCF_API_OPUS_MODEL` | - | 运行时覆盖 Opus 模型 |
| `ZCF_DEFAULT_OUTPUT_STYLE` | - | 运行时覆盖默认输出样式 |
| `ZCF_ALL_LANG` | - | 运行时统一覆盖语言参数 |
| `ZCF_AI_OUTPUT_LANG` | - | 运行时覆盖 AI 输出语言 |

说明：

- compose demo 中不再暴露 `ZS_CLAUDE_PATH`，避免误改导致运行异常；
- runner 镜像默认 `ZS_HOME=/data`，compose 中不再配置 `ZS_HOME`；
- `claude` 在镜像构建时已预安装；
- `zcf` 默认配置改为容器启动时首次初始化（当 `/root/.claude` 为空时触发），首次启动会比后续启动更慢一些；
- `ZCF_API_KEY` 与 `ZCF_API_URL` 必须保持语义一致：前者是 token，后者是 URL；入口脚本会对明显写反的值发出告警并自动纠正。

## 运行时版本选择

容器启动时通过环境变量选择 Go 和 Node.js 版本。

- Node.js 使用 `nvm` 管理；
- Go 使用 `goenv` 管理；
- 当指定版本未安装时，会通过对应管理器自动安装；
- 安装失败时会报错并退出（非 0）。

### 预装版本

镜像构建时预装以下版本：

- **Node.js**: 20 / 22（nvm）
- **Go**: 1.22.12 / 1.24.3（goenv）

### 切换示例

```bash
# 使用 Go 1.22.12 和 Node.js 20
docker compose run --rm \
  -e ZS_GO_VERSION=1.22.12 \
  -e ZS_NODE_VERSION=20 \
  zs-runner go version

# 仅切换 Node.js 到 22
docker compose run --rm \
  -e ZS_NODE_VERSION=22 \
  zs-runner node -v
```

## 内置工具清单

| 工具 | 来源 | 说明 |
|------|------|------|
| `bun` | 基础镜像 | JavaScript/TypeScript 运行时和包管理器 |
| `node` / `npm` | nvm | Node.js 运行时 |
| `pnpm` | npm 全局 | 高性能 Node.js 包管理器 |
| `yarn` | npm 全局 | Node.js 包管理器 |
| `go` | goenv | Go 编程语言工具链 |
| `curl` | apt | HTTP 客户端 |
| `git` | apt | 版本控制 |
| `zs` | 本项目 | 主神 CLI 命令 |
| `claude` | npm 全局（`@anthropic-ai/claude-code`） | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) - Anthropic AI 编程助手 |
| `mss` | pnpm 全局 | [MCP Swagger Server](https://github.com/zaizaizhao/mcp-swagger-server) - Swagger/OpenAPI MCP 服务 |
| `trellis` | pnpm 全局 | [Trellis](https://docs.trytrellis.app/) - AI 代码代理，支持多文件编辑 |
| `ux` | pnpm 全局 | 用户体验 CLI 工具 |

### 依赖闭包说明

runner 运行时镜像会保留完整生产依赖闭包，优先保证 `zs` CLI 在容器内的真实启动链可用（例如 `tar` 等运行时依赖链）。

当前运行时镜像仅复制以下源码目录：

- `cli/`
- `shared/`

不再复制 `hub/`、`web/`、`website/`、`docs/` 源码目录。

## 验证命令

在 compose 模式下，建议优先使用：

```bash
bun run docker:check
docker compose up -d zs-hub zs-runner
docker compose ps
docker compose logs --tail=100 zs-hub zs-runner
```

> `bun run docker:check` 已内置 `docker compose config --quiet` 校验；`docker compose ps` 中可看到 `zs-hub` / `zs-runner` 的 health 状态；CI 也会执行 compose 级 smoke test，并额外断言 runner 没有进入 restart loop。

Runner 单镜像验证：

```bash
docker run --rm zs-runner:local zs --help
docker run --rm zs-runner:local claude --version
docker run --rm zs-runner:local bun --version
docker run --rm zs-runner:local node -v
docker run --rm zs-runner:local go version
docker run --rm zs-runner:local pnpm -v
docker run --rm zs-runner:local yarn -v
docker run --rm zs-runner:local curl --version
docker run --rm zs-runner:local git --version
docker run --rm -e ZS_NODE_VERSION=20 zs-runner:local node -v
docker run --rm -e ZS_GO_VERSION=1.22.12 zs-runner:local go version
docker run --rm zs-runner:local mss --help
docker run --rm zs-runner:local trellis --help
```


## 数据持久化

compose 配置使用命名卷持久化数据：

- `runner-data` -> `/data` (runner 配置和状态)
- `hub-data` -> `/data/zhushen` (`zs-hub` 数据库和配置)

Claude Code 配置通过绑定挂载 `CLAUDE_CONFIG_DIR` 目录到 `/root/.claude`，使容器使用宿主机的 Claude 认证信息。
