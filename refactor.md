# HAPI 重构计划

## 摘要
- 基线: `bun run typecheck`、`bun run test` 全绿；当前重点=结构清理，不是修红。
- 说明: 你提到的 `server/`，仓库实际对应 `hub/`；以下按 `cli/`、`hub/`、`web/`、`shared/` 审查。
- 静态发现: `cli` 3 组循环依赖，`hub` 1 组，`web` 1 组；存在确认未引用文件、兼容别名、重复 DTO、超大模块。

## 高优先级
### [高] 统一跨端协议/DTO/Schema，收口到 `shared/`
位置: `shared/src/*`, `web/src/types/api.ts`, `cli/src/api/types.ts`, `hub/src/web/routes/*.ts`, `hub/src/sync/*`
问题: HTTP/SSE/RPC 响应类型分散本地定义；`Machine`/`RunnerState`/Session 响应体多处重复；事件 patch 语义靠前端猜测，易漂移。
方案: 把 Web API DTO、SSE patch/full event、CLI route response、Machine/RunnerState schema 全部提升到 `shared/`；`hub` 只产出 shared schema，`cli/web` 只消费 shared 类型；删除本地镜像类型。
影响范围: `cli` API 客户端、`hub` 路由/SSE、`web` 查询层与实时层、测试夹具。

### [高] 清除兼容包袱与已确认死代码
位置: `cli/src/commands/registry.ts`, `cli/src/commands/{connect,notify}.ts`, `cli/src/persistence.ts`, `cli/src/ui/apiUrlInit.ts`, `cli/src/utils/autoStartServer.ts`, `hub/src/config/{settings.ts,serverSettings.ts}`, `hub/src/store/index.ts`, `shared/src/modes.ts`, `web/src/components/{MachineList.tsx,SpawnSession.tsx}`, `web/src/hooks/useScrollToBottom.ts`, `web/src/lib/locales/{en.ts,zh-CN.ts}`, `cli/src/api/socketOutbox.ts`, `cli/src/agent/runners/gemini.ts`
问题: 还保留 `hapi server` alias、`serverUrl/webapp*` 旧字段、运行时 DB migration、`connect/notify` 直连占位命令、旧新建会话组件、未使用 outbox/Gemini 注册器、旧文案键；噪音大，误导后续重构。
方案: 直接删兼容读取/迁移/别名/stub；只保留当前主路径 `hub`、`apiUrl`、`listen*`、`publicUrl`；DB 不再运行历史迁移，改“版本不符即重建/离线迁移”；删除未引用 UI/命令/工具与旧 locale key。
影响范围: CLI 帮助与启动流程、Hub 配置加载、SQLite 初始化、Web bundle、文档。

### [高] 拆分 `hub` 会话核心，消除缓存/发布/传输耦合
位置: `hub/src/sync/{syncEngine.ts,sessionCache.ts,machineCache.ts,messageService.ts,eventPublisher.ts}`, `hub/src/sse/sseManager.ts`
问题: `SessionCache` 同时做 hydration、schema parse、todo backfill、keepalive、config 持久化、merge/dedup/delete；`SyncEngine` 再包一层调度；`SSEManager` 反向 import `syncEngine` 类型，形成循环依赖。
方案: 切成 `sessionRepository`、`sessionLivenessService`、`sessionConfigService`、`sessionMergeService`、`machineLivenessService`、`eventBus`；新增 `hub/src/sync/types.ts`，SSE 仅依赖 shared event types；缓存层只管内存状态，不再承载业务修复逻辑。
影响范围: Hub SSE、Socket handler、REST route、session dedup/merge、相关测试。

### [高] 抽象 CLI 多代理运行时模板，去掉平行实现
位置: `cli/src/{claude,codex,cursor,opencode}/{loop.ts,session.ts,*LocalLauncher.ts,*RemoteLauncher.ts}`, `cli/src/agent/{sessionBase.ts,loopBase.ts}`
问题: 四套 agent 会话/loop/local/remote 结构高度相似；setter、failure 记录、client 代理、mode 切换、session 构造重复；`loop -> session -> launcher` 互相引用，形成循环依赖。
方案: 建统一 agent runtime kit: `SessionContext`、`LocalAdapter`、`RemoteAdapter`、`ModeConfig`、`LaunchPolicy`；把每个 agent 的差异收敛到“参数翻译 + 事件转换 + 特有 hook/scanner”；把 mode type 从 `loop.ts` 抽到独立 `modes.ts`，打断循环。
影响范围: `claude/codex/cursor/opencode` 主流程、runner spawn、权限模式、远程切换、单测。

### [高] 规范 `hub` 路由层，抽走重复守卫/解析/错误映射
位置: `hub/src/web/routes/{sessions.ts,messages.ts,git.ts,machines.ts,permissions.ts,auth.ts,bind.ts,events.ts}`, `hub/src/web/routes/guards.ts`
问题: 几乎每个 route 都重复 `requireSyncEngine` / `requireSessionFromParam` / `await c.req.json().catch(() => null)` / `Invalid body` / try-catch error mapping；`sessions.ts` 已超大。
方案: 提供统一 `parseJsonBody(schema)`、`withEngine`、`withSession`、`withActiveSession`、`withMachine`、`ApiRouteError`；把 `auth/bind` 共用 JWT 与 Telegram/accessToken 校验 service；把 `sessions.ts` 拆成 lifecycle/config/upload/read-only 多文件。
影响范围: Hub HTTP API、错误语义、路由测试、后续接口扩展。

