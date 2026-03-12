# 质量规范

> 后端开发的代码质量标准。

---

## 概述

HAPI Hub 通过以下方式保障质量：

- **严格 TypeScript** - 禁止隐式 any，启用严格空值检查
- 使用 **Bun test** 进行单元测试（内置测试运行器）
- 使用 **Zod** 做所有输入校验
- **优雅错误处理** - 遇到非法输入时不要让服务崩溃
- **命名空间隔离** - 所有数据都必须按 namespace 进行作用域限制

**构建与测试命令**：
```bash
bun test           # 运行测试
bun run typecheck  # 类型检查
bun run build      # 构建生产版本
```

---

## 禁止模式

### ❌ 绝不要使用

1. **`any` type**
   ```typescript
   // 错误示例
   function handle(data: any) { }

   // 正确示例
   function handle(data: unknown) { }
   ```

2. **Zod `.parse()` 会抛异常的** - 应改用 `.safeParse()`
   ```typescript
   // 错误示例 - throws on validation failure
   const data = schema.parse(body)

   // 正确示例 - returns result object
   const parsed = schema.safeParse(body)
   if (!parsed.success) return c.json({ error: '请求体无效' }, 400)
   ```

3. **SQL 字符串拼接** - 应使用预处理语句
   ```typescript
   // 错误示例 - SQL injection risk
   db.query(`SELECT * FROM sessions WHERE id = '${id}'`)

   // 正确示例
   db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
   ```

4. **直接使用 JSON.parse 且不做错误处理**
   ```typescript
   // 错误示例 - throws on invalid JSON
   const data = JSON.parse(row.metadata)

   // 正确示例 - use safeJsonParse
   import { safeJsonParse } from './json'
   const data = safeJsonParse(row.metadata)
   ```

5. **缺少 namespace 过滤条件的查询** - 避免数据泄漏
   ```typescript
   // 错误示例 - returns all sessions
   db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)

   // 正确示例 - scoped to namespace
   db.prepare('SELECT * FROM sessions WHERE id = ? AND namespace = ?').get(id, namespace)
   ```

6. **在 Socket.IO 事件处理器中抛异常**
   ```typescript
   // 错误示例 - crashes socket connection
   socket.on('event', (data) => {
       if (!valid(data)) throw new Error('Invalid data')
   })

   // 正确示例 - silently ignore or emit error event
   socket.on('event', (data) => {
       const parsed = schema.safeParse(data)
       if (!parsed.success) return
   })
   ```

7. **在 API 响应中暴露内部错误细节**
   ```typescript
   // 错误示例 - leaks implementation details
   return c.json({ error: error.message }, 500)

   // 正确示例 - generic message for 500s
   console.error('操作失败:', error)
   return c.json({ error: '服务器内部错误' }, 500)
   ```

8. **忽略 TypeScript 错误**
   ```typescript
   // 错误示例
   // @ts-ignore
   const value = data.prop

   // 正确示例 - fix the type
   const value = typeof data === 'object' && data !== null && 'prop' in data
       ? (data as { prop: unknown }).prop
       : undefined
   ```

9. **默认导出** - 应使用具名导出
   ```typescript
   // 错误示例
   export default function createRoutes() { }

   // 正确示例
   export function createRoutes() { }
   ```

10. **未检查 guard 的返回结果**
    ```typescript
    // 错误示例 - engine could be a Response
    const engine = requireSyncEngine(c, getSyncEngine)
    engine.getSessions()  // 如果 engine 是 Response，这里会触发 TypeError

    // 正确示例
    const engine = requireSyncEngine(c, getSyncEngine)
    if (engine instanceof Response) return engine
    engine.getSessions()  // 安全
    ```


## Bot 集成契约

对于调用 `openai/codex-action@v1` 的 GitHub Actions：

- 将 `responses-api-endpoint` 视为最终的 Responses API URL，而不是供应商的基础 URL。
- 要求自定义 endpoint 在 action 步骤运行前必须以 `/responses` 结尾。
- 在工作流预检中拒绝 `https://host/` 或 `https://host/v1` 这类格式错误的值。
- 优先显式配置 runner 本地的 `codex-home`，避免隐式依赖 `~/.codex`。
- 如果 URL 校验通过后运行仍然因 `stream disconnected before response.completed` 失败，应优先排查上游协议兼容性，而不是先怀疑 prompt 内容。

---

## 容器运行时契约

对于执行基于 Bun 的 CLI 的 Docker / runner 镜像：

- 将生产镜像的依赖闭包视为运行时契约，而不是构建优化细节。
- 除非你已经确认所有运行时传递依赖都已落入最终镜像，否则不要依赖过滤后的生产安装。
- 如果运行路径会导入 `tar` 这类包，应优先用真实启动命令验证最终镜像，而不是假设 lockfile 完整就足够。
- 对于 `ZCF_API_KEY` / `ZCF_API_URL` 这类成对 env 变量，在修改持久化配置前要先校验语义形态（`key` 不应像 URL，`url` 应能被解析为 URL）。
- 如果 entrypoint 在配置告警后仍可继续执行，要确保告警足够精确，能说明故障是否可恢复，还是应当终止启动。
- 要区分 **容器 entrypoint 命令** 与 **守护化 bootstrap 命令**。如果某个命令在发现已有后台进程后可能以 `0` 正常退出，它就不是合法的 Docker PID 1 契约。
- 如果某个 CLI 子命令会打印 `already running` 之类的信息然后 `process.exit(0)`，就不要直接把它接成长期运行的 Compose 服务命令。
- 对于带有 `restart: unless-stopped` 的 Compose 服务，要确认主进程设计为保持前台运行；否则一次成功退出也会变成重启循环。
- 增加可执行校验，不仅检查 `docker compose up`，还要确认服务在初始 bootstrap 后保持 `Up` 并进入 `healthy`。

## Runner 可用性结果契约

对于组合持久化元数据与实时探测结果的运行时 helper：

- 当调用方必须区分 `missing`、`stale`、`degraded`、`running` 时，不要把多结果运行时状态压缩成 `boolean`。
- 对于被多个命令使用的可用性 helper，应优先使用显式结果对象或可辨识联合类型。
- 只有在确认拥有者进程已经死亡时，才能删除持久化状态/锁元数据；传输失败或探测失败都不能直接推断所有权已陈旧。
- 当 `degraded` 状态是可能结果时，要明确记录调用方行为：`start` 可以接受降级启动，`doctor` 应展示降级健康状态，版本检查逻辑仍应视 runner 为存在。
- 该契约边界上的任何 helper 签名变更，都必须审计 CLI 命令、doctor/debug UI、自更新/重启流程中的所有调用方。

---

## ACP 会话完成顺序契约

对于 ACP 风格后端，若最终 prompt 完成与 session 更新分别通过不同异步通道到达：

- 当同一轮的 tool/message 更新仍可能在响应后到达时，不要把 prompt RPC 完成视为唯一的完成信号。
- 在进入响应后的静默等待前，要刷新本地最后更新时间标记，让等待窗口从“响应刚完成”开始，而不是沿用过时的响应前时间戳。
- 同一轮次必须保持发射顺序：尾随 tool 更新 → 缓冲的 assistant 文本刷新 → `turn_complete`。
- 任何完成顺序修复都必须配套回归测试，模拟 `response resolves first, tool updates arrive shortly after`。
- 如果顺序依赖静默窗口启发式，在测试里必须保证等待是有界且确定性的。

---

### ✅ 始终使用

1. 所有函数、类、类型都使用 **具名导出**
2. 所有外部输入（HTTP body、socket 事件）都使用 **Zod schema** 校验
3. 所有数据库查询都使用 **预处理语句**
4. 所有数据库查询都带 **namespace 过滤条件**
5. 路由中的依赖检查统一使用 **Guard 模式**（`T | Response`）
6. 多结果操作使用 **Result 类型**，不要直接抛异常
7. 所有 JSON 列读取都使用 **`safeJsonParse`**
8. 查询结果显式添加 **类型标注**（如 `as DbSessionRow | undefined`）
9. 捕获到的错误统一使用 **`unknown`** 类型（不要用 `any`）
10. 对订阅和事件监听器做好 **清理逻辑**

---

## 测试要求

### 测试框架

使用 Bun 内置测试运行器（`bun test`）：

```typescript
import { describe, expect, it } from 'bun:test'

describe('NotificationHub', () => {
    it('当会话变为就绪时发送通知', async () => {
        // 准备
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine, [channel])

        // 执行
        engine.emit({ type: 'session-ready', session: createSession() })

        // 断言
        expect(channel.readySessions).toHaveLength(1)
    })
})
```

### 测试模式

**优先使用 Fake/Stub，而不是 Mock**：

```typescript
// 正确示例 - 实现该接口
class FakeSyncEngine {
    private readonly listeners: Set<SyncEventListener> = new Set()

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: SyncEvent): void {
        for (const listener of this.listeners) {
            listener(event)
        }
    }
}

// 正确示例 - 记录调用的 stub
class StubChannel implements NotificationChannel {
    readonly readySessions: Session[] = []

    async sendReady(session: Session): Promise<void> {
        this.readySessions.push(session)
    }
}
```

**Store 测试使用内存数据库**：

```typescript
import { Store } from '../store'

function createTestStore(): Store {
    return new Store(':memory:')
}

describe('SessionStore', () => {
    it('创建并获取会话', () => {
        const store = createTestStore()
        const session = store.sessions.getOrCreateSession('test-tag', {}, null, 'default')
        expect(session.tag).toBe('test-tag')
    })
})
```

**为测试数据提供工厂函数**：

```typescript
function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        active: true,
        createdAt: 0,
        updatedAt: 0,
        metadata: null,
        ...overrides
    }
}
```

### 应该测试什么

**优先级 1 - 业务逻辑**：
- Store 操作（带 namespace 与版本控制的数据库 CRUD）
- 通知解析与路由
- Sync engine 状态迁移
- 合法/非法输入下的 Socket 事件处理器

**优先级 2 - 工具函数**：
- JSON 解析边界情况
- 带版本更新的冲突处理
- Schema 迁移正确性

**不要测试**：
- 框架样板代码（如 Hono 路由注册）
- 第三方库内部实现
- 简单 getter/setter

