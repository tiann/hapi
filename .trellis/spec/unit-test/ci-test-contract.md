# CI 测试契约

> 定义 CI 中类型安全与测试门禁的要求。

---

## 本指南的边界

本指南只覆盖以下内容：

- CI 会运行哪些检查
- PR 前需要满足的本地一致性要求
- 失败分诊的预期方式

本指南**不**定义覆盖率阈值（见 `coverage-policy.md`）。

---

## 当前 CI 事实

根据 `.github/workflows/test.yml`：

- 触发条件：`push` 和 `pull_request`
- 核心检查包括：
  - `bun install`
  - `bun typecheck`
  - 为 CLI 配置集成测试环境文件
  - `bun run test`

---

## 贡献者契约

- 尽可能在本地运行与 CI 入口一致的检查
- 与测试相关的变更在合并前必须同时通过 typecheck 和 tests
- 所需的环境配置必须被文档化，并且可以稳定复现

---

## 失败处理

- 先对失败分类：typecheck、test 或 environment
- 修复根因；不要绕过检查

### Monorepo 测试失败分诊（CLI 变更）

当面向 CLI 的变更触发 `bun run test:cli` 失败时，按以下顺序分诊：

1. **先识别无关的全局失败**
   - 如果像 `src/agent/backends/acp/AcpSdkBackend.test.ts` 这样的非 runner 文件在目标区域之前或同时失败，应将其视为独立的基线问题。
   - 不要假设所有红灯测试都由当前变更引起。

2. **区分环境门控的集成测试与逻辑回归**
   - `src/runner/runner.integration.test.ts` 依赖本地 hub 可达性和 hook 时序。
   - 像 `beforeEach` 中出现 `Hook timed out in 10000ms` 这样的失败，首先是环境或运行时时序证据，而不是自动证明被修改的断言路径是错误的。

3. **对于进程生命周期变更，要显式验证状态迁移契约**
   - 如果命令行为依赖旧/新 PID 交接，测试就必须断言 PID 替换，而不仅仅是“某个 runner 仍然存活”。
   - 如果 stop/start 语义发生变化，需要重新检查辅助函数的返回契约（`void` 还是 `boolean`）以及所有调用方。

4. **在得出全量结论前，优先做窄范围验证**
   - 先运行 typecheck。
   - 再检查 diff 与失败堆栈位置。
   - 然后将失败归类为：
     - 无关的基线失败
     - 环境门控的集成测试失败
     - 已变更契约中的真实回归

### 本地 Runner / 生产业务隔离契约

对于 CLI runner 集成测试以及任何会启动真实本地进程的测试：

- 即使使用隔离的 `ZS_HOME`，也默认把本地 `runner` / `session` 生命周期测试视为**会影响宿主机**的测试。
- 状态文件或日志目录的隔离，**并不**保证以下内容被隔离：
  - 本地后台进程
  - 端口 / socket
  - 机器资源
  - 同一 worktree 中当前运行的开发流程
- 如果该机器正在承载真实生产业务或业务关键的本地自动化任务，**不要**在该机器上运行有干扰性的集成测试。
- 允许策略必须明确：
  - **生产 / 业务环境**：不允许任何干扰
  - **开发者本地环境**：只有当操作者主动运行测试并理解它可能停止/重启本地 runner 进程时，才允许干扰
- 可能杀死/重启 runner 进程的测试，必须在测试契约或测试说明中记录这一副作用。
- 在调试 runner 失败前，先判断观测到的问题属于：
  - 对生产/业务 runner 的影响
  - 本地测试干扰
  - 真实产品回归

### Runner 调试契约（执行 CWD 与业务工作目录）

当修改 CLI 进程启动行为（`spawnHappyCLI`、agent 入口点、runner 子进程拉起）时：

- 要区分**执行/运行时解析上下文**与**业务工作目录**。
- 在开发模式下，运行时必须从能正确解析 TS 入口、别名与资源的位置启动。
- 如果产品语义需要用户指定的工作目录，应将其显式作为 data/config/env 传递，而不是滥用进程执行 cwd。
- 任何改变 spawn 语义的辅助函数，都必须在所有 agent 入口点范围内进行审查，而不只是第一个失败路径。
- 集成测试必须同时验证：
  - 运行时可以成功启动
  - 会话元数据/行为仍然反映所请求的工作目录

如果 CI 新增覆盖率门禁，应引用 `coverage-policy.md` 中的策略（单一事实来源）。

---

## Bot 工作流契约

对于使用 `openai/codex-action@v1` 的 GitHub Actions bot 工作流：

- 在 action 步骤前显式准备 runner 本地的 `codex-home`
- 优先使用 `${{ runner.temp }}/codex-home`，不要隐式依赖 `~/.codex`
- 将 `read-server-info` 的 ENOENT 视为启动/runner 状态失败，而不是 prompt 失败
- 如果配置了自定义 `responses-api-endpoint`，它必须是一个完整的 Responses API URL，并以 `/responses` 结尾
- 不要传入 provider 根 URL，例如 `https://host/`，也不要传入不完整的 base URL，例如 `https://host/v1`
- 对于不能使用默认 OpenAI endpoint 的仓库，如果 `OPENAI_BASE_URL` 缺失或格式错误，应快速失败，而不是静默回退
- 如果日志出现 `stream disconnected before response.completed`，先验证 endpoint 路径，再验证上游服务是否完整支持 Responses 流式语义

---

## 本仓库中的参考文件

- `.github/workflows/test.yml`
- `package.json`
- `cli/vitest.config.ts`
- `web/vitest.config.ts`