### [高] 简化 Web 实时更新契约，去掉 heuristic patching
位置: `web/src/hooks/useSSE.ts`, `shared/src/sessionSummary.ts`, `hub/src/sync/sessionCache.ts`, `web/src/lib/message-window-store.ts`
问题: `useSSE` 既做连接管理，又做 query patch，又靠 `hasUnknownSessionPatchKeys()` 决定是否回源；session summary contract 不完整，前端自己猜 patch 字段；第二套 store 增加复杂度。
方案: 统一成一种事件协议: 要么总是发完整 `SessionSummary/MachineSummary`，要么发 shared 定义的最小 patch schema；删前端 heuristic；`message-window-store` 只保留聊天窗口分页/溢出职责，不再承担通用会话缓存修补。
影响范围: Web SSE、Hub emit、TanStack Query cache、聊天刷新体验。

## 中优先级
### [中] 拆 Web 大组件/大解析器
位置: `web/src/{App.tsx,router.tsx}`, `web/src/components/{SessionChat.tsx,AssistantChat/HappyComposer.tsx,ToolCard/ToolCard.tsx}`, `web/src/chat/normalizeAgent.ts`
问题: 400-800 行文件过多；单文件同时处理 auth、theme、push、SSE、voice、chat controller、composer、message normalization；修改风险高。
方案: 拆成 app shell、auth bootstrap、sessions layout、chat controller hook、composer state/actions hook、按 envelope/flavor 分类的 normalizer。
影响范围: Web 启动流程、聊天页、语音、路由层、单测。

### [中] 解耦 ToolCard registry/result renderer，打断 11 文件循环
位置: `web/src/components/ToolCard/views/{_all.tsx,_results.tsx,*View.tsx}`, `web/src/components/ToolCard/{ToolCard.tsx,knownTools.tsx}`
问题: `_all.tsx` 提供类型并注册组件，`_results.tsx` 又反向依赖它；各 ToolView 统一从 `_all.tsx` 拿类型，导致大环。
方案: 新建 `views/types.ts`、`views/registry.ts`、`views/resultRegistry.ts`；每个工具旁置 input/result adapter；`ToolCard` 仅负责布局与调度。
影响范围: Tool card 渲染、结果视图、测试、未来新增工具。

### [中] 抽重复 util/query 逻辑，减少同构代码
位置: `web/src/hooks/queries/*.ts`, `web/src/hooks/queries/{useSkills.ts,useSlashCommands.ts}`, `cli/src/cursor/{cursorLocalLauncher.ts,cursorRemoteLauncher.ts}`, `cli/src/modules/common/handlers/uploads.ts`, `hub/src/web/routes/sessions.ts`
问题: Query hook 返回结构重复；`levenshteinDistance` 重复；Cursor permissionMode 映射重复；base64 大小估算重复。
方案: 建 `createApiQuery`、`fuzzyMatch.ts`、`cursorPermissionMode.ts`、`uploadSize.ts` 等共享 util；保留差异逻辑在调用层。
影响范围: Web 查询层、CLI Cursor 模式、上传流程。

### [中] 简化配置生命周期，去掉可变 singleton/proxy
位置: `cli/src/configuration.ts`, `hub/src/configuration.ts`, `cli/src/persistence.ts`, `hub/src/config/*`
问题: `configuration._setApiUrl()`、`_setCliApiToken()`、Proxy 暴露未初始化对象；配置对象可变，测试/启动顺序敏感。
方案: 改成显式 `loadConfig()` + 只读对象；初始化后通过依赖注入传递；shared 保留持久化 schema，包内只做特有字段扩展。
影响范围: CLI/Hub 启动、测试隔离、未来并发初始化。

## 低优先级
### [低] 统一命名，去掉 Happy/Server/Codex 历史残留
位置: `README.md`, `cli/src/commands/claude.ts`, `shared/src/modes.ts`, `web/src/App.tsx`, 相关文档/帮助文本
问题: `hub/server`、`Happy/HAPI`、agent payload type=`codex` 混用；认知负担高。
方案: 统一外部命名 `hub`、内部 envelope 命名 `agent`/`tool-call`；文档、帮助、日志同一术语。
影响范围: 文档、日志、调试、shared 常量。

### [低] 第三方集成抽服务
位置: `hub/src/web/routes/voice.ts`, `hub/src/telegram/bot.ts`, `hub/src/notifications/*`
问题: route/bot 文件内直接持有外部 API 调用、缓存、日志；边界不清。
方案: 抽 `voiceService`、`telegramNotificationService`、`externalClients/*`；route 只做 I/O 映射。
影响范围: Voice、Telegram、通知测试。

## 测试计划
- 协议层: shared schema/DTO 快照；Hub route response contract test；CLI/Web 编译期类型收敛检查。
- Hub 核心: session alive/expire/dedup/merge、namespace 隔离、SSE broadcast、route helper 错误映射。
- CLI runtime: 每个 agent 至少覆盖 local/remote 切换、abort/switch、resume/sessionId 写回、权限模式映射。
- Web: `useSSE` 连接/重连/patch、ToolCard registry/result、NewSession 创建流、SessionChat/Composer 关键交互。
- 回归门槛: `bun run typecheck`、`bun run test` 必跑；新增重构只补边界/契约测试，不铺大而全 UI 快照。

## 假设与默认
- 默认不保留任何向后兼容: 旧命令、旧设置字段、旧 DB schema、旧消息 envelope 均可删除或强制迁移。
- 默认以 `hub/` 作为 server 包继续重构，不新建平行 `server/` 目录。
- 默认保留现有行为语义；优先改结构，不主动改产品功能或交互。
- 默认删除“确认未引用且无动态入口”的文件；若某文件仅靠发布脚本/二进制入口使用，先补显式引用再决定去留。