### 测试文件位置

测试文件与源文件放在一起：

```
notifications/
├── notificationHub.ts
├── notificationHub.test.ts  ← 同目录
└── eventParsing.ts
```


## 场景：Slash Command 跨层契约（Project + Nested）

### 1. 范围 / 触发条件
- 触发条件：修改了 slash command 发现流程的跨层命令契约。
- 为什么需要 code-spec 深度：
  - CLI 侧的 `listSlashCommands` 签名已变更。
  - 返回值中的 `source` 联合类型在 CLI/Hub/Web 间发生了变更。
  - Project 级命令扫描行为已变更为递归扫描。

### 2. 签名
- CLI 命令发现签名：
  - `cli/src/modules/common/slashCommands.ts`
  - `listSlashCommands(agent: string, projectDir?: string): Promise<SlashCommand[]>`
- CLI RPC 处理器签名：
  - `cli/src/modules/common/handlers/slashCommands.ts`
  - `registerSlashCommandHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void`
- 通用 handler 接线：
  - `cli/src/modules/common/registerCommonHandlers.ts`
  - 必须将 `workingDirectory` 传入 `registerSlashCommandHandlers`
- Hub/Sync 响应契约：
  - `hub/src/sync/rpcGateway.ts`
  - `hub/src/sync/syncEngine.ts`
  - `commands[].source: 'builtin' | 'user' | 'plugin' | 'project'`
- Web 类型契约：
  - `web/src/types/api.ts`
  - `SlashCommand.source: 'builtin' | 'user' | 'plugin' | 'project'`

### 3. 契约
- 请求契约（session RPC）：
  - 方法：`listSlashCommands`
  - 参数：`{ agent: string }`
  - 说明：`projectDir` 不通过 RPC 传输，而是在 CLI handler 注册时由 session 的 `workingDirectory` 推导。
- 响应契约：
  - 结构：`{ success: boolean; commands?: SlashCommand[]; error?: string }`
  - `SlashCommand` 字段：
    - `name: string`
    - `description?: string`
    - `source: 'builtin' | 'user' | 'plugin' | 'project'`
    - `content?: string`
    - `pluginName?: string`
- 环境变量/路径契约：
  - Global user commands (Claude): `${CLAUDE_CONFIG_DIR ?? ~/.claude}/commands`
  - Project commands (Claude): `<projectDir>/.claude/commands`
  - Global user commands (Codex): `${CODEX_HOME ?? ~/.codex}/prompts`
  - Project commands (Codex): `<projectDir>/.codex/prompts`

### 4. 校验与错误矩阵
- 目录不存在 / 无访问权限 -> 对该来源返回 `[]`（不抛异常）。
- Markdown 解析/frontmatter 失败 -> 保留命令，并采用回退的 description/content 行为。
- 对 user/project commands 不支持的 agent -> 返回 `[]`。
- 不同来源命令名重复 -> 按优先级合并（后面的来源覆盖前面的来源）。
- Web 查询中的 RPC 失败 -> UI 回退路径中仍应保留 builtins。

### 5. 良好 / 基线 / 反例
- Good：
  - Project 下存在 `.claude/commands/trellis/start.md`。
  - API 返回 `trellis:start`，且 `source: 'project'`。
- Base：
  - 不存在 project 命令目录。
  - API 返回 builtin 与可用的 user/plugin commands，且无错误。
- Bad：
  - UI/backend 的 `source` 联合类型不同步（如缺少 `'project'`）。
  - 现象：类型报错，或 project commands 在 Web 中被静默过滤。

### 6. 必需测试（含断言点）
- CLI 单元测试（`cli/src/modules/common/slashCommands.test.ts`）：
  - 不传 `projectDir` 时保持向后兼容。
  - 提供 `projectDir` 时能够加载 project commands。
  - 同名冲突时解析为 project command。
  - 嵌套路径能够映射成冒号命名（`trellis/start.md` -> `trellis:start`）。
  - project 目录缺失时不抛异常。
- 类型层检查：
  - 必须通过 `bun run typecheck`，确保 CLI/Hub/Web 的 `source` 联合类型一致。
- 集成验证：
  - 在 project 目录中拉起 session，并调用 `GET /api/sessions/:id/slash-commands`。
  - 断言响应中包含 `source: 'project'` 的 commands。

### 7. 错误示例 vs 正确示例
#### 错误示例
- 非递归扫描命令（仅扫描第一层 `.md` 文件）。
- 结果：`.claude/commands/<group>/` 下的嵌套命令不可见。

#### 正确示例
- 递归扫描 project 命令根目录下的 `.md` 文件。
- 将嵌套相对路径转换为以 `:` 分隔的命令名。
- 保持优先级合并规则：
  - `builtin -> user(global) -> plugin -> project` (project overrides same-name global command).

---

## 场景：面向上游协作与自定义产品线的分支拓扑契约

### 1. 范围 / 触发条件
- 触发条件：仓库工作流同时要求支持兼容上游的 PR，以及长期存在的自定义产品提交。
- 为什么需要 code-spec 深度：
  - Git 分支命名与来源基线是可执行的工作流契约。
  - 基线分支错误会直接导致 PR diff 被污染，并带来 force-push 风险。
  - 需要为 `origin` 与 `upstream` 明确 merge/rebase 及同步边界。

### 2. 签名
- 长期分支：
  - `main` (upstream mirror line)
  - `main-custom` (product line)
- 短期分支：
  - `pr/<topic>` (upstream contribution branch, created from `main`)
  - `feature/<topic>` (custom feature branch, created from `main-custom`)
- 远程仓库契约：
  - `upstream` = canonical repository
  - `origin` = fork repository

### 3. 契约
- 分支来源契约：
  - `pr/*` MUST branch from latest `main` (which mirrors `upstream/main`).
  - `feature/*` MUST branch from latest `main-custom`.
- 同步契约：
  - `main` may be hard-reset to `upstream/main`.
  - `main-custom` must absorb upstream via `merge main` (preferred) or `rebase main`.
- PR 契约：
  - Upstream PR head MUST be `origin:pr/*`.
  - `main-custom` commits MUST NOT be sent directly as upstream PR head.

### 4. 校验与错误矩阵
- Create upstream PR from `main-custom` -> error pattern: large unrelated diff; reject and recreate from `main`.
- Commit custom features on `main` -> policy violation; cherry-pick to `main-custom`, then reset `main` to upstream.
- Force-push `origin/main` without confirming impact -> high-risk operation; require explicit confirmation.
- Let `main-custom` drift for too long -> merge conflict spike; schedule periodic upstream sync.

### 5. 良好 / 基线 / 反例
- Good：
  - `main == upstream/main`; upstream fix developed in `pr/fix-xxx`; custom roadmap in `main-custom`.
- Base：
  - No custom work yet; `main-custom` currently equals `main`.
- Bad：
  - Single long-lived branch used for both upstream PRs and product work; PRs contain unrelated commits.

### 6. 必需测试（含断言点）
- Workflow checks (manual, required before opening PR):
  - `git merge-base --is-ancestor upstream/main HEAD` on `pr/*` should pass.
  - `git log --oneline upstream/main..HEAD` on `pr/*` should only show topic commits.
  - `git rev-list --left-right --count upstream/main...main` should be `0\t0` after sync.
