---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 7
  issues_found: 1
  must_fix_count: 0
  low_count: 1
  info_count: 0
  duration_estimate: "5"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-06-06 02:27
- 项目路径：/Users/zhushanwen/Code/hapi-workspace/feat-pi-support
- Phase A（自动检查）：跳过（任务指定项目无 lint 配置，跳过）
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

项目未配置 lint/typecheck，Phase A 跳过。

## Phase B: AGENTS.md 规范对比

### 提取的规范条目

从 AGENTS.md `Shared rules` 和全局 CLAUDE.md 中提取以下规范：

| # | 规范条目 | 来源 |
|---|---------|------|
| 1 | TypeScript strict；no untyped code | AGENTS.md |
| 2 | 禁止 `any`，用 `unknown` 或具体类型 | CLAUDE.md |
| 3 | Prefer 4-space indentation | AGENTS.md |
| 4 | Zod for runtime validation | AGENTS.md |
| 5 | No backward compatibility: breaking old formats freely | AGENTS.md |
| 6 | Prioritize Pragmatism, Avoid Overengineering | AGENTS.md |
| 7 | Write necessary tests ONLY | AGENTS.md |
| 8 | Path alias `@/*` maps to `./src/*` per package | AGENTS.md |

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | TypeScript strict; no untyped code | 全部 7 文件 | ✅ 符合 | — |
| 2 | 禁止 any 类型 | 全部 7 文件 | ✅ 符合 | — |
| 3 | 4-space indentation | 全部 7 文件 | ✅ 符合 | — |
| 4 | Zod runtime validation | modes.ts | ✅ 符合 | — |
| 5 | No backward compatibility | modes.ts, flavors.ts | ➖ 不适用 | — |
| 6 | Prioritize Pragmatism | 全部 | ✅ 符合 | — |
| 7 | Write necessary tests ONLY | — | ➖ 不适用 | — |
| 8 | Path alias @/* | cli/src 下文件 | ✅ 符合 | — |

### 各文件审查详情

#### `cli/src/pi/PiTransport.ts` ✅

- `Record<string, unknown>` 替代 `any`，外部 JSON 事件用 unknown 类型
- `ChildProcessWithoutNullStreams` 类型准确，spawn 返回值类型标注正确
- JSONL buffer 解析逻辑清晰，`handleStdout` → `handleLine` 分层合理
- `NodeJS.ErrnoException` 类型窄化处理 ENOENT / EPIPE，符合 TypeScript strict 要求
- 无问题

#### `cli/src/pi/PiEventConverter.ts` ✅

- `Record<string, unknown>` 入参，`as string` / `as Record<string, unknown>` 类型断言均在类型守卫之后，类型安全
- switch-case 覆盖所有已知 Pi 事件类型，default 静默返回空数组，符合项目 "Pragmatism" 原则
- `AgentMessage` 类型来自 `@/agent/types`，路径别名使用正确
- 无问题

#### `cli/src/pi/runPi.ts` ✅

- `lifecycle.cleanupAndExit` 覆盖模式（L157-160）用闭包 resolve Promise，虽不常见但务实，符合 "Prioritize Pragmatism"
- `session.onUserMessage`、`rpcHandlerManager.registerHandler` 等均使用已有基础设施，未重复造轮子
- `formatMessageWithAttachments` 复用已有工具函数，无重复逻辑
- 无问题

#### `cli/src/commands/pi.ts` ✅

- 动态 `import('@/pi/runPi')` 与其他命令（gemini、kimi、opencode）一致
- 错误处理 `chalk.red` + `process.exit(1)` 与现有命令模式一致
- `parseRemoteAgentCommandOptions` 复用已有解析器，传入 `PI_PERMISSION_MODES`
- 无问题

#### `shared/src/modes.ts` ✅

- `PI_PERMISSION_MODES` / `PiPermissionMode` 定义方式与 `CLAUDE_PERMISSION_MODES` 等完全一致
- `getPermissionModesForFlavor` 增加 `flavor === 'pi'` 分支，位置在 `cursor` 之后、default fallback 之前，合理
- `AGENT_FLAVORS` 数组已包含 `'pi'`，`AgentFlavorSchema` 自动覆盖
- 无问题

#### `shared/src/flavors.ts` ✅

- `FLAVOR_CAPS` 增加 `pi: new Set([Capabilities.ModelChange])`，与 gemini/kimi 等同级 agent 一致
- `FLAVOR_LABELS` 增加 `pi: 'Pi'`，格式统一
- 无问题

#### `cli/src/commands/registry.ts` ✅

- `piCommand` import 并加入 `COMMANDS` 数组，位置在 `opencodeCommand` 之后，与 modes.ts 中处理顺序一致
- 注册模式与其他命令完全相同
- 无问题

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | LOW | B | PiTransport 构造函数参数与 PiTransportOptions 接口不一致 | cli/src/pi/PiTransport.ts | L7-10, L17 | `PiTransportOptions` 接口已定义但构造函数接收散参数而非 `options: PiTransportOptions`。建议统一为 `constructor(options: PiTransportOptions)` 或移除接口直接用内联类型 |

## 结论

**通过。** 7 个审查文件全部符合 AGENTS.md 编码规范。代码类型安全（无 `any`），4-space 缩进一致，路径别名正确，Zod 在 modes.ts 中用于 schema 定义。新代码与现有 claude/codex/gemini 等模块保持一致的架构模式。1 条 LOW 级别建议（构造函数参数风格），不影响功能。