- Hygiene checks:
  - Before force-pushing `origin/main`, assert no required unique commits are only on `origin/main`.
  - After syncing `main-custom` from `main`, run project smoke checks relevant to changed areas.

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# 从自定义产品线创建上游 PR 分支
git checkout main-custom
git checkout -b pr/fix-docker
```

#### 正确示例
```bash
# 从镜像 main 保持上游 PR 分支干净
git fetch upstream
git checkout main
git reset --hard upstream/main
git checkout -b pr/fix-docker
```

---

## 场景： Independent Development Mode (Origin-only Mainline)

### 1. 范围 / 触发条件
- 触发条件： Team decides to stop tracking upstream and move to fully independent development on fork remote only.
- 为什么需要 code-spec 深度：
  - Remote topology (`origin`/`upstream`) and branch tracking are executable workflow contracts.
  - Wrong migration sequence can leave rebase/merge half-state and block pull/push.
  - Requires explicit safety and recovery rules for conflict resolution during mainline transition.

### 2. 签名
- Long-lived branch signature:
  - `main` = independent product mainline (tracks `origin/main` only)
- Optional product branch signature:
  - `product/main` may exist as staging/integration branch, then merged into `main`
- Remote signatures:
  - `origin` = canonical remote after transition
  - `upstream` = removed in independent mode
- Transition command signatures:
  - `git branch -u origin/main main`
  - `git remote remove upstream`

### 3. 契约
- Canonical remote contract:
  - After transition, release/feature sync operations MUST use `origin/*` only.
- Mainline tracking contract:
  - `main` MUST track `origin/main`; detached or no-upstream state must be fixed before routine pull/push.
- Transition sequencing contract:
  - If `product/main` is source of truth, merge/rebase into `main` first, then update tracking/remotes.
- Conflict recovery contract:
  - If merge/rebase pauses with conflicts, resolve and complete (`rebase --continue` / merge commit) before any `pull`.
- Safety contract:
  - Before topology changes, create `backup/safety-*` anchor for current `main` tip.

### 4. 校验与错误矩阵
- `pull --rebase` while unresolved conflicts exist -> git blocks with unmerged files; resolve then continue/abort rebase.
- `branch --unset-upstream` on branch without upstream -> non-fatal; skip and set desired upstream directly.
- Attempting `remote remove upstream` when already removed -> non-fatal no-op; keep `origin` intact.
- `main` ahead/behind `origin/main` after transition -> run `pull --rebase origin main`, then push.
- Mixed commits (infra + unrelated web) during transition -> split into topic commits before merge to keep history readable.

### 5. 良好 / 基线 / 反例
- Good：
  - `main` tracks `origin/main`, no `upstream` remote, transition commit history is conflict-resolved and pushable.
- Base：
  - `upstream` already absent, but `main` upstream tracking still unset; set to `origin/main` and continue.
- Bad：
  - Topology switched mid-rebase without finishing conflict resolution; subsequent pull/push commands fail repeatedly.

### 6. 必需测试（含断言点）
- Topology assertions:
  - `git remote -v` returns only `origin` in independent mode.
  - `git branch -vv` shows `main` tracking `origin/main`.
- Workflow assertions:
  - `git pull --rebase origin main` succeeds (or reports up to date).
  - `git push origin main` succeeds after transition.
- Conflict-handling assertions:
  - During paused rebase, `git status` must clearly show unmerged paths; after resolution, status must clear conflict markers.

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# 在 rebase 冲突未解决时直接 pull
git pull --rebase origin main
# 在未确认 main 跟踪状态和待处理冲突前就先删除 upstream
```

#### 正确示例
```bash
# 1) resolve paused rebase/merge first
git status
git add <resolved-files>
git rebase --continue

# 2) set independent tracking
git branch -u origin/main main
git remote remove upstream

# 3) sync and publish
git pull --rebase origin main
git push origin main
```

## 场景：GitHub Actions Codex Home 契约（Bot Workflows）

### 1. 范围 / 触发条件
- 触发条件： GitHub Actions workflows invoke `openai/codex-action@v1` for PR review, mention response, or issue auto-response.
- 为什么需要 code-spec 深度：
  - The action writes runner-local server metadata into `codex-home`; if the directory contract is implicit, the workflow can fail before any prompt executes.
  - Failure shows up as action-internal `read-server-info` ENOENT, but the root cause is often missing runner-local state preparation or incompatible endpoint initialization.
  - The contract spans workflow YAML, runner temp filesystem, and external Responses API endpoint configuration.

### 2. 签名
- Workflow files:
  - `.github/workflows/codex-pr-review.yml`
  - `.github/workflows/codex-mention-response.yml`
  - `.github/workflows/issue-auto-response.yml`
- Action signature:
  - `uses: openai/codex-action@v1`
- Required action inputs/env for stable runner-local state:
  - `codex-home: ${{ runner.temp }}/codex-home`
  - a prior shell step creating that directory
- Endpoint signature:
  - `responses-api-endpoint: ${{ secrets.OPENAI_BASE_URL }}` only when the secret is confirmed to be Responses-API compatible.

### 3. 契约
- Runner-local state contract:
  - Workflow MUST create the directory used by `codex-home` before invoking `openai/codex-action@v1`.
- Isolation contract:
  - Workflow SHOULD use `${{ runner.temp }}` for `codex-home` instead of relying on default `~/.codex` state.
- Endpoint compatibility contract:
  - `responses-api-endpoint` MUST point to a Responses API compatible base endpoint; if compatibility is unknown, prefer the action default endpoint.
- Failure attribution contract:
  - `Error: Failed to read server info from <codex-home>/<run_id>.json` means the action could not observe the expected server metadata file; treat this as startup/contract failure, not prompt-content failure.

### 4. 校验与错误矩阵
- `ENOENT <codex-home>/<run_id>.json` -> directory missing or action startup failed before writing metadata; verify prepare step and `codex-home` path first.
- `codex-home` omitted -> action falls back to default `~/.codex`; environment-dependent behavior becomes harder to reproduce.
- Custom endpoint configured but not Responses compatible -> startup may fail before metadata file exists; retry with default endpoint or validated compatible base URL.
- Multiple bot workflows share identical assumptions -> fix all Codex workflows, not just the first failing one.

### 5. 良好 / 基线 / 反例
- Good：
  - Workflow creates `${{ runner.temp }}/codex-home`, passes `codex-home`, and Codex step starts consistently on fresh runners.
- Base：
  - Workflow uses default endpoint and explicit temp `codex-home`; no custom networking assumptions.
- Bad：
  - Workflow relies on implicit `~/.codex` and treats `read-server-info` ENOENT as flaky model behavior instead of startup contract failure.

### 6. 必需测试（含断言点）
- Workflow assertions:
  - Each workflow that uses `openai/codex-action@v1` has a preceding `Prepare Codex home` step.
  - Each such action call passes `codex-home: ${{ runner.temp }}/codex-home`.
- Failure triage assertions:
  - If ENOENT reappears, inspect `codex-home` setup and endpoint compatibility before changing prompts.
- Local review assertions:
  - `git diff` shows the directory-prepare step and `codex-home` input added consistently across all Codex workflows.

### 7. 错误示例 vs 正确示例
#### 错误示例
```yaml
- uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    prompt-file: .github/prompts/codex-pr-review.md
```

#### 正确示例
```yaml
- name: Prepare Codex home
  run: mkdir -p "${{ runner.temp }}/codex-home"

- uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    codex-home: ${{ runner.temp }}/codex-home
    prompt-file: .github/prompts/codex-pr-review.md
```

---

### 1. 范围 / 触发条件
- 触发条件： After code implementation, workflow requires automated branch governance, clean PR creation, review-driven iteration, and optional PR replacement.
- 为什么需要 code-spec 深度：
  - This flow executes hard-to-reverse git/gh operations (`squash/rebase/close PR/reopen PR`).
  - It spans local git state, fork remote (`origin`), upstream remote (`upstream`), and GitHub PR state.
  - Missing explicit safety contracts can lose commits or create polluted PR history.

### 2. 签名
- Command signatures:
  - `/trellis:branch-governor`
  - `/trellis:pr-autopilot`
- Recommended runtime args:
  - branch-governor: `mode=audit|fix`, `base=upstream/main`, `protect=product/main,contrib/upstream-main`, `splitPR=true|false`
  - pr-autopilot: `base=upstream/main`, `head=<feature-branch>`, `squash=one|auto|keep`, `watch=on|off`, `maxIterations=<int>`, `allowReopen=true|false`
- Branch role signatures:
  - `product/main`: product-only long-lived line
  - `contrib/upstream-main`: clean upstream contribution baseline
  - `contrib/<topic>`: per-feature PR branch created from `upstream/main`
  - `backup/safety-*`: non-loss safety anchors before history rewrite or PR replacement

### 3. 契约
- Safety contract:
  - Any operation that may rewrite history or replace PR MUST create `backup/safety-*` first.
- Source contract:
  - Upstream PR head MUST be based on `upstream/main` lineage, not product-only lineage.
- Commit hygiene contract:
  - `contrib/<topic>` SHOULD contain one topic-focused commit when feasible; if not feasible, commit set must still be single-topic.
- Review loop contract:
  - Only blocking review/PIA issues are auto-applied.
  - Non-blocking suggestions are batched into recommendation output, not blindly auto-committed.
- Replacement contract:
  - Close old PR only after new replacement PR exists and is referenced in close comment.

### 4. 校验与错误矩阵
- Missing safety anchor before rebase/squash/close PR -> policy violation; stop and create backup branch first.
- `contrib/*` branch not descendant of `upstream/main` -> high-risk polluted diff; recreate clean branch and cherry-pick topic commits.
- PR contains unrelated commits/files -> split by feature and reopen/replace PR.
- CI green but blocking review exists -> do not mark ready; iterate fix loop.
- Review comments ambiguous/non-reproducible -> output focused clarification plan instead of speculative code edits.
- Attempt to close PR before replacement PR exists -> reject operation.

### 5. 良好 / 基线 / 反例
- Good：
  - `branch-governor` audits topology, routes commits by function, then `pr-autopilot` opens a clean Chinese PR and iterates until no blocking signals.
- Base：
  - PR created cleanly; one blocking review comment handled in one additional fix commit.
- Bad：
  - Direct PR from product branch with private config commits, repeated force-push without safety anchor, and speculative fixes to non-blocking comments.

### 6. 必需测试（含断言点）
- Topology assertions:
  - `git merge-base --is-ancestor upstream/main HEAD` on `contrib/<topic>` must pass.
  - `git log --oneline upstream/main..HEAD` on PR branch contains only topic commits.
- Safety assertions:
  - Before rewrite operations, verify `refs/heads/backup/safety-*` exists.
- PR lifecycle assertions:
  - New PR creation returns valid URL.
  - Replacement flow asserts: new PR exists -> old PR close comment includes replacement reference.
- Review loop assertions:
  - Blocking comments produce concrete fix plan entries.
  - Non-blocking comments are reported but not auto-committed unless explicitly requested.

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# 直接从产品线分支发起带混合提交的 PR
git checkout product/main
gh pr create --base main --head product/main
# 然后在没有备份分支的情况下反复 force-push
```

#### 正确示例
```bash
# 1) create safety anchor before rewrite/split
git branch backup/safety-pr-<date> HEAD

# 2) create clean contrib branch from upstream baseline
git fetch upstream
git checkout -b contrib/<topic> upstream/main
git cherry-pick <topic-commits>

# 3) open PR from clean branch
gh pr create --base main --head <fork>:contrib/<topic>

# 4) if replacement needed: open new PR first, then close old PR with replacement link
```

---

## 场景：Docker Workflow Scope 契约（PR 校验 vs 主线发布）

### 1. 范围 / 触发条件
- 触发条件： GitHub Actions workflow both validates Docker images on PR and publishes images on `main` / tag pushes.
- 为什么需要 code-spec 深度：
  - PR checks and release publishing have different goals, costs, and failure surfaces.
  - If workflow scope is implicit, contributors may unintentionally run expensive multi-arch image builds on every PR even when no publish artifact is needed.
  - The contract spans workflow triggers, Buildx platform matrix, package permissions, and registry push policy.

### 2. 签名
- Workflow file:
  - `.github/workflows/docker-images.yml`
- Trigger signatures:
  - `pull_request` = validation only
  - `push` to `main` / `tag` = publish path
- Build signatures:
  - PR validation SHOULD prefer the cheapest build that still proves Dockerfile correctness.
  - Publish path MAY use multi-arch build (`linux/amd64,linux/arm64`) and registry push.
- Push signature:
  - `pr-validate`: `push: false`
  - `publish`: `push: true`

### 3. 契约
- Responsibility contract:
  - PR workflow MUST answer a concrete validation question (for example: “Dockerfile still builds”).
  - If the PR path does not produce a user-visible artifact, it MUST avoid release-grade cost by default.
- Cost boundary contract:
  - Multi-arch Buildx + QEMU SHOULD be reserved for `main` / tag publish path unless PR specifically needs cross-arch verification.
- Publish boundary contract:
  - Registry login and image push MUST NOT happen on `pull_request`.
- Trigger precision contract:
  - Docker workflows SHOULD use path filters or separate jobs so PRs only run image validation when Docker-related inputs changed.
- Escalation contract:
  - If arm64 compatibility is a real product requirement before merge, document that explicitly and keep a dedicated PR verification job instead of piggybacking on publish workflow semantics.

### 4. 校验与错误矩阵
- PR runs Docker workflow, `push=false`, but still performs full multi-arch Buildx/QEMU build -> likely process smell; validation exists, but cost is mis-scoped.
- PR runs single-arch local-equivalent build and catches Dockerfile regression -> expected validation path.
- `main` / tag push skips multi-arch publish -> release contract gap; users may receive stale or missing images.
- PR path logs in to GHCR or requests package write unnecessarily -> permission boundary violation.

### 5. 良好 / 基线 / 反例
- Good：
  - PR only verifies required image buildability with the minimum platform scope; `main` / tags perform multi-arch publish.
- Base：
  - PR uses the same Dockerfile but builds `linux/amd64` only with `load: false` / `push: false`; release path adds login and multi-arch push.
- Bad：
  - Every PR pays full QEMU + multi-arch build cost even though the result is never pushed or consumed.

### 6. 必需测试（含断言点）
- Workflow assertions:
  - `pull_request` path does not push images.
  - PR path does not require `packages: write` unless technically unavoidable.
  - PR validation job uses documented minimal platform scope.
  - `main` / tag path still performs the intended publish flow.
- 评审断言：
  - For any Docker workflow change, reviewers must ask: “Is this job validating, publishing, or both?”
  - If both, reviewers must verify that cost/permission boundaries are explicit in YAML.

### 7. 错误示例 vs 正确示例
#### 错误示例
```yaml
jobs:
  build:
    steps:
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
```

#### 正确示例
```yaml
jobs:
  pr-validate:
    if: github.event_name == 'pull_request'
    steps:
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64
          push: false

  publish:
    if: github.event_name != 'pull_request'
    steps:
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64,linux/arm64
          push: true
```

---

## 场景：合并后冲突解决契约（Workflow Dependencies + Runtime Availability）

### 1. 范围 / 触发条件
- 触发条件： a branch resolves merge conflicts in files that encode executable behavior, especially:
  - `.github/workflows/*.yml`
  - runtime lifecycle helpers such as `cli/src/runner/controlClient.ts`, `cli/src/runner/run.ts`
- 为什么需要 code-spec 深度：
  - Conflict resolution often preserves syntax while silently breaking job graphs, step ordering, or caller semantics.
  - The bug may not be local to the conflicted file; it often appears in the next caller that interprets the merged result.

### 2. 签名
- Workflow dependency signature:
  - `jobs.<job>.needs`
- Workflow release gate signature:
  - validation/smoke steps MUST precede any `push: true` artifact publish
- Runtime availability signature:
  - `getRunnerAvailability(): Promise<{ status: 'missing' | 'stale' | 'degraded' | 'running'; ... }>`
  - `isRunnerRunningCurrentlyInstalledHappyVersion(): Promise<boolean>`
  - `startRunner()` caller branch in `cli/src/runner/run.ts`

### 3. 契约
- Workflow graph contract:
  - every `needs:` reference MUST resolve to an existing job in the same merged workflow file.
- Publish ordering contract:
  - smoke/validation steps that protect artifact quality MUST run before the irreversible publish step.
- Artifact identity contract:
  - pre-publish compose or smoke validation MUST run against explicitly tagged candidate images prepared before publish, and MUST avoid rebuilding from the workspace inside the smoke step.
  - if publish rebuilds later for release-only concerns (for example multi-arch output), reviewers MUST explicitly confirm that the smoke gate still executes before any irreversible push and that the smoke step is not silently validating a different ad-hoc local image after publish.
- Availability caller contract:
  - helpers that answer “runner is healthy and reusable now” MUST return `true` only for `running`; `degraded` may preserve ownership/state, but it MUST NOT be treated as a healthy reusable control plane.
- Conflict-resolution contract:
  - after merging, review the helper and every side-effecting caller in the same chain before considering the conflict resolved.

### 4. 校验与错误矩阵
- `needs:` points to removed job -> workflow invalid, guarded job never runs.
- Smoke test exists but runs after `push: true` -> bad artifact can already be published.
- Smoke test rebuilds from the workspace (`docker compose up --build`) instead of loading the candidate artifact -> validation no longer proves the published image works.
- Helper returns `true` for `degraded`, caller maps `true -> skip startup / reuse existing runner` -> later RPC or session operations still fail on the unavailable control plane.
- File looks merged cleanly, but caller chain was not replayed -> semantic regression survives review.

### 5. 良好 / 基线 / 反例
- Good：
  - merged workflow keeps valid `needs`, smoke validation runs before publish against the candidate image, and only `running` counts as reusable runner health.
- Base：
  - workflow passes syntax but still requires explicit `gh`/review inspection of job graph, order, and validated artifact identity.
- Bad：
  - merge only removes conflict markers; no one checks dependency edges, publish ordering, artifact identity, or downstream caller behavior.

### 6. 必需测试（含断言点）
- Workflow assertions:
  - no `needs:` entry references a missing job.
  - smoke/validation runs before artifact push.
  - smoke/validation loads the candidate artifact and avoids rebuilding from the workspace.
- Runtime assertions:
  - `degraded` availability does not trigger `stopRunner()` or forced restart path.
  - `degraded` availability does not satisfy helpers/callers that mean “runner is healthy and reusable now”.
  - same-PID stale state remains distinguishable from degraded live state.
- 评审断言：
  - when conflict resolution touches helper return semantics, reviewers must inspect all callers with side effects.

### 7. 错误示例 vs 正确示例
#### 错误示例
```yaml
compose-smoke:
  needs: publish
  steps:
    - run: docker compose up -d --build
```

```ts
if (availability.status === 'degraded') {
  return true; // callers will skip startup and assume control-plane health
}
```

#### 正确示例
```yaml
compose-smoke:
  if: github.event_name != 'pull_request'
  needs: build
  steps:
    - run: docker load --input /tmp/hub-image.tar
    - run: docker load --input /tmp/runner-image.tar
    - run: docker compose up -d --no-build

publish:
  needs: compose-smoke
```

```ts
if (availability.status !== 'running') {
  return false;
}
```

---

## 场景：修复级联控制契约（Commit Chain Triage + Goal Drift）

### 1. 范围 / 触发条件
- 触发条件： the same bug family causes 4+ closely spaced fix commits, repeated review follow-ups, or re-diagnosis after merge/review churn.
- 为什么需要 code-spec 深度：
  - Long repair chains often indicate the team is no longer solving a single bounded bug, but a moving bundle of root fix, propagation, review response, and adjacent cleanup.
  - Once commit intent drifts, later fixes can repeat already-disproved conclusions or silently re-open previously closed scope.
  - The waste is not only code churn; it is repeated thinking churn across the same evidence layers.

### 2. 签名
- Commit-chain signature:
  - `git log --oneline --date=iso -N`
  - clusters of `fix(...)` commits touching the same files/contract boundary within hours
- Goal-drift signature:
  - commit subjects mention different local symptoms while the underlying contract boundary stays the same
  - e.g. `startup status`, `same PID stale state`, `workflow contract`, `review trigger`, `degraded reusable runner`
- Rework signature:
  - later commits partially undo or narrow behavior introduced by earlier commits
  - merge commits or review fixes reintroduce previously solved behavior
- Evidence-loop signature:
  - repeated inspection of the same UI/status layer without escalating to the true source of truth (`git`, workflow runs, caller chain, integration contract)

### 3. 契约
- Primary-goal contract:
  - every repair burst MUST name one primary bug contract in one sentence; work that does not directly serve that sentence MUST be split out or deferred.
- Change-budget contract:
  - root fix, required propagation, and optional hardening MUST be classified separately before writing the next patch.
- Regression-origin contract:
  - before adding another fix commit, identify which earlier commit introduced the behavior and whether the new patch is a correction, rollback, or hardening layer.
- Re-diagnosis contract:
  - if 3+ sequential fix commits touch the same boundary, stop coding and rebuild the full end-to-end model (`trigger -> state model -> caller -> side effect -> verification`) before continuing.
- Merge-reentry contract:
  - after a merge commit or large review follow-up, first test whether old behavior was reintroduced; do not invent a fresh root cause until reentry is ruled out.
- Documentation contract:
  - once a repair chain is recognized, capture the failed assumptions, redundant paths, and scope rules in spec/guides before resuming more feature work.

### 4. 校验与错误矩阵
- Many small commits, one unchanged contract boundary -> likely goal drift, not many independent bugs.
- New commit explains the bug with a different theory but touches the same helper/workflow/caller set -> likely re-diagnosis without a refreshed model.
- Merge/review fix lands, then old symptom returns -> likely regression reentry, not net-new root cause.
- Review response mixes root fix, cleanup, docs, and unrelated improvements -> repair scope inflation makes validation slower and conclusions noisier.
- Engineers repeatedly inspect UI aggregates (`gh pr view`, one helper result, one local test) -> evidence loop prevents escalation to source-of-truth layers.

### 5. 良好 / 基线 / 反例
- Good：
  - the team names the single active contract, maps which commit introduced the regression, isolates the minimal corrective patch, and defers adjacent cleanup.
- Base：
  - multiple commits are still needed, but each one has a declared role: root fix, propagation, verification hardening, or documentation capture.
- Bad：
  - every new symptom generates a new theory, fixes overlap in scope, old conclusions are revisited without new evidence, and merge/review churn is treated as unrelated fresh bugs.

### 6. 必需测试（含断言点）
- Process assertions:
  - if a bug family exceeds 3 fix commits, require a written commit-chain timeline before the next code change.
  - each fix commit must name whether it is correcting a specific prior commit or adding new hardening.
- Verification assertions:
  - every diagnosis step must identify its source of truth (`git ref`, workflow-run history, integration test, caller chain) rather than a lagging aggregate signal.
- 评审断言：
  - reviewers should challenge patches that combine root fix and optional cleanup without explicit separation.
- Documentation assertions:
  - specs/guides must record redundant goals, redundant conclusions, and repeated evidence loops observed in the repair chain.

### 7. 错误示例 vs 正确示例
#### 错误示例
```text
commit 1: fix startup
commit 2: fix workflow
commit 3: fix stale state
commit 4: fix review trigger
# 每个 commit 都在更换解释理论，但没有人停下来确认是不是又把同一个契约边界重新打开了
```

#### 正确示例
```text
primary contract: "candidate artifact must be validated before publish; degraded runner must not be treated as healthy reusable"
introduced by: <commit A>, reintroduced by merge/review in <commit B>
next patch role: corrective rollback of <commit B>
deferred items: optional cleanup / broader UX / unrelated hardening
```

---

## 场景： 高风险修改前的历史提交检查契约（相关 Commit 回放 + 冲突语义保留）

### 1. 范围 / 触发条件
- 触发条件：准备修改以下高风险区域之一：
  - merge / rebase 冲突解决
  - 同一文件在 24 小时内被连续修复
  - workflow / CI / Docker / 发布链路
  - runtime 状态机、helper 语义、生命周期逻辑
  - 有 review comment 直接指向的文件
- 为什么需要 code-spec 深度：
  - 当前文件只能告诉你“代码现在长什么样”，却不会告诉你“为什么会变成这样”。
  - 很多看似啰嗦、保守、重复的分支/测试，其实是为了锁死某次事故、review 或回归。
  - 冲突解决如果只按文本拼接，不按历史意图排序，就很容易保留语法正确、却丢掉语义正确。

### 2. 签名
- History-blind signature：
  - 直接在当前文件上修改，没有先看相关 `git log` / `git show`。
  - 看见复杂分支、奇怪测试、保守顺序时，第一反应是“简化 / 删除 / 合并掉”。
- Conflict-risk signature：
  - 冲突两侧都能编译，但无法说清哪一边是 bugfix、哪一边是 review 修正、哪一边只是重构。
- Regression-signature：
  - 某段逻辑刚修过不久，又被新的修改“顺手改回去”。
  - 某个 test 看起来多余，删除后旧问题复发。

### 3. 契约
- Commit-replay contract：
  - 命中高风险场景时，修改前至少查看该文件最近 **3 个相关 commit**，并写清：
    1. 哪个 commit 在修 bug
    2. 哪个 commit 在回应 review
    3. 哪个 commit 只是重构 / 清理
- Conflict-priority contract：
  - 冲突解决时，历史意图优先级必须是：
    - 事故修复 > review 修正 > 功能演进 > 重构清理
  - 不允许只按“哪边更顺眼 / 更短 / 更容易拼起来”处理冲突。
- Caller-history contract：
  - 修改 helper / 状态判断 / workflow 依赖时，除了看 helper 自己的历史，还必须看 caller / downstream job 的历史。
  - 禁止只根据 helper 当前实现推断语义，而不核对调用方过去依赖的契约。
- Test-origin contract：
  - 当某个 test 看起来奇怪、保守、冗长时，先查它是为哪个 commit / 哪类 bug 引入的；在未确认前不得删除或弱化。
- Minimal-history-note contract：
  - 高风险修改前，至少写下：
    - `相关历史 commit：A/B/C`
    - `本次修改不能破坏：契约 X / 契约 Y`

### 4. 校验与错误矩阵
- 只看当前文件，不看历史 commit -> 容易把事故修复误判成可删复杂度。
- 冲突解决只保留“能编译”的文本组合 -> 高概率语义回归。
- helper 被简化，但 caller 历史语义未检查 -> 高概率出现“helper 看起来对，调用方却错了”。
- test 被删除时说不出它锁的是哪个历史 bug -> 高概率删掉回归保护。
- 某文件短时间内被连续修复，却没人做 commit 回放 -> 高概率重复修同一类问题。

### 5. 良好 / 基线 / 反例
- Good：
  - 修改前先回放最近相关 commit，明确哪次是事故修复、哪次是 review 修正，再做最小改动。
- Base：
  - 至少查看最近 3 个相关 commit，并写下“本次不能破坏的历史契约”。
- Bad：
  - 直接对当前文件做“看起来更优雅”的调整，冲突时按文本拼接，最后把刚修好的行为改回去。

### 6. 必需测试（含断言点）
- Process assertions：
  - 命中高风险场景时，修改前必须补一段简短历史说明：`相关 commit + 不可破坏契约`。
  - 同一文件如果在 24 小时内出现连续修复，下一次改动前必须先做 commit 回放。
- Review assertions：
  - reviewer 应追问：
    - “这个分支 / 测试是哪个 commit 引入的？”
    - “本次冲突保留了哪一边的历史语义？”
- Documentation assertions：
  - spec / guide 必须明确要求：高风险改动不能只看文件现状，还要看相关历史 commit。

### 7. 错误示例 vs 正确示例
#### 错误示例
```text
看到 helper 很复杂
-> 直接简化
看到 test 很奇怪
-> 直接删掉
看到冲突两边都能跑
-> 选更顺眼的一边拼起来
# 结果：把历史 bugfix / review 修正一起抹掉
```

#### 正确示例
```text
修改前先看最近 3 个相关 commit
- commit A：事故修复
- commit B：review 修正
- commit C：重构清理

本次修改不能破坏：
- 契约 X
- 契约 Y

冲突时按优先级保留：事故修复 > review 修正 > 功能演进 > 重构清理
```

---



### 1. 范围 / 触发条件
- 触发条件：某个修复 / 功能 / 重构在原始 blocker 已解决之后仍继续推进，并不断累积边际收益递减的 commit。
- 为什么需要 code-spec 深度：
  - 低 ROI 工作通常不是技术 bug，而是**决策 bug**：没有人明确问一句“现在是不是应该停了？”
  - 每一步单独看都像是合理的小补充，但累计成本（时间、review 往返、上下文切换）已经超过累计收益。
  - 这类工作常被包装成“顺手补完整”“一次性收干净”“写得更漂亮”，所以在心理上很难及时停止。

### 2. 签名
- Blocker-resolution signature：
  - 原始 P0 症状（崩溃、门禁失效、用户可见失败）已经被修复。
  - 后续 commit 开始转向：日志、边缘 case、重构、穷尽式 spec、预防性 hardening。
- Effort-escalation signature：
  - 原本预估 1 小时左右的工作，已经消耗 4 小时以上。
  - 多轮 review 讨论的重点变成“更优雅 / 更完整”，而不是“是否还错误”。
- Impact-gap signature：
  - 如果问“把这个 commit 延后，对用户可见行为有什么变化？”，答案是“没有”或“只是内部状态更整洁一点”。
- Exit-condition signature：
  - 没有人提前写下 done 的定义；工作一直持续到“感觉差不多完整”为止。

### 3. 契约
- Stop-signal contract：
  - 原始 blocker 一旦解决，必须显式问：**“如果现在停下，哪个可观察契约会坏？”**
  - 如果答案是“没有”，剩余工作默认属于可选项，继续前必须重新评估 ROI。
- Defer-criteria contract：
  - 仅改善内部整洁度、覆盖假想 edge case、补穷尽式规范、但不改变外部行为的工作，默认 SHOULD 延后，除非：
    1. reviewer / CI / 用户明确要求现在处理；或
    2. 延后的成本（未来 bug 风险、未来返工）明显大于继续的成本（时间、review 往返、上下文切换）。
- Done-definition contract：
  - 在开始修复 / 功能前，先写清退出条件：`done = X 症状被消除 + Y 契约已验证`。
  - 如果工作继续超出这个退出条件，必须为新增工作写出新的明确目标，不能只靠“顺手一起做”。
- ROI-comparison contract：
  - 在原始 blocker 解决之后，每增加一个 commit，都要显式比较：
    - 继续的成本：时间、上下文切换、review 往返、merge 风险
    - 延后的成本：未来 bug 风险、未来返工
  - 如果继续的成本 > 延后的成本，就应该停止并延后。

### 4. 校验与错误矩阵
- 原始 blocker 已修复，但工作仍继续进入 polish -> 高概率是低 ROI churn。
- 工作被描述成“顺手收尾 / 补完整”，但没有新的明确 blocker -> 高概率是把可选工作伪装成必做工作。
- 多个 commit 单看都很小，但累计 ROI 逼近于 0 -> 高概率是渐进式 scope creep。
- 没人能明确回答“如果现在停下，哪个契约会坏？” -> 高概率说明已经没有剩余的可观察 blocker。
- 投入时间超出预估 2 倍以上，但收益仍只是“更整洁 / 更优雅 / 更完整” -> 高概率已经进入收益递减区间。

### 5. 良好 / 基线 / 反例
- Good：
  - blocker 修复后，团队显式问“现在是不是应该停”，其余工作按 ROI 归档为 deferred 项。
- Base：
  - blocker 修复后，仍做少量 polish，但团队写下退出条件，并在达到条件后停止。
- Bad：
  - blocker 修复后，工作继续扩张到边缘 case、相邻重构、穷尽式 spec、预防性 hardening，却没有任何人问“是否已经够了”。

### 6. 必需测试（含断言点）
- Process assertions：
  - 开始工作前必须写出：`done = X 症状被消除 + Y 契约已验证`。
  - blocker 解决后必须显式问：**“如果现在停下，哪个可观察契约会坏？”**
- Review assertions：
  - reviewer 应主动质疑那些已经超出原始 blocker、却没有新的明确目标或 ROI 理由的 commit。
- Documentation assertions：
  - spec / guides 必须记录停止信号 checklist 与延后判定规则，避免未来继续用“感觉还没收完”驱动工作。

### 7. 错误示例 vs 正确示例
#### 错误示例
```text
commit 1: 修复 publish gate（blocker 已解决）
commit 2: 补更好的日志
commit 3: 覆盖边缘 case X
commit 4: 顺手重构相邻代码
commit 5: 写一整套穷尽式 spec
commit 6: 为假想问题 Y 做预防性 hardening
# 每一步都感觉“顺手且合理”，但没有人问：现在是不是应该停？
```

#### 正确示例
```text
commit 1: 修复 publish gate（blocker 已解决）
# 立刻问：如果现在停下，哪个可观察契约会坏？
# 答案：没有
# 那么把以下内容延后：更好的日志、边缘 case X、相邻重构、穷尽式 spec、预防性 hardening
# 如果仍要继续，必须分别写出每项工作的 ROI 理由
```

---

## 场景：GitHub PR Review Trigger 契约（Push SHA vs pull_request_target Review）

### 1. 范围 / 触发条件
- 触发条件： a developer pushes a new commit to an existing PR branch, but review automation (for example `Codex PR Review`) does not appear to rerun.
- 为什么需要 code-spec 深度：
  - Git references, PR metadata, workflow triggers, and review comments refresh on different timelines.
  - A successful branch push does not prove that PR-event workflows (`pull_request` / `pull_request_target`) were emitted or completed.
  - Debugging can easily stop at the wrong layer (`gh pr view`) unless branch SHA, workflow runs, and event type are validated separately.

### 2. 签名
- Branch freshness signature:
  - `git rev-parse HEAD`
  - `git ls-remote origin refs/heads/<branch>`
- PR metadata signature:
  - `gh pr view <number> --json headRefOid,updatedAt,statusCheckRollup,reviews`
- Workflow trigger signature:
  - `.github/workflows/codex-pr-review.yml`
  - `on: pull_request_target`
  - `types: [opened, reopened, ready_for_review, synchronize]`
- Workflow-run verification signature:
  - `gh run list --branch <branch>`
  - `gh api repos/<owner>/<repo>/actions/workflows/<workflow>/runs?...`

### 3. 契约
- Push contract:
  - if `git ls-remote` shows the new SHA on the remote branch, the push succeeded regardless of stale PR UI data.
- Trigger contract:
  - a workflow triggered only by `pull_request` / `pull_request_target` MUST NOT be inferred from `push` workflow activity.
- Verification contract:
  - workflow-run history is the source of truth for whether review automation ran; `statusCheckRollup` is only a lagging aggregate view.
- Triage contract:
  - when review automation seems missing, distinguish three states explicitly:
    1. push failed,
    2. push succeeded but PR metadata is stale,
    3. push succeeded but the PR event workflow did not trigger.

### 4. 校验与错误矩阵
- Local HEAD != remote branch SHA -> push failed or wrong branch pushed.
- Local HEAD == remote branch SHA, but no new `push` run -> Actions dispatch problem or branch mismatch.
- New `push` run exists, but no new `pull_request_target` run -> review workflow did not trigger for the PR event path.
- PR `headRefOid` still points to old SHA while branch ref already advanced -> PR metadata / review aggregation lag; do not treat this as push failure.
- Reviewer reads only PR comments/status rollup -> false conclusion that no new commit exists.

### 5. 良好 / 基线 / 反例
- Good：
  - remote branch SHA matches local HEAD, workflow-specific runs confirm whether `push` and `pull_request_target` both fired, and diagnosis names the exact missing layer.
- Base：
  - `gh pr view` may lag, but branch ref and workflow-run APIs are checked before conclusions are drawn.
- Bad：
  - team assumes "no new review" means "commit not pushed" without checking remote branch SHA or workflow trigger history.

### 6. 必需测试（含断言点）
- Operational assertions:
  - verify remote branch SHA after push before debugging review bots.
  - verify workflow-specific run list for the expected event type (`push` vs `pull_request_target`).
- Review automation assertions:
  - if workflow is expected on `synchronize`, there should be a new run whose `head_sha` matches the pushed commit.
- Documentation assertions:
  - troubleshooting docs must tell engineers to compare branch ref, PR head metadata, and workflow-run history separately.

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# `gh pr view` 仍显示旧的 head
# 因此就断定 push 一定失败了
```

#### 正确示例
```bash
git rev-parse HEAD
git ls-remote origin refs/heads/zs-docker
gh run list --branch zs-docker
# 需要判断缺失的是 push、PR 元数据刷新，还是 pull_request_target 触发
```

---

## 场景：Docker Build Lockfile Freeze 契约（Bun Workspace CI）

### 1. 范围 / 触发条件
- 触发条件： GitHub Actions Docker multi-arch build fails at `bun install --frozen-lockfile`.
- 为什么需要 code-spec 深度：
  - Lockfile immutability is an executable CI contract, not a soft convention.
  - Failure appears inside Docker Buildx pipeline, but root cause often originates from repository dependency graph drift.
  - Requires synchronized handling across `package.json` manifests, `bun.lock`, Dockerfile copy order, and CI validation commands.

### 2. 签名
- Docker install step signature:
  - `Dockerfile.hub`, `Dockerfile.runner`
  - `RUN bun install --frozen-lockfile`
- Workspace manifest copy signature:
  - root `package.json`, root `bun.lock`, and all workspace `*/package.json` included in lock resolution.
- CI workflow signature:
  - `.github/workflows/docker-images.yml`
  - `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`

### 3. 契约
- Lockfile immutability contract:
  - If any workspace dependency graph changed, `bun.lock` MUST be regenerated and committed before CI Docker build.
  - Changes to CLI release artifact packages (for example `optionalDependencies` platform package additions/removals) also count as dependency graph changes, even if app runtime code did not change.
- Docker context contract:
  - Dockerfile MUST copy all manifests participating in lock resolution before `bun install --frozen-lockfile`.
- Version consistency contract:
  - Bun version in local/dev/CI SHOULD be pinned consistently to avoid lockfile format and resolver drift.
- Failure attribution contract:
  - In multi-arch logs, canceled secondary platform stages MUST NOT be treated as root cause when primary stage reports lockfile mutation.
  - If `publish` has `needs: compose-smoke`, then missing package/upload execution after a failed run MUST be interpreted as gate prevention, not as publish-step malfunction.

### 4. 校验与错误矩阵
- `lockfile had changes, but lockfile is frozen` in Docker step -> missing/stale committed `bun.lock`; regenerate at repo root and commit.
- CLI `optionalDependencies` adds/removes platform release package -> must rerun root `bun install` and commit updated `bun.lock`.
- Added/changed workspace `package.json` not copied before install -> Docker resolver differs from repo state; update Dockerfile copy list.
- Local `bun install` passes but frozen fails in CI -> Bun version mismatch; align Bun versions and rerun frozen install locally.
- Buildx shows `linux/arm64 CANCELED` -> secondary cancellation due to another platform failure; inspect first failing platform logs (often amd64).
- `publish` / upload steps absent after failed workflow -> inspect upstream `needs` jobs first; do not debug registry/upload logic before the gate job is green.

### 5. 良好 / 基线 / 反例
- Good：
  - Developer updates workspace manifest, runs root `bun install`, commits `bun.lock`, local frozen install passes, CI Docker build passes.
  - Release artifact package list changes in `cli/package.json`, root lockfile is refreshed, and publish runs only after `compose-smoke` passes.
- Base：
  - No dependency graph changes; frozen install remains deterministic across local and CI.
- Bad：
  - Manifest changed without lockfile commit; CI fails at frozen install and noise from other platform cancellation obscures diagnosis.
  - Team sees no upload job execution and misdiagnoses registry/publish logic, while the actual cause is an upstream smoke gate failure.

### 6. 必需测试（含断言点）
- Local pre-push assertions:
  - `bun install --frozen-lockfile` succeeds at repo root.
  - `git diff --exit-code bun.lock` returns clean after install.
  - If CLI release package list changed, verify the corresponding lockfile entries are present.
- Docker assertions:
  - `docker build -f Dockerfile.hub .` reaches install step without lockfile mutation.
  - `docker build -f Dockerfile.runner .` reaches install step without lockfile mutation.
- CI assertions:
  - `.github/workflows/docker-images.yml` path filter includes lock/manifests and Dockerfiles.
  - Build matrix fail log triage identifies first failing platform and command.
  - `publish` remains gated by `needs: compose-smoke` and does not execute when smoke validation fails.

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# 只更新 workspace 的 package.json
# 直接 push，并指望 CI 来帮你发现 lock 漂移
```

#### 正确示例
```bash
# 任何依赖图变更之后
bun install
git add bun.lock
# 可选的严格检查
bun install --frozen-lockfile
# 然后再 push / 发起 PR
```

---

## 场景：语音助手下线契约（Web + Hub + Shared + Docs）

### 1. 范围 / 触发条件
- 触发条件： Remove an existing cross-layer capability (`Voice Assistant` / ElevenLabs) in a single phase.
- 为什么需要 code-spec 深度：
  - API contract removal (`POST /api/voice/token`) spans frontend call sites and backend route registration.
  - Shared protocol export removal (`@hapi/protocol/voice`) affects compile-time imports across multiple packages.
  - User-facing contract changes require synchronized docs, settings UI, and i18n cleanup.

### 2. 签名
- Backend route signature to remove:
  - `hub/src/web/routes/voice.ts`
  - `createVoiceRoutes(): Hono<WebAppEnv>`
  - `POST /voice/token`
- Backend route registration signature to remove:
  - `hub/src/web/server.ts`
  - `app.route('/api', createVoiceRoutes())`
- Frontend API signature to remove:
  - `web/src/api/client.ts`
  - `fetchVoiceToken(credentials?: VoiceCredentials): Promise<VoiceTokenResponse>`
- Shared package export signature to remove:
  - `shared/package.json`
  - `"./voice": "./src/voice.ts"`

### 3. 契约
- Request contract (removed):
  - Endpoint: `POST /api/voice/token`
  - Request body: `{ customAgentId?: string; customApiKey?: string }`
  - Response body: `{ allowed: boolean; token?: string; agentId?: string; error?: string }`
- Env contract (removed):
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_AGENT_ID`
- Frontend behavior contract (after removal):
  - UI MUST NOT render voice entry points in composer/settings.
  - Runtime MUST NOT initiate `/api/voice/token` requests.
- Build contract (after removal):
  - No remaining import of `@hapi/protocol/voice`.
  - No remaining dependency on `@elevenlabs/react` in `web/package.json`.

### 4. 校验与错误矩阵
- Residual frontend API call to `/api/voice/token` -> 404/runtime noise; fix by removing call sites and state branches.
- Residual backend `createVoiceRoutes` import/registration -> TypeScript compile failure; remove import + route mount together.
- Residual `@hapi/protocol/voice` import after export removal -> unresolved module error; remove import chain before/with export deletion.
- Docs still mention ElevenLabs env keys after code removal -> operational confusion; remove docs links and setup sections.
- i18n/settings keys removed incompletely -> dead UI labels or lint noise; remove keys and corresponding settings blocks together.

### 5. 良好 / 基线 / 反例
- Good：
  - Web/Hub typecheck/test/build pass.
  - No `/api/voice/token` route or client call remains.
  - No `@hapi/protocol/voice` imports and no `@elevenlabs/react` dependency.
  - Docs no longer reference Voice Assistant/ElevenLabs setup.
- Base：
  - Voice feature files removed; text chat, permission handling, session switching still function.
- Bad：
  - Only UI is hidden but backend/shared contracts remain.
  - Or backend is deleted while frontend still calls removed endpoint.

### 6. 必需测试（含断言点）
- Type-level assertions:
  - `bun run --cwd web typecheck` passes (assert: no missing voice symbols/types/imports).
  - `bun run --cwd hub typecheck` passes (assert: no `createVoiceRoutes` / route import residue).
- Runtime/test assertions:
  - `bun run --cwd web test` passes (assert: settings/chat tests no longer depend on voice state).
  - `bun run --cwd hub test` passes.
- Build assertions:
  - `bun run --cwd web build` passes (assert: no voice vendor chunk rule/dependency required).
- Optional grep assertions (recommended):
  - No source/docs matches for `@hapi/protocol/voice`, `/api/voice/token`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`.

### 7. 错误示例 vs 正确示例
#### 错误示例
```ts
// Only remove UI toggle, keep API + shared contract alive
// - Composer voice button hidden
// - fetchVoiceToken still exists and can be called
// - backend /api/voice/token route still mounted
```

#### 正确示例
```ts
// Remove capability end-to-end in one contract change:
// 1) Remove web entry/state/hooks/api call paths
// 2) Remove hub route file + server registration
// 3) Remove shared voice export/module
// 4) Remove dependency/docs/env references
```

---

## 场景：中文优先文档术语契约

### 1. 范围 / 触发条件
- 触发条件：对 `README.md` 与 `docs/guide/*.md` 做文档本地化与术语统一。
- 为什么重要：
  - 混用命名（`hub`/`Hub`、`session`/`会话`）会增加认知负担，并造成不一致的 UX 文案。
  - 文档之间的漂移会让搜索、onboarding 和维护更困难。

### 2. 签名
- 文档范围（当前项目约定）：
  - `README.md`
  - `cli/README.md`
  - `hub/README.md`
  - `web/README.md`
  - `docs/guide/*.md`
- 本任务线排除的本地化范围：
  - `.claude/**`
  - `.github/**`
  - `.trellis/**`

### 3. 契约
- 语言契约：
  - User-facing product docs are Chinese-primary.
  - Technical tokens/commands/paths remain literal (e.g., `hapi hub`, `/api/events`, `runner.state.json`).
- 术语契约：
  - Product component names use consistent title form in prose: `Hub`, `Runner`, `Session`.
  - Generic concept text prefers Chinese term `会话`; keep English token only when needed for protocol/UI labels.
- 风格契约：
  - Do not alter executable snippets when only normalizing prose terminology.

### 4. 校验与错误矩阵
- Prose contains lowercase `hub` for product component mention -> normalize to `Hub`.
- Mixed `session` and `会话` in adjacent prose without protocol reason -> normalize to `会话` (or explicit mixed form once, then consistent).
- Terminology edits inside command/code blocks -> reject change and keep literal tokens.
- Localization accidentally touches excluded directories -> revert those edits.

### 5. 良好 / 基线 / 反例
- Good：
  - `web/README.md` uses `Hub` consistently in prose, while preserving `hapi hub` in commands.
- Base：
  - Existing docs already Chinese-primary; only minor terminology cleanup needed.
- Bad：
  - Blind global replace modifies command literals or API paths.

### 6. 必需测试（含断言点）
- Grep 断言（仅文档）：
  - Search for inconsistent prose tokens in target docs and review hits manually.
  - Assert no unintended edits under `.claude/.github/.trellis`.
- 评审断言：
  - Commands/paths/API literals remain unchanged.
  - Terminology consistency preserved in modified files.

### 7. 错误示例 vs 正确示例
#### 错误示例
```md
登录页右上角有 hub 选择器；输入 hapi hub 的 origin。
```

#### 正确示例
```md
登录页右上角有 Hub 选择器；输入 hapi Hub 的 origin。
# 代码块中的命令字面量保持不变：`hapi hub`
```

---

## 场景：全局 npm 安装 Peer Dependency 漂移（已发布 CLI 包）

### 1. 范围 / 触发条件
- 触发条件：执行 `pnpm install -g @jlovec/zhushen` 时，从全局传递依赖图中打印出 peer dependency 警告。
- 为什么需要 code-spec 深度：
  - 这是一个跨边界契约，涉及已发布包的元数据、npm/pnpm 全局存储行为，以及终端用户安装体验。
  - 仅告警类失败很容易被忽视，但重复告警会掩盖后续真正的不兼容问题。
  - 需要明确的分诊契约，以区分无害告警与需要处理的不兼容问题。

### 2. 签名
- 已发布包签名：
  - `cli/package.json`
  - `name: "@jlovec/zhushen"`
  - `optionalDependencies: @jlovec/zhushen-<platform>`
- 打包生成签名：
  - `cli/scripts/prepare-npm-packages.ts`
  - `buildOptionalDependencies(version: string): Record<string, string>`
- 安装命令签名：
  - `pnpm install -g @jlovec/zhushen`

### 3. 契约
- 运行时契约：
  - CLI 运行时 **不得** 依赖无关全局包的 peer 依赖完全干净。
  - 来自第三方依赖树（如 `@qingchencloud/openclaw-zh -> ... -> zod-to-json-schema@3.24.6`）的全局 peer 警告，除非 CLI 行为失败，否则属于非阻塞问题。
- 依赖契约：
  - Workspace 包统一以 Zod v4（`^4.x`）为规范基线。
  - 未经兼容性评审，不允许新增只接受 `zod@^3` peer 范围的直接依赖。
- 发布契约：
  - 发布前验证 **必须** 包含干净环境下的全局安装冒烟测试，以及告警分类。

### 4. 校验与错误矩阵
- `pnpm install -g` 打印 peer 警告，但 CLI 能正常启动 -> 归类为 `Warning/External`，记录并持续观察。
- `pnpm install -g` 因依赖解析错误失败 -> 归类为 `Blocking`，停止发布。
- 全局告警指向的包不在仓库依赖图中 -> 不要盲目修改项目 lockfile；先核对安装上下文。
- 新增仓库依赖引入不兼容 peer 范围（仅支持 `zod@^3`）-> 在升级或隔离之前阻止合并。

### 5. 良好 / 基线 / 反例
- Good：
  - Install succeeds, warning来源于外部全局包，`zs` command works normally.
- Base：
  - Install has no peer warnings; binary package resolves correctly for current platform.
- Bad：
  - 把每个全局告警都当成项目缺陷并强行在项目里加 override，造成不必要的依赖复杂度。

### 6. 必需测试（含断言点）
- 发布冒烟检查：
  - 在干净容器或用户配置环境中执行 `pnpm install -g @jlovec/zhushen`。
  - 断言安装退出码为 `0`，且 `zs --help` 退出码为 `0`。
- 依赖图检查：
  - 发布前搜索直接清单中的高风险 peer 依赖（如直接依赖中仅支持 `zod@^3` 的范围）。
  - 断言 `cli/package.json` 中可选平台依赖与当前版本一致。
- 回归检查：
  - 执行 workspace 的 `bun run typecheck` 与 CLI 测试，确保运行时/类型系统未与告警依赖树耦合。

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# 看到全局 peer 警告后，立刻去修改项目依赖或 lockfile
# 但并没有先证明告警来自本项目的依赖图。
```

#### 正确示例
```bash
# 1）在干净环境中复现
pnpm install -g @jlovec/zhushen

# 2）验证运行时行为
zs --help

# 3）如果告警来自外部且非阻塞，则记录为受监控风险；
#    只有在直接依赖图证明存在不兼容时才修改仓库依赖。
```

## 场景：Docker CLI zcf 混合配置契约（构建默认值 + 运行时覆盖）

### 1. 范围 / 触发条件
- 触发条件：Docker CLI 镜像切换为由 zcf 驱动的 Claude 配置，并支持运行时 env 覆盖。
- 为什么需要 code-spec 深度：
  - Infra integration changed (`Dockerfile.runner` build phase + `docker/entrypoint.sh` runtime phase).
  - New executable env contract (`ZCF_*`, `CLAUDE_CONFIG_DIR`) controls mounted config behavior.
  - Runtime override semantics must be testable to avoid accidental config loss or silent non-override.

### 2. 签名
- Build-time signature (`Dockerfile.runner`):
  - Global install: `pnpm install -g ... zcf`
  - Default generation:
    - `HOME=/tmp/zcf-home zcf init --skip-prompt --config-action new ... --default-output-style nekomata-engineer --workflows all --mcp-services Playwright,serena`
  - Default export path: `/usr/local/share/claude-default`
- Runtime signature (`docker/entrypoint.sh`):
  - Bootstrap when mounted config dir is empty:
    - copy `/usr/local/share/claude-default/.` -> `${CLAUDE_CONFIG_DIR}`
  - Runtime override command:
    - `HOME=/root zcf init --skip-prompt --config-action merge --code-type claude-code --install-cometix-line false --workflows skip --mcp-services skip --output-styles skip --api-type <skip|api_key> ...`
  - Post-merge explicit override:
    - write `${CLAUDE_CONFIG_DIR}/settings.json` for explicitly provided `ZCF_*` keys.

### 3. 契约
- Path/env contract:
  - `CLAUDE_CONFIG_DIR` (optional, default `/root/.claude`)
  - image defaults path fixed at `/usr/local/share/claude-default`
- Runtime override trigger contract (any non-empty value triggers override):
  - `ZCF_API_KEY`
  - `ZCF_API_URL`
  - `ZCF_API_MODEL`
  - `ZCF_API_HAIKU_MODEL`
  - `ZCF_API_SONNET_MODEL`
  - `ZCF_API_OPUS_MODEL`
  - `ZCF_DEFAULT_OUTPUT_STYLE`
  - `ZCF_ALL_LANG`
  - `ZCF_AI_OUTPUT_LANG`
- API key/security contract:
  - `ZCF_API_KEY` runtime-only; MUST NOT be injected via Docker build args/layers.
- Mount behavior contract:
  - Empty mount dir -> bootstrap defaults.
  - Non-empty mount dir + no `ZCF_*` trigger -> keep mounted files unchanged.
  - Non-empty mount dir + `ZCF_*` trigger -> run zcf merge then force-set explicitly provided fields.

### 4. 校验与错误矩阵
- Missing `${CLAUDE_CONFIG_DIR}/settings.json` after merge -> skip explicit JSON patch (no hard crash beyond zcf phase).
- Model/API URL provided without `ZCF_API_KEY` -> warn and keep `api-type=skip`.
- Mounted directory non-empty, no trigger vars -> no zcf init invocation.
- Empty mount + default dir exists -> must log bootstrap message and copy defaults once.
- Build pipeline includes API key material -> policy violation (block release).

### 5. 良好 / 基线 / 反例
- Good：
  - Mounted non-empty `.claude`, set `ZCF_DEFAULT_OUTPUT_STYLE=engineer-professional`.
  - Result: `settings.json.outputStyle == engineer-professional`.
- Base：
  - Mounted non-empty `.claude`, no `ZCF_*` env.
  - Result: existing settings preserved.
- Bad：
  - Assume `--config-action merge` always overrides existing fields.
  - Symptom: runtime env appears ignored (e.g., outputStyle remains old value).

### 6. 必需测试（含断言点）
- Build checks:
  - `docker build --check -f Dockerfile.runner .` passes.
  - `docker build -t zhushen-runner:zcf -f Dockerfile.runner .` passes.
- Compose checks:
  - `docker compose config --quiet` passes with required `.env` presence.
- Runtime behavior matrix:
  - Case A (empty mount, no vars): assert bootstrap happened and default `outputStyle == nekomata-engineer`.
  - Case B (non-empty mount, no vars): assert original `outputStyle` unchanged.
  - Case C (non-empty mount, with `ZCF_DEFAULT_OUTPUT_STYLE`): assert overridden `outputStyle` equals env value.
- Security checks:
  - `docker history --format '{{.CreatedBy}}' zhushen-runner:zcf` contains no API key literal.

### 7. 错误示例 vs 正确示例
#### 错误示例
```sh
# 误以为 merge 模式会自动覆盖已有配置项
docker run --rm -e ZCF_DEFAULT_OUTPUT_STYLE=engineer-professional -v "$PWD/.claude:/root/.claude" zhushen-runner:zcf
# 如果没有显式的 merge 后补丁，outputStyle 可能仍保持旧值
```

#### 正确示例
```sh
# 保持 merge 的非破坏性行为，然后显式补丁写入传入的配置项
# 在 `${CLAUDE_CONFIG_DIR}/settings.json` 中写入，以确保运行时覆盖结果可预测。
docker run --rm -e ZCF_DEFAULT_OUTPUT_STYLE=engineer-professional -v "$PWD/.claude:/root/.claude" zhushen-runner:zcf
# 断言 settings.json.outputStyle == engineer-professional
```

---

## 场景：不附带二进制产物的 GitHub Release 契约（Release Drafter + Install Notes）

### 1. 范围 / 触发条件
- 触发条件：Release 工作流从“附带二进制产物”改为“npm/docker 分发 + 自动生成说明”。
- 为什么需要 code-spec 深度：
  - Changes release pipeline contract (`.github/workflows/release.yml`) and published output behavior.
  - Introduces cross-step notes composition contract (draft release body + install notes template).
  - Affects release governance (draft release lifecycle + Homebrew fallback behavior).

### 2. 签名
- Release workflow signature:
  - `.github/workflows/release.yml`
  - 触发条件： `push.tags: v*`
  - Job: `release`
- Release notes draft workflow signature:
  - `.github/workflows/release-drafter.yml`
  - 触发条件： `push` to `main` + `pull_request_target` label/sync events
  - Job: `update-draft`
- Release Drafter config signature:
  - `.github/release-drafter.yml`
  - Mixed categorization: `labels` first + `autolabeler` (conventional commit fallback)
- Install notes template signature:
  - `.github/release-install-notes.md`
  - Placeholder: `${TAG}` (must be substituted before release creation)

### 3. 契约
- Distribution contract:
  - GitHub Release MUST NOT publish downloadable build artifacts (`cli/release-artifacts/*`) as release assets.
  - User upgrade path is documented via npm / Homebrew / Docker instructions in release notes.
- Notes composition contract:
  - Primary notes source: latest draft release body generated by Release Drafter.
  - Fallback notes source: static `## What's Changed` header if no draft is available.
  - Install section: append rendered `.github/release-install-notes.md` with `${TAG}` substituted from `GITHUB_REF`.
- Draft lifecycle contract:
  - After final release is created, consumed draft release SHOULD be deleted (best effort, `continue-on-error: true`).
- Existing release-side integration contract:
  - Homebrew update remains non-blocking (`continue-on-error: true`).

### 4. 校验与错误矩阵
- Draft release body fetch failed -> use fallback header, continue release.
- Install notes template missing `${TAG}` substitution -> release notes contain unresolved literal; treat as quality failure and fix before tagging.
- `gh release create` still includes asset glob (`cli/release-artifacts/*`) -> contract violation (must remove asset attachment).
- Release Drafter labels missing on PR -> `autolabeler` conventional-commit rules provide fallback grouping.
- Draft deletion API call fails -> log and continue (non-blocking cleanup).

### 5. 良好 / 基线 / 反例
- Good：
  - Tag `v0.1.2` triggers release; notes contain categorized changes + install/upgrade section with concrete npm/docker commands and resolved tag.
- Base：
  - No draft release exists; final release still generated with fallback "What's Changed" and install section.
- Bad：
  - Release publishes binary assets while docs claim npm/docker-only path; users get conflicting distribution signals.

### 6. 必需测试（含断言点）
- Workflow static validation:
  - Assert `.github/workflows/release.yml` has no `actions/upload-artifact` step.
  - Assert `gh release create` command does not pass `cli/release-artifacts/*` assets.
- Notes generation assertions:
  - Simulate tag context and verify `/tmp/release-notes.md` includes both change section and install section.
  - Assert `${TAG}` placeholder is fully substituted in rendered install commands.
- Drafting contract assertions:
  - On PR title `feat(...): ...` without label, verify Release Drafter `autolabeler` assigns `feature` (or mapped category label).
- Monorepo pre-check assertions (finish-work prerequisite):
  - In fresh workspace, run `bun install` before `bun run lint`, `bun run type-check`, `bun run test`.
  - Assert quality commands are not executed against missing toolchain state.

### 7. 错误示例 vs 正确示例
#### 错误示例
```bash
# 最终发布中仍然附带二进制产物
gh release create "$TAG" --generate-notes cli/release-artifacts/*
```

#### 正确示例
```bash
# 说明内容 = release-drafter 草稿（或回退内容）+ 渲染后的安装说明
gh release create "$TAG" \
  --title "Release $TAG" \
  --notes-file /tmp/release-notes.md
```

---

### 提交前检查


- [ ] `bun run typecheck` 通过（无 TypeScript 错误）
- [ ] `bun test` 通过
- [ ] 不存在 `any` 类型
- [ ] 不存在 SQL 字符串拼接
- [ ] 所有输入都使用 Zod `.safeParse()` 校验
- [ ] 所有查询都按 namespace 过滤
- [ ] 已检查 Guard 返回结果（`instanceof Response`）
- [ ] 错误处理足够优雅（无未处理的 rejection）
- [ ] HTTP 响应中不暴露内部错误细节

### 评审检查清单

**安全性**：
- [ ] 使用预处理语句（无 SQL 注入风险）
- [ ] 所有查询都保证 namespace 隔离
- [ ] 响应中不包含内部错误细节
- [ ] 输入在处理前已完成校验

**错误处理**：
- [ ] 已检查 Guard 返回结果
- [ ] 使用 Zod `.safeParse()`（而不是 `.parse()`）
- [ ] 后台错误会记录日志，但不会导致服务崩溃
- [ ] 使用合适的 HTTP 状态码

**TypeScript**：
- [ ] 不存在 `any` 类型
- [ ] 查询结果已标注类型（`as DbRowType | undefined`）
- [ ] 仅使用具名导出

**数据库**：
- [ ] 已使用预处理语句
- [ ] 所有查询都带 namespace 过滤
- [ ] 并发修改场景使用带版本更新
- [ ] 遵守外键约束

**测试**：
- [ ] 新增业务逻辑具备测试
- [ ] 测试使用工厂函数，而不是手写原始对象
- [ ] 需要时测试使用 `:memory:` 数据库

---

## TypeScript 配置

### Hub（`hub/tsconfig.json`）

```json
{
    "extends": "../tsconfig.base.json",
    "compilerOptions": {
        "target": "ESNext",
        "module": "ESNext",
        "types": ["bun-types"],
        "baseUrl": "."
    },
    "include": ["src"]
}
```

**继承自 `tsconfig.base.json`**：
- `strict: true` - 启用所有严格检查
- `noImplicitAny: true` - 禁止隐式 any
- `strictNullChecks: true` - 显式处理 null
- `noImplicitReturns: true` - 所有分支都必须返回

---

## 总结

**核心原则**：
1. **安全优先** - 无 SQL 注入、无跨 namespace 数据泄漏
2. **优雅失败** - 校验所有输入，不因坏数据导致崩溃
3. **类型安全** - 严格 TypeScript、禁用 `any`、查询结果带类型
4. **测试业务逻辑** - 覆盖 Store 操作、事件处理、状态迁移
5. **一致模式** - Guard 模式、Result 类型、具名导出
